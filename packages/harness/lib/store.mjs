// Tiny JSON-file persistence for connector state (enabled flag + config/secrets).
// Server-side only — secrets never go to the browser unmasked. One file keeps the
// spike dependency-free and easy to inspect/back up.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.VOXA_DATA_DIR || join(__dirname, "..", "data");
const DATA_FILE = join(DATA_DIR, "connectors.json");

let cache = null;

async function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(DATA_FILE, "utf8"));
  } catch {
    cache = {}; // { [connectorId]: { enabled: bool, config: {...} } }
  }
  return cache;
}

async function persist() {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(cache, null, 2), "utf8");
}

export async function getState(id) {
  const all = await load();
  return all[id] || { enabled: false, config: {} };
}

export async function getAllState() {
  return { ...(await load()) };
}

export async function setState(id, partial) {
  const all = await load();
  const cur = all[id] || { enabled: false, config: {} };
  all[id] = {
    enabled: partial.enabled ?? cur.enabled,
    config: { ...cur.config, ...(partial.config || {}) },
  };
  await persist();
  return all[id];
}

// Remove a single config key from a state entry (e.g. unset a secret).
export async function unsetConfigKey(id, key) {
  const all = await load();
  const cur = all[id];
  if (!cur || !cur.config || !(key in cur.config)) return false;
  delete cur.config[key];
  await persist();
  return true;
}
