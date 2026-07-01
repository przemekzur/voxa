// Spotify user auth — OAuth 2.0 Authorization Code + PKCE (RFC 7636 / 8252).
//
// Why PKCE + loopback (like xcom-auth, not the vibeengine device flow)? Spotify
// does NOT implement the OAuth 2.0 Device Authorization Grant. Its only supported
// user-context flow for a public client is Authorization Code with PKCE and a
// redirect URI. For a local desktop app that means a loopback redirect: open the
// browser, spin a one-shot http listener on 127.0.0.1, catch the ?code, exchange
// it. "Click approve in the browser" UX, no client secret anywhere.
//
// Prerequisite the user must do once (interactive, can't be automated):
//   1. Create a free app at https://developer.spotify.com/dashboard.
//   2. Add this exact redirect URL to the app:  http://127.0.0.1:8724/callback
//      (Spotify rejects `localhost` as of Nov 2025 — use the 127.0.0.1 literal.)
//   3. Copy the app's Client ID into the Spotify connector's config (it's a public
//      identifier, NOT a secret — PKCE means there is no client secret to store).
//
// Only the user's own access/refresh tokens are sensitive; they live in the shared
// __secrets store and refresh automatically. Spotify scopes are requested up front.
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { getState, setState, unsetConfigKey } from "./store.mjs";

const AUTHORIZE = "https://accounts.spotify.com/authorize";
const TOKEN = "https://accounts.spotify.com/api/token";

// Full-control scopes: read playback state + currently playing, control playback,
// and read private playlists + saved library.
const SCOPE = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "playlist-read-private",
  "user-library-read",
  "streaming",         // required by librespot (the in-Voxa player)
  "user-read-email",   // streaming requires these two identity scopes
  "user-read-private",
].join(" ");

export const REDIRECT_PORT = 8724;
export const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const SECRETS = "__secrets";

const K_ACCESS = "spotify_access_token";
const K_REFRESH = "spotify_refresh_token";
const K_EXP = "spotify_token_expiry"; // ms-epoch string

let flow = null; // background login state: { server, done, ok, error, verifier, state }

async function secrets() { return (await getState(SECRETS)).config || {}; }

async function saveTokens(t) {
  const cfg = {};
  if (t.access_token) cfg[K_ACCESS] = t.access_token;
  // Spotify only returns a new refresh_token sometimes; merge semantics in the
  // store keep the existing one when this is absent.
  if (t.refresh_token) cfg[K_REFRESH] = t.refresh_token;
  if (t.expires_in) cfg[K_EXP] = String(Date.now() + (Number(t.expires_in) - 60) * 1000); // 60s skew
  await setState(SECRETS, { enabled: true, config: cfg });
}

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function exchange(clientId, grantParams) {
  const body = new URLSearchParams({ ...grantParams, client_id: clientId });
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
    signal: AbortSignal.timeout(15000),
  });
  const t = await res.json().catch(() => ({}));
  if (!res.ok || !t.access_token) {
    throw new Error(t.error_description || t.error || `token endpoint HTTP ${res.status}`);
  }
  await saveTokens(t);
  return t.access_token;
}

async function refresh(clientId) {
  const rt = (await secrets())[K_REFRESH];
  if (!rt || !clientId) return null;
  try {
    return await exchange(clientId, { grant_type: "refresh_token", refresh_token: rt });
  } catch {
    return null;
  }
}
export { refresh as forceRefresh };

// A usable user access token, or null. Refreshes an expired token automatically.
export async function getBearer(clientId) {
  const s = await secrets();
  const exp = Number(s[K_EXP] || 0);
  if (s[K_ACCESS] && (!exp || Date.now() < exp)) return s[K_ACCESS];
  if (s[K_REFRESH]) { const r = await refresh(clientId); if (r) return r; }
  return null;
}

export async function isAuthed(clientId) {
  if (!clientId) return "no-client"; // app not registered yet
  const s = await secrets();
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
export async function startLogin(openUrl, clientId) {
  if (!clientId) {
    throw new Error(
      `No Spotify Client ID set. Create a free app at https://developer.spotify.com/dashboard, ` +
      `add redirect URL ${REDIRECT_URI}, then paste its Client ID into the Spotify connector config.`
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
      if (oauthErr) { flow.error = oauthErr; flow.done = true; reply("Spotify login failed."); server.close(); return; }
      if (!code || gotState !== flow.state) { flow.error = "state_mismatch"; flow.done = true; reply("Spotify login failed (state mismatch)."); server.close(); return; }
      await exchange(clientId, { grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: flow.verifier });
      flow.ok = true; flow.done = true;
      reply("✅ Signed in to Spotify. Voxa is connected.");
    } catch (e) {
      flow.error = e?.message || String(e); flow.done = true;
      try { res.writeHead(200, { "content-type": "text/html" }).end(`<body style="font:16px system-ui;padding:3rem;text-align:center">Spotify login failed: ${flow.error}</body>`); } catch {}
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
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  if (openUrl) { try { openUrl(authUrl); } catch { /* non-fatal */ } }
  return { authUrl, redirectUri: REDIRECT_URI };
}
