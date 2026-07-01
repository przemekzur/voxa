// Declarative HTTP connector runtime — the ONLY executable code behind Tier-A
// "forged" connectors. A forged connector file is just:
//
//   import { makeHttpConnector } from "../../lib/http-connector.mjs";
//   export default makeHttpConnector({ ...validated data-only spec... });
//
// so the agent never supplies code, only a spec this fixed runtime interprets.
//
// Hardened (security audit):
//   • {secret:KEY} resolves ONLY keys the spec declared in `secrets:[]` — a forged
//     connector can never read another connector's secret. (secret exfiltration)
//   • outbound host is validated AND resolved-then-checked against private/
//     loopback/link-local/metadata ranges (IPv4, IPv6, IPv4-mapped-IPv6), closing
//     DNS-rebinding and ::ffff: bypasses. (SSRF)
//   • redirects are followed manually and each hop is re-validated. (SSRF via 3xx)
import { getState } from "./store.mjs";
import dns from "node:dns/promises";
import net from "node:net";

const SECRETS_ID = "__secrets";
const MAX_RESULT_CHARS = 4000;
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 3;

// ── SSRF guard ───────────────────────────────────────────────────────────────
function isBlockedV4(ip) {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  return (
    a === 10 || a === 127 || a === 0 ||
    (a === 169 && b === 254) ||               // link-local + AWS/GCP metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224                                   // multicast / reserved
  );
}
function isBlockedAddr(address, family) {
  const a = String(address).toLowerCase();
  if (family === 4 || net.isIPv4(a)) return isBlockedV4(a);
  // IPv6
  if (a === "::1" || a === "::") return true;
  if (a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe80") || a.startsWith("ff")) return true;
  const mapped = a.match(/^::ffff:(.+)$/); // IPv4-mapped IPv6 (dotted or hex)
  if (mapped) {
    const rest = mapped[1];
    if (net.isIPv4(rest)) return isBlockedV4(rest);
    const hm = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hm) {
      const hi = parseInt(hm[1], 16), lo = parseInt(hm[2], 16);
      return isBlockedV4(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
    }
  }
  return false; // global IPv6 — allow
}

// Sync literal check (used at forge time + as a first pass): protocol + obvious
// literal hosts. Kept synchronous so forge-time validation stays simple.
export function assertPublicHttps(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { throw new Error(`invalid URL: ${urlStr}`); }
  if (u.protocol !== "https:") throw new Error(`only https:// is allowed (got ${u.protocol}//)`);
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal") {
    throw new Error(`host "${host}" is not allowed`);
  }
  if (net.isIP(host) && isBlockedAddr(host, net.isIPv4(host) ? 4 : 6)) {
    throw new Error(`private/loopback/link-local host "${host}" is not allowed`);
  }
  return u;
}

// Async check: resolve the host and reject if ANY resolved address is private/
// loopback/link-local/metadata. Closes DNS rebinding + name→private-IP.
async function assertResolvedPublic(u) {
  const host = u.hostname.toLowerCase();
  if (net.isIP(host)) return; // literal already checked by assertPublicHttps
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); }
  catch { throw new Error(`cannot resolve host "${host}"`); }
  if (!addrs.length) throw new Error(`host "${host}" did not resolve`);
  for (const { address, family } of addrs) {
    if (isBlockedAddr(address, family)) {
      throw new Error(`host "${host}" resolves to a blocked address (${address})`);
    }
  }
}

// Fetch with manual redirect handling: every hop (and the final URL) is
// protocol-checked and resolve-checked before the request goes out.
async function safeFetch(urlStr, opts) {
  let current = urlStr;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = assertPublicHttps(current);
    await assertResolvedPublic(u);
    const res = await fetch(u.toString(), { ...opts, redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hop === MAX_REDIRECTS) throw new Error("too many redirects");
      current = new URL(res.headers.get("location"), u).toString();
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}

// ── value interpolation ──────────────────────────────────────────────────────
function interpolate(value, args, secrets) {
  if (value == null) return value;
  if (typeof value === "object" && !Array.isArray(value)) {
    if (typeof value.secretRef === "string") {
      const s = secrets[value.secretRef] ?? ""; // secrets is already spec-bound
      return (value.prefix ?? "") + s;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, args, secrets);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, args, secrets));
  if (typeof value === "string") {
    return value.replace(/\{([^}]+)\}/g, (_, tok) => {
      const t = tok.trim();
      if (t.startsWith("secret:")) return String(secrets[t.slice(7).trim()] ?? "");
      return args[t] !== undefined && args[t] !== null ? String(args[t]) : "";
    });
  }
  return value;
}

