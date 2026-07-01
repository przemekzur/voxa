// ── Voxa local brain ────────────────────────────────────────────────────────
// A "brain" that is just a folder of Markdown files. Voxa's default memory
// provider: search / read / save / list, with keyword (BM25) retrieval over
// heading-chunked notes. Fully offline — Node stdlib only, no model, no API key.
//
// Point `brainDir` at %APPDATA%\Voxa\brain (default) or straight at an Obsidian
// vault — same code. Retrieval lives behind `searchChunks()` so a vector/embedding
// backend can drop in later without changing the memory_* tool contract.
//
// Voxa-only connector (authored for Voxa). Conforms to the harness connector
// manifest (see BUILDING-A-CONNECTOR.md).

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

// ── paths ───────────────────────────────────────────────────────────────────
function defaultBrainDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), ".config");
  return path.join(base, "Voxa", "brain");
}
function brainDirOf(cfg) {
  const d = (cfg?.brainDir || "").trim();
  return d ? path.resolve(d) : defaultBrainDir();
}
// Resolve a user-supplied relative path and refuse anything outside the brain.
// Lexical check first, then realpath the deepest existing ancestor so a symlink
// planted inside the brain can't point read/write outside it.
async function safeJoin(root, rel) {
  const base = path.resolve(root);
  const abs = path.resolve(base, rel || "");
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  const realBase = await fs.realpath(base).catch(() => base);
  const real = await fs.realpath(abs).catch(async () =>
    fs.realpath(path.dirname(abs)).catch(() => path.dirname(abs)));
  const r = String(real);
  if (r !== realBase && !r.startsWith(realBase + path.sep)) return null;
  return abs;
}

async function listMarkdown(dir) {
  const out = [];
  async function walk(d) {
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && /\.(md|markdown|txt)$/i.test(e.name)) out.push(full);
    }
  }
  await walk(dir);
  return out;
}

// ── markdown → heading chunks ───────────────────────────────────────────────
function chunkMarkdown(text, relPath) {
  const lines = text.split(/\r?\n/);
  const chunks = [];
  let heading = relPath; // preamble (before first heading) is titled by file
  let body = [];
  const flush = () => {
    const t = body.join("\n").trim();
    if (t || heading !== relPath) chunks.push({ path: relPath, heading, text: t });
    body = [];
  };
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) { flush(); heading = m[2].trim(); }
    else body.push(line);
  }
  flush();
  return chunks.filter((c) => c.text || c.heading);
}

// ── tokenizer + BM25 ────────────────────────────────────────────────────────
const STOP = new Set("a an and are as at be but by for from has have i if in is it its of on or that the their this to was were will with you your".split(" "));
function tokenize(s) {
  return (s.toLowerCase().match(/[a-z0-9]{2,}/g) || []).filter((t) => !STOP.has(t));
}

