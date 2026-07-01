// X.com (Twitter) connector.
//
// Two halves, deliberately decoupled so the useful part works with zero setup:
//
//  • SEARCH (works today, free): X's API dropped free reads in Feb 2026 (pay-per-use
//    only), so reading recent posts through the official API now costs money per read.
//    Instead we source "recent posts" by querying the web (SerpApi, scoped to
//    site:x.com / site:twitter.com) — the same provider/key the `websearch` connector
//    already uses. No X account, no per-read billing.
//
//  • POST + user context (opt-in): real "act as my X account" actions go through a
//    proper OAuth 2.0 PKCE login (see lib/xcom-auth.mjs). This is the "authentication
//    built around the connector" — it stays dormant until you register an X app and
//    log in, and posting is metered pay-per-use by X.
//
// Search results are trimmed to a few short lines so the model can read them aloud.
import { openInBrowser } from "../../lib/open-browser.mjs";
import { getState } from "../../lib/store.mjs";
import { getBearer, forceRefresh, startLogin, loginStatus, isAuthed, logout } from "../../lib/xcom-auth.mjs";

const SERP = "https://serpapi.com/search.json";
const TWEETS = "https://api.twitter.com/2/tweets";

const clip = (s, n = 160) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const ok = (result) => ({ result });
const err = (m) => ({ error: m });

// SerpApi key: this connector's own config, else fall back to the websearch connector's.
async function serpKey(cfg) {
  if (cfg?.serpapiKey) return cfg.serpapiKey;
  const ws = await getState("websearch");
  if ((ws.config?.provider || "").toLowerCase() === "serpapi" && ws.config?.apiKey) return ws.config.apiKey;
  return ws.config?.apiKey || "";
}

async function searchX(cfg, query, count) {
  const key = await serpKey(cfg);
  if (!key) throw new Error("No SerpApi key — set serpapiKey here, or configure the websearch connector with a SerpApi key.");
  const q = `${query} (site:x.com OR site:twitter.com)`;
  const params = new URLSearchParams({ api_key: key, engine: "google", q, num: String(count), hl: "en" });
  const r = await fetch(`${SERP}?${params}`, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) {
    let detail = ""; try { detail = (await r.json())?.error || ""; } catch {}
    if (r.status === 401) throw new Error(`SerpApi key rejected${detail ? ` — ${detail}` : ""}.`);
    throw new Error(`SerpApi ${r.status}${detail ? `: ${detail}` : ""}.`);
  }
  const data = await r.json();
  if (data.error) throw new Error(`SerpApi: ${data.error}`); // invalid key returns 200 + error
  const items = (data.organic_results || []).slice(0, count).map((x) => ({ title: x.title, snippet: x.snippet || "" }));
  if (!items.length) return `No recent X posts found for "${query}".`;
  return items.map((x, i) => `${i + 1}. ${[x.title, clip(x.snippet)].filter(Boolean).join(" — ")}`).join(" ");
}

export default {
  id: "xcom-news",
  name: "X.com",
  description: "Find recent posts on X/Twitter (via web search — no X account needed), and post to X once you log in.",
  icon: "🐦",

  config: [
    { key: "serpapiKey", label: "SerpApi key (optional)", type: "text", secret: true,
      help: "Used to search X via the web. Leave blank to reuse the websearch connector's SerpApi key." },
  ],

  async test(cfg) {
    let searchMsg;
    try {
      const out = await searchX(cfg, "news", 1);
      searchMsg = `Search ready — ${out.startsWith("No ") ? "no sample hits" : "returned a result"}.`;
    } catch (e) {
      searchMsg = `Search not ready: ${e.message}`;
    }
    const a = await isAuthed();
    const authMsg = {
      "no-client": "Posting: not set up (register an X app, see xcom_login).",
      active: "Posting: signed in.",
      refreshable: "Posting: signed in (will auto-refresh).",
      none: "Posting: app registered, not logged in (run xcom_login).",
    }[a] || a;
    const okFlag = !searchMsg.startsWith("Search not ready");
    return { ok: okFlag, message: `${searchMsg} ${authMsg}` };
  },

  actions: [
    {
      name: "xcom_news_search",
      description: "Search recent public posts on X (Twitter) by keyword, e.g. 'AI regulation' or 'NASA Mars'. Sourced via web search — works without an X account.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search terms." },
          count: { type: "integer", description: "How many results, 1–8. Default 5." },
        },
        required: ["query"],
      },
      async handler(args, cfg) {
        const query = String(args.query || "").trim();
        if (!query) return err("Empty query.");
        const count = Math.min(Math.max(parseInt(args.count, 10) || 5, 1), 8);
        try { return ok(await searchX(cfg, query, count)); }
        catch (e) { return err(e.message); }
      },
    },
    {
      name: "xcom_login",
      description: "Sign in to X as your account (OAuth in the browser) to enable posting. Opens the consent page; you'll be connected once you approve. Use when xcom_post says you're not signed in.",
      parameters: { type: "object", properties: {} },
      async handler() {
        try {
          await startLogin(openInBrowser);
          return ok("Opened X in your browser — approve access and I'll be connected within a few seconds (then it auto-renews).");
        } catch (e) { return err(e.message); }
      },
    },
    {
      name: "xcom_auth_status",
      description: "Check whether Voxa is signed in to X (for posting).",
      parameters: { type: "object", properties: {} },
      async handler() {
        const p = loginStatus();
        if (p?.pending) return ok("Waiting for you to approve access in the browser…");
        if (p?.error) return ok(`Last login failed: ${p.error}. Run xcom_login again.`);
        const a = await isAuthed();
        const msg = {
          "no-client": "No X app registered yet — see xcom_login for one-time setup.",
          active: "Signed in to X (token valid).",
          refreshable: "Signed in to X (will auto-refresh).",
          none: "X app registered but not logged in — run xcom_login.",
        };
        return ok(msg[a] || a);
      },
    },
    {
      name: "xcom_logout",
      description: "Sign out of X (clears stored tokens).",
      parameters: { type: "object", properties: {} },
      async handler() { await logout(); return ok("Signed out of X."); },
    },
    {
      name: "xcom_post",
      description: "Post a new tweet to X as the signed-in account. Requires xcom_login first. Note: X bills per post (pay-per-use).",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "The post text (max 280 chars)." } },
        required: ["text"],
      },
      async handler(args) {
        const text = String(args.text || "").trim();
        if (!text) return err("Empty post.");
        if (text.length > 280) return err(`Too long (${text.length}/280 chars).`);
        let bearer = await getBearer();
        if (!bearer) return err("Not signed in to X — run xcom_login first.");
        const post = async (token) => fetch(TWEETS, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ text }),
          signal: AbortSignal.timeout(12000),
        });
        try {
          let r = await post(bearer);
          if (r.status === 401) { // token expired between getBearer and now — refresh once
            const refreshed = await forceRefresh();
            if (refreshed) r = await post(refreshed);
          }
          const body = await r.json().catch(() => ({}));
          if (!r.ok) return err(body?.detail || body?.title || `X API ${r.status}.`);
          const id = body?.data?.id;
          return ok(id ? `Posted to X (id ${id}).` : "Posted to X.");
        } catch (e) { return err(e?.message || String(e)); }
      },
    },
  ],
};
