// Hacker News connector — top stories + search via the Algolia HN API. No key.
//   front page: https://hn.algolia.com/api/v1/search?tags=front_page
//   search:     https://hn.algolia.com/api/v1/search?query=rust&tags=story
const API = "https://hn.algolia.com/api/v1/search";
const clip = (s, n = 110) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

async function getJSON(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`${r.status} from Hacker News`);
  return r.json();
}
const render = (hits, count) =>
  hits.slice(0, count).map((h, i) => `${i + 1}. ${clip(h.title)} (${h.points || 0} pts, ${h.num_comments || 0} comments)`).join(" ");

export default {
  id: "hackernews",
  name: "Hacker News",
  description: "Top Hacker News stories and keyword search. No API key.",
  icon: "🟧",
  config: [],

  async test() {
    try {
      const d = await getJSON(`${API}?tags=front_page&hitsPerPage=1`);
      return { ok: true, message: `Ready. Front page top: "${clip(d.hits?.[0]?.title || "", 60)}".` };
    } catch (e) { return { ok: false, message: e?.message || String(e) }; }
  },

  actions: [
    {
      name: "hackernews_top",
      description: "Get the current top Hacker News front-page stories (titles, points, comment counts).",
      parameters: {
        type: "object",
        properties: { count: { type: "integer", description: "How many stories, 1–8. Default 5." } },
      },
      async handler(args) {
        try {
          const count = Math.min(Math.max(parseInt(args.count, 10) || 5, 1), 8);
          const d = await getJSON(`${API}?tags=front_page&hitsPerPage=${count}`);
          if (!d.hits?.length) return { result: "No stories right now." };
          return { result: render(d.hits, count) };
        } catch (e) { return { error: e?.message || String(e) }; }
      },
    },
    {
      name: "hackernews_search",
      description: "Search Hacker News stories by keyword, ranked by relevance. Use for 'what's HN saying about X'.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search terms, e.g. 'rust async'." },
          count: { type: "integer", description: "How many results, 1–8. Default 5." },
        },
        required: ["query"],
      },
      async handler(args) {
        try {
          const query = String(args.query || "").trim();
          if (!query) return { error: "Search for what?" };
          const count = Math.min(Math.max(parseInt(args.count, 10) || 5, 1), 8);
          const d = await getJSON(`${API}?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${count}`);
          if (!d.hits?.length) return { result: `No HN stories for "${query}".` };
          return { result: render(d.hits, count) };
        } catch (e) { return { error: e?.message || String(e) }; }
      },
    },
  ],
};
