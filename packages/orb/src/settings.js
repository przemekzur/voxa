// Voxa Settings window logic. Reads voxa-config.json via the orb's Tauri command
// (read_local_config) and the Gemini key from shared localStorage; writes both
// back. The orb applies the config on its next session.

import { BUILTIN_SOULS, DEFAULT_SOUL_ID, CUSTOM_SOUL_ID, getSoul } from "./souls.js";

const TAURI = window.__TAURI__;
const invoke = TAURI?.core?.invoke;
const $ = (id) => document.getElementById(id);
const KEY_LS = "voxa.geminiKey";

let cfg = {};                 // last-read config (so save preserves unmanaged fields)
const setStatus = (m) => { $("status").textContent = m || ""; };

// Built-in souls merged with the user's saved per-soul overrides (cfg.souls).
function souls() {
  const over = cfg.souls || {};
  return BUILTIN_SOULS.map((s) => ({ ...s, ...(over[s.id] || {}) }));
}
function soulById(id) { return souls().find((s) => s.id === id) || null; }

function buildSoulMenu(selectedId) {
  const sel = $("soul");
  sel.innerHTML = "";
  for (const s of souls()) {
    const o = document.createElement("option");
    o.value = s.id; o.textContent = s.name;
    sel.appendChild(o);
  }
  const custom = document.createElement("option");
  custom.value = CUSTOM_SOUL_ID; custom.textContent = "Custom…";
  sel.appendChild(custom);
  sel.value = selectedId;
  updateTagline();
}
function updateTagline() {
  const s = soulById($("soul").value);
  $("soulTag").textContent = s?.tagline || "Your own persona — edit the instruction below.";
}

// Fill the editable fields from a soul (used on persona change / reset).
function fillFromSoul(id) {
  const s = soulById(id);
  if (!s) return;
  $("personaName").value = s.name || "";
  $("instruction").value = s.instruction || "";
  if (s.voice) $("voiceName").value = s.voice;
  updateTagline();
}

async function load() {
  try { cfg = JSON.parse((invoke ? await invoke("read_local_config") : localStorage.getItem("voxa.config")) || "{}"); }
  catch { cfg = {}; }

  const v = cfg.voice || {};
  $("provider").value = v.provider || "gemini";
  $("model").value = v.model || "";
  if (v.voiceName) $("voiceName").value = v.voiceName;
  $("source").value = (Array.isArray(cfg.sources) && cfg.sources[0]?.url) || "http://localhost:3010";
  try { $("key").value = localStorage.getItem(KEY_LS) || ""; } catch {}
  try { $("openaiKey").value = localStorage.getItem("voxa.openaiKey") || ""; } catch {}
  $("openaiVoice").value = v.openaiVoice || "";
  $("daemonUrl").value = v.daemonUrl || "";
  try { if (invoke) $("brainDir").value = await invoke("brain_dir"); } catch {}

  // Persona: reflect the saved active persona; default to Voxa.
  const p = cfg.persona || {};
  const activeId = p.soul || DEFAULT_SOUL_ID;
  buildSoulMenu(getSoul(activeId) || cfg.souls?.[activeId] ? activeId : CUSTOM_SOUL_ID);
  // Prefer the live saved persona text over the preset, so edits show on reopen.
  $("personaName").value = p.name || soulById(activeId)?.name || "Voxa";
  $("instruction").value = p.instruction || soulById(activeId)?.instruction || "";
  updateTagline();
}

async function save() {
  // Read-merge so we never drop fields this form doesn't manage (appearance, ui, focus…).
  let base = {};
  try { base = JSON.parse((invoke ? await invoke("read_local_config") : "{}") || "{}"); } catch {}

  base.voice = {
    ...(base.voice || {}),
    provider: $("provider").value,
    model: $("model").value.trim() || "gemini-3.1-flash-live-preview",
    voiceName: $("voiceName").value,
    openaiVoice: $("openaiVoice").value.trim(),
    daemonUrl: $("daemonUrl").value.trim(),
  };

  const soulId = $("soul").value;
  const name = $("personaName").value.trim();
  const instruction = $("instruction").value.trim();
  base.persona = { soul: soulId, name, instruction };
  // Persist the (possibly edited) text as a per-soul override so re-selecting a
  // persona shows your version, not the built-in.
  if (soulId !== CUSTOM_SOUL_ID) {
    base.souls = { ...(base.souls || {}), [soulId]: { name, instruction, voice: $("voiceName").value } };
  }

  const url = $("source").value.trim();
  if (url) base.sources = [{ url }];

  try {
    const json = JSON.stringify(base, null, 2);
    if (invoke) await invoke("write_local_config", { contents: json });
    else localStorage.setItem("voxa.config", json);
    const k = $("key").value.trim();
    if (k) localStorage.setItem(KEY_LS, k);
    const ok = $("openaiKey").value.trim();
    if (ok) localStorage.setItem("voxa.openaiKey", ok);
    cfg = base;
    setStatus("Saved — tap the orb to apply.");
  } catch (e) { setStatus("Save failed: " + (e?.message || e)); }
}

$("soul").addEventListener("change", () => {
  const id = $("soul").value;
  if (id === CUSTOM_SOUL_ID) { updateTagline(); return; }
  fillFromSoul(id);
});
$("resetSoul").addEventListener("click", () => {
  const id = $("soul").value;
  const builtin = getSoul(id);
  if (!builtin) return;
  $("personaName").value = builtin.name;
  $("instruction").value = builtin.instruction;
  $("voiceName").value = builtin.voice;
  // Drop any saved override for this soul on next save.
  if (cfg.souls) delete cfg.souls[id];
  setStatus("Reset to preset — Save to keep.");
});
$("openBrain").addEventListener("click", () => { try { invoke?.("open_brain_folder"); } catch (e) { setStatus("Open failed: " + (e?.message || e)); } });
// Open the connector manager (harness UI) as an app window — same "connectors"
// label the orb uses, so there's only ever one manager window.
$("openConnectors").addEventListener("click", async () => {
  const url = ($("source").value.trim() || "http://localhost:3010").replace(/\/+$/, "");
  const WW = TAURI?.webviewWindow?.WebviewWindow || TAURI?.window?.WebviewWindow;
  if (!WW) { try { window.open(url, "_blank"); } catch {} return; }
  try {
    const existing = await WW.getByLabel("connectors");
    if (existing) { await existing.setFocus(); return; }
    new WW("connectors", {
      url, title: "Voxa Connectors",
      width: 1080, height: 760, resizable: true, decorations: true,
      transparent: false, alwaysOnTop: false, focus: true, center: true,
    });
  } catch (e) { setStatus("Couldn't open connectors: " + (e?.message || e)); }
});
$("save").addEventListener("click", save);
$("close").addEventListener("click", async () => {
  try { await TAURI?.window?.getCurrentWindow?.().close(); } catch { window.close(); }
});
load();
