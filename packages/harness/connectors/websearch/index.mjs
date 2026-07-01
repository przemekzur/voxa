// Web search connector — let the orb look things up on the live web.
//
// Providers (set in config):
//   brave   — Brave Search API. Free tier, one key. Best general web + news.
//             key: https://brave.com/search/api/   header X-Subscription-Token
//   tavily  — Tavily. LLM-oriented, returns a synthesized answer. One key.
//             key: https://tavily.com/   POST api.tavily.com/search
//   serpapi — SerpApi (Google results + Google News). Free plan ~250/month.
//             key: https://serpapi.com/   GET serpapi.com/search.json?api_key=
//   duckduckgo — keyless Instant Answer API. No setup, but only good for quick
//             facts/definitions (no general ranked results). Used as the default
//             so the connector works before you add a key.
//
// Results are trimmed to a few short lines so the model can read them aloud.

const BRAVE_WEB = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_NEWS = "https://api.search.brave.com/res/v1/news/search";
const BRAVE_IMG = "https://api.search.brave.com/res/v1/images/search";
const TAVILY = "https://api.tavily.com/search";
const SERP = "https://serpapi.com/search.json";
const DDG = "https://api.duckduckgo.com/";

const clip = (s, n = 140) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const provider = (cfg) => String(cfg.provider || "duckduckgo").toLowerCase();

async function braveSearch(cfg, url, query, count) {
  const r = await fetch(`${url}?q=${encodeURIComponent(query)}&count=${count}`, {
    headers: { Accept: "application/json", "X-Subscription-Token": cfg.apiKey || "" },
    signal: AbortSignal.timeout(9000),
  });
  if (!r.ok) {
    // Brave reports an invalid subscription token as 422 (not 401/403), with the
    // reason in error.code/error.detail. Surface it so the cause is obvious.
    let detail = "";
    try { const j = await r.json(); detail = j?.error?.detail || j?.error?.code || ""; } catch {}
    if ([401, 403, 422].includes(r.status)) throw new Error(`Brave key rejected${detail ? ` — ${detail}` : ""}.`);
    throw new Error(`Brave API ${r.status}${detail ? `: ${detail}` : ""}.`);
  }
  const data = await r.json();
  const items = data?.web?.results || data?.results || [];
  return items.slice(0, count).map((x) => ({ title: x.title, snippet: x.description || x.snippet || "", url: x.url || "" }));
}

async function tavilySearch(cfg, query, count, topic) {
  const r = await fetch(TAVILY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: cfg.apiKey || "", query, max_results: count, include_answer: true, topic: topic || "general" }),
    signal: AbortSignal.timeout(12000),
  });
  if (r.status === 401) throw new Error("Tavily API key missing or invalid.");
  if (!r.ok) throw new Error(`Tavily API ${r.status}.`);
  const data = await r.json();
  return {
    answer: data?.answer || "",
    items: (data?.results || []).slice(0, count).map((x) => ({ title: x.title, snippet: x.content || "", url: x.url || "" })),
  };
}

async function serpapiSearch(cfg, query, count, isNews) {
  const params = new URLSearchParams({ api_key: cfg.apiKey || "", q: query, hl: "en" });
  if (isNews) params.set("engine", "google_news");
  else { params.set("engine", "google"); params.set("num", String(count)); }
  const r = await fetch(`${SERP}?${params}`, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) {
    let detail = ""; try { detail = (await r.json())?.error || ""; } catch {}
    if (r.status === 401) throw new Error(`SerpApi key rejected${detail ? ` — ${detail}` : ""}.`);
    throw new Error(`SerpApi ${r.status}${detail ? `: ${detail}` : ""}.`);
  }
  const data = await r.json();
  if (data.error) throw new Error(`SerpApi: ${data.error}`); // invalid key returns 200 + error here
  if (isNews) {
    const items = (data.news_results || []).slice(0, count).map((x) => ({ title: x.title, snippet: x.source?.name || x.source || x.date || "", url: x.link || "" }));
    return { items };
  }
  const ab = data.answer_box;
  const answer = ab?.answer || ab?.snippet || data.knowledge_graph?.description || "";
  const items = (data.organic_results || []).slice(0, count).map((x) => ({ title: x.title, snippet: x.snippet || "", url: x.link || "" }));
  return { answer, items };
}

