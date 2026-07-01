// VibeEngine catalog — backed by the official VibeEngine MCP server.
//
// Uses https://vibeengine.live/mcp (Streamable HTTP, stateless) instead of
// reverse-engineered REST routes. Auth is `Authorization: Bearer <token>` — the
// better-auth session token, stored as the harness secret `vibeengine_token`
// (never embedded). Public tools (search/albums/vibes) work without it; playlists
// and likes require it.
//
// NOTE: the MCP's get_stream_url tool currently returns "Route not found", so
// playback (vibeplay) still sources stream URLs from REST until that's fixed.
import { openInBrowser } from "../../lib/open-browser.mjs";
import { mcpCall } from "../../lib/mcp-client.mjs";
import { getBearer, forceRefresh, startDeviceLogin, loginStatus, isAuthed, logout } from "../../lib/vibeengine-auth.mjs";

const MCP = "https://vibeengine.live/mcp";

// One MCP call, with a single auth-refresh retry on an auth error.
async function call(name, args) {
  try {
    return await mcpCall(MCP, name, args, { bearer: await getBearer() });
  } catch (e) {
    if (/auth/i.test(e.message)) {
      const r = await forceRefresh();
      if (r) return mcpCall(MCP, name, args, { bearer: r });
      throw new Error("not signed in — run vibeengine_login");
    }
    throw e;
  }
}
const ok = (v) => ({ result: typeof v === "string" ? v : JSON.stringify(v) });
const err = (m) => ({ error: m });

export default {
  id: "vibeengine",
  name: "VibeEngine (MCP)",
  description: "Browse the VibeEngine music catalog via its official MCP — search, tracks, albums, playlists, vibes.",
  icon: "🎵",
  config: [],

  async test() {
    try {
      await call("search_tracks", { query: "the", limit: 1 });
      const auth = await isAuthed();
      return { ok: true, message: `MCP reachable. Auth: ${auth} (run vibeengine_login for full access).` };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  },

  actions: [
    {
      name: "vibeengine_login",
      description: "Sign in to VibeEngine via the browser (OAuth device flow). Opens the approval page; tell the user the code and that you'll be connected once they approve. Use when playlists/account actions say 'not signed in'.",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        try {
          const d = await startDeviceLogin(openInBrowser);
          return ok(`Opened ${d.verificationUri} to approve — code ${d.userCode}. Approve there and I'll be signed in within a few seconds (it auto-renews after that).`);
        } catch (e) { return err(e.message); }
      },
    },
    {
      name: "vibeengine_auth_status",
      description: "Check VibeEngine sign-in status.",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        const a = await isAuthed();
        const p = loginStatus();
        if (p?.pending) return ok(`Waiting for approval (code ${p.userCode}).`);
        if (p?.error) return ok(`Last login failed: ${p.error}. Run vibeengine_login again.`);
        const msg = { active: "Signed in (token valid).", refreshable: "Signed in (will auto-refresh).", "legacy-token": "Using a hand-set token (consider vibeengine_login).", none: "Not signed in — run vibeengine_login." };
        return ok(msg[a] || a);
      },
    },
    {
      name: "vibeengine_logout",
      description: "Sign out of VibeEngine (clears stored tokens).",
      parameters: { type: "object", properties: {} },
      handler: async () => { await logout(); return ok("Signed out."); },
    },
    {
      name: "vibeengine_search",
      description: "Search the VibeEngine catalog by text and/or a vibe/genre tag.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Title/artist text." },
          vibe: { type: "string", description: "A vibe/genre/mood tag (see vibeengine_vibes)." },
          limit: { type: "number", description: "Max results." },
        },
      },
      handler: async (a) => {
        if (!a?.query && !a?.vibe) return err("provide a query and/or vibe");
        try { return ok(await call("search_tracks", { query: a.query, vibe: a.vibe, limit: a.limit })); }
        catch (e) { return err(e.message); }
      },
    },
    {
      name: "vibeengine_vibes",
      description: "List the available vibe/genre/mood tags in the catalog.",
      parameters: { type: "object", properties: {} },
      handler: async () => { try { return ok(await call("list_vibes", {})); } catch (e) { return err(e.message); } },
    },
    {
      name: "vibeengine_track",
      description: "Get full details for a single track by id.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      handler: async (a) => { try { return ok(await call("get_track", { id: a.id })); } catch (e) { return err(e.message); } },
    },
    {
      name: "vibeengine_albums",
      description: "List albums in the catalog.",
      parameters: { type: "object", properties: { limit: { type: "number" } } },
      handler: async (a) => { try { return ok(await call("list_albums", { limit: a?.limit })); } catch (e) { return err(e.message); } },
    },
    {
      name: "vibeengine_album",
      description: "Get an album and its tracks by slug.",
      parameters: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"] },
      handler: async (a) => { try { return ok(await call("get_album", { slug: a.slug })); } catch (e) { return err(e.message); } },
    },
    {
      name: "vibeengine_my_playlists",
      description: "List the signed-in user's playlists (requires auth).",
      parameters: { type: "object", properties: {} },
      handler: async () => { try { return ok(await call("get_my_playlists", {})); } catch (e) { return err(e.message); } },
    },
    {
      name: "vibeengine_playlist",
      description: "Get a playlist and its tracks by id.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      handler: async (a) => { try { return ok(await call("get_playlist", { id: a.id })); } catch (e) { return err(e.message); } },
    },
  ],
};
