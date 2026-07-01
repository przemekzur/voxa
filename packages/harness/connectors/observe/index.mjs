// Observe connector — the durable note store behind Voxa's "Listen & Observe"
// mode. While that mode is active Voxa listens to a conversation (e.g. a
// Discord call), takes NO actions, and quietly captures salient points here.
//
// Notes are grouped into named "sessions" (one per conversation) and each note
// is timestamped. This store is DELIBERATELY SEPARATE from `lists` and any
// normal notes — it's observation-mode only. Reflection (summarizing, pulling
// action points) is done by the model reading these back ON REQUEST; nothing
// here acts on its own.
//
//   data/observe.json:
//   { "active": "<id>|null",
//     "sessions": { "<id>": { id, name, startedAt, endedAt, notes:[{text,ts}] } } }
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");
const DATA_FILE = join(DATA_DIR, "observe.json");

async function load() {
  try { const v = JSON.parse(await readFile(DATA_FILE, "utf8")); return v && typeof v === "object" ? v : { active: null, sessions: {} }; }
  catch { return { active: null, sessions: {} }; }
}
async function save(db) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(db, null, 2), "utf8");
}

let _seq = 0;
const newId = () => `obs-${Date.now().toString(36)}${(_seq++).toString(36)}`;
const hhmm = (ts) => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const dayLabel = (ts) => new Date(ts).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const fold = (s) => String(s || "").trim().toLowerCase();

// Resolve a session by name keyword or id; default to the active one.
function resolve(db, ref) {
  if (!ref) return db.sessions[db.active] || null;
  const q = fold(ref);
  if (db.sessions[ref]) return db.sessions[ref];
  return Object.values(db.sessions).find((s) => fold(s.name).includes(q)) || null;
}
// Get the active session, creating a date-named default if there is none.
function activeOrCreate(db) {
  let s = db.sessions[db.active];
  if (!s) {
    const id = newId();
    s = { id, name: `Conversation ${dayLabel(Date.now())}`, startedAt: Date.now(), endedAt: null, notes: [] };
    db.sessions[id] = s;
    db.active = id;
  }
  return s;
}

export default {
  id: "observe",
  name: "Observations (Listen & Observe)",
  description: "Durable, timestamped notes captured during Voxa's Listen & Observe mode. Separate from lists; for reflecting on later, never acted on automatically.",
  icon: "👁",
  config: [],

  async test() {
    const db = await load();
    const n = Object.keys(db.sessions).length;
    const active = db.sessions[db.active]?.name;
    return { ok: true, message: n ? `Ready. ${n} observation session(s)${active ? `, active: "${active}"` : ""}.` : "Ready. No observation sessions yet." };
  },

  actions: [
    {
      name: "observe_start_session",
      description: "Begin a new observation session for a conversation and make it active. Give it a short name based on who/what it's about, e.g. 'Call with Anna' or 'Discord standup'. New notes attach to this session.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Short conversation name." } },
        required: ["name"],
      },
      async handler(args) {
        const name = String(args.name || "").trim();
        if (!name) return { error: "Give the conversation a short name." };
        const db = await load();
        const id = newId();
        db.sessions[id] = { id, name, startedAt: Date.now(), endedAt: null, notes: [] };
        db.active = id;
        await save(db);
        return { result: `Now observing "${name}".` };
      },
    },
    {
      name: "observe_note",
      description: "Save one observation/note from the current conversation (timestamped). Capture a salient point, fact, decision, name, or follow-up — concise. Starts a default session if none is active.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "The note text." } },
        required: ["text"],
      },
      async handler(args) {
        const text = String(args.text || "").trim();
        if (!text) return { error: "Nothing to note." };
        const db = await load();
        const s = activeOrCreate(db);
        s.notes.push({ text, ts: Date.now() });
        await save(db);
        return { result: `Noted (${s.notes.length} in "${s.name}").` };
      },
    },
    {
      name: "observe_read",
      description: "Read back the timestamped notes from an observation session (the active one by default, or pass a name keyword). Use this when the user asks to reflect on or review what was observed.",
      parameters: {
        type: "object",
        properties: {
          session: { type: "string", description: "Session name keyword. Optional — defaults to the active session." },
          limit: { type: "integer", description: "Max notes to return (most recent). Optional." },
        },
      },
      async handler(args) {
        const db = await load();
        const s = resolve(db, args.session);
        if (!s) return { result: args.session ? `No observation session matching "${args.session}".` : "No active observation session." };
        let notes = s.notes;
        const limit = parseInt(args.limit, 10);
        if (Number.isFinite(limit) && limit > 0) notes = notes.slice(-limit);
        if (!notes.length) return { result: `"${s.name}" has no notes yet.` };
        return { result: `"${s.name}" (${s.notes.length} notes): ` + notes.map((n) => `[${hhmm(n.ts)}] ${n.text}`).join(" · ") };
      },
    },
    {
      name: "observe_sessions",
      description: "List saved observation sessions (name, note count, and when), most recent first.",
      parameters: { type: "object", properties: {} },
      async handler() {
        const db = await load();
        const all = Object.values(db.sessions).sort((a, b) => b.startedAt - a.startedAt);
        if (!all.length) return { result: "No observation sessions yet." };
        return { result: all.slice(0, 12).map((s) => `"${s.name}" — ${s.notes.length} notes, ${dayLabel(s.startedAt)}${s.id === db.active ? " (active)" : ""}`).join("; ") };
      },
    },
    {
      name: "observe_end_session",
      description: "Close the active observation session. Its notes are kept; new notes will start a fresh session.",
      parameters: { type: "object", properties: {} },
      async handler() {
        const db = await load();
        const s = db.sessions[db.active];
        if (!s) return { result: "No active observation session." };
        s.endedAt = Date.now();
        db.active = null;
        await save(db);
        return { result: `Closed "${s.name}" (${s.notes.length} notes saved).` };
      },
    },
  ],
};
