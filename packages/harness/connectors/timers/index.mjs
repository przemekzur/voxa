// Timers connector — voice countdown timers, pure-local.
//
// NOTE on firing: the harness is request/response — it cannot push a "ding" to
// the orb on its own. Timers are tracked by wall-clock and queryable: the agent
// sets one, asks for remaining time, and calls timers_check to learn which have
// elapsed (the orb can announce them when it polls). Set/list/cancel/check.
//
// Shape on disk (data/timers.json):
//   [ { "id": "t1", "label": "pasta", "endsAt": 1718000000000, "durationSec": 600 } ]
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");
const DATA_FILE = join(DATA_DIR, "timers.json");

async function load() {
  try { const v = JSON.parse(await readFile(DATA_FILE, "utf8")); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
async function save(arr) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(arr, null, 2), "utf8");
}

// Humanize a duration in seconds to a short spoken phrase.
function human(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s && !h) parts.push(`${s}s`);
  return parts.join(" ") || "0s";
}

let _seq = 0;
const newId = () => `t${Date.now().toString(36)}${(_seq++).toString(36)}`;

export default {
  id: "timers",
  name: "Timers",
  description: "Set and track countdown timers by voice. Set, list remaining, cancel, and check which have elapsed.",
  icon: "◷",

  config: [],

  async test() {
    const arr = await load();
    return { ok: true, message: arr.length ? `Ready. ${arr.length} active timer(s).` : "Ready. No timers running." };
  },

  actions: [
    {
      name: "timers_set",
      description: "Start a countdown timer. Give the duration in minutes (decimals allowed for seconds, e.g. 0.5 = 30 seconds) and an optional label like 'pasta' or 'laundry'.",
      parameters: {
        type: "object",
        properties: {
          minutes: { type: "number", description: "Duration in minutes. 0.5 = 30 seconds." },
          label: { type: "string", description: "Optional name for the timer, e.g. 'pasta'." },
        },
        required: ["minutes"],
      },
      async handler(args) {
        const minutes = Number(args.minutes);
        if (!isFinite(minutes) || minutes <= 0) return { error: "Give a positive number of minutes." };
        const durationSec = Math.round(minutes * 60);
        const label = String(args.label || "").trim() || "timer";
        const arr = await load();
        arr.push({ id: newId(), label, endsAt: Date.now() + durationSec * 1000, durationSec });
        await save(arr);
        return { result: `${label} timer set for ${human(durationSec)}.` };
      },
    },
    {
      name: "timers_list",
      description: "List all active timers with their remaining time.",
      parameters: { type: "object", properties: {} },
      async handler() {
        const now = Date.now();
        const arr = (await load()).filter((t) => t.endsAt > now);
        await save(arr); // drop any already-elapsed on read
        if (!arr.length) return { result: "No active timers." };
        return { result: arr.map((t) => `${t.label}: ${human((t.endsAt - now) / 1000)} left`).join(", ") + "." };
      },
    },
    {
      name: "timers_cancel",
      description: "Cancel a timer by label, or cancel all timers. Omit label and pass all=true to clear everything.",
      parameters: {
        type: "object",
        properties: {
          label: { type: "string", description: "Label of the timer to cancel (fuzzy match)." },
          all: { type: "boolean", description: "Cancel every active timer." },
        },
      },
      async handler(args) {
        let arr = await load();
        if (args.all) {
          const n = arr.length;
          await save([]);
          return { result: n ? `Cancelled all ${n} timer(s).` : "No timers to cancel." };
        }
        const want = String(args.label || "").trim().toLowerCase();
        if (!want) return { error: "Give a timer label, or pass all=true." };
        let idx = arr.findIndex((t) => t.label.toLowerCase() === want);
        if (idx < 0) idx = arr.findIndex((t) => t.label.toLowerCase().includes(want));
        if (idx < 0) return { result: `No timer named "${args.label}".` };
        const [gone] = arr.splice(idx, 1);
        await save(arr);
        return { result: `Cancelled the ${gone.label} timer.` };
      },
    },
    {
      name: "timers_check",
      description: "Return timers that have finished since the last check (and remove them). Use this to announce when a timer is up.",
      parameters: { type: "object", properties: {} },
      async handler() {
        const now = Date.now();
        const arr = await load();
        const done = arr.filter((t) => t.endsAt <= now);
        const stillRunning = arr.filter((t) => t.endsAt > now);
        if (done.length !== arr.length) await save(stillRunning);
        if (!done.length) return { result: "No timers have finished." };
        return { result: `Finished: ${done.map((t) => t.label).join(", ")}.` };
      },
    },
  ],
};
