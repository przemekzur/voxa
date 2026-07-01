// Spotify — control playback and browse your library via the Spotify Web API.
//
// Auth is OAuth 2.0 Authorization Code + PKCE (browser login, loopback redirect,
// no client secret) — see lib/spotify-auth.mjs. The only thing the user supplies
// is a public Client ID (config field) from a free app at developer.spotify.com.
//
// NOTE: playback CONTROL (play/pause/skip/volume/transfer/queue) requires Spotify
// Premium and an already-active device. Search, library, playlists and
// "now playing" reads work on free accounts too.
import { openInBrowser } from "../../lib/open-browser.mjs";
import {
  getBearer, forceRefresh, isAuthed, logout,
  startLogin, loginStatus, REDIRECT_URI,
} from "../../lib/spotify-auth.mjs";
import * as player from "../../lib/spotify-player.mjs";

const API = "https://api.spotify.com/v1";

const ok = (v) => ({ result: typeof v === "string" ? v : JSON.stringify(v) });
const err = (m) => ({ error: m });

// One Spotify Web API call with a single auth-refresh retry on 401.
// Returns parsed JSON, or null for 204 (playback controls answer No Content).
async function api(cfg, method, path, { query, body } = {}) {
  const clientId = cfg?.client_id;
  let bearer = await getBearer(clientId);
  if (!bearer) throw new Error("not signed in — run spotify_login");

  const url = API + path + (query ? "?" + new URLSearchParams(query).toString() : "");
  const send = (tok) => fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${tok}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });

  let res = await send(bearer);
  if (res.status === 401) {
    const r = await forceRefresh(clientId);
    if (!r) throw new Error("session expired — run spotify_login");
    res = await send(r);
  }

  if (res.status === 204) return null;
  if (res.status === 404) throw new Error("no active Spotify device — open Spotify on a device first (spotify_devices to list).");
  if (res.status === 403) throw new Error("Spotify refused this (playback control needs Premium, or the action isn't allowed right now).");
  if (res.status === 429) throw new Error("rate-limited by Spotify — try again shortly.");

  const text = await res.text();
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { /* some control endpoints return non-JSON */ } }
  if (!res.ok) throw new Error(json?.error?.message || text || `Spotify HTTP ${res.status}`);
  return json;
}

// --- formatting helpers (keep results short + speakable) -------------------
const artistsOf = (t) => (t.artists || []).map((a) => a.name).join(", ");
const trackLine = (t) => `${t.name} — ${artistsOf(t)}`;

async function resolveTrackUri(cfg, query) {
  const r = await api(cfg, "GET", "/search", { query: { q: query, type: "track", limit: "1" } });
  const t = r?.tracks?.items?.[0];
  if (!t) throw new Error(`no track found for "${query}"`);
  return { uri: t.uri, label: trackLine(t) };
}

// Resolve the in-Voxa player device (only). Playback NEVER auto-targets other
// devices (TV/phone) — that requires an explicit `device` name. Returns null if
// the Voxa device isn't present.
async function voxaDevice(cfg) {
  const r = await api(cfg, "GET", "/me/player/devices");
  const name = (cfg?.player_name || "Voxa").toLowerCase();
  return (r?.devices || []).find((d) => d.name?.toLowerCase() === name) || null;
}

// Resolve a device by explicit name (case-insensitive). For when the user names
// a non-Voxa device, e.g. "play on the TV". Returns the device or null.
async function namedDevice(cfg, name) {
  const r = await api(cfg, "GET", "/me/player/devices");
  const q = String(name).toLowerCase();
  const ds = r?.devices || [];
  return ds.find((d) => d.name?.toLowerCase() === q) || ds.find((d) => d.name?.toLowerCase().includes(q)) || null;
}

