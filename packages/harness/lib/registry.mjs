// Connector registry — discovers and loads connector plugins from connectors/<id>/index.mjs.
//
// A connector is a plain ES module default-exporting a manifest:
//
//   export default {
//     id: "grenton",                       // unique, lowercase
//     name: "Grenton Home",                // display name
//     description: "...",                  // one-liner for the UI + model
//     icon: "◈",                           // optional glyph for the UI
//     config: [                            // fields rendered in the config form
//       { key, label, type, placeholder?, default?, required?, secret?, help? }
//     ],
//     async test(config) { return { ok, message } },   // optional connectivity check
//     actions: [                           // voice tools this connector exposes
//       {
//         name: "grenton_light_on",        // globally-unique tool name (prefix with id)
//         description: "...",
//         parameters: { type:"object", properties:{...}, required:[...] }, // JSON Schema
//         async handler(args, config) { return { result } | { error } },
//       },
//     ],
//   };
//
// That's the entire contract. See BUILDING-A-CONNECTOR.md.
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONNECTORS_DIR = join(__dirname, "..", "connectors");

const connectors = new Map();

export async function loadConnectors() {
  connectors.clear();
  let entries = [];
  try {
    entries = await readdir(CONNECTORS_DIR, { withFileTypes: true });
  } catch {
    return connectors;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = join(CONNECTORS_DIR, e.name, "index.mjs");
    try {
      const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
      const m = mod.default;
      if (!m || !m.id) { console.error(`[harness] ${e.name}: missing default export / id`); continue; }
      m.config = Array.isArray(m.config) ? m.config : [];
      m.actions = Array.isArray(m.actions) ? m.actions : [];
      connectors.set(m.id, m);
      console.error(`[harness] loaded connector "${m.id}" (${m.actions.length} actions)`);
    } catch (err) {
      console.error(`[harness] failed to load connector ${e.name}:`, err?.message || err);
    }
  }
  return connectors;
}

export function getConnector(id) { return connectors.get(id); }
export function allConnectors() { return [...connectors.values()]; }

// Mask secret fields before sending config to the browser.
export function maskConfig(manifest, config = {}) {
  const out = {};
  for (const f of manifest.config) {
    const v = config[f.key];
    if (f.secret && v) out[f.key] = "••••••••";
    else if (v !== undefined) out[f.key] = v;
    else if (f.default !== undefined) out[f.key] = f.default;
  }
  return out;
}

// Resolve effective config (stored over defaults) for execution. Never masked.
export function effectiveConfig(manifest, stored = {}) {
  const out = {};
  for (const f of manifest.config) {
    out[f.key] = stored[f.key] !== undefined ? stored[f.key] : f.default;
  }
  return out;
}
