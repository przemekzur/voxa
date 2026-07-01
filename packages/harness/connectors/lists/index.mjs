// Lists & notes connector — voice-friendly named lists (shopping, todo, ideas…).
// Pure-local, no external service: items live in a small JSON file next to the
// connector state. Perfect for "add milk to the shopping list" / "what's on my
// todo list" / "remind me to call the dentist".
//
// Shape on disk (data/lists.json):
//   { "shopping": [ { "text": "milk", "ts": 1718000000000 } ], "todo": [ ... ] }
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");
const DATA_FILE = join(DATA_DIR, "lists.json");

async function load() {
  try { return JSON.parse(await readFile(DATA_FILE, "utf8")); }
  catch { return {}; }
}
async function save(data) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

// Normalize a spoken list name. Empty / "the list" / "my list" → the default.
function listName(cfg, raw) {
  const def = (cfg.defaultList || "general").trim().toLowerCase() || "general";
  const s = String(raw || "").trim().toLowerCase()
    .replace(/^(my|the)\s+/, "").replace(/\s+list$/, "").trim();
  return s || def;
}
const fold = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

export default {
  id: "lists",
  name: "Lists & Notes",
  description: "Keep named lists (shopping, todo, ideas) by voice: add, read, remove and clear items. Local only.",
  icon: "▤",

  config: [
    { key: "defaultList", label: "Default list name", type: "text", default: "general", help: "Used when a request doesn't name a list (e.g. 'add milk')." },
  ],

  async test() {
    const data = await load();
    const names = Object.keys(data);
    return { ok: true, message: names.length ? `Ready. ${names.length} list(s): ${names.join(", ")}.` : "Ready. No lists yet." };
  },

  actions: [
    {
      name: "lists_add",
      description: "Add an item to a named list (e.g. add 'milk' to 'shopping'). Omit list to use the default list.",
      parameters: {
        type: "object",
        properties: {
          item: { type: "string", description: "The item / note text to add." },
          list: { type: "string", description: "List name, e.g. 'shopping' or 'todo'. Optional." },
        },
        required: ["item"],
      },
      async handler(args, cfg) {
        const item = String(args.item || "").trim();
        if (!item) return { error: "Nothing to add — item is empty." };
        const name = listName(cfg, args.list);
        const data = await load();
        const arr = (data[name] ||= []);
        if (arr.some((x) => fold(x.text) === fold(item))) return { result: `"${item}" is already on the ${name} list.` };
        arr.push({ text: item, ts: Date.now() });
        await save(data);
        return { result: `Added "${item}" to the ${name} list (${arr.length} item${arr.length === 1 ? "" : "s"}).` };
      },
    },
    {
      name: "lists_read",
      description: "Read out the items on a named list. Omit list to use the default list.",
      parameters: {
        type: "object",
        properties: { list: { type: "string", description: "List name. Optional." } },
      },
      async handler(args, cfg) {
        const name = listName(cfg, args.list);
        const data = await load();
        const arr = data[name] || [];
        if (!arr.length) return { result: `The ${name} list is empty.` };
        return { result: `${name} (${arr.length}): ${arr.map((x) => x.text).join(", ")}.` };
      },
    },
    {
      name: "lists_remove",
      description: "Remove an item from a named list by name (fuzzy match). Omit list to use the default list.",
      parameters: {
        type: "object",
        properties: {
          item: { type: "string", description: "The item to remove (approximate text is fine)." },
          list: { type: "string", description: "List name. Optional." },
        },
        required: ["item"],
      },
      async handler(args, cfg) {
        const name = listName(cfg, args.list);
        const target = fold(args.item);
        if (!target) return { error: "No item given to remove." };
        const data = await load();
        const arr = data[name] || [];
        let idx = arr.findIndex((x) => fold(x.text) === target);
        if (idx < 0) idx = arr.findIndex((x) => fold(x.text).includes(target) || target.includes(fold(x.text)));
        if (idx < 0) return { result: `Couldn't find "${args.item}" on the ${name} list.` };
        const [gone] = arr.splice(idx, 1);
        await save(data);
        return { result: `Removed "${gone.text}" from the ${name} list (${arr.length} left).` };
      },
    },
    {
      name: "lists_clear",
      description: "Clear (empty) a named list entirely. Omit list to use the default list.",
      parameters: {
        type: "object",
        properties: { list: { type: "string", description: "List name. Optional." } },
      },
      async handler(args, cfg) {
        const name = listName(cfg, args.list);
        const data = await load();
        const n = (data[name] || []).length;
        delete data[name];
        await save(data);
        return { result: n ? `Cleared the ${name} list (${n} item${n === 1 ? "" : "s"} removed).` : `The ${name} list was already empty.` };
      },
    },
    {
      name: "lists_all",
      description: "List the names of all lists and how many items each has.",
      parameters: { type: "object", properties: {} },
      async handler() {
        const data = await load();
        const names = Object.keys(data).filter((k) => (data[k] || []).length);
        if (!names.length) return { result: "No lists yet." };
        return { result: names.map((n) => `${n} (${data[n].length})`).join(", ") + "." };
      },
    },
  ],
};
