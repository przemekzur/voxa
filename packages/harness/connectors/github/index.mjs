// GitHub connector — READ-ONLY. Answers "what's going on with my GitHub":
// repos, a repo's overview, open PRs/issues, recent commits, CI (Actions)
// status, notifications, and issue/PR search. Every call is a GET — this
// connector never writes.
//
// Auth: a GitHub Personal Access Token (recommended — needed for private repos
// and a 5000/h rate limit). Use a READ-ONLY token:
//   • Fine-grained PAT: Repository access + read on Metadata, Contents, Issues,
//     Pull requests, Actions; Account → Notifications (read).
//   • or a classic PAT with `repo` (read) + `notifications` + `read:org`.
// Without a token it still works for PUBLIC repos (60/h rate limit).
const API = "https://api.github.com";
const clip = (s, n = 80) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

function rel(iso) {
  const ts = Date.parse(iso);
  if (!ts) return "";
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  const m = Math.round(sec / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24); if (d === 1) return "yesterday";
  if (d < 14) return `${d}d ago`;
  return `${Math.round(d / 7)}w ago`;
}

async function gh(cfg, path, params) {
  const url = `${API}${path}${params ? "?" + new URLSearchParams(params) : ""}`;
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "voxa-connector", // GitHub requires a User-Agent
  };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
  if (r.status === 401) throw new Error("GitHub token invalid or expired.");
  if (r.status === 403) {
    const remaining = r.headers.get("x-ratelimit-remaining");
    throw new Error(remaining === "0" ? "GitHub rate limit reached — add/refresh a token." : "GitHub 403 (token scope or access?).");
  }
  if (r.status === 404) throw new Error("Not found — wrong owner/repo, or your token can't see it.");
  if (!r.ok) throw new Error(`GitHub ${r.status}.`);
  return r.json();
}

// Resolve "owner/repo" or bare "repo" (using the default owner / the token's user).
let _meLogin = null;
async function ownerOf(cfg) {
  if (cfg.defaultOwner?.trim()) return cfg.defaultOwner.trim();
  if (_meLogin) return _meLogin;
  if (!cfg.token) throw new Error("Set a default owner, or use 'owner/repo'.");
  _meLogin = (await gh(cfg, "/user")).login;
  return _meLogin;
}
async function resolveRepo(cfg, repoArg) {
  const s = String(repoArg || "").trim();
  if (!s) throw new Error("Which repository?");
  if (s.includes("/")) return s;
  return `${await ownerOf(cfg)}/${s}`;
}