// Pure ranking over chunks — swap this for a vector search later, same signature.
function searchChunks(chunks, query, limit) {
  const q = tokenize(query);
  if (!q.length || !chunks.length) return [];
  const docs = chunks.map((c) => tokenize(c.heading + " " + c.text));
  const N = docs.length;
  const avgdl = docs.reduce((a, d) => a + d.length, 0) / N || 1;
  // document frequency per query term
  const df = new Map();
  for (const term of new Set(q)) {
    let n = 0;
    for (const d of docs) if (d.includes(term)) n++;
    df.set(term, n);
  }
  const k1 = 1.5, b = 0.75;
  const scored = chunks.map((c, i) => {
    const d = docs[i];
    const tf = new Map();
    for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const term of q) {
      const f = tf.get(term);
      if (!f) continue;
      const idf = Math.log(1 + (N - df.get(term) + 0.5) / (df.get(term) + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (d.length / avgdl)));
    }
    return { chunk: c, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

function snippet(text, max = 200) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}
function slug(s) {
  return (s || "note").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "note";
}
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const READ_CLAMP = 8000; // keep tool results small for the realtime model

export default {
  id: "memory",
  name: "Memory (local brain)",
  description: "Voxa's local brain — a folder of Markdown notes you can search, read, and write to by voice. Offline, no API key.",
  icon: "🧠",
  defaultEnabled: true, // ships on — the brain works out of the box (no required config)

  config: [
    { key: "brainDir", label: "Brain folder", type: "text",
      placeholder: defaultBrainDir(),
      help: "Folder of .md files Voxa searches and writes to. Leave blank for the default, or point at an Obsidian vault." },
    { key: "maxResults", label: "Max search results", type: "number", default: 5,
      help: "How many note sections memory_search returns." },
  ],

  async test(cfg) {
    const dir = brainDirOf(cfg);
    const files = await listMarkdown(dir);
    return { ok: true, message: `Brain at ${dir} — ${files.length} note file(s).` };
  },

  actions: [
    {
      name: "memory_search",
      description: "Search the user's personal notes/brain for anything they've saved or written. Use this whenever the user asks what they noted, decided, or remember about a topic. Returns the most relevant note sections with their file paths.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for, in natural language or keywords." },
          limit: { type: "number", description: "Max results (default 5)." },
        },
        required: ["query"],
      },
      async handler(args, cfg) {
        const dir = brainDirOf(cfg);
        const files = await listMarkdown(dir);
        if (!files.length) return { result: `The brain at ${dir} is empty — nothing saved yet.` };
        const chunks = [];
        for (const f of files) {
          try { chunks.push(...chunkMarkdown(await fs.readFile(f, "utf8"), path.relative(dir, f).replace(/\\/g, "/"))); }
          catch { /* skip unreadable */ }
        }
        const limit = Math.max(1, Math.min(10, Number(args.limit) || Number(cfg?.maxResults) || 5));
        const hits = searchChunks(chunks, args.query, limit);
        if (!hits.length) return { result: `No notes matched "${args.query}".` };
        const lines = hits.map((h, i) =>
          `${i + 1}. [${h.chunk.path}${h.chunk.heading !== h.chunk.path ? " › " + h.chunk.heading : ""}] ${snippet(h.chunk.text)}`);
        return { result: `Found ${hits.length} note section(s) for "${args.query}":\n${lines.join("\n")}` };
      },
    },
    {
      name: "memory_read",
      description: "Read a full note file from the brain by its path (as returned by memory_search or memory_list). Use when a search snippet isn't enough and you need the whole note.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Relative note path, e.g. 'projects/voxa.md'." } },
        required: ["path"],
      },
      async handler(args, cfg) {
        const dir = brainDirOf(cfg);
        const abs = await safeJoin(dir, args.path);
        if (!abs) return { error: "Path is outside the brain folder." };
        try {
          const text = await fs.readFile(abs, "utf8");
          return { result: text.length > READ_CLAMP ? text.slice(0, READ_CLAMP) + "\n…[truncated]" : text };
        } catch { return { error: `No note at ${args.path}.` }; }
      },
    },
    {
      name: "memory_save",
      description: "Save a note to the user's brain. Use when the user says to remember, note, or write something down. Without a title it appends to today's daily note; with a title it writes/append to that topic note.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The note content to save." },
          title: { type: "string", description: "Optional topic title; omit to append to the daily note." },
        },
        required: ["text"],
      },
      async handler(args, cfg) {
        const dir = brainDirOf(cfg);
        const text = String(args.text || "").trim();
        if (!text) return { error: "Nothing to save — text was empty." };
        const now = new Date();
        let rel, entry;
        if (args.title && args.title.trim()) {
          rel = `${slug(args.title)}.md`;
          entry = `\n## ${args.title.trim()}\n${text}\n`;
        } else {
          rel = path.join("daily", `${ymd(now)}.md`).replace(/\\/g, "/");
          entry = `- ${now.toTimeString().slice(0, 5)} ${text}\n`;
        }
        const abs = await safeJoin(dir, rel);
        if (!abs) return { error: "Resolved path is outside the brain folder." };
        try {
          await fs.mkdir(path.dirname(abs), { recursive: true });
          let head = "";
          try { await fs.access(abs); } catch { head = `# ${args.title?.trim() || ymd(now)}\n`; }
          await fs.appendFile(abs, head + entry);
          return { result: `Saved to ${rel}.` };
        } catch (e) { return { error: `Could not save: ${e.message}` }; }
      },
    },
    {
      name: "memory_list",
      description: "List the note files in the brain (paths + titles). Use to see what's saved or to find a path to memory_read.",
      parameters: { type: "object", properties: {} },
      async handler(_args, cfg) {
        const dir = brainDirOf(cfg);
        const files = await listMarkdown(dir);
        if (!files.length) return { result: `The brain at ${dir} is empty.` };
        const rows = [];
        for (const f of files.slice(0, 50)) {
          const rel = path.relative(dir, f).replace(/\\/g, "/");
          let title = rel;
          try { const m = /^#\s+(.+)$/m.exec(await fs.readFile(f, "utf8")); if (m) title = m[1].trim(); } catch {}
          rows.push(`• ${rel}${title !== rel ? `  — ${title}` : ""}`);
        }
        return { result: `${files.length} note(s):\n${rows.join("\n")}` };
      },
    },
  ],
};
