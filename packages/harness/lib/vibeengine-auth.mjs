// VibeEngine MCP auth — OAuth 2.0 Device Authorization Grant + token refresh.
//
// Replaces the brittle hand-pasted weekly session token with a proper login:
//  1. startDeviceLogin() requests a device code, opens the approval page, and
//     polls in the background until the user approves.
//  2. On approval we store access_token + refresh_token (offline_access) in the
//     harness secrets store.
//  3. getBearer() returns a valid access token, refreshing automatically when it
//     expires. On hard failure it falls back to a legacy hand-set token if present.
//
// Endpoints (verified): device/code, device/token, oauth2/token (refresh).
import { getState, setState, unsetConfigKey } from "./store.mjs";

const AUTH = "https://vibeengine.live/api/auth";
const CLIENT_ID = "voxa";
const SCOPE = "openid profile offline_access";
const SECRETS = "__secrets";

const K_ACCESS = "vibeengine_access_token";
const K_REFRESH = "vibeengine_refresh_token";
const K_EXP = "vibeengine_token_expiry";   // ms-epoch string
const K_LEGACY = "vibeengine_token";       // hand-pasted session token (fallback)

let poll = null; // background device-poll state

async function secrets() { return (await getState(SECRETS)).config || {}; }

async function saveTokens(t) {
  const cfg = {};
  if (t.access_token) cfg[K_ACCESS] = t.access_token;
  if (t.refresh_token) cfg[K_REFRESH] = t.refresh_token;
  if (t.expires_in) cfg[K_EXP] = String(Date.now() + (Number(t.expires_in) - 60) * 1000); // 60s skew
  await setState(SECRETS, { enabled: true, config: cfg });
}

async function postJson(path, body) {
  const res = await fetch(AUTH + path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => ({}));
}

async function refresh() {
  const rt = (await secrets())[K_REFRESH];
  if (!rt) return null;
  const t = await postJson("/oauth2/token", { grant_type: "refresh_token", refresh_token: rt, client_id: CLIENT_ID });
  if (t.access_token) { await saveTokens(t); return t.access_token; }
  return null;
}
export { refresh as forceRefresh };

// A usable bearer or null. Uses a live access token, refreshes an expired one,
// then falls back to a hand-set legacy token.
export async function getBearer() {
  const s = await secrets();
  const exp = Number(s[K_EXP] || 0);
  if (s[K_ACCESS] && (!exp || Date.now() < exp)) return s[K_ACCESS];
  if (s[K_REFRESH]) { const r = await refresh(); if (r) return r; }
  return s[K_LEGACY] || s[K_ACCESS] || null;
}

export async function isAuthed() {
  const s = await secrets();
  const exp = Number(s[K_EXP] || 0);
  if (s[K_ACCESS] && (!exp || Date.now() < exp)) return "active";
  if (s[K_REFRESH]) return "refreshable";
  if (s[K_LEGACY]) return "legacy-token";
  return "none";
}

export async function logout() {
  for (const k of [K_ACCESS, K_REFRESH, K_EXP]) await unsetConfigKey(SECRETS, k);
  if (poll?.timer) { clearTimeout(poll.timer); poll = null; }
}

export function loginStatus() {
  return poll ? { pending: !poll.done, ok: !!poll.ok, error: poll.error, userCode: poll.userCode } : null;
}

// Start the device flow. openUrl(url) is optional (opens the approval page).
// Returns the user code + URL immediately; polling continues in the background.
export async function startDeviceLogin(openUrl) {
  const d = await postJson("/device/code", { client_id: CLIENT_ID, scope: SCOPE });
  if (!d.device_code) throw new Error(d.error_description || d.message || "couldn't start device login");
  let interval = Math.max(2, Number(d.interval || 5));
  const deadline = Date.now() + Number(d.expires_in || 900) * 1000;
  if (poll?.timer) clearTimeout(poll.timer);
  poll = { done: false, userCode: d.user_code };
  if (openUrl && d.verification_uri_complete) { try { openUrl(d.verification_uri_complete); } catch { /* non-fatal */ } }

  const step = async () => {
    if (Date.now() > deadline) { Object.assign(poll, { done: true, error: "expired" }); return; }
    const t = await postJson("/device/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: d.device_code,
      client_id: CLIENT_ID,
    });
    if (t.access_token) { await saveTokens(t); Object.assign(poll, { done: true, ok: true }); return; }
    if (t.error === "slow_down") interval += 5;
    else if (t.error && t.error !== "authorization_pending") { Object.assign(poll, { done: true, error: t.error }); return; }
    poll.timer = setTimeout(step, interval * 1000);
  };
  poll.timer = setTimeout(step, interval * 1000);
  return { userCode: d.user_code, verificationUri: d.verification_uri, verificationUriComplete: d.verification_uri_complete, expiresIn: d.expires_in };
}
