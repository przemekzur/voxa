#!/usr/bin/env node
// ── Voxa v2 Connector Harness ──────────────────────────────────────────────
// A thin aggregation layer that lets you add service integrations ("connectors")
// to the Voxa realtime cockpit without touching the the brain brain.
//
// It speaks the SAME voice-tool contract the cockpit already consumes
// (GET /api/voice/tools, POST /api/voice/tools/call), and MERGES:
//   • the brain's tools (proxied from BRAIN_URL, default :3000), plus
//   • every enabled connector's actions.
// Point the cockpit's bridge URL at this server (default :3010) and you get the
// full brain + all your connectors in one tool surface.
//
// Run:  node experiments/connector-harness/server.mjs   (PORT, BRAIN_URL env)
import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConnectors, getConnector, allConnectors, maskConfig, effectiveConfig } from "./lib/registry.mjs";
import { getState, getAllState, setState, unsetConfigKey } from "./lib/store.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3010", 10);
const BRAIN_URL = (process.env.BRAIN_URL || "http://localhost:3000").replace(/\/$/, "");

const app = express();
app.use(express.json({ limit: "1mb" }));

// Permissive localhost CORS (mirrors the brain) so the cockpit on any localhost
// port can reach us. This must also match the Voxa orb's WebView origin, which
// differs by platform under Tauri v2:
//   • Windows (WebView2):     http://tauri.localhost   (the `tauri.` subdomain)
//   • Linux/macOS (WebKit):   tauri://localhost        (custom `tauri:` scheme)
// The `tauri:` scheme is the important one — miss it and every fetch from the
// Linux/macOS orb to the harness is CORS-blocked, so the bridge loads zero tools
// and the agent reports it can't see any connectors.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && /^(https?|tauri):\/\/([\w-]+\.)?(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type,authorization");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── Connector management API (drives the harness UI) ─────────────────────────

// List connectors with their manifest (config schema + actions) and saved state.
app.get("/api/connectors", async (_req, res) => {
  const all = await getAllState();
  const list = allConnectors().map((m) => {
    const st = all[m.id] || { enabled: defaultOn(m), config: {} };
    const needsConfig = m.config.some((f) => f.required && !st.config?.[f.key] && f.default === undefined);
    return {
      id: m.id,
      name: m.name,
      description: m.description || "",
      icon: m.icon || "◆",
      config: m.config,
      actions: m.actions.map((a) => ({ name: a.name, description: a.description, parameters: a.parameters || null })),
      hasTest: typeof m.test === "function",
      enabled: !!st.enabled,
      savedConfig: maskConfig(m, st.config),
      status: !st.enabled ? "disabled" : needsConfig ? "needs-config" : "enabled",
    };
  });
  res.json({ connectors: list, brainUrl: BRAIN_URL });
});

// Save a connector's config and/or enabled flag. Secret fields keep their stored
// value if the client sends the masked placeholder back unchanged.
app.put("/api/connectors/:id", async (req, res) => {
  const m = getConnector(req.params.id);
  if (!m) return res.status(404).json({ error: "unknown connector" });
  const body = req.body || {};
  const stored = (await getState(m.id)).config || {};
  const config = {};
  if (body.config) {
    for (const f of m.config) {
      const v = body.config[f.key];
      if (v === undefined) continue;
      if (f.secret && v === "••••••••") continue; // unchanged masked secret
      config[f.key] = v;
    }
  }
  const next = await setState(m.id, { enabled: body.enabled, config });
  res.json({ ok: true, enabled: next.enabled, savedConfig: maskConfig(m, next.config) });
});

// Optional connectivity test.
app.post("/api/connectors/:id/test", async (req, res) => {
  const m = getConnector(req.params.id);
  if (!m) return res.status(404).json({ error: "unknown connector" });
  if (typeof m.test !== "function") return res.json({ ok: true, message: "no test defined" });
  try {
    const cfg = effectiveConfig(m, (await getState(m.id)).config);
    const r = await m.test(cfg);
    res.json({ ok: !!r?.ok, message: r?.message || (r?.ok ? "OK" : "failed") });
  } catch (e) {
    res.json({ ok: false, message: e?.message || String(e) });
  }
});

// Run a single connector action directly (used by the UI "Run" buttons).
app.post("/api/connectors/:id/actions/:name", async (req, res) => {
  const m = getConnector(req.params.id);
  if (!m) return res.status(404).json({ error: "unknown connector" });
  const action = m.actions.find((a) => a.name === req.params.name);
  if (!action) return res.status(404).json({ error: "unknown action" });
  try {
    const cfg = effectiveConfig(m, (await getState(m.id)).config);
    const out = await action.handler(req.body?.args || {}, cfg);
    res.json(out?.error ? { error: out.error } : { result: out?.result ?? out });
  } catch (e) {
    res.json({ error: e?.message || String(e) });
  }
});

// Hot-reload connector modules from disk (handy while authoring).
app.post("/api/reload", async (_req, res) => {
  await loadConnectors();
  res.json({ ok: true, count: allConnectors().length });
});

