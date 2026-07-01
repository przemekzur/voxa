#!/usr/bin/env node
// Export / import the connector-harness state — enabled flags, per-connector
// config, AND the secret store — so it can travel through the repo (e.g. to set
// up a new machine with `git pull`).
//
// ⚠️  SECURITY WARNING ⚠️
// state-snapshot.json contains PLAINTEXT SECRETS (API keys, OAuth tokens). This
// is a DELIBERATE, TEMPORARY convenience for syncing your own machines. Do not
// keep it in a shared/public repo long-term, and ROTATE the keys once you move
// to a proper secret store. The live state (data/connectors.json) stays
// gitignored — only this snapshot is committed.
//
//   node state-sync.mjs export   # data/connectors.json -> state-snapshot.json (commit this)
//   node state-sync.mjs import   # state-snapshot.json  -> data/connectors.json (then restart the harness)
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIVE = join(__dirname, "data", "connectors.json");
const SNAP = join(__dirname, "state-snapshot.json");
const ids = (state) => Object.keys(state || {}).filter((k) => !k.startsWith("__"));

async function doExport() {
  if (!existsSync(LIVE)) { console.error(`No live state at ${LIVE} — start/use the harness first.`); process.exit(1); }
  const state = JSON.parse(await readFile(LIVE, "utf8"));
  const snapshot = {
    _warning: "CONTAINS PLAINTEXT SECRETS (API keys / OAuth tokens). Temporary convenience for syncing machines via git. Do NOT publish; rotate keys when you remove this.",
    exportedAt: new Date().toISOString(),
    state,
  };
  await writeFile(SNAP, JSON.stringify(snapshot, null, 2), "utf8");
  console.log(`Exported ${ids(state).length} connectors${state.__secrets ? " + secret store" : ""} -> ${SNAP}`);
  console.log("Commit state-snapshot.json to carry enablement + config + secrets to another machine.");
}

async function doImport() {
  if (!existsSync(SNAP)) { console.error(`No snapshot at ${SNAP} — pull the repo (or run export first).`); process.exit(1); }
  const snap = JSON.parse(await readFile(SNAP, "utf8"));
  const state = snap.state || snap; // tolerate a raw connectors.json too
  await mkdir(dirname(LIVE), { recursive: true });
  if (existsSync(LIVE)) await copyFile(LIVE, LIVE + ".bak");
  await writeFile(LIVE, JSON.stringify(state, null, 2), "utf8");
  console.log(`Imported ${ids(state).length} connectors${state.__secrets ? " + secret store" : ""} -> ${LIVE}${existsSync(LIVE + ".bak") ? " (previous backed up to connectors.json.bak)" : ""}`);
  console.log("Restart the harness (or the desktop) so the running process loads the new state.");
}

const cmd = process.argv[2];
if (cmd === "export") await doExport();
else if (cmd === "import") await doImport();
else { console.error("usage: node state-sync.mjs export | import"); process.exit(1); }