export default {
  id: "github",
  name: "GitHub (read-only)",
  description: "Read-only GitHub: your repos, PRs, issues, commits, CI status, notifications, and search. Never writes.",
  icon: "",

  config: [
    { key: "token", label: "GitHub token (read-only PAT)", type: "text", secret: true, help: "Recommended — needed for private repos + higher rate limit. Use a read-only fine-grained or classic PAT. Public repos work without one." },
    { key: "defaultOwner", label: "Default owner/user", type: "text", placeholder: "octocat", help: "Used when you say a bare repo name like 'my-repo'. Defaults to the token's account." },
  ],

  async test(cfg) {
    try {
      if (cfg.token) {
        const me = await gh(cfg, "/user");
        return { ok: true, message: `Signed in as ${me.login}${me.name ? ` (${me.name})` : ""} — ${me.public_repos} public repos.` };
      }
      await gh(cfg, "/repos/octocat/Hello-World"); // unauth public smoke
      return { ok: true, message: "Working without a token (public repos only, 60/h limit). Add a PAT for your private repos." };
    } catch (e) { return { ok: false, message: e?.message || String(e) }; }
  },

  actions: [
    {
      name: "github_me",
      description: "Who you're signed in as on GitHub, with repo/follower counts. Needs a token.",
      parameters: { type: "object", properties: {} },
      async handler(_a, cfg) {
        try {
          if (!cfg.token) return { error: "No token set — can't identify you." };
          const u = await gh(cfg, "/user");
          return { result: `${u.login}${u.name ? ` (${u.name})` : ""}: ${u.public_repos} public repos, ${u.followers} followers, ${u.following} following.` };
        } catch (e) { return { error: e?.message || String(e) }; }
      },
    },
    {
      name: "github_repos",
      description: "List repositories, most recently pushed first. Omit owner to list your own (needs a token); or pass a user/org name.",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string", description: "User/org to list. Optional — omit for your own repos." },
          count: { type: "integer", description: "How many, 1–15. Default 8." },
        },
      },
      async handler(args, cfg) {
        try {
          const count = Math.min(Math.max(parseInt(args.count, 10) || 8, 1), 15);
          const owner = String(args.owner || "").trim();
          const repos = owner
            ? await gh(cfg, `/users/${owner}/repos`, { sort: "pushed", per_page: count })
            : (cfg.token ? await gh(cfg, "/user/repos", { sort: "pushed", per_page: count, affiliation: "owner" })
                         : (() => { throw new Error("No token — name a user/org to list public repos."); })());
          if (!repos.length) return { result: "No repositories found." };
          return { result: repos.slice(0, count).map((r) => `${r.name} (${r.language || "?"}, ★${r.stargazers_count}, ${r.open_issues_count} open, pushed ${rel(r.pushed_at)})`).join("; ") };
        } catch (e) { return { error: e?.message || String(e) }; }
      },
    },
    {
      name: "github_repo",
      description: "Overview of one repository: language, stars, open issue/PR count, last push, description.",
      parameters: { type: "object", properties: { repo: { type: "string", description: "'owner/repo' or a bare repo name." } }, required: ["repo"] },
      async handler(args, cfg) {
        try {
          const full = await resolveRepo(cfg, args.repo);
          const r = await gh(cfg, `/repos/${full}`);
          return { result: `${r.full_name}: ${r.language || "?"}, ★${r.stargazers_count}, ${r.forks_count} forks, ${r.open_issues_count} open issues/PRs, pushed ${rel(r.pushed_at)}.${r.description ? " " + clip(r.description, 120) : ""}` };
        } catch (e) { return { error: e?.message || String(e) }; }
      },
    },
    {
      name: "github_prs",
      description: "Open pull requests in a repository (most recently updated first).",
      parameters: {
        type: "object",
        properties: { repo: { type: "string", description: "'owner/repo' or bare repo name." }, count: { type: "integer", description: "How many, 1–10. Default 6." } },
        required: ["repo"],
      },
      async handler(args, cfg) {
        try {
          const full = await resolveRepo(cfg, args.repo);
          const count = Math.min(Math.max(parseInt(args.count, 10) || 6, 1), 10);
          const prs = await gh(cfg, `/repos/${full}/pulls`, { state: "open", sort: "updated", direction: "desc", per_page: count });
          if (!prs.length) return { result: `No open PRs in ${full}.` };
          return { result: `${prs.length} open PR(s) in ${full}: ` + prs.map((p) => `#${p.number} "${clip(p.title, 60)}" by ${p.user?.login} (${rel(p.updated_at)})`).join("; ") };
        } catch (e) { return { error: e?.message || String(e) }; }
      },
    },
    {
      name: "github_issues",
      description: "Open issues in a repository (excludes pull requests).",
      parameters: {
        type: "object",
        properties: { repo: { type: "string", description: "'owner/repo' or bare repo name." }, count: { type: "integer", description: "How many, 1–10. Default 6." } },
        required: ["repo"],
      },
      async handler(args, cfg) {
        try {
          const full = await resolveRepo(cfg, args.repo);
          const count = Math.min(Math.max(parseInt(args.count, 10) || 6, 1), 10);
          const all = await gh(cfg, `/repos/${full}/issues`, { state: "open", sort: "updated", per_page: count + 10 });
          const issues = all.filter((i) => !i.pull_request).slice(0, count);
          if (!issues.length) return { result: `No open issues in ${full}.` };
          return { result: `Open issues in ${full}: ` + issues.map((i) => `#${i.number} "${clip(i.title, 60)}" (${rel(i.updated_at)})`).join("; ") };
        } catch (e) { return { error: e?.message || String(e) }; }
      },
    },
    {
      name: "github_commits",
      description: "Recent commits on a repository (optionally a specific branch).",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "'owner/repo' or bare repo name." },
          branch: { type: "string", description: "Branch name. Optional — defaults to the default branch." },
          count: { type: "integer", description: "How many, 1–10. Default 5." },
        },
        required: ["repo"],
      },
      async handler(args, cfg) {
        try {
          const full = await resolveRepo(cfg, args.repo);
          const count = Math.min(Math.max(parseInt(args.count, 10) || 5, 1), 10);
          const params = { per_page: count };
          if (args.branch) params.sha = String(args.branch).trim();
          const commits = await gh(cfg, `/repos/${full}/commits`, params);
          if (!commits.length) return { result: `No commits found in ${full}.` };
          return { result: `Recent in ${full}: ` + commits.map((c) => `"${clip(c.commit.message.split("\n")[0], 60)}" by ${c.commit.author?.name} (${rel(c.commit.author?.date)})`).join("; ") };
        } catch (e) { return { error: e?.message || String(e) }; }
      },
    },
    {
      name: "github_ci",
      description: "Latest GitHub Actions (CI) run status for a repository — did the build pass?",
      parameters: {
        type: "object",
        properties: { repo: { type: "string", description: "'owner/repo' or bare repo name." }, count: { type: "integer", description: "How many recent runs, 1–5. Default 3." } },
        required: ["repo"],
      },
      async handler(args, cfg) {
        try {
          const full = await resolveRepo(cfg, args.repo);
          const count = Math.min(Math.max(parseInt(args.count, 10) || 3, 1), 5);
          const data = await gh(cfg, `/repos/${full}/actions/runs`, { per_page: count });
          const runs = data.workflow_runs || [];
          if (!runs.length) return { result: `No Actions runs in ${full}.` };
          return { result: `CI in ${full}: ` + runs.map((r) => `${r.name} on ${r.head_branch} — ${r.conclusion || r.status} (${rel(r.created_at)})`).join("; ") };
        } catch (e) { return { error: e?.message || String(e) }; }
      },
    },
    {
      name: "github_notifications",
      description: "Your unread GitHub notifications. Needs a token.",
      parameters: { type: "object", properties: { count: { type: "integer", description: "How many, 1–10. Default 6." } } },
      async handler(args, cfg) {
        try {
          if (!cfg.token) return { error: "No token set — can't read your notifications." };
          const count = Math.min(Math.max(parseInt(args.count, 10) || 6, 1), 10);
          const n = await gh(cfg, "/notifications", { per_page: count });
          if (!n.length) return { result: "No unread GitHub notifications." };
          return { result: `${n.length} unread: ` + n.map((x) => `${x.repository?.name} — "${clip(x.subject?.title, 50)}" (${x.reason})`).join("; ") };
        } catch (e) { return { error: e?.message || String(e) }; }
      },
    },
    {
      name: "github_search_issues",
      description: "Search issues and pull requests across GitHub with a query (GitHub search syntax, e.g. 'repo:owner/name is:open label:bug' or 'assignee:me is:pr').",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "GitHub issue/PR search query." }, count: { type: "integer", description: "How many, 1–8. Default 5." } },
        required: ["query"],
      },
      async handler(args, cfg) {
        try {
          const q = String(args.query || "").trim();
          if (!q) return { error: "Empty query." };
          const count = Math.min(Math.max(parseInt(args.count, 10) || 5, 1), 8);
          const data = await gh(cfg, "/search/issues", { q, per_page: count, sort: "updated" });
          const items = data.items || [];
          if (!items.length) return { result: `No results for "${q}".` };
          return { result: `${data.total_count} match(es): ` + items.map((i) => { const repo = (i.repository_url || "").split("/repos/")[1] || ""; return `${repo}#${i.number} "${clip(i.title, 50)}" (${i.pull_request ? "PR" : "issue"}, ${i.state})`; }).join("; ") };
        } catch (e) { return { error: e?.message || String(e) }; }
      },
    },
  ],
};
