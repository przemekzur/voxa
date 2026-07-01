// VibeEngine player — "play a song / album / playlist / vibe" by voice, IN the orb.
//
// Backed by the official VibeEngine MCP, authenticated via the shared OAuth login
// (lib/vibeengine-auth.mjs). Uses the newer playback tools where available:
//   - play_playlist(id)  -> a playlist's tracks IN ORDER, each with a ready URL
//   - play_album(slug)   -> an album's tracks IN ORDER, each with a ready URL
// (one call, no per-track get_stream_url fan-out). Songs + vibes still resolve via
// search_tracks -> get_stream_url since there's no single/vibe "play" tool.
//
// Each handler returns a PLAY DIRECTIVE — `{ speak, play:{ kind, title,
// tracks:[{url,title,artist}] } }`. The orb intercepts it and plays the audio
// itself (no browser tab); the model only sees `speak`. Playback is available
// only while this connector is enabled.
import { mcpCall } from "../../lib/mcp-client.mjs";
import { getBearer, forceRefresh } from "../../lib/vibeengine-auth.mjs";

const MCP = "https://vibeengine.live/mcp";
const PLAY_THRESHOLD = 60; // name-match confidence
const MAX_TRACKS = 60;     // cap tracks queued per request

// One MCP call with a single auth-refresh retry.
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

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function score(name, q) {
  const n = norm(name);
  if (!n || !q) return 0;
  if (n === q) return 100;
  if (n.startsWith(q)) return 85;
  if (n.includes(q)) return 70;
  const qt = q.split(" ").filter(Boolean);
  const nt = new Set(n.split(" "));
  const overlap = qt.filter((w) => nt.has(w)).length;
  if (overlap === qt.length && qt.length > 1) return 65;
  return overlap ? 10 * overlap : 0;
}

// play_album / play_playlist already return tracks WITH a signed streamUrl — just
// map to the orb's {url,title,artist} shape (capped). No extra calls.
function toPlayTracks(mcpTracks) {
  return (mcpTracks || [])
    .slice(0, MAX_TRACKS)
    .map((t) => ({ url: t.streamUrl || t.url, title: t.title, artist: t.artist }))
    .filter((t) => t.url);
}

// Resolve loose {id,title,artist} items into playable {url,title,artist} via
// get_stream_url (parallel) — for paths without a batch "play" tool (song, vibe).
async function toTracks(items) {
  const out = await Promise.all(
    items.slice(0, MAX_TRACKS).map((t) =>
      call("get_stream_url", { songId: t.id })
        .then((s) => ({ url: s.streamUrl, title: s.title || t.title, artist: s.artist || t.artist }))
        .catch(() => null),
    ),
  );
  return out.filter((t) => t && t.url);
}

const directive = (speak, kind, title, tracks) => ({ result: JSON.stringify({ speak, play: { kind, title, tracks } }) });
const plural = (n) => `${n} track${n === 1 ? "" : "s"}`;