// Which device control commands (pause / volume / skip) should target. Default to
// the in-Voxa player so they hit the SAME device spotify_play uses. Without an
// explicit device_id, Spotify routes these to its "active device" — often a phone
// or TV — so they silently miss the music actually playing on this machine (the
// classic "volume/pause does nothing" bug). Returns null if Voxa isn't found, so
// callers fall back to the old active-device behaviour.
async function controlTargetId(cfg) {
  const dev = await voxaDevice(cfg).catch(() => null);
  return dev?.id || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Make the in-Voxa player available so voice "play X" works without a separate
// "start the player" step: if the Voxa device isn't listed and librespot isn't
// running, start it (silent once credentials are cached) and wait for it to
// register as a Spotify device. Best-effort — the caller falls back to whatever
// device exists if this can't bring Voxa up.
async function ensurePlayer(cfg) {
  const name = (cfg?.player_name || "Voxa").toLowerCase();
  const voxaListed = async () => {
    const r = await api(cfg, "GET", "/me/player/devices").catch(() => null);
    return (r?.devices || []).some((d) => d.name?.toLowerCase() === name);
  };
  if (await voxaListed()) return true;
  if (!player.isRunning()) {
    const s = await player.start({ binary: cfg?.librespot_path, name: cfg?.player_name });
    if (!s.ok) return false;
  }
  for (let i = 0; i < 8; i++) { await sleep(1500); if (await voxaListed()) return true; }
  return false;
}

export default {
  id: "spotify",
  name: "Spotify",
  description: "Control Spotify playback and browse your library — search, play/pause/skip, volume, now-playing, devices, playlists.",
  icon: "🎧",

  config: [
    {
      key: "client_id",
      label: "Spotify Client ID",
      type: "text",
      required: true,
      help: `Public Client ID from a free app at developer.spotify.com/dashboard. Add redirect URL ${REDIRECT_URI} to that app. Not a secret (PKCE = no client secret).`,
    },
    {
      key: "player_name",
      label: "In-Voxa player name",
      type: "text",
      default: "Voxa",
      help: "Device name librespot registers so audio plays from this machine. spotify_play targets it by default.",
    },
    {
      key: "librespot_path",
      label: "librespot path (optional)",
      type: "text",
      help: "Path to the librespot executable. Leave blank to auto-detect (~/.cargo/bin or PATH).",
    },
  ],

  async test(cfg) {
    if (!cfg?.client_id) return { ok: false, message: "Set the Spotify Client ID, then Save." };
    const a = await isAuthed(cfg.client_id);
    if (a === "active" || a === "refreshable") {
      try {
        const me = await api(cfg, "GET", "/me");
        return { ok: true, message: `Signed in as ${me?.display_name || me?.id || "user"}.` };
      } catch (e) { return { ok: false, message: e.message }; }
    }
    return { ok: true, message: "Client ID set. Run spotify_login to connect." };
  },

  actions: [
    {
      name: "spotify_login",
      description: "Sign in to Spotify via the browser (OAuth PKCE). Opens the consent page; tell the user to approve it and that you'll be connected within a few seconds. Use when actions say 'not signed in'.",
      parameters: { type: "object", properties: {} },
      handler: async (_a, cfg) => {
        try {
          const d = await startLogin(openInBrowser, cfg?.client_id);
          return ok(`Opened Spotify's approval page (redirect ${d.redirectUri}). Approve there and I'll be signed in within a few seconds — it auto-refreshes after that.`);
        } catch (e) { return err(e.message); }
      },
    },
    {
      name: "spotify_auth_status",
      description: "Check Spotify sign-in status.",
      parameters: { type: "object", properties: {} },
      handler: async (_a, cfg) => {
        const p = loginStatus();
        if (p?.pending) return ok("Waiting for browser approval…");
        if (p?.error) return ok(`Last login failed: ${p.error}. Run spotify_login again.`);
        const a = await isAuthed(cfg?.client_id);
        const msg = {
          "no-client": "No Client ID set — add it in the connector config first.",
          active: "Signed in (token valid).",
          refreshable: "Signed in (will auto-refresh).",
          none: "Not signed in — run spotify_login.",
        };
        return ok(msg[a] || a);
      },
    },
    {
      name: "spotify_logout",
      description: "Sign out of Spotify (clears stored tokens).",
      parameters: { type: "object", properties: {} },
      handler: async () => { await logout(); return ok("Signed out of Spotify."); },
    },

    {
      name: "spotify_player_start",
      description: "Start the in-Voxa Spotify player (librespot) so music plays from THIS machine instead of a phone/TV. First run opens a browser to approve (one time); afterwards it's silent and spotify_play targets it automatically. Requires Premium.",
      parameters: { type: "object", properties: {} },
      handler: async (_a, cfg) => {
        try {
          const r = await player.start({ binary: cfg?.librespot_path, name: cfg?.player_name });
          return r.ok ? ok(r.message) : err(r.message);
        } catch (e) { return err(e.message); }
      },
    },
    {
      name: "spotify_player_stop",
      description: "Stop the in-Voxa Spotify player (librespot).",
      parameters: { type: "object", properties: {} },
      handler: async () => { try { return ok(player.stop().message); } catch (e) { return err(e.message); } },
    },
    {
      name: "spotify_player_status",
      description: "Whether the in-Voxa Spotify player (librespot) is running, with recent diagnostics.",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        const s = player.status();
        if (s.running) return ok(`Running as "${s.deviceName}" (pid ${s.pid}).`);
        return ok(`Not running.${s.lastError ? " Last error: " + s.lastError : ""}`);
      },
    },

    {
      name: "spotify_search",
      description: "Search Spotify's catalog for tracks, albums, artists, or playlists. Returns names and Spotify URIs you can pass to spotify_play.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free text, e.g. 'daft punk discovery'." },
          type: { type: "string", description: "One of: track, album, artist, playlist. Default track." },
          limit: { type: "number", description: "Max results (1-20). Default 5." },
        },
        required: ["query"],
      },
      handler: async (a, cfg) => {
        try {
          const type = ["track", "album", "artist", "playlist"].includes(a.type) ? a.type : "track";
          const limit = String(Math.min(Math.max(Number(a.limit) || 5, 1), 20));
          const r = await api(cfg, "GET", "/search", { query: { q: a.query, type, limit } });
          const items = (r?.[`${type}s`]?.items || []).filter(Boolean);
          if (!items.length) return ok(`No ${type} results for "${a.query}".`);
          const lines = items.map((it) => {
            if (type === "track") return `${trackLine(it)}  [${it.uri}]`;
            if (type === "album") return `${it.name} — ${artistsOf(it)}  [${it.uri}]`;
            return `${it.name}  [${it.uri}]`;
          });
          return ok(lines.join("\n"));
        } catch (e) { return err(e.message); }
      },
    },
    {
      name: "spotify_now_playing",
      description: "What's currently playing on the user's Spotify (track, artist, and whether it's paused).",
      parameters: { type: "object", properties: {} },
      handler: async (_a, cfg) => {
        try {
          const r = await api(cfg, "GET", "/me/player");
          if (!r || !r.item) return ok("Nothing is playing right now.");
          const state = r.is_playing ? "Playing" : "Paused";
          const dev = r.device?.name ? ` on ${r.device.name}` : "";
          return ok(`${state}${dev}: ${trackLine(r.item)}`);
        } catch (e) { return err(e.message); }
      },
    },
    {
      name: "spotify_play",
      description: "Start or resume playback through the in-Voxa player (audio from THIS machine). Pass `query` to search and play the top track, or a `uri` (spotify:track:/album:/playlist:). No args resumes the current track. By default it plays ONLY on Voxa (auto-starting it) and never on the TV/phone — pass `device` ONLY if the user explicitly names another device. Requires Premium.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text to search; the top track is played." },
          uri: { type: "string", description: "A Spotify URI to play (track, album, artist, or playlist)." },
          device: { type: "string", description: "Explicit device name to play on (e.g. 'TV'). OMIT to use the in-Voxa player — only set this when the user explicitly names a device." },
        },
      },
      handler: async (a, cfg) => {
        try {
          let body, label = "playback";
          if (a?.uri) {
            body = a.uri.includes(":track:") ? { uris: [a.uri] } : { context_uri: a.uri };
            label = a.uri;
          } else if (a?.query) {
            const t = await resolveTrackUri(cfg, a.query);
            body = { uris: [t.uri] };
            label = t.label;
          }
          // Default: the in-Voxa player ONLY (auto-started). Never fall back to
          // other devices — an external device must be named explicitly.
          let dev;
          if (a?.device) {
            dev = await namedDevice(cfg, a.device);
            if (!dev) return err(`no device named "${a.device}" — run spotify_devices to see what's available.`);
          } else {
            await ensurePlayer(cfg);
            dev = await voxaDevice(cfg);
            if (!dev) return err("the in-Voxa player isn't available yet — try again in a moment, or run spotify_player_start. (I won't play on the TV/phone unless you name it.)");
          }
          await api(cfg, "PUT", "/me/player/play", { query: { device_id: dev.id }, ...(body ? { body } : {}) });
          // Cold/idle Connect devices often load the track but stay paused on the
          // first transfer; a second bare play nudges it (no-op if already playing).
          if (!dev.active) {
            await api(cfg, "PUT", "/me/player/play", { query: { device_id: dev.id } }).catch(() => {});
          }
          const what = a?.query || a?.uri ? `Playing ${label}` : "Resumed playback";
          return ok(`${what} on ${dev.name}.`);
        } catch (e) { return err(e.message); }
      },
    },
    {
      name: "spotify_pause",
      description: "Pause Spotify playback. Requires Premium.",
      parameters: { type: "object", properties: {} },
      handler: async (_a, cfg) => {
        try {
          const id = await controlTargetId(cfg);
          await api(cfg, "PUT", "/me/player/pause", id ? { query: { device_id: id } } : {});
          return ok("Paused.");
        } catch (e) { return err(e.message); }
      },
    },
    {
      name: "spotify_next",
      description: "Skip to the next track. Requires Premium.",
      parameters: { type: "object", properties: {} },
      handler: async (_a, cfg) => {
        try {
          const id = await controlTargetId(cfg);
          await api(cfg, "POST", "/me/player/next", id ? { query: { device_id: id } } : {});
          return ok("Skipped to next track.");
        } catch (e) { return err(e.message); }
      },
    },
    {
      name: "spotify_previous",
      description: "Go back to the previous track. Requires Premium.",
      parameters: { type: "object", properties: {} },
      handler: async (_a, cfg) => {
        try {
          const id = await controlTargetId(cfg);
          await api(cfg, "POST", "/me/player/previous", id ? { query: { device_id: id } } : {});
          return ok("Went to previous track.");
        } catch (e) { return err(e.message); }
      },
    },
    {
      name: "spotify_set_volume",
      description: "Set playback volume as a percentage 0-100. Requires Premium.",
      parameters: {
        type: "object",
        properties: { percent: { type: "number", description: "Volume 0-100." } },
        required: ["percent"],
      },
      handler: async (a, cfg) => {
        try {
          const v = Math.min(Math.max(Math.round(Number(a.percent)), 0), 100);
          const id = await controlTargetId(cfg);
          await api(cfg, "PUT", "/me/player/volume", { query: { volume_percent: String(v), ...(id ? { device_id: id } : {}) } });
          return ok(`Volume set to ${v}%.`);
        } catch (e) { return err(e.message); }
      },
    },
    {
      name: "spotify_queue",
      description: "Add a track to the playback queue. Pass `query` to search the top track, or a `uri`. Requires Premium.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text to search; top track is queued." },
          uri: { type: "string", description: "A spotify:track:… URI." },
        },
      },
      handler: async (a, cfg) => {
        try {
          let uri = a?.uri, label = a?.uri;
          if (!uri && a?.query) { const t = await resolveTrackUri(cfg, a.query); uri = t.uri; label = t.label; }
          if (!uri) return err("provide a query or a track uri");
          await ensurePlayer(cfg);
          const dev = await voxaDevice(cfg);
          if (!dev) return err("the in-Voxa player isn't available yet — try again, or run spotify_player_start.");
          await api(cfg, "POST", "/me/player/queue", { query: { uri, device_id: dev.id } });
          return ok(`Queued ${label} on ${dev.name}.`);
        } catch (e) { return err(e.message); }
      },
    },
    {
      name: "spotify_devices",
      description: "List the user's available Spotify Connect devices (and which is active). Use this when playback fails with 'no active device'.",
      parameters: { type: "object", properties: {} },
      handler: async (_a, cfg) => {
        try {
          const r = await api(cfg, "GET", "/me/player/devices");
          const ds = r?.devices || [];
          if (!ds.length) return ok("No devices found — open Spotify on a phone, desktop, or speaker.");
          return ok(ds.map((d) => `${d.active ? "▶ " : "  "}${d.name} (${d.type}) [${d.id}]`).join("\n"));
        } catch (e) { return err(e.message); }
      },
    },
    {
      name: "spotify_transfer",
      description: "Transfer playback to a specific device (get its id from spotify_devices). Requires Premium.",
      parameters: {
        type: "object",
        properties: {
          device_id: { type: "string", description: "Device id from spotify_devices." },
          play: { type: "boolean", description: "Start playing on transfer. Default true." },
        },
        required: ["device_id"],
      },
      handler: async (a, cfg) => {
        try {
          await api(cfg, "PUT", "/me/player", { body: { device_ids: [a.device_id], play: a.play !== false } });
          return ok("Transferred playback.");
        } catch (e) { return err(e.message); }
      },
    },
    {
      name: "spotify_my_playlists",
      description: "List the signed-in user's playlists (names + ids/URIs).",
      parameters: { type: "object", properties: { limit: { type: "number", description: "Max (1-50). Default 20." } } },
      handler: async (a, cfg) => {
        try {
          const limit = String(Math.min(Math.max(Number(a?.limit) || 20, 1), 50));
          const r = await api(cfg, "GET", "/me/playlists", { query: { limit } });
          const items = r?.items || [];
          if (!items.length) return ok("No playlists found.");
          return ok(items.map((p) => `${p.name} (${p.tracks?.total ?? "?"} tracks)  [${p.uri}]`).join("\n"));
        } catch (e) { return err(e.message); }
      },
    },
    {
      name: "spotify_playlist_tracks",
      description: "List the tracks in a playlist by its id.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Playlist id (the part after spotify:playlist:)." },
          limit: { type: "number", description: "Max (1-50). Default 20." },
        },
        required: ["id"],
      },
      handler: async (a, cfg) => {
        try {
          const id = String(a.id).replace(/^spotify:playlist:/, "");
          const limit = String(Math.min(Math.max(Number(a?.limit) || 20, 1), 50));
          const r = await api(cfg, "GET", `/playlists/${id}/tracks`, { query: { limit } });
          const items = (r?.items || []).map((it) => it.track).filter(Boolean);
          if (!items.length) return ok("That playlist has no tracks (or wasn't found).");
          return ok(items.map(trackLine).join("\n"));
        } catch (e) { return err(e.message); }
      },
    },
  ],
};
