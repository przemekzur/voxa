// Claude Code connector — read-only visibility into the local Claude Code app
// data on this machine. Lets the orb answer "what did I work on", "list my
// projects", "summarize my last Claude Code session" by reading the on-disk
// history the CLI/desktop app already writes. It does NOT spawn or control
// Claude Code — it only reads. Nothing here writes to ~/.claude.
//
// Data layout (Claude Code):
//   ~/.claude/history.jsonl                    flat log: {display, timestamp, project, sessionId}
//   ~/.claude/projects/<encoded-cwd>/<id>.jsonl  per-session event stream
//     event types we use: ai-title {aiTitle}, user/assistant {message, cwd}, last-prompt
import { readFile, readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, basename } from "node:path";

const home = (cfg) => (cfg.claudeHome?.trim() || join(homedir(), ".claude"));
const projectsDir = (cfg) => join(home(cfg), "projects");

// Read at most `maxLines` parsed JSON objects from the head of a jsonl file.
// Used to pull a session's title + cwd cheaply without loading huge transcripts.
function headLines(file, maxLines) {
  return new Promise((resolve) => {
    const out = [];
    let rl;
    try { rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity }); }
    catch { return resolve(out); }
    rl.on("line", (line) => {
      if (!line) return;
      try { out.push(JSON.parse(line)); } catch {}
      if (out.length >= maxLines) rl.close();
    });
    rl.on("close", () => resolve(out));
    rl.on("error", () => resolve(out));
  });
}

// Pull a friendly title + real cwd from a session file (scans the head only).
// A session has TWO titles: the auto-generated `ai-title` and the user's
// `custom-title` (what they rename it to in the app — and what they'll ask
// about). Prefer the custom title; keep both for matching. Titles are rewritten
// on most turns, so take the LAST one in the scanned window (most current).
async function sessionMeta(file) {
  const rows = await headLines(file, 300);
  let aiTitle = "", customTitle = "", cwd = "";
  for (const r of rows) {
    if (r.type === "ai-title" && r.aiTitle) aiTitle = r.aiTitle;
    if (r.type === "custom-title" && r.customTitle) customTitle = r.customTitle;
    if (!cwd && r.cwd) cwd = r.cwd;
    if (!cwd && r.message?.cwd) cwd = r.message.cwd;
  }
  return { title: customTitle || aiTitle, aiTitle, customTitle, cwd };
}

// Stream the WHOLE session and return the last `k` user prompts (real recency).
// Reading the head would surface a long session's OLDEST prompts mislabelled as
// recent; a rolling tail buffer is cheap and correct even for 16 MB files. Also
// recovers the most-current title/cwd in the same single pass.
function tailSession(file, k) {
  return new Promise((resolve) => {
    const prompts = [];
    let aiTitle = "", customTitle = "", cwd = "";
    let rl;
    try { rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity }); }
    catch { return resolve({ prompts, title: "", cwd }); }
    rl.on("line", (line) => {
      if (!line) return;
      let r; try { r = JSON.parse(line); } catch { return; }
      if (r.type === "ai-title" && r.aiTitle) aiTitle = r.aiTitle;
      if (r.type === "custom-title" && r.customTitle) customTitle = r.customTitle;
      if (!cwd && (r.cwd || r.message?.cwd)) cwd = r.cwd || r.message.cwd;
      let text = "";
      if (r.type === "last-prompt" && typeof r.prompt === "string") text = r.prompt;
      else if (r.type === "user" && typeof r.message?.content === "string") text = r.message.content;
      else if (r.type === "user" && Array.isArray(r.message?.content)) text = r.message.content.map((c) => c.text || "").join(" ");
      text = text.replace(/\s+/g, " ").trim();
      if (text && !text.startsWith("<")) {
        prompts.push(text);
        if (prompts.length > k) prompts.shift();
      }
    });
    rl.on("close", () => resolve({ prompts, title: customTitle || aiTitle, aiTitle, customTitle, cwd }));
    rl.on("error", () => resolve({ prompts, title: customTitle || aiTitle, aiTitle, customTitle, cwd }));
  });
}