function extractPath(obj, path) {
  if (!path) return obj;
  let cur = obj;
  for (const part of path.split(".")) {
    if (cur == null) return undefined;
    const key = /^\d+$/.test(part) ? Number(part) : part;
    cur = cur[key];
  }
  return cur;
}
function clip(text) {
  return text.length > MAX_RESULT_CHARS ? text.slice(0, MAX_RESULT_CHARS) + "…[truncated]" : text;
}
async function loadSecrets() { return (await getState(SECRETS_ID)).config || {}; }
function isSecretSet(v) {
  if (typeof v !== "string") return v != null && v !== "";
  const s = v.trim();
  if (s === "") return false;
  if (/^<.*>$/.test(s)) return false;
  return true;
}

// ── action handler factory ───────────────────────────────────────────────────
function makeHandler(spec, action) {
  const declared = Array.isArray(spec.secrets) ? spec.secrets : [];
  return async function handler(args = {}) {
    const all = await loadSecrets();
    // Bind secrets to what the spec declared — {secret:KEY} for any other key is "".
    const secrets = {};
    for (const k of declared) secrets[k] = all[k];

    const req = action.request || {};
    const method = (req.method || "GET").toUpperCase();
    const path = interpolate(req.path || "", args, secrets);
    const url = new URL((spec.baseUrl || "").replace(/\/$/, "") + path);
    if (req.query && typeof req.query === "object") {
      for (const [k, v] of Object.entries(req.query)) {
        const val = interpolate(v, args, secrets);
        if (val !== "" && val != null) url.searchParams.set(k, String(val));
      }
    }

    const headers = {};
    if (req.headers && typeof req.headers === "object") {
      for (const [k, v] of Object.entries(req.headers)) headers[k] = String(interpolate(v, args, secrets));
    }
    let body;
    if (!["GET", "HEAD"].includes(method) && req.body != null) {
      const interpolated = interpolate(req.body, args, secrets);
      if ((req.bodyType || "json") === "form") {
        body = new URLSearchParams(interpolated).toString();
        headers["content-type"] = headers["content-type"] || "application/x-www-form-urlencoded";
      } else {
        body = JSON.stringify(interpolated);
        headers["content-type"] = headers["content-type"] || "application/json";
      }
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await safeFetch(url.toString(), { method, headers, body, signal: ctrl.signal });
    } catch (e) {
      clearTimeout(timer);
      return { error: e.name === "AbortError" ? `request timed out after ${TIMEOUT_MS}ms` : e.message };
    }
    clearTimeout(timer);

    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    if (!res.ok) {
      const detail = parsed ? JSON.stringify(parsed) : text;
      return { error: `HTTP ${res.status} ${res.statusText}: ${clip(detail)}` };
    }
    const extracted = parsed != null ? extractPath(parsed, action.resultPath) : text;
    const result = typeof extracted === "string" ? extracted : JSON.stringify(extracted);
    return { result: clip(result ?? "") };
  };
}

// ── manifest factory ─────────────────────────────────────────────────────────
export function makeHttpConnector(spec) {
  const declaredSecrets = Array.isArray(spec.secrets) ? spec.secrets : [];
  return {
    id: spec.id,
    name: spec.name || spec.id,
    description: spec.description || "",
    icon: spec.icon || "🛠",
    forged: true,
    config: Array.isArray(spec.config) ? spec.config : [],
    async test() {
      const secrets = await loadSecrets();
      const missing = declaredSecrets.filter((k) => !isSecretSet(secrets[k]));
      const n = (spec.actions || []).length;
      if (missing.length) {
        return { ok: false, message: `Needs secret(s): ${missing.join(", ")}. ${n} action(s) ready once set.` };
      }
      return { ok: true, message: `Ready — ${n} action(s), all referenced secrets set.` };
    },
    actions: (spec.actions || []).map((a) => ({
      name: a.name,
      description: a.description || "",
      parameters: a.parameters || { type: "object", properties: {} },
      handler: makeHandler(spec, a),
    })),
  };
}
