// X (Twitter) user auth — OAuth 2.0 Authorization Code + PKCE (RFC 7636 / 8252).
//
// Why not a device flow (like vibeengine-auth)? X does NOT implement the OAuth 2.0
// Device Authorization Grant. The only supported user-context flow is Authorization
// Code with PKCE and a redirect URI. For a local desktop app that means a loopback
// redirect: we open the browser, spin a one-shot http listener on 127.0.0.1, catch
// the ?code, and exchange it. Same "click approve in the browser" UX, correct grant.
//
// Prerequisite the user must do once (interactive, can't be automated):
//   1. Create a free X developer account + an OAuth 2.0 app at developer.x.com.
//   2. Set the app type to "Native/Public client" (PKCE, no secret) — or a
//      confidential client if you also set x_client_secret below.
//   3. Add this exact redirect URL to the app:  http://127.0.0.1:8723/callback
//   4. Store the app's Client ID as the harness secret `x_client_id`
//      (PUT /api/secrets/x_client_id, or via the xcom_login action's error hint).
//
// Tokens are stored in the same __secrets store as everything else and refreshed
// automatically. NOTE: reading/posting via the X API is metered pay-per-use as of
// Feb 2026 — auth being valid does not make calls free.
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { getState, setState, unsetConfigKey } from "./store.mjs";

const AUTHORIZE = "https://twitter.com/i/oauth2/authorize";
const TOKEN = "https://api.twitter.com/2/oauth2/token";
const SCOPE = "tweet.read tweet.write users.read offline.access";
const REDIRECT_PORT = 8723;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const SECRETS = "__secrets";

const K_CLIENT = "x_client_id";
const K_SECRET = "x_client_secret"; // optional — only for confidential clients
const K_ACCESS = "x_access_token";
const K_REFRESH = "x_refresh_token";
const K_EXP = "x_token_expiry"; // ms-epoch string

let flow = null; // background login state: { server, done, ok, error, verifier, state }

async function secrets() { return (await getState(SECRETS)).config || {}; }

async function saveTokens(t) {
  const cfg = {};
  if (t.access_token) cfg[K_ACCESS] = t.access_token;
  if (t.refresh_token) cfg[K_REFRESH] = t.refresh_token;
  if (t.expires_in) cfg[K_EXP] = String(Date.now() + (Number(t.expires_in) - 60) * 1000); // 60s skew
  await setState(SECRETS, { enabled: true, config: cfg });
}

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Build the auth header / body bits for the chosen client style.
function clientAuth(s) {
  const clientId = s[K_CLIENT];
  const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (s[K_SECRET]) {
    // Confidential client → HTTP Basic auth, client_id stays out of the body.
    headers.authorization = "Basic " + Buffer.from(`${clientId}:${s[K_SECRET]}`).toString("base64");
    return { headers, clientIdInBody: false };
  }
  return { headers, clientIdInBody: true }; // public client (PKCE)
}

async function exchange(grantParams) {
  const s = await secrets();
  const { headers, clientIdInBody } = clientAuth(s);
  const body = new URLSearchParams(grantParams);
  if (clientIdInBody) body.set("client_id", s[K_CLIENT]);
  const res = await fetch(TOKEN, { method: "POST", headers, body: body.toString() });
  const t = await res.json().catch(() => ({}));
  if (!res.ok || !t.access_token) {
    throw new Error(t.error_description || t.error || `token endpoint HTTP ${res.status}`);
  }
  await saveTokens(t);
  return t.access_token;
}

async function refresh() {
  const rt = (await secrets())[K_REFRESH];
  if (!rt) return null;
  try {
    return await exchange({ grant_type: "refresh_token", refresh_token: rt });
  } catch {
    return null;
  }
}
export { refresh as forceRefresh };

// A usable user access token, or null. Refreshes an expired token automatically.
export async function getBearer() {
  const s = await secrets();
  const exp = Number(s[K_EXP] || 0);
  if (s[K_ACCESS] && (!exp || Date.now() < exp)) return s[K_ACCESS];
  if (s[K_REFRESH]) { const r = await refresh(); if (r) return r; }
  return null;
}

export async function isAuthed() {
  const s = await secrets();
  if (!s[K_CLIENT]) return "no-client"; // app not registered yet
  const exp = Number(s[K_EXP] || 0);
  if (s[K_ACCESS] && (!exp || Date.now() < exp)) return "active";
  if (s[K_REFRESH]) return "refreshable";
  return "none";
}

export async function logout() {
  for (const k of [K_ACCESS, K_REFRESH, K_EXP]) await unsetConfigKey(SECRETS, k);
  if (flow?.server) { try { flow.server.close(); } catch {} }
  flow = null;
}

export function loginStatus() {
  return flow ? { pending: !flow.done, ok: !!flow.ok, error: flow.error } : null;
}

// Start the PKCE login. openUrl(url) opens the consent page. Returns the auth URL
// immediately; the loopback listener + token exchange complete in the background.
export async function startLogin(openUrl) {
  const s = await secrets();
  if (!s[K_CLIENT]) {
    throw new Error(
      `No X app registered. Create an OAuth 2.0 app at developer.x.com (Native/Public client), ` +
      `add redirect URL ${REDIRECT_URI}, then store its Client ID: ` +
      `PUT http://127.0.0.1:<harness-port>/api/secrets/x_client_id  body {"value":"<client id>"}.`
    );
  }

  // PKCE pair + CSRF state.
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));

  // Tear down any prior in-flight attempt.
  if (flow?.server) { try { flow.server.close(); } catch {} }
  flow = { done: false, ok: false, error: null, verifier, state };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }
      const code = url.searchParams.get("code");
      const gotState = url.searchParams.get("state");
      const oauthErr = url.searchParams.get("error");
      const reply = (msg) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><meta charset=utf-8><body style="font:16px system-ui;padding:3rem;text-align:center">${msg}<p>You can close this tab.</p></body>`);
      };
      if (oauthErr) { flow.error = oauthErr; flow.done = true; reply("X login failed."); server.close(); return; }
      if (!code || gotState !== flow.state) { flow.error = "state_mismatch"; flow.done = true; reply("X login failed (state mismatch)."); server.close(); return; }
      await exchange({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: flow.verifier });
      flow.ok = true; flow.done = true;
      reply("✅ Signed in to X. Voxa is connected.");
    } catch (e) {
      flow.error = e?.message || String(e); flow.done = true;
      try { res.writeHead(200, { "content-type": "text/html" }).end(`<body style="font:16px system-ui;padding:3rem;text-align:center">X login failed: ${flow.error}</body>`); } catch {}
    } finally {
      try { server.close(); } catch {}
    }
  });

  server.on("error", (e) => { flow.error = `loopback listener: ${e.message}`; flow.done = true; });
  await new Promise((resolve) => server.listen(REDIRECT_PORT, "127.0.0.1", resolve));
  flow.server = server;
  // Safety: stop waiting after 5 minutes.
  setTimeout(() => { if (flow && !flow.done) { flow.error = "expired"; flow.done = true; try { server.close(); } catch {} } }, 300_000).unref?.();

  const authUrl = `${AUTHORIZE}?` + new URLSearchParams({
    response_type: "code",
    client_id: s[K_CLIENT],
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  if (openUrl) { try { openUrl(authUrl); } catch { /* non-fatal */ } }
  return { authUrl, redirectUri: REDIRECT_URI };
}