export default {
  id: "vibeplay",
  name: "VibeEngine · Player",
  description: "Play a VibeEngine song, album, playlist, or vibe by name. Audio plays inside Voxa (the orb).",
  icon: "▶",
  config: [],

  async test() {
    try {
      await call("search_tracks", { query: "the", limit: 1 });
      return { ok: true, message: "MCP reachable. Sign in with vibeengine_login for playlists." };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  },

  actions: [
    {
      name: "vibeplay_song",
      description: "Find a VibeEngine song by title and play it in the orb.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "The song title (or part of it)." } },
        required: ["query"],
      },
      async handler({ query }) {
        if (!query) return { error: "say which song to play" };
        let results;
        try { results = await call("search_tracks", { query, limit: 8 }); }
        catch (e) { return { error: e.message }; }
        if (!Array.isArray(results) || !results.length) return { error: `No song found for "${query}".` };
        const q = norm(query);
        const hit = results.find((s) => norm(s.title) === q) || results[0];
        const tracks = await toTracks([hit]);
        if (!tracks.length) return { error: `couldn't get a stream for "${hit.title}".` };
        return directive(`Playing "${hit.title}"${hit.artist ? " by " + hit.artist : ""}.`, "song", hit.title, tracks);
      },
    },

    {
      name: "vibeplay_album",
      description: "Find a VibeEngine album by name and play it in the orb, in track order.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "The album name (or part of it)." } },
        required: ["query"],
      },
      async handler({ query }) {
        if (!query) return { error: "say which album to play" };
        let albums;
        try { albums = await call("list_albums", { limit: 100 }); }
        catch (e) { return { error: e.message }; }
        if (!Array.isArray(albums) || !albums.length) return { error: "couldn't load albums" };
        const q = norm(query);
        // Albums are matched on their slug (list_albums doesn't always carry a
        // title); norm() turns the slug's hyphens into spaces so "black neon
        // pulse" matches the slug "black-neon-pulse".
        const ranked = albums
          .map((a) => ({ a, s: Math.max(score(a.slug, q), score(a.title, q)) }))
          .sort((x, y) => y.s - x.s);
        if (!ranked[0] || ranked[0].s < PLAY_THRESHOLD) {
          const sug = ranked.slice(0, 4).filter((r) => r.s > 0).map((r) => (r.a.title || r.a.slug || "").replace(/-/g, " "));
          return { error: sug.length ? `No clear album match for "${query}". Did you mean: ${sug.join(", ")}?` : `No album matching "${query}".` };
        }
        let detail;
        try { detail = await call("play_album", { slug: ranked[0].a.slug }); }
        catch (e) { return { error: e.message }; }
        const tracks = toPlayTracks(detail?.tracks);
        const name = detail?.name || (ranked[0].a.slug || "").replace(/-/g, " ");
        if (!tracks.length) return { error: `album "${name}" has no playable tracks.` };
        return directive(`Playing album "${name}" — ${plural(tracks.length)}.`, "album", name, tracks);
      },
    },

    {
      name: "vibeplay_playlist",
      description: "Find one of your VibeEngine playlists by name and play it in the orb (queues all its tracks in order).",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "The playlist name (or part of it)." } },
        required: ["query"],
      },
      async handler({ query }) {
        if (!query) return { error: "say which playlist to play" };
        let lists;
        try { lists = await call("get_my_playlists", {}); }
        catch (e) { return { error: e.message }; }
        if (!Array.isArray(lists)) return { error: "couldn't load your playlists" };
        const ranked = lists.map((p) => ({ p, s: score(p.name, norm(query)) })).sort((a, b) => b.s - a.s);
        if (!ranked[0] || ranked[0].s < PLAY_THRESHOLD) {
          const sug = ranked.slice(0, 4).filter((r) => r.s > 0).map((r) => r.p.name);
          return { error: sug.length ? `No clear match for "${query}". Did you mean: ${sug.join(", ")}?` : `No playlist matching "${query}".` };
        }
        const pl = ranked[0].p;
        let detail;
        // One call: ordered tracks, each already carrying a ready-to-play URL.
        try { detail = await call("play_playlist", { id: pl.id }); }
        catch (e) { return { error: e.message }; }
        const tracks = toPlayTracks(detail?.tracks);
        const name = detail?.name || pl.name;
        if (!tracks.length) return { error: `playlist "${name}" has no playable tracks.` };
        return directive(`Playing playlist "${name}" — ${plural(tracks.length)}.`, "playlist", name, tracks);
      },
    },

    {
      name: "vibeplay_vibe",
      description: "Play a queue of tracks matching a vibe/genre/mood (e.g. 'lo-fi', 'ambient', 'synthwave'). See the catalog connector's vibeengine_vibes for valid tags.",
      parameters: {
        type: "object",
        properties: { vibe: { type: "string", description: "The vibe/genre/mood tag to play." } },
        required: ["vibe"],
      },
      async handler({ vibe }) {
        if (!vibe) return { error: "say which vibe to play" };
        let results;
        try { results = await call("search_tracks", { vibe, limit: 20 }); }
        catch (e) { return { error: e.message }; }
        if (!Array.isArray(results) || !results.length) return { error: `No tracks found for the vibe "${vibe}".` };
        const tracks = await toTracks(results);
        if (!tracks.length) return { error: `couldn't get streams for "${vibe}".` };
        return directive(`Playing ${plural(tracks.length)} for the "${vibe}" vibe.`, "vibe", vibe, tracks);
      },
    },
  ],
};