async function ddgSearch(query) {
  const r = await fetch(`${DDG}?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`DuckDuckGo ${r.status}.`);
  const data = await r.json();
  if (data.AbstractText) return { answer: `${data.AbstractText} (${data.AbstractSource || "source"})` };
  const related = (data.RelatedTopics || []).filter((t) => t.Text).slice(0, 3);
  if (related.length) return { items: related.map((t) => ({ title: "", snippet: t.Text, url: t.FirstURL || "" })) };
  return { items: [] };
}

function render(query, answer, items) {
  if (answer) return { result: clip(answer, 600) };
  if (!items?.length) return { result: `No results for "${query}".` };
  // Include the real URL on each result so the model has a verified link to open
  // in the viewport (instead of fabricating one). It need not read URLs aloud.
  const lines = items.map((x, i) => {
    const head = [x.title, clip(x.snippet)].filter(Boolean).join(" — ");
    return `${i + 1}. ${head}${x.url ? ` <${x.url}>` : ""}`;
  });
  return { result: lines.join("  ") };
}

// Image search — returns DIRECT image URLs (the actual .jpg/.png), not page links.
async function serpapiImages(cfg, query, count) {
  const params = new URLSearchParams({ api_key: cfg.apiKey || "", q: query, engine: "google_images", hl: "en" });
  const r = await fetch(`${SERP}?${params}`, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) {
    let d = ""; try { d = (await r.json())?.error || ""; } catch {}
    if (r.status === 401) throw new Error(`SerpApi key rejected${d ? ` — ${d}` : ""}.`);
    throw new Error(`SerpApi ${r.status}${d ? `: ${d}` : ""}.`);
  }
  const data = await r.json();
  if (data.error) throw new Error(`SerpApi: ${data.error}`);
  return (data.images_results || [])
    .map((x) => ({ title: x.title || "", url: x.original || "", source: x.source || x.link || "" }))
    .filter((x) => /^https?:\/\//i.test(x.url))
    .slice(0, count);
}

async function braveImages(cfg, query, count) {
  const r = await fetch(`${BRAVE_IMG}?q=${encodeURIComponent(query)}&count=${count}`, {
    headers: { Accept: "application/json", "X-Subscription-Token": cfg.apiKey || "" },
    signal: AbortSignal.timeout(9000),
  });
  if (!r.ok) {
    if ([401, 403, 422].includes(r.status)) throw new Error("Brave key rejected.");
    throw new Error(`Brave images ${r.status}.`);
  }
  const data = await r.json();
  return (data.results || [])
    .map((x) => ({ title: x.title || "", url: x.properties?.url || x.thumbnail?.src || "", source: x.url || "" }))
    .filter((x) => /^https?:\/\//i.test(x.url))
    .slice(0, count);
}

export default {
  id: "websearch",
  name: "Web Search",
  description: "Look things up on the live web (Brave, Tavily, or keyless DuckDuckGo). Returns a few short results to read aloud.",
  icon: "⌕",

  config: [
    { key: "provider", label: "Provider", type: "text", default: "duckduckgo", help: "brave | tavily | serpapi | duckduckgo. brave/tavily/serpapi need an API key; duckduckgo is keyless (quick facts only)." },
    { key: "apiKey", label: "API key", type: "text", secret: true, help: "Required for brave / tavily / serpapi. Leave blank for duckduckgo." },
  ],

  async test(cfg) {
    const p = provider(cfg);
    if ((p === "brave" || p === "tavily" || p === "serpapi") && !cfg.apiKey) return { ok: false, message: `${p} needs an API key.` };
    try {
      const out = await runSearch(cfg, "hello world", 1);
      return { ok: true, message: `Ready (${p}). Sample returned ${out.result ? "a result" : "nothing"}.` };
    } catch (e) {
      return { ok: false, message: e?.message || String(e) };
    }
  },

  actions: [
    {
      name: "websearch_query",
      description: "Search the web for a query and return the top few results (or a synthesized answer). Use for current facts, how-tos, and anything beyond the model's knowledge.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for." },
          count: { type: "integer", description: "How many results, 1–5. Default 3." },
        },
        required: ["query"],
      },
      async handler(args, cfg) {
        const query = String(args.query || "").trim();
        if (!query) return { error: "Empty query." };
        const count = Math.min(Math.max(parseInt(args.count, 10) || 3, 1), 5);
        try { return await runSearch(cfg, query, count); }
        catch (e) { return { error: e?.message || String(e) }; }
      },
    },
    {
      name: "websearch_images",
      description: "Find IMAGES on the web and return DIRECT image URLs (.jpg/.png) ready to pass straight to viewport_show_image. Use this whenever the operator wants to SEE a picture or photo of something — get a real URL here instead of guessing one. Needs the serpapi or brave provider.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to find an image of, e.g. 'NASA picture of the day' or 'red panda'." },
          count: { type: "integer", description: "How many image URLs, 1–5. Default 3." },
        },
        required: ["query"],
      },
      async handler(args, cfg) {
        const query = String(args.query || "").trim();
        if (!query) return { error: "Empty query." };
        const count = Math.min(Math.max(parseInt(args.count, 10) || 3, 1), 5);
        const p = provider(cfg);
        try {
          let imgs;
          if (p === "serpapi") imgs = await serpapiImages(cfg, query, count);
          else if (p === "brave") imgs = await braveImages(cfg, query, count);
          else return { error: `Image search needs the serpapi or brave provider (current: ${p}). Set one in the websearch connector config.` };
          if (!imgs.length) return { result: `No images found for "${query}".` };
          const lines = imgs.map((x, i) => `${i + 1}. ${x.url}${x.title ? ` (${clip(x.title, 60)})` : ""}`);
          return { result: `Direct image URLs for "${query}" — pass the FIRST to viewport_show_image (try the next if one fails): ${lines.join("  ")}` };
        } catch (e) { return { error: e?.message || String(e) }; }
      },
    },
    {
      name: "websearch_news",
      description: "Get recent news headlines about a topic (or top headlines if no topic). Best with the brave or tavily provider.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "News topic, e.g. 'AI' or 'Warsaw'. Optional." },
          count: { type: "integer", description: "How many headlines, 1–5. Default 4." },
        },
      },
      async handler(args, cfg) {
        const topic = String(args.topic || "today top headlines").trim();
        const count = Math.min(Math.max(parseInt(args.count, 10) || 4, 1), 5);
        try {
          const p = provider(cfg);
          if (p === "brave") return render(topic, "", await braveSearch(cfg, BRAVE_NEWS, topic, count));
          if (p === "tavily") { const o = await tavilySearch(cfg, topic, count, "news"); return render(topic, o.answer, o.items); }
          if (p === "serpapi") { const o = await serpapiSearch(cfg, topic, count, true); return render(topic, "", o.items); }
          const o = await ddgSearch(topic); return render(topic, o.answer, o.items);
        } catch (e) { return { error: e?.message || String(e) }; }
      },
    },
  ],
};

// Shared search dispatch (also used by test()).
async function runSearch(cfg, query, count) {
  const p = provider(cfg);
  if (p === "brave") return render(query, "", await braveSearch(cfg, BRAVE_WEB, query, count));
  if (p === "tavily") { const o = await tavilySearch(cfg, query, count); return render(query, o.answer, o.items); }
  if (p === "serpapi") { const o = await serpapiSearch(cfg, query, count, false); return render(query, o.answer, o.items); }
  const o = await ddgSearch(query); return render(query, o.answer, o.items);
}