function rel(ts) {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 90) return "just now";
  const min = Math.round(sec / 60); if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60); if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24); if (day === 1) return "yesterday";
  if (day < 7) return `${day}d ago`;
  return `${Math.round(day / 7)}w ago`;
}

async function listProjectDirs(cfg) {
  try { return (await readdir(projectsDir(cfg), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return []; }
}

// Newest .jsonl files (by mtime) in a project dir, capped.
async function sessionsIn(cfg, dirName, cap) {
  const dir = join(projectsDir(cfg), dirName);
  let files = [];
  try { files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")); } catch { return []; }
  const stated = [];
  for (const f of files) {
    try { const s = await stat(join(dir, f)); stated.push({ file: join(dir, f), id: f.replace(/\.jsonl$/, ""), mtime: s.mtimeMs }); } catch {}
  }
  stated.sort((a, b) => b.mtime - a.mtime);
  return cap ? stated.slice(0, cap) : stated;
}

async function readHistory(cfg, limit) {
  const file = join(home(cfg), "history.jsonl");
  let text = "";
  try { text = await readFile(file, "utf8"); } catch { return []; }
  const lines = text.split("\n").filter(Boolean);
  const tail = lines.slice(-Math.max(limit * 4, 50)); // over-read, then filter/dedupe
  const out = [];
  for (const l of tail) { try { out.push(JSON.parse(l)); } catch {} }
  return out;
}

export default {
  id: "claude-code",
  name: "Claude Code",
  description: "Read-only view of your local Claude Code activity: projects, recent sessions, and what you've been working on. Does not control Claude Code.",
  icon: "✳",

  config: [
    { key: "claudeHome", label: "Claude home dir", type: "text", placeholder: "(defaults to ~/.claude)", help: "Path to the Claude Code data dir. Leave blank to use ~/.claude." },
  ],

  async test(cfg) {
    const dirs = await listProjectDirs(cfg);
    if (!dirs.length) return { ok: false, message: `No projects found under ${projectsDir(cfg)}.` };
    return { ok: true, message: `Ready. ${dirs.length} project(s) under ${home(cfg)}.` };
  },

  actions: [
    {
      name: "claude_code_projects",
      description: "List your Claude Code projects, most recently active first, with how many sessions each has.",
      parameters: {
        type: "object",
        properties: { count: { type: "integer", description: "How many projects to list, 1–15. Default 6." } },
      },
      async handler(args, cfg) {
        try {
          const cap = Math.min(Math.max(parseInt(args.count, 10) || 6, 1), 15);
          const dirs = await listProjectDirs(cfg);
          if (!dirs.length) return { result: "No Claude Code projects found." };
          const rows = [];
          for (const d of dirs) {
            const ss = await sessionsIn(cfg, d, 0);
            if (ss.length) rows.push({ dir: d, count: ss.length, mtime: ss[0].mtime, newest: ss[0].file });
          }
          rows.sort((a, b) => b.mtime - a.mtime);
          const top = rows.slice(0, cap);
          const labeled = [];
          for (const r of top) {
            const meta = await sessionMeta(r.newest);
            const name = meta.cwd ? basename(meta.cwd) : r.dir;
            labeled.push(`${name} (${r.count} session${r.count === 1 ? "" : "s"}, ${rel(r.mtime)})`);
          }
          return { result: labeled.join("; ") + "." };
        } catch (e) { return { error: e?.message || String(e) }; }
      },
    },
    {
      name: "claude_code_sessions",
      description: "List recent Claude Code sessions with their titles and when they were last active. Optionally filter to one project by name keyword.",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project name keyword to filter by (e.g. 'my-project'). Optional — omit for all projects." },
          count: { type: "integer", description: "How many sessions, 1–10. Default 5." },
        },
      },
      async handler(args, cfg) {
        try {
          const cap = Math.min(Math.max(parseInt(args.count, 10) || 5, 1), 10);
          const filter = String(args.project || "").trim().toLowerCase();
          let dirs = await listProjectDirs(cfg);
          if (filter) dirs = dirs.filter((d) => d.toLowerCase().includes(filter));
          if (!dirs.length) return { result: filter ? `No project matching "${args.project}".` : "No projects found." };
          let all = [];
          for (const d of dirs) all = all.concat((await sessionsIn(cfg, d, cap)).map((s) => ({ ...s, dir: d })));
          all.sort((a, b) => b.mtime - a.mtime);
          const top = all.slice(0, cap);
          const lines = [];
          for (const s of top) {
            const meta = await sessionMeta(s.file);
            const proj = meta.cwd ? basename(meta.cwd) : s.dir;
            lines.push(`"${meta.title || "untitled"}" — ${proj}, ${rel(s.mtime)}`);
          }
          return { result: lines.join("; ") + "." };
        } catch (e) { return { error: e?.message || String(e) }; }
      },
    },
    {
      name: "claude_code_recent",
      description: "What you've recently been doing in Claude Code — your latest prompts and commands across all projects.",
      parameters: {
        type: "object",
        properties: { count: { type: "integer", description: "How many recent entries, 1–10. Default 6." } },
      },
      async handler(args, cfg) {
        try {
          const cap = Math.min(Math.max(parseInt(args.count, 10) || 6, 1), 10);
          const hist = await readHistory(cfg, cap);
          if (!hist.length) return { result: "No recent Claude Code activity found." };
          const recent = hist.slice(-cap).reverse();
          const lines = recent.map((h) => {
            const proj = h.project ? basename(String(h.project)) : "?";
            const what = String(h.display || "").replace(/\s+/g, " ").trim().slice(0, 80);
            return `${proj}: ${what} (${rel(h.timestamp)})`;
          });
          return { result: lines.join("; ") + "." };
        } catch (e) { return { error: e?.message || String(e) }; }
      },
    },
    {
      name: "claude_code_session_summary",
      description: "Summarize a Claude Code session: its title and your recent prompts in it. Defaults to the most recent session; pass a keyword to match a session title or project.",
      parameters: {
        type: "object",
        properties: { match: { type: "string", description: "Keyword to match a session title or project. Optional — omit for the most recent session." } },
      },
      async handler(args, cfg) {
        try {
          const want = String(args.match || "").trim().toLowerCase();
          const dirs = await listProjectDirs(cfg);
          // Gather candidate sessions newest-first across projects.
          let cand = [];
          for (const d of dirs) cand = cand.concat((await sessionsIn(cfg, d, want ? 0 : 1)).map((s) => ({ ...s, dir: d })));
          cand.sort((a, b) => b.mtime - a.mtime);
          const hit = (meta, s) =>
            [meta.customTitle, meta.aiTitle, s.dir, meta.cwd]
              .some((v) => (v || "").toLowerCase().includes(want));
          let chosen = null, chosenMeta = null;
          for (const s of cand) {
            const meta = await sessionMeta(s.file);
            if (!want || hit(meta, s)) { chosen = s; chosenMeta = meta; break; }
          }
          if (!chosen) return { result: want ? `No session matching "${args.match}".` : "No sessions found." };
          // Read the TAIL for genuinely-recent prompts (and the most-current
          // title/cwd) in a single pass — the head would report stale, early asks.
          const { prompts, title, cwd } = await tailSession(chosen.file, 6);
          const proj = (cwd || chosenMeta.cwd) ? basename(cwd || chosenMeta.cwd) : chosen.dir;
          const displayTitle = title || chosenMeta.title || "untitled";
          const last = prompts.slice(-5).map((p) => p.slice(0, 110));
          const body = last.length ? ` Recent asks: ${last.map((p) => `"${p}"`).join("; ")}.` : "";
          return { result: `"${displayTitle}" in ${proj}, ${rel(chosen.mtime)}.${body}` };
        } catch (e) { return { error: e?.message || String(e) }; }
      },
    },
  ],
};
