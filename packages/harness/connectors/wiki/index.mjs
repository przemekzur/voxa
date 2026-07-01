// Wikipedia connector — quick factual lookups + "on this day". No API key.
//   summary: https://en.wikipedia.org/api/rest_v1/page/summary/{title}
//   on this day: https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/{MM}/{DD}
const clip = (s, n = 600) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

async function getJSON(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  if (r.status === 404) throw new Error("no Wikipedia article for that");
  if (!r.ok) throw new Error(`${r.status} from Wikipedia`);
  return r.json();
}

export default {
  id: "wiki",
  name: "Wikipedia",
  description: "Quick factual summaries and 'on this day in history' from Wikipedia. No API key.",
  icon: "📚",
  config: [
    { key: "lang", label: "Language", type: "text", default: "en", help: "Wikipedia language code: en, pl, de…" },
  ],

  async test(cfg) {
    try {
      const lang = cfg.lang || "en";
      const d = await getJSON(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/Wikipedia`);
      return { ok: true, message: `Ready (${lang}). "${d.title}" resolves.` };
    } catch (e) { return { ok: false, message: e?.message || String(e) }; }
  },

  actions: [
    {
      name: "wiki_summary",
      description: "Get a short factual summary of a topic, person, place or thing from Wikipedia. Use for 'who/what is X' questions.",
      parameters: {
        type: "object",
        properties: { topic: { type: "string", description: "What to look up, e.g. 'Nikola Tesla' or 'black hole'." } },
        required: ["topic"],
      },
      async handler(args, cfg) {
        try {
          const topic = String(args.topic || "").trim();
          if (!topic) return { error: "Look up what?" };
          const lang = cfg.lang || "en";
          const d = await getJSON(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic.replace(/\s+/g, "_"))}`);
          if (d.type === "disambiguation") return { result: `"${d.title}" is ambiguous — be more specific.` };
          return { result: clip(d.extract || `No summary for "${topic}".`) };
        } catch (e) { return { error: e?.message || String(e) }; }
      },
    },
    {
      name: "wiki_on_this_day",
      description: "Notable historical events that happened on today's date (or a given month/day).",
      parameters: {
        type: "object",
        properties: {
          month: { type: "integer", description: "Month 1–12. Optional — defaults to today." },
          day: { type: "integer", description: "Day 1–31. Optional — defaults to today." },
        },
      },
      async handler(args, cfg) {
        try {
          const now = new Date();
          const mm = String(Math.min(Math.max(parseInt(args.month, 10) || now.getMonth() + 1, 1), 12)).padStart(2, "0");
          const dd = String(Math.min(Math.max(parseInt(args.day, 10) || now.getDate(), 1), 31)).padStart(2, "0");
          const lang = cfg.lang || "en";
          const d = await getJSON(`https://${lang}.wikipedia.org/api/rest_v1/feed/onthisday/events/${mm}/${dd}`);
          const events = (d.events || []).sort((a, b) => b.year - a.year).slice(0, 4);
          if (!events.length) return { result: `Nothing notable found for ${mm}/${dd}.` };
          return { result: `On ${mm}/${dd}: ` + events.map((e) => `${e.year} — ${clip(e.text, 120)}`).join("; ") };
        } catch (e) { return { error: e?.message || String(e) }; }
      },
    },
  ],
};
