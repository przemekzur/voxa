// ── Session learning client ────────────────────────────────────────────────
// Builds conversation-session payloads and ships them to the connector
// harness (`POST /api/learn/session`) so transcripts can be distilled into
// durable memory. Pure ESM with no browser globals at module top level, so it
// is importable by Node for tests as well as by the orb WebView.

const SESSION_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const MAX_TURNS = 500;
const POST_TIMEOUT_MS = 3000;
const DEFAULT_LEARN_BASE = "http://localhost:3010";

// "s-" + compact UTC timestamp + "-" + 4 random base36 chars, lowercase.
// e.g. "s-20260710193000-k3f9"
export function makeSessionId(now = Date.now()) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, "0");
  const ts =
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds());
  let rand = "";
  for (let i = 0; i < 4; i++) rand += Math.floor(Math.random() * 36).toString(36);
  const id = `s-${ts}-${rand}`.toLowerCase();
  return SESSION_ID_RE.test(id) ? id : `s-${Date.now().toString(36)}-${rand}`;
}

// Build a plain, validated session payload. Undefined/invalid optional fields
// are dropped; turns are clamped to the most recent MAX_TURNS. `debrief` is an
// opaque passthrough object (filled in by the debrief flow).
export function buildSessionPayload({
  sessionId,
  startedAt,
  endedAt,
  persona,
  turns,
  actions,
  summary,
  debrief,
  final,
} = {}) {
  const out = {};
  if (typeof sessionId === "string" && sessionId.trim()) out.sessionId = sessionId.trim();
  if (Number.isFinite(startedAt)) out.startedAt = startedAt;
  if (Number.isFinite(endedAt)) out.endedAt = endedAt;
  if (typeof persona === "string" && persona.trim()) out.persona = persona.trim();
  out.turns = Array.isArray(turns) ? turns.slice(-MAX_TURNS) : [];
  out.actions = Array.isArray(actions) ? actions.slice() : [];
  if (typeof summary === "string" && summary.trim()) out.summary = summary;
  if (debrief && typeof debrief === "object" && !Array.isArray(debrief)) out.debrief = debrief;
  out.final = final === true;
  return out;
}

// POST the payload to `${baseUrl}/api/learn/session`. Never throws: resolves
// {ok:true, status, data} on success or {ok:false, error} on any failure
// (network error, non-2xx, timeout). Fire-and-forget safe.
export async function postSession(baseUrl, payload, fetchImpl = fetch) {
  const base = String(baseUrl || DEFAULT_LEARN_BASE).trim().replace(/\/+$/, "");
  let controller = null;
  let timer = null;
  try {
    if (typeof AbortController === "function") {
      controller = new AbortController();
      timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    }
    const res = await fetchImpl(`${base}/api/learn/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
      signal: controller ? controller.signal : undefined,
    });
    if (!res || !res.ok) {
      return { ok: false, error: `HTTP ${res && typeof res.status === "number" ? res.status : "error"}` };
    }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON body is fine */ }
    return { ok: true, status: res.status, data };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Given the settings `sources` array (strings or {url} objects), pick the
// learn-egress base: the harness (:3010) if listed, else the first entry that
// is not the memory server (:3000), else the default harness address.
export function getLearnBase(sources) {
  const urls = (Array.isArray(sources) ? sources : [])
    .map((s) => (typeof s === "string" ? s : s && typeof s.url === "string" ? s.url : ""))
    .map((u) => String(u).trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const harness = urls.find((u) => u.includes(":3010"));
  if (harness) return harness;
  const other = urls.find((u) => !u.includes(":3000"));
  if (other) return other;
  return DEFAULT_LEARN_BASE;
}

// Key-free fallback compaction: roll the previous summary forward and append
// one condensed line per exchange, keeping the most recent content when the
// result must be clamped to maxChars.
export function heuristicCompact(previousSummary, turns, { maxChars = 1200 } = {}) {
  const clip = (s, n) => {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  };
  const lines = [];
  let pendingUser = "";
  for (const t of Array.isArray(turns) ? turns : []) {
    if (!t || typeof t.text !== "string" || !t.text.trim()) continue;
    if (t.who === "user") {
      if (pendingUser) lines.push(`user: ${clip(pendingUser, 100)}`);
      pendingUser = t.text;
    } else if (t.who === "bot" || t.who === "assistant") {
      lines.push(
        pendingUser
          ? `user: ${clip(pendingUser, 100)} → assistant: ${clip(t.text, 120)}`
          : `assistant: ${clip(t.text, 120)}`
      );
      pendingUser = "";
    }
  }
  if (pendingUser) lines.push(`user: ${clip(pendingUser, 100)}`);
  const prev = String(previousSummary || "").trim();
  let out = [prev, ...lines].filter(Boolean).join("\n");
  if (out.length > maxChars) out = "…" + out.slice(out.length - (maxChars - 1));
  return out;
}