// ── App secrets (server-side only) ───────────────────────────────────────────
// Central place for non-connector secrets the local tooling needs — e.g. the
// Gemini key used by the ESP voice bridge. Stored in the same JSON store under a
// reserved id that is NOT a connector (so it never appears in the connector
// list). Unmasked values are returned ONLY to loopback callers (the local
// bridge) — never over the LAN, never to the browser.
const SECRETS_ID = "__secrets";
function isLoopback(req) {
  const a = (req.socket.remoteAddress || "").replace("::ffff:", "");
  return a === "127.0.0.1" || a === "::1";
}

// List which secret keys are set (values never returned here) — loopback only,
// so the LAN can't even enumerate which secrets exist.
app.get("/api/secrets", async (req, res) => {
  if (!isLoopback(req)) return res.status(403).json({ error: "loopback only" });
  const cfg = (await getState(SECRETS_ID)).config || {};
  res.json({ keys: Object.keys(cfg).map((k) => ({ key: k, set: !!cfg[k] })) });
});

// Read one secret UNMASKED — loopback only.
app.get("/api/secrets/:key", async (req, res) => {
  if (!isLoopback(req)) return res.status(403).json({ error: "loopback only" });
  const cfg = (await getState(SECRETS_ID)).config || {};
  const value = cfg[req.params.key];
  if (value === undefined) return res.status(404).json({ error: "not set" });
  res.json({ key: req.params.key, value });
});

// Set one secret — loopback only.
app.put("/api/secrets/:key", async (req, res) => {
  if (!isLoopback(req)) return res.status(403).json({ error: "loopback only" });
  const value = req.body?.value;
  if (typeof value !== "string" || !value) return res.status(400).json({ error: "value (non-empty string) required" });
  await setState(SECRETS_ID, { enabled: true, config: { [req.params.key]: value } });
  res.json({ ok: true, key: req.params.key });
});

// Remove one secret — loopback only.
app.delete("/api/secrets/:key", async (req, res) => {
  if (!isLoopback(req)) return res.status(403).json({ error: "loopback only" });
  const removed = await unsetConfigKey(SECRETS_ID, req.params.key);
  res.json({ ok: true, key: req.params.key, removed });
});

// ── Voice-tool surface (same contract as the brain) ──────────────────────────

// Build the list of enabled connector tools.
// Voxa: default-enabled unless the connector opts out or can't work unconfigured.
const defaultOn = (m) =>
  m.defaultEnabled !== false &&
  !m.config.some((f) => f.required && f.default === undefined);

async function connectorTools() {
  const all = await getAllState();
  const tools = [];
  const owners = new Map(); // toolName -> connectorId
  for (const m of allConnectors()) {
    const st = all[m.id];
    if (!(st ? st.enabled : defaultOn(m))) continue;
    for (const a of m.actions) {
      tools.push({ name: a.name, description: a.description || "", parameters: a.parameters || { type: "object", properties: {} } });
      owners.set(a.name, m.id);
    }
  }
  return { tools, owners };
}

// The harness serves ONLY connector tools — it is a separate, independent tool
// source from the brain. The cockpit loads brain (:3000) and connectors (:3010)
// as two distinct sources and routes calls to whichever owns the tool.
app.get("/api/voice/tools", async (_req, res) => {
  const { tools } = await connectorTools();
  res.json({ tools, sources: { connectors: tools.length } });
});

app.post("/api/voice/tools/call", async (req, res) => {
  const { name, args } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const { owners } = await connectorTools();
  const ownerId = owners.get(name);
  if (!ownerId) {
    console.error(`[harness] tool call "${name}" -> 404 (no connector owns it)`);
    return res.status(404).json({ error: `no connector owns tool "${name}"` });
  }

  const m = getConnector(ownerId);
  const action = m.actions.find((a) => a.name === name);
  try {
    const cfg = effectiveConfig(m, (await getState(ownerId)).config);
    const out = await action.handler(args || {}, cfg);
    // Log every call's outcome so tool failures are visible (voice debugging).
    console.error(`[harness] tool call "${name}" -> ${out?.error ? "ERROR: " + out.error : "ok"}`);
    if (out?.error) return res.json({ error: out.error });
    const result = typeof out?.result === "string" ? out.result : JSON.stringify(out?.result ?? out);
    // Pass an `image` through verbatim so vision connectors (e.g. screen) can hand
    // the orb a picture to inject into the live session. The model never sees the
    // base64 in a tool response; the orb routes it into session content instead.
    return res.json(out?.image?.data ? { result, image: out.image } : { result });
  } catch (e) {
    console.error(`[harness] tool call "${name}" THREW: ${e?.message || e}`);
    return res.json({ error: e?.message || String(e) });
  }
});

// ── Static management UI ─────────────────────────────────────────────────────
app.use(express.static(join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ status: "ok", service: "connector-harness" }));

await loadConnectors();
// Security: bind loopback-only. Every consumer (orb, realtime-voice, the local
// ESP bridge) reaches this over http://localhost — nothing on the LAN should be
// able to invoke connectors or read secrets.
app.listen(PORT, "127.0.0.1", () => {
  console.error(`[harness] Connector harness on http://localhost:${PORT}`);
  console.error(`[harness] Serves connector tools only (brain stays separate at ${BRAIN_URL}).`);
  console.error(`[harness] In the cockpit Config → Connectors, set the Connectors URL to http://localhost:${PORT}`);
});
