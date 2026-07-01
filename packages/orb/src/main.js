// ── Voxa orb shell ──────────────────────────────────────────────────────
// Frameless, transparent, always-on-top window wired to the SAME voice stack
// as experiments/realtime-voice: GeminiSession (Gemini Live, open mic, server
// VAD) + multi-source ToolBridge (brain :3000 + connector harness :3010).
//
// Tap the orb → live session. Tap again → stop. Chevron → expanded, resizable
// conversation view (window grows upward, bottom edge stays anchored). Gear →
// mic device picker (hot-swaps mid-session). The Gemini API key is asked for
// once and kept in this window's localStorage (orb origin = tauri.localhost).

import { GeminiSession } from "./js/gemini.js";
import { OpenAiSession } from "./js/openai.js";
import { DaemonSession } from "./js/daemon.js";
import { ToolBridge } from "./js/tools.js";
import { createOrb } from "./js/orb.js";
import { FocusManager } from "./js/focus.js";
import { SKINS, PALETTES, SKIN_ORDER, PALETTE_ORDER, DEFAULT_SKIN, DEFAULT_PALETTE, getSkin, getPalette, resolveSkin, resolvePalette, extendAppearance, LAYOUTS, LAYOUT_ORDER, DEFAULT_LAYOUT, getLayout, resolveLayout } from "./js/skins.js";

const TAURI = window.__TAURI__;
const els = {
  body: document.body,
  orb: document.getElementById("orb"),
  orbCanvas: document.getElementById("orbCanvas"),
  status: document.getElementById("status"),
  line: document.getElementById("line"),
  nowplaying: document.getElementById("nowplaying"),
  npIcon: document.getElementById("npIcon"),
  npText: document.getElementById("npText"),
  feed: document.getElementById("feed"),
  settings: document.getElementById("settings"),
  micSel: document.getElementById("micSel"),
  micGain: document.getElementById("micGain"),
  micGainVal: document.getElementById("micGainVal"),
  micMeter: document.getElementById("micMeter"),
  noiseSuppress: document.getElementById("noiseSuppress"),
  autoGain: document.getElementById("autoGain"),
  vadSel: document.getElementById("vadSel"),
  rekey: document.getElementById("rekey"),
  brand: document.getElementById("brand"),
  gear: document.getElementById("gear"),
  expand: document.getElementById("expand"),
  key: document.getElementById("key"),
  close: document.getElementById("close"),
  clearMem: document.getElementById("clearMem"),
  wave: document.getElementById("wave"),
  wave2: document.getElementById("wave2"),
  composer: document.getElementById("composer"),
  composerInput: document.getElementById("composerInput"),
  ptt: document.getElementById("ptt"),
  send: document.getElementById("send"),
  hint: document.getElementById("hint"),
};
if (!TAURI) els.body.classList.add("web-preview");

// Procedural holographic orb (canvas). setOrbState drives idle/connecting/
// listening/speaking; setAudioLevel(0..1) feeds it REAL audio (see below).
const orb = createOrb(els.orbCanvas);

// ── Appearance: skin + palette (persist + apply live, no restart) ───────────
const appearance = {
  get skin() { return localStorage.getItem("voxa.skin") || DEFAULT_SKIN; },
  set skin(v) { localStorage.setItem("voxa.skin", v); },
  get palette() { return localStorage.getItem("voxa.palette") || DEFAULT_PALETTE; },
  set palette(v) { localStorage.setItem("voxa.palette", v); },
  get layout() { return localStorage.getItem("voxa.layout") || DEFAULT_LAYOUT; },
  set layout(v) { localStorage.setItem("voxa.layout", v); },
};
const curLayout = () => getLayout(appearance.layout);
let expanded = false; // window expanded (chat) state — declared early for layout sizing

// Control-state (declared early so applyAppearance()'s boot call can no-op
// refreshControls() before the panel is built — avoids a TDZ on first run).
let controlsBuilt = false;
const skinBtns = {}, palBtns = {}, modeBtns = {}, layBtns = {};
// RGB [0-255] -> [hueDeg, sat%] for driving the chrome's HSL accent variables.
function rgbToHs(c) {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return [h, s * 100];
}

function applyAppearance() {
  const sk = getSkin(appearance.skin);
  const pl = getPalette(appearance.palette);
  orb.setSkin(sk.id);
  orb.setPalette(pl.id);
  // Recolour the whole window chrome to the palette: the CSS derives every accent
  // from --hue/--sat/--hue2 (used as hsl(var(--accent))), so set those, not the
  // composed colour, or we'd break the existing hsl() usages.
  const [h, s] = rgbToHs(pl.core);
  const [h2] = rgbToHs(pl.accent);
  const root = document.documentElement.style;
  root.setProperty("--hue", String(Math.round(h)));
  root.setProperty("--sat", Math.round(s) + "%");
  root.setProperty("--hue2", String(Math.round(h2)));
  if (typeof refreshControls === "function") refreshControls();
}
function chooseSkin(id) { const s = getSkin(id); appearance.skin = s.id; applyAppearance(); return s; }
function choosePalette(id) { const p = getPalette(id); appearance.palette = p.id; applyAppearance(); return p; }
// ── Layout (window arrangement; switchable at runtime) ──────────────────────
async function growToSettings() {
  // Settings is taller than the collapsed window. Measuring is unreliable here (the
  // panel is align-self:stretch so its box is clamped to the tiny window), so grow
  // to a fixed per-layout settings size that comfortably fits all controls.
  // `settings-open` top-aligns the panel so the controls read from the top.
  els.body.classList.add("settings-open");
  settingsGrew = true;
  const lay = curLayout();
  const w = Math.max(460, lay.collapsed.w);
  await setWindowSize(w, lay.settingsH || 480, false);
}
async function applyLayout(id, resize = true) {
  const lay = getLayout(id);
  appearance.layout = lay.id;
  for (const k of LAYOUT_ORDER) els.body.classList.toggle("lay-" + k, k === lay.id);
  if (resize && TAURI) {
    if (!els.settings.classList.contains("hidden") && !expanded) await growToSettings();
    else { const d = expanded ? lay.expanded : lay.collapsed; await setWindowSize(d.w, d.h, expanded); }
  }
  refreshControls();
}
function chooseLayout(id) { const l = getLayout(id); applyLayout(l.id); return l; }

applyAppearance();              // persisted skin + palette
applyLayout(appearance.layout); // persisted layout (body class + window size)

// Verbal control — appear in every session (pushed into LOCAL_TOOLS below).
const APPEARANCE_TOOLS = [
  {
    name: "set_skin",
    description:
      "Change the orb's visual skin/face. Options include orbit, halo, reactor, lens, holo (HUD), minimal, nebula, handoff, spectrum, and runtime custom skins. " +
      "Use when the operator says 'change the skin', 'switch to the reactor look', 'minimal mode', 'new face', etc.",
    parameters: { type: "object", properties: { skin: { type: "string", description: "Skin name or a loose description ('the iron man one' -> reactor)." } }, required: ["skin"] },
    handler: async (a) => {
      const id = resolveSkin(a?.skin);
      if (!id) return `I don't have a skin like "${a?.skin}". Try: ${SKIN_ORDER.join(", ")}.`;
      return `Switched to the ${chooseSkin(id).name} skin.`;
    },
  },
  {
    name: "set_theme",
    description:
      "Change the orb's colour palette/theme. Options: ember (orange), ice (cyan/blue), violet, emerald (green). " +
      "Use for 'make it blue', 'go violet', 'change the colour', 'theme to green'.",
    parameters: { type: "object", properties: { theme: { type: "string", description: "Palette name or colour ('blue' -> ice, 'green' -> emerald)." } }, required: ["theme"] },
    handler: async (a) => {
      const id = resolvePalette(a?.theme);
      if (!id) return `I don't have a "${a?.theme}" theme. Try: ${PALETTE_ORDER.join(", ")}.`;
      return `Theme set to ${choosePalette(id).name}.`;
    },
  },
  {
    name: "set_layout",
    description:
      "Change the orb's window LAYOUT/arrangement. Options: dock (compact slab), capsule (sculpted floating glass pill), reactor (arc-reactor HUD frame with ring + telemetry), holodock (angular holographic notched panels). " +
      "Use for 'change the layout', 'capsule mode', 'reactor frame', 'holographic dock', 'go compact'.",
    parameters: { type: "object", properties: { layout: { type: "string", description: "Layout name or description ('the pill' -> capsule, 'arc reactor' -> reactor)." } }, required: ["layout"] },
    handler: async (a) => {
      const id = resolveLayout(a?.layout);
      if (!id) return `I don't have a "${a?.layout}" layout. Try: ${LAYOUT_ORDER.join(", ")}.`;
      return `Layout set to ${chooseLayout(id).name}.`;
    },
  },
];

const SETTINGS = {
  model: "gemini-3.1-flash-live-preview",
  voice: "Puck",
  secretsUrl: "http://localhost:3010",
  sources: [
    { url: "http://localhost:3010" },  // connector harness: memory brain + connectors (Voxa is brain-free)
  ],
  systemInstruction:
    "You are Voxa, a concise, dry-witted assistant living in a small floating orb " +
    "on the operator's desktop. Keep replies short and spoken-friendly.",
  // Input + shortcut behaviour (overridable from voxa-config.json `ui`):
  //   pushToTalk false → the shortcut TOGGLES the session (open mic, server VAD).
  //   pushToTalk true  → HOLD the shortcut to talk (mic gated; released = muted).
  //   pttKey      → KeyboardEvent.code of the trigger key (e.g. "Space", "F8", "Backquote").
  //   pttModifier → "ctrl" | "alt" | "shift" | "meta" | "ctrlmeta" | "none".
  ui: { pushToTalk: false, pttKey: "Space", pttModifier: "ctrlmeta" },
  // Focus Area: let the orb attach to a running coding-agent terminal (Claude /
  // Codex / Gemini / Copilot / Devin), read it, and route prompts into it. Sends
  // are STAGED for verbal confirm unless trust is turned on. Overridable from
  // voxa-config.json `focus`.
  focus: {
    enabled: true,
    providerFilter: ["claude", "codex", "gemini", "copilot", "devin"],
    confirmBeforeSend: true,
    snapshotOnFocus: true,
    maxPromptChars: 2000,
  },
};

// ── Externalised config (authored by the desktop "Voxa" page) ────────────
// The desktop app writes voice (provider/model/name), tool sources, and the
// secrets URL to <app-data-dir>/voxa-config.json; the brain serves it at
// /api/cass/voxa-config. We merge it over SETTINGS on boot AND before each
// session, so changes made in the desktop app take effect on the orb's next
// session with no rebuild and no relaunch. If the brain (:3000) is offline or
// the file is absent we silently keep the built-in defaults above.
const CONFIG_URL = "http://localhost:3000/api/cass/voxa-config";

function applyVoxaConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return;
  if (extendAppearance(cfg.appearance)) { applyAppearance(); rebuildControls(); }
  // Personality ("soul"): the desktop authors persona.instruction; the orb uses
  // it verbatim as its system prompt (tool/brain guidance is appended later).
  if (typeof cfg.persona?.instruction === "string" && cfg.persona.instruction.trim()) {
    SETTINGS.systemInstruction = cfg.persona.instruction.trim();
  }
  // Brand badge shows the active assistant's NAME. Prefer persona.name, but the
  // desktop now authors the persona as a "soul" (e.g. soul:"voxa") without a name,
  // so fall back to the soul id — setBrand upper-cases it: "voxa" -> "VOXA".
  const brandName =
    (typeof cfg.persona?.name === "string" && cfg.persona.name.trim()) ||
    (typeof cfg.persona?.soul === "string" && cfg.persona.soul.trim()) || "";
  if (brandName) setBrand(brandName);
  const v = cfg.voice || {};
  if (typeof v.model === "string" && v.model.trim()) SETTINGS.model = v.model.trim();
  if (typeof v.voiceName === "string" && v.voiceName.trim()) SETTINGS.voice = v.voiceName.trim();
  // The orb speaks only through Gemini Live today; honor model/voice but flag a
  // non-gemini provider rather than silently using the wrong backend.
  if (typeof v.provider === "string" && v.provider) SETTINGS.provider = v.provider;
  if (typeof v.openaiModel === "string" && v.openaiModel) SETTINGS.openaiModel = v.openaiModel;
  if (typeof v.openaiVoice === "string" && v.openaiVoice) SETTINGS.openaiVoice = v.openaiVoice;
  if (typeof v.daemonUrl === "string" && v.daemonUrl) SETTINGS.daemonUrl = v.daemonUrl;
  if (Array.isArray(cfg.sources)) {
    const srcs = cfg.sources
      .filter((s) => s && s.url && s.enabled !== false)
      .map((s) => ({ url: String(s.url) }));
    if (srcs.length) SETTINGS.sources = srcs;
  }
  if (typeof cfg.secretsUrl === "string" && cfg.secretsUrl.trim()) {
    SETTINGS.secretsUrl = cfg.secretsUrl.trim();
  }
  // Input mode + configurable shortcut.
  if (cfg.ui && typeof cfg.ui === "object") {
    if (typeof cfg.ui.pushToTalk === "boolean") SETTINGS.ui.pushToTalk = cfg.ui.pushToTalk;
    if (typeof cfg.ui.pttKey === "string" && cfg.ui.pttKey.trim()) SETTINGS.ui.pttKey = cfg.ui.pttKey.trim();
    if (typeof cfg.ui.pttModifier === "string" && cfg.ui.pttModifier.trim()) SETTINGS.ui.pttModifier = cfg.ui.pttModifier.trim().toLowerCase();
  }
  // Focus Area overrides — merge per-key, additively, with type checks. Unknown
  // keys in cfg.focus are ignored; existing SETTINGS.focus keys are preserved.
  if (cfg.focus && typeof cfg.focus === "object") {
    const f = cfg.focus;
    if (typeof f.enabled === "boolean") SETTINGS.focus.enabled = f.enabled;
    if (typeof f.confirmBeforeSend === "boolean") SETTINGS.focus.confirmBeforeSend = f.confirmBeforeSend;
    if (typeof f.snapshotOnFocus === "boolean") SETTINGS.focus.snapshotOnFocus = f.snapshotOnFocus;
    if (typeof f.maxPromptChars === "number" && Number.isFinite(f.maxPromptChars) && f.maxPromptChars > 0) {
      SETTINGS.focus.maxPromptChars = Math.round(f.maxPromptChars);
    }
    if (Array.isArray(f.providerFilter)) {
      const list = f.providerFilter.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
      if (list.length) SETTINGS.focus.providerFilter = list;
    }
  }
  applyShortcutHint();
}

async function loadVoxaConfig() {
  // Voxa is brain-free: read the local config file (written by the Settings
  // window) via the Tauri command. Fall back to the legacy HTTP endpoint only
  // when running outside Tauri (e.g. the web preview).
  try {
    if (TAURI?.core?.invoke) {
      const raw = await TAURI.core.invoke("read_local_config");
      const cfg = JSON.parse(raw || "{}");
      applyVoxaConfig(cfg && cfg.config ? cfg.config : cfg);
      return true;
    }
  } catch { /* fall through to HTTP */ }
  try {
    const res = await fetch(CONFIG_URL, { cache: "no-store" });
    if (!res.ok) return false;
    const data = await res.json();
    applyVoxaConfig(data?.config);
    return true;
  } catch {
    return false;
  }
}

// On a fresh boot the brain (:3000) is usually still starting — it's a desktop
// sidecar that comes up AFTER the orb. A single fetch then loses the race and
// silently fails, leaving the orb on defaults (generic "Voice UI" brand, no
// skin/persona) until the first session. Poll until it answers so the idle orb
// already shows the operator's assistant name, skin, and persona.
async function loadVoxaConfigWithRetry(tries = 15, delayMs = 2000) {
  for (let i = 0; i < tries; i++) {
    if (await loadVoxaConfig()) return;
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

const COLLAPSED = { w: 460, h: 140 };
const EXPANDED_DEFAULT = { w: 460, h: 520 };

const store = {
  get key() { return localStorage.getItem("voxa.geminiKey") || ""; },
  set key(v) { localStorage.setItem("voxa.geminiKey", v); },
  get micId() { return localStorage.getItem("voxa.micId") || ""; },
  set micId(v) { localStorage.setItem("voxa.micId", v); },
  // Mic tuning (experiment from Settings). Constraints default ON to match the
  // browser's previous hardcoded behaviour; gain defaults to 1× (no boost).
  get micGain() { const v = parseFloat(localStorage.getItem("voxa.micGain")); return Number.isFinite(v) ? v : 1; },
  set micGain(v) { localStorage.setItem("voxa.micGain", String(v)); },
  get noiseSuppress() { return localStorage.getItem("voxa.noiseSuppress") !== "0"; },
  set noiseSuppress(v) { localStorage.setItem("voxa.noiseSuppress", v ? "1" : "0"); },
  get autoGain() { return localStorage.getItem("voxa.autoGain") !== "0"; },
  set autoGain(v) { localStorage.setItem("voxa.autoGain", v ? "1" : "0"); },
  get vadSensitivity() { return localStorage.getItem("voxa.vadSensitivity") || ""; },
  set vadSensitivity(v) { localStorage.setItem("voxa.vadSensitivity", v || ""); },
  get expSize() {
    try { return JSON.parse(localStorage.getItem("voxa.expSize")) || EXPANDED_DEFAULT; }
    catch { return EXPANDED_DEFAULT; }
  },
  set expSize(v) { localStorage.setItem("voxa.expSize", JSON.stringify(v)); },
  // Persisted conversation: a rolling transcript of user/bot turns plus a durable
  // summary that Voxa writes via compact_conversation. Both survive stop/restart
  // so the chat (and the model's context) carries across sessions.
  get history() {
    try { return JSON.parse(localStorage.getItem("voxa.history")) || []; }
    catch { return []; }
  },
  set history(v) {
    try { localStorage.setItem("voxa.history", JSON.stringify((v || []).slice(-HISTORY_MAX))); } catch {}
  },
  get summary() { return localStorage.getItem("voxa.summary") || ""; },
  set summary(v) { localStorage.setItem("voxa.summary", v || ""); },
};

// ── Persisted conversation ────────────────────────────────────────────────
const HISTORY_MAX = 120;        // rolling cap on stored turns
const SEED_RECENT_TURNS = 12;   // how many recent turns to replay to the model
const SEED_MAX_CHARS = 3000;    // cap on the seeded context block

let history = store.history;

function pushHistory(who, text) {
  const t = (text || "").trim();
  if (!t) return;
  history.push({ who, text: t, ts: Date.now() });
  if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
  store.history = history;
}

function clearMemory() {
  history = [];
  store.history = history;
  store.summary = "";
  els.feed.innerHTML = "";
  turn.user = null;
  turn.bot = null;
  feedEmptyNote();
}

// Restore prior user/bot turns into the feed so the conversation is visible
// again when the panel is expanded.
function restoreFeed() {
  els.feed.innerHTML = "";
  for (const m of history) {
    if (m.who === "user" || m.who === "bot" || m.who === "tool") addMsg(m.who, m.text, m.ts);
  }
}

// Persist a tool call + its result into history so the model remembers what it
// DID (queued songs, stored facts) across a restart — these were shown in the
// feed but never saved. Compact + clamped so memory doesn't bloat.
function recordToolHistory(name, args, phase, info) {
  let a = "";
  try { a = args && Object.keys(args).length ? JSON.stringify(args) : ""; } catch {}
  if (a.length > 120) a = a.slice(0, 119) + "…";
  let r = String(info ?? "").replace(/\s+/g, " ").trim();
  if (r.length > 160) r = r.slice(0, 159) + "…";
  pushHistory("tool", `${name}(${a})${phase === "error" ? " — ERROR" : ""}${r ? " → " + r : ""}`);
}

// Build the context block handed to the model when a session starts, so Voxa
// "remembers" earlier conversations. Summary (its own compaction) + recent turns.
function conversationContext() {
  const parts = [];
  const summary = store.summary;
  if (summary) parts.push("Summary of earlier conversation (your own notes):\n" + summary);
  const recent = history
    .filter((m) => m.who === "user" || m.who === "bot")
    .slice(-SEED_RECENT_TURNS)
    .map((m) => `${m.who === "user" ? "Operator" : "Voxa"}: ${m.text}`)
    .join("\n");
  if (recent) parts.push("Most recent exchanges:\n" + recent);
  // Actions Voxa actually performed (tool calls + results) so it remembers what
  // it DID across restarts — e.g. songs it queued, facts it stored.
  const actions = history
    .filter((m) => m.who === "tool")
    .slice(-8)
    .map((m) => "• " + m.text)
    .join("\n");
  if (actions) parts.push("Actions you performed recently (you DID these — don't redo them):\n" + actions);
  if (!parts.length) return "";
  let ctx = parts.join("\n\n");
  if (ctx.length > SEED_MAX_CHARS) ctx = "…" + ctx.slice(ctx.length - SEED_MAX_CHARS);
  return "\n\n--- CONVERSATION MEMORY (persists across sessions; continue naturally, don't re-introduce yourself) ---\n" +
    ctx + "\n--- END MEMORY ---";
}

const STATES = ["idle", "connecting", "listening", "speaking"];
let state = "idle";
let session = null;
let starting = false; // re-entry lock: never start two sessions at once
let lastSessionError = "";
let hydratedGeminiKey = "";

// ── Audio-reactivity (REAL) ────────────────────────────────────────────────
// micLevel  : live RMS from MicCapture.onLevel (set in the status callback).
// One rAF loop blends the right REAL source into the orb + waveforms:
//   listening → mic RMS         (what the operator is saying)
//   speaking  → TTS output RMS  (session.getOutputLevel(), AnalyserNode tap)
//   otherwise → 0
// If you ever need to inject a level from elsewhere, call orb.setAudioLevel(0..1)
// directly — that is the single audio hook the orb reads.
let micLevel = 0;

const waveCanvases = [els.wave, els.wave2].filter(Boolean);
const waveCtxs = waveCanvases.map((c) => c.getContext("2d"));
const wavePhase = waveCanvases.map(() => Math.random() * Math.PI * 2);

function drawWaveform(canvas, c2d, idx, lvl) {
  const w = canvas.width, h = canvas.height;
  c2d.clearRect(0, 0, w, h);
  const mid = h / 2;
  const amp = (h / 2 - 1) * (0.12 + 0.88 * lvl);
  wavePhase[idx] += 0.18 + lvl * 0.35;
  const color = state === "listening" ? "#00e5ff" : "#ff8a2b";
  c2d.lineWidth = 1.6;
  c2d.strokeStyle = color;
  c2d.globalAlpha = 0.5 + 0.5 * Math.min(1, lvl * 2);
  c2d.beginPath();
  for (let x = 0; x <= w; x++) {
    const t = (x / w) * Math.PI * 2;
    const y = mid + Math.sin(t * 2 + wavePhase[idx]) * amp * (0.6 + 0.4 * Math.sin(t * 3));
    if (x === 0) c2d.moveTo(x, y); else c2d.lineTo(x, y);
  }
  c2d.stroke();
  c2d.globalAlpha = 1;
}

let lastLvlTick = performance.now();
function audioLevelLoop(now) {
  requestAnimationFrame(audioLevelLoop);
  let lvl = 0;
  if (state === "listening") lvl = micLevel;
  else if (state === "speaking") lvl = session ? Math.min(1, session.getOutputLevel() * 3) : 0;
  // Decay mic level between frames so the meter falls naturally on silence.
  if (now - lastLvlTick > 40) { micLevel *= 0.82; lastLvlTick = now; }
  // Live mic meter in Settings, so the operator can SEE the gain/NS effect.
  if (els.micMeter && els.body.classList.contains("settings-open")) {
    els.micMeter.style.width = Math.round(Math.min(1, lvl) * 100) + "%";
  }
  orb.setAudioLevel(lvl);
  for (let i = 0; i < waveCanvases.length; i++) drawWaveform(waveCanvases[i], waveCtxs[i], i, lvl);
}
requestAnimationFrame(audioLevelLoop);

function setState(next) {
  if (!STATES.includes(next)) return;
  state = next;
  els.body.classList.remove(...STATES);
  els.body.classList.add(next);
  orb.setOrbState(next);
}
function setStatus(text) { els.status.textContent = text; }
// Brand badge = the active assistant's name (soul name), shown letter-spaced like
// the old "VOXA". Uppercased to match the badge styling.
function setBrand(name) { if (els.brand && name) els.brand.textContent = String(name).toUpperCase(); }
function setLine(text, who) {
  els.line.textContent = text;
  els.line.classList.toggle("user", who === "user");
}
function describeError(err) {
  if (!err) return "";
  if (typeof err === "string") return err;
  const name = err.name ? `${err.name}: ` : "";
  const msg = err.message || String(err);
  return `${name}${msg}`;
}
function isAuthError(msg) {
  return /api key|apikey|api_key|unauthorized|unauthenticated|invalid credential|401|403/i.test(String(msg || ""));
}
function showSessionError(msg) {
  lastSessionError = String(msg || "Session closed");
  setLine(lastSessionError);
}
async function hydrateGeminiKeyFromHarness() {
  if (hydratedGeminiKey || store.key) return hydratedGeminiKey || store.key;
  const base = SETTINGS.secretsUrl.replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/secrets/geminiApiKey`, { cache: "no-store" });
    if (!res.ok) return "";
    const data = await res.json();
    if (data?.value) {
      hydratedGeminiKey = String(data.value).trim();
      if (hydratedGeminiKey) setLine("Loaded Gemini key from connector harness");
    }
  } catch {
    // Harness is optional; fall back to the key prompt.
  }
  return hydratedGeminiKey;
}

// ── Conversation feed ──────────────────────────────────────────────────────
// Streaming transcripts update the *current* turn bubble in place; turn
// boundaries (status flips back to listening) seal them.
const turn = { user: null, bot: null };

function feedEmptyNote() {
  if (!els.feed.children.length) {
    const d = document.createElement("div");
    d.className = "feed-empty";
    d.textContent = "Conversation will appear here";
    els.feed.appendChild(d);
  }
}
function clearEmptyNote() {
  const e = els.feed.querySelector(".feed-empty");
  if (e) e.remove();
}
function stamp(ts) {
  return new Date(ts || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
async function copyText(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch {}
    ta.remove();
  }
}
function addMsg(who, text, ts) {
  clearEmptyNote();
  const d = document.createElement("div");
  d.className = `msg ${who}`;
  const span = document.createElement("span");
  span.textContent = text;
  d.appendChild(span);
  if (who !== "tool") {
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = stamp(ts);
    d.appendChild(t);
    const copy = document.createElement("button");
    copy.className = "copy-btn";
    copy.title = "Copy message";
    copy.textContent = "⧉";
    copy.addEventListener("click", (e) => {
      e.stopPropagation();
      copyText(span.textContent || "");
      copy.classList.add("done");
      copy.textContent = "✓";
      setTimeout(() => { copy.classList.remove("done"); copy.textContent = "⧉"; }, 900);
    });
    d.appendChild(copy);
  }
  els.feed.appendChild(d);
  els.feed.scrollTop = els.feed.scrollHeight;
  return span;
}
function streamMsg(who, text) {
  if (!turn[who]) turn[who] = addMsg(who === "user" ? "user" : "bot", text);
  else turn[who].textContent = text;
  els.feed.scrollTop = els.feed.scrollHeight;
}
function sealTurn() {
  if (turn.user) pushHistory("user", turn.user.textContent);
  if (turn.bot) pushHistory("bot", turn.bot.textContent);
  turn.user = null;
  turn.bot = null;
}

window.Voxa = { get state() { return state; }, setStatus, setLine, setState };

// ── API key (one-time prompt, persisted) ──────────────────────────────────
function askForKey() {
  setStatus("Setup");
  setLine("");
  els.key.classList.remove("hidden");
  els.key.focus();
}
els.key.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const v = els.key.value.trim();
  if (!v) return;
  store.key = v;
  els.key.value = "";
  els.key.classList.add("hidden");
  startSession();
});
els.rekey.addEventListener("click", () => {
  closeSettings();
  askForKey();
});
// Voxa: full Settings window (separate Tauri webview).
async function openSettingsWindow() {
  const WebviewWindow = getWebviewWindow();
  if (!WebviewWindow) { setLine("Settings need the desktop app."); return; }
  try {
    const existing = await WebviewWindow.getByLabel("settings");
    if (existing) { try { await existing.setFocus(); } catch {} return; }
    new WebviewWindow("settings", {
      url: "settings.html", title: "Voxa Settings",
      width: 460, height: 640, resizable: true, decorations: true,
      transparent: false, alwaysOnTop: false, focus: true, center: true,
    });
  } catch (e) { setLine("Couldn't open settings: " + (e?.message || e)); }
}
(function addSettingsButton() {
  if (!els.rekey || !els.rekey.parentNode || document.getElementById("openSettings")) return;
  const b = document.createElement("button");
  b.id = "openSettings"; b.type = "button"; b.textContent = "⚙ Settings…";
  b.className = els.rekey.className || "";
  b.addEventListener("click", () => { closeSettings(); openSettingsWindow(); });
  els.rekey.parentNode.insertBefore(b, els.rekey.nextSibling);
})();
els.clearMem.addEventListener("click", () => {
  clearMemory();
  setLine("Conversation memory cleared");
});

// ── Mic device picker ──────────────────────────────────────────────────────
async function listMics() {
  let devs = await navigator.mediaDevices.enumerateDevices();
  // Labels are blank until mic permission has been granted once — nudge it.
  if (devs.some((d) => d.kind === "audioinput" && !d.label)) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      devs = await navigator.mediaDevices.enumerateDevices();
    } catch { /* user denied — show generic names */ }
  }
  return devs.filter((d) => d.kind === "audioinput");
}

async function populateMicSel() {
  const mics = await listMics();
  els.micSel.innerHTML = "";
  const def = document.createElement("option");
  def.value = "";
  def.textContent = "System default";
  els.micSel.appendChild(def);
  for (const m of mics) {
    if (m.deviceId === "default" || m.deviceId === "communications") continue;
    const o = document.createElement("option");
    o.value = m.deviceId;
    o.textContent = m.label || `Microphone ${els.micSel.length}`;
    els.micSel.appendChild(o);
  }
  els.micSel.value = store.micId;
  if (els.micSel.value !== store.micId) els.micSel.value = ""; // saved mic unplugged
}

els.micSel.addEventListener("change", async () => {
  store.micId = els.micSel.value;
  if (session) {
    setStatus("Switching mic…");
    try { await session.setMicDevice(store.micId || null); } catch (e) { setLine(String(e?.message || e)); }
    setStatus(state === "speaking" ? "Speaking" : "Listening");
  }
});

// ── Mic tuning (live experimentation) ──────────────────────────────────────
// The audio params handed to every session; also applied live to the running one.
function audioParams() {
  return {
    gain: store.micGain,
    noiseSuppression: store.noiseSuppress,
    autoGainControl: store.autoGain,
    vadSensitivity: store.vadSensitivity,
  };
}
function syncAudioControls() {
  els.micGain.value = String(store.micGain);
  els.micGainVal.textContent = store.micGain.toFixed(1) + "×";
  els.noiseSuppress.checked = store.noiseSuppress;
  els.autoGain.checked = store.autoGain;
  els.vadSel.value = store.vadSensitivity;
}
els.micGain.addEventListener("input", () => {
  const g = parseFloat(els.micGain.value) || 1;
  store.micGain = g;
  els.micGainVal.textContent = g.toFixed(1) + "×";
  if (session) session.setAudioParams({ gain: g }); // instant, no mic restart
});
async function applyConstraint(patch) {
  if (!session) return;
  setStatus("Applying…");
  try { await session.setAudioParams(patch); } catch (e) { setLine(String(e?.message || e)); }
  setStatus(state === "speaking" ? "Speaking" : "Listening");
}
els.noiseSuppress.addEventListener("change", () => {
  store.noiseSuppress = els.noiseSuppress.checked;
  applyConstraint({ noiseSuppression: store.noiseSuppress }); // restarts mic
});
els.autoGain.addEventListener("change", () => {
  store.autoGain = els.autoGain.checked;
  applyConstraint({ autoGainControl: store.autoGain }); // restarts mic
});
els.vadSel.addEventListener("change", () => {
  store.vadSensitivity = els.vadSel.value;
  if (session) { session.setAudioParams({ vadSensitivity: store.vadSensitivity }); setLine("Voice-detection change applies on the next session."); }
});
syncAudioControls();

// Settings opens an overlay that is now taller than the collapsed window, so when
// folded we GROW the window to fit it (measured) and shrink back on close —
// otherwise the controls overflow the clipped window and the panel looks broken.
let settingsGrew = false;
async function openSettings() {
  els.settings.classList.remove("hidden");
  els.body.classList.add("settings-open"); // both modes (collapsed grows; expanded hides the feed)
  buildControls();
  refreshControls();
  populateMicSel();
  if (!expanded && TAURI) await growToSettings();
}
async function closeSettings() {
  els.settings.classList.add("hidden");
  els.body.classList.remove("settings-open");
  if (settingsGrew && !expanded) {
    settingsGrew = false;
    const c = curLayout().collapsed;
    await setWindowSize(c.w, c.h, false);
  }
}
els.gear.addEventListener("click", async () => {
  if (els.settings.classList.contains("hidden")) await openSettings();
  else await closeSettings();
});

// ── Appearance + mode controls (built lazily into the settings panel) ───────
function ctlSection(label) {
  const el = document.createElement("div");
  el.className = "appear-row";
  const l = document.createElement("span");
  l.className = "appear-l";
  l.textContent = label;
  const body = document.createElement("div");
  body.className = "appear-body";
  el.append(l, body);
  return { el, body };
}
function ctlChip(text, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "chip";
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}
function callMode(name, args) {
  const t = AMBIENT_CONTROL_TOOLS.find((x) => x.name === name);
  if (t) Promise.resolve(t.handler(args)).then(() => refreshControls()).catch(() => {});
}
function rebuildControls() {
  const old = els.settings.querySelector(".appear");
  if (old) old.remove();
  for (const k of Object.keys(skinBtns)) delete skinBtns[k];
  for (const k of Object.keys(palBtns)) delete palBtns[k];
  for (const k of Object.keys(layBtns)) delete layBtns[k];
  for (const k of Object.keys(modeBtns)) delete modeBtns[k];
  controlsBuilt = false;
  if (!els.settings.classList.contains("hidden")) buildControls();
}
function buildControls() {
  if (controlsBuilt) return;
  controlsBuilt = true;
  const wrap = document.createElement("div");
  wrap.className = "appear";

  const sk = ctlSection("Skin");
  for (const id of SKIN_ORDER) {
    const b = ctlChip(SKINS[id].name, () => chooseSkin(id));
    b.title = SKINS[id].blurb;
    skinBtns[id] = b;
    sk.body.appendChild(b);
  }

  const pl = ctlSection("Theme");
  for (const id of PALETTE_ORDER) {
    const p = PALETTES[id];
    const b = ctlChip("", () => choosePalette(id));
    b.classList.add("swatch");
    b.title = p.name;
    b.setAttribute("aria-label", p.name);
    b.style.setProperty("--sw", `rgb(${p.core.join(",")})`);
    b.style.setProperty("--sw2", `rgb(${p.accent.join(",")})`);
    palBtns[id] = b;
    pl.body.appendChild(b);
  }

  const ly = ctlSection("Layout");
  for (const id of LAYOUT_ORDER) {
    const b = ctlChip(LAYOUTS[id].name, () => chooseLayout(id));
    b.title = LAYOUTS[id].blurb;
    layBtns[id] = b;
    ly.body.appendChild(b);
  }

  const md = ctlSection("Mode");
  modeBtns.ambient = ctlChip("Ambient", () => callMode("set_ambient_mode", { on: !ambientMode }));
  modeBtns.text = ctlChip("Text", () => callMode("set_reply_mode", { mode: replyMode === "text" ? "voice" : "text" }));
  modeBtns.observe = ctlChip("Observe", () => callMode("set_observe_mode", { on: !observeMode }));
  modeBtns.ambient.title = "Stay quiet, speak only when it matters";
  modeBtns.text.title = "Reply as text (mute) instead of speaking";
  modeBtns.observe.title = "Listen-only: take silent notes, no actions";
  md.body.append(modeBtns.ambient, modeBtns.text, modeBtns.observe);

  wrap.append(sk.el, pl.el, ly.el, md.el);
  els.settings.appendChild(wrap);
  refreshControls();
}
function refreshControls() {
  if (!controlsBuilt) return;
  for (const id of SKIN_ORDER) skinBtns[id]?.classList.toggle("on", appearance.skin === id);
  for (const id of PALETTE_ORDER) palBtns[id]?.classList.toggle("on", appearance.palette === id);
  for (const id of LAYOUT_ORDER) layBtns[id]?.classList.toggle("on", appearance.layout === id);
  modeBtns.ambient?.classList.toggle("on", !!ambientMode);
  modeBtns.text?.classList.toggle("on", replyMode === "text");
  modeBtns.observe?.classList.toggle("on", !!observeMode);
}

// ── Expand / collapse ──────────────────────────────────────────────────────
async function setWindowSize(w, h, resizable) {
  if (!TAURI) return;
  const { getCurrentWindow, currentMonitor, PhysicalSize, PhysicalPosition } = TAURI.window;
  const win = getCurrentWindow();
  try {
    // Work in PHYSICAL pixels throughout. Mixing logical coords with a single
    // scale factor breaks on multi-monitor layouts (different DPI, negative or
    // offset origins) and could fling the orb onto another screen. WHY: the old
    // Math.max(8, …) clamp assumed the primary monitor started at (0,0).
    const sf = await win.scaleFactor();
    const pos = await win.outerPosition();   // physical, virtual-desktop space
    const inner = await win.innerSize();      // physical
    const targetW = Math.round(w * sf);
    const targetH = Math.round(h * sf);
    // Anchor the BOTTOM edge: grow upward by the physical height delta.
    const dyPhys = targetH - inner.height;
    let nx = pos.x;
    let ny = pos.y - dyPhys;
    // Keep the window on the monitor it currently lives on.
    const mon = await currentMonitor();
    if (mon) {
      const minMargin = Math.round(8 * sf);
      const top = mon.position.y + minMargin;
      const left = mon.position.x;
      const right = mon.position.x + mon.size.width;
      ny = Math.max(top, ny);
      nx = Math.min(nx, right - targetW);
      nx = Math.max(nx, left);
    }
    await win.setResizable(!!resizable);
    await win.setSize(new PhysicalSize(targetW, targetH));
    await win.setPosition(new PhysicalPosition(Math.round(nx), Math.round(ny)));
  } catch (e) { console.warn("resize failed", e); }
}

async function toggleExpand() {
  expanded = !expanded;
  els.body.classList.toggle("expanded", expanded);
  els.feed.classList.toggle("hidden", !expanded);
  els.composer.classList.toggle("hidden", !expanded);
  els.hint.classList.toggle("hidden", !expanded);
  settingsGrew = false; // expand/collapse owns the sizing now
  // Sizes come from the active layout, so expanding respects the chosen layout.
  if (expanded) {
    // Rebuild persisted turns so prior conversation is visible on expand. Only
    // when the feed has no live messages, so an active session isn't clobbered.
    if (!els.feed.querySelector(".msg")) restoreFeed();
    feedEmptyNote(); // fallback note only when there's genuinely no history
    const s = curLayout().expanded;
    await setWindowSize(s.w, s.h, true);
    els.feed.scrollTop = els.feed.scrollHeight;
  } else {
    const c = curLayout().collapsed;
    await setWindowSize(c.w, c.h, false);
  }
}
els.expand.addEventListener("click", toggleExpand);

// ── Proactive timers / reminders ───────────────────────────────────────────
// The agent can schedule a future event (set_timer / remind_me). When it fires
// we chime and inject an event into the live session so the agent SPEAKS the
// alert on its own. If the session is closed we reopen it to deliver the alert.
const timers = new Map(); // id -> { label, alertText, timeout, fireAt }
let pendingAlerts = []; // alerts waiting for the session to be live
let timerSeq = 0;

function chime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    [880, 1320].forEach((freq, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      const t0 = now + i * 0.16;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.18, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
      o.connect(g).connect(ctx.destination);
      o.start(t0);
      o.stop(t0 + 0.2);
    });
    setTimeout(() => { try { ctx.close(); } catch {} }, 800);
  } catch {}
}

function flushAlerts() {
  if (!pendingAlerts.length) return;
  if (session && session.isLive && (state === "listening" || state === "speaking")) {
    const msgs = pendingAlerts.splice(0);
    for (const m of msgs) session.sendEvent(m);
  } else if (!session || state === "offline") {
    // Reopen the session; the 'listening' handler will flush on connect.
    startSession();
  }
  // if 'connecting', leave queued — the listening handler flushes it.
}

function deliverAlert(text) {
  chime();
  pendingAlerts.push(text);
  flushAlerts();
}

function fireTimer(id) {
  const t = timers.get(id);
  if (!t) return;
  timers.delete(id);
  deliverAlert(t.alertText);
}

function scheduleTimer({ ms, label, alertText }) {
  const id = `tmr-${++timerSeq}`;
  const fireAt = Date.now() + ms;
  const timeout = setTimeout(() => fireTimer(id), ms);
  timers.set(id, { label, alertText, timeout, fireAt });
  return id;
}

function humanLeft(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

// ── Local tools (run in the orb, not routed to the brain) ──────────────────
const LOCAL_TOOLS = [
  {
    name: "set_timer",
    description:
      "Set a countdown timer. When it expires you will be alerted and should SAY OUT LOUD, briefly, that the timer is up. Use for 'set a timer for N seconds/minutes'. Returns a confirmation to read back.",
    parameters: {
      type: "object",
      properties: {
        seconds: { type: "number", description: "Duration in seconds (e.g. 5, 300). Convert minutes to seconds." },
        label: { type: "string", description: "Optional short label, e.g. 'tea', 'standup'." },
      },
      required: ["seconds"],
    },
    handler: async (args) => {
      const seconds = Math.max(1, Math.min(86400, Math.round(Number(args?.seconds) || 0)));
      if (!seconds) return "I need a duration in seconds.";
      const label = String(args?.label || "").trim();
      const ms = seconds * 1000;
      scheduleTimer({
        ms,
        label: label || `${seconds}s`,
        alertText: `[TIMER FINISHED] The ${label ? `"${label}" ` : ""}timer you set for ${humanLeft(ms)} is up. Tell the user out loud, briefly and naturally, that it's done.`,
      });
      return `Timer set for ${humanLeft(ms)}${label ? ` (${label})` : ""}. I'll let you know.`;
    },
  },
  {
    name: "remind_me",
    description:
      "Set a reminder to deliver a spoken message after a delay. When it fires you will be alerted and should SAY the reminder message out loud, naturally. Use for 'remind me in N minutes to …'.",
    parameters: {
      type: "object",
      properties: {
        minutes: { type: "number", description: "Delay in minutes (e.g. 10, 0.5)." },
        message: { type: "string", description: "What to remind the user about." },
      },
      required: ["minutes", "message"],
    },
    handler: async (args) => {
      const minutes = Math.max(0.05, Math.min(1440, Number(args?.minutes) || 0));
      const message = String(args?.message || "").trim();
      if (!message) return "What should I remind you about?";
      const ms = Math.round(minutes * 60000);
      scheduleTimer({
        ms,
        label: message.slice(0, 40),
        alertText: `[REMINDER] Say this to the user out loud, naturally, as a reminder: "${message}"`,
      });
      return `Reminder set for ${humanLeft(ms)} from now. I'll say: "${message}".`;
    },
  },
  {
    name: "list_timers",
    description: "List the active timers and reminders and how long until each fires.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      if (!timers.size) return "No active timers or reminders.";
      const now = Date.now();
      return [...timers.values()]
        .sort((a, b) => a.fireAt - b.fireAt)
        .map((t) => `${t.label}: ${humanLeft(t.fireAt - now)} left`)
        .join("; ");
    },
  },
  {
    name: "cancel_timer",
    description: "Cancel a timer/reminder by label, or all of them if no label is given.",
    parameters: {
      type: "object",
      properties: { label: { type: "string", description: "Label to cancel; omit to cancel all." } },
    },
    handler: async (args) => {
      const label = String(args?.label || "").trim().toLowerCase();
      let n = 0;
      for (const [id, t] of [...timers.entries()]) {
        if (!label || t.label.toLowerCase().includes(label)) {
          clearTimeout(t.timeout);
          timers.delete(id);
          n++;
        }
      }
      return n ? `Cancelled ${n} timer(s).` : "No matching timers to cancel.";
    },
  },
  {
    name: "compact_conversation",
    description:
      "Summarize the conversation so far into a compact note that PERSISTS across sessions, then clear the on-screen history. Call this when the conversation gets long, when the operator asks you to 'compact' or 'summarize and clear', or to checkpoint important context before it scrolls away. Pass the summary you want to remember; it becomes your durable memory and seeds future sessions.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "A concise summary of the important points, decisions, facts, and open threads from the conversation so far. Written so future-you can pick up seamlessly.",
        },
      },
      required: ["summary"],
    },
    handler: async (args) => {
      const summary = String(args?.summary || "").trim();
      if (!summary) return "No summary provided — nothing was compacted.";
      // Fold any existing summary in so we don't lose earlier checkpoints.
      store.summary = store.summary ? store.summary + "\n\n" + summary : summary;
      history = [];
      store.history = history;
      els.feed.innerHTML = "";
      turn.user = null;
      turn.bot = null;
      feedEmptyNote();
      return "Conversation compacted and saved to memory. On-screen history cleared.";
    },
  },
];

// ── In-orb music playback (VibeEngine) ─────────────────────────────────────
// Audio plays through the orb itself (no browser tab). GATED on the `vibeplay`
// connector being enabled: play directives are ignored and the control tools are
// withheld unless it's on. Music ducks while Voxa is speaking.
const musicAudio = new Audio();
musicAudio.preload = "auto";
let mQueue = [];
let mIndex = 0;
let mTitle = "";
let mSpeaking = false;
let vibeplayEnabled = false;
// User-set base volume (0..1), persisted across sessions. Ducking multiplies it.
let musicVolume = (() => {
  const v = parseFloat(localStorage.getItem("voxa.musicVolume"));
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
})();

function duckVolume() { return (mSpeaking ? 0.18 : 1) * musicVolume; }
function setMusicDuck(speaking) {
  mSpeaking = speaking;
  if (!musicAudio.paused) musicAudio.volume = duckVolume();
}
function setMusicVolume(frac) {
  musicVolume = Math.min(1, Math.max(0, frac));
  localStorage.setItem("voxa.musicVolume", String(musicVolume));
  musicAudio.volume = duckVolume();
  syncSpotifyVolume(musicVolume); // keep Spotify/librespot in lockstep with VibeEngine
  return Math.round(musicVolume * 100);
}

// ── Now-playing chip (shared by VibeEngine + Spotify, kept consistent) ──────
// One chip below the status line shows the current track with the source's icon.
// Both players feed it via setVibeNowPlaying / setSpotifyNowPlaying; VibeEngine
// (local audio) wins when both are somehow active. Separate from the status line
// so it never fights session messages / transcripts.
const NP_ICONS = {
  // VibeEngine brand mark (fetched from https://vibeengine.live/logo.svg): a
  // V-shaped equalizer in the brand gradient on a dark rounded tile.
  vibe: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" width="15" height="15" aria-hidden="true"><defs><linearGradient id="veBg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#131b27"/><stop offset="100%" stop-color="#090c12"/></linearGradient><linearGradient id="veBars" x1="174" y1="0" x2="626" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#ff6b35"/><stop offset="35%" stop-color="#ff7a45"/><stop offset="50%" stop-color="#ffb68a"/><stop offset="65%" stop-color="#12d4c5"/><stop offset="100%" stop-color="#53a8ff"/></linearGradient></defs><rect width="800" height="800" rx="160" fill="url(#veBg)"/><g><rect x="174" y="210" width="44" rx="22" height="380" fill="url(#veBars)"/><rect x="242" y="245" width="44" rx="22" height="310" fill="url(#veBars)"/><rect x="310" y="280" width="44" rx="22" height="240" fill="url(#veBars)"/><rect x="378" y="325" width="44" rx="22" height="150" fill="url(#veBars)"/><rect x="446" y="280" width="44" rx="22" height="240" fill="url(#veBars)"/><rect x="514" y="245" width="44" rx="22" height="310" fill="url(#veBars)"/><rect x="582" y="210" width="44" rx="22" height="380" fill="url(#veBars)"/></g></svg>`,
  spotify: `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.59 14.43c-.18.3-.57.39-.87.21-2.39-1.46-5.4-1.79-8.94-.98-.34.08-.68-.14-.76-.48-.08-.34.14-.68.48-.76 3.87-.88 7.2-.5 9.88 1.14.3.18.39.57.21.87zm1.22-2.72c-.23.37-.71.48-1.08.26-2.74-1.68-6.91-2.17-10.15-1.19-.41.12-.85-.11-.97-.52-.12-.41.11-.85.52-.97 3.71-1.12 8.31-.58 11.46 1.35.36.22.48.71.22 1.07zm.1-2.83C14.69 8.99 9.4 8.82 6.3 9.76c-.49.15-1.01-.13-1.16-.62-.15-.49.13-1.01.62-1.16 3.56-1.08 9.4-.87 13.11 1.33.44.26.59.83.33 1.27-.26.44-.83.59-1.27.33z"/></svg>`,
};
let npVibe = null;    // VibeEngine current track (or null)
let npSpotify = null; // Spotify current track (or null)
let npShown = "";     // last rendered "src|text" — avoids redundant DOM writes
function renderNowPlaying() {
  if (!els.nowplaying) return;
  const cur = npVibe ? { src: "vibe", text: npVibe } : (npSpotify ? { src: "spotify", text: npSpotify } : null);
  const key = cur ? cur.src + "|" + cur.text : "";
  if (key === npShown) return;
  npShown = key;
  if (!cur) { els.nowplaying.classList.add("hidden"); return; }
  if (els.npIcon) els.npIcon.innerHTML = NP_ICONS[cur.src] || "";
  els.nowplaying.classList.remove("src-vibe", "src-spotify");
  els.nowplaying.classList.add("src-" + cur.src);
  els.npText.textContent = cur.text;
  els.nowplaying.classList.remove("hidden");
}
function setVibeNowPlaying(text) { npVibe = text || null; renderNowPlaying(); }
function setSpotifyNowPlaying(text) { npSpotify = text || null; renderNowPlaying(); }
const vibeLabel = (t, i) => `${t.title}${t.artist ? " — " + t.artist : ""}${mQueue.length > 1 ? ` (${i + 1}/${mQueue.length})` : ""}`;

function stopMusic() { musicAudio.pause(); musicAudio.removeAttribute("src"); mQueue = []; setVibeNowPlaying(null); }
function pauseMusic() { if (!musicAudio.paused) musicAudio.pause(); setVibeNowPlaying(null); }
function resumeMusic() {
  if (musicAudio.src) { musicAudio.play().catch(() => {}); if (mQueue[mIndex]) setVibeNowPlaying(vibeLabel(mQueue[mIndex], mIndex)); }
}

function playIndex(i) {
  if (i < 0 || i >= mQueue.length) { stopMusic(); return; }
  mIndex = i;
  const t = mQueue[i];
  musicAudio.src = t.url;
  musicAudio.volume = duckVolume();
  musicAudio.play().catch((e) => setLine("Couldn't play audio: " + (e?.message || e)));
  setVibeNowPlaying(vibeLabel(t, i));
}
musicAudio.addEventListener("ended", () => {
  if (mIndex + 1 < mQueue.length) playIndex(mIndex + 1);
  else { mQueue = []; setVibeNowPlaying(null); setLine(mTitle ? `Finished "${mTitle}".` : "Playback finished."); }
});

function playQueue(tracks, title) {
  mQueue = (tracks || []).filter((t) => t && t.url);
  mTitle = title || "";
  if (!mQueue.length) { setLine("Nothing to play."); return; }
  // Asking to play implies wanting to hear it — never start silent.
  if (musicVolume <= 0) setMusicVolume(0.7);
  playIndex(0);
}

// Play directive from the vibeplay connector (see js/gemini.js on.play).
function handlePlayDirective(play) {
  if (!vibeplayEnabled) { setLine("The VibeEngine player connector is disabled."); return; }
  if (!play || !Array.isArray(play.tracks)) return;
  playQueue(play.tracks, play.title);
}

// Control tools — only offered to the model when vibeplay is enabled.
const PLAYBACK_TOOLS = [
  { name: "stop_music", description: "Stop music playback.", parameters: { type: "object", properties: {} },
    handler: async () => { stopMusic(); return "Stopped."; } },
  { name: "pause_music", description: "Pause music playback.", parameters: { type: "object", properties: {} },
    handler: async () => { pauseMusic(); return "Paused."; } },
  { name: "resume_music", description: "Resume paused music.", parameters: { type: "object", properties: {} },
    handler: async () => { resumeMusic(); return "Resumed."; } },
  { name: "skip_track", description: "Skip to the next track in the current queue.", parameters: { type: "object", properties: {} },
    handler: async () => {
      if (mIndex + 1 < mQueue.length) { playIndex(mIndex + 1); return `Skipped to ${mQueue[mIndex].title}.`; }
      stopMusic(); return "End of queue.";
    } },
];

// Volume control is shared across players: set_volume / volume_up / volume_down
// drive a single musicVolume that setMusicVolume mirrors to BOTH VibeEngine and
// Spotify, so "turn it up" is consistent no matter which is playing. Available
// whenever either player is on (PLAYBACK_TOOLS above is VibeEngine-only).
const VOLUME_TOOLS = [
  { name: "set_volume", description: "Set the music volume to a percentage (0-100).",
    parameters: { type: "object", properties: { percent: { type: "number", description: "Volume 0-100." } }, required: ["percent"] },
    handler: async (a) => `Volume set to ${setMusicVolume((Number(a?.percent) || 0) / 100)}%.` },
  { name: "volume_up", description: "Turn the music volume up.", parameters: { type: "object", properties: {} },
    handler: async () => `Volume ${setMusicVolume(musicVolume + 0.15)}%.` },
  { name: "volume_down", description: "Turn the music volume down (won't fully mute; use set_volume 0 for that).", parameters: { type: "object", properties: {} },
    handler: async () => `Volume ${setMusicVolume(Math.max(0.1, musicVolume - 0.15))}%.` },
];

// Whether the vibeplay connector is enabled on the harness — decides if playback
// and the control tools are active this session.
async function refreshVibeplayEnabled() {
  try {
    const base = (SETTINGS.secretsUrl || "http://localhost:3010").replace(/\/$/, "");
    const res = await fetch(base + "/api/connectors", { cache: "no-store" });
    if (!res.ok) { vibeplayEnabled = false; return; }
    const data = await res.json();
    vibeplayEnabled = !!(data.connectors || []).find((x) => x.id === "vibeplay")?.enabled;
  } catch { vibeplayEnabled = false; }
}

// ── Spotify now-playing line ────────────────────────────────────────────────
// Spotify audio is played by librespot (a Connect device "Voxa" managed by the
// harness), not by the orb — so unlike VibeEngine there's no local <audio> to
// read. Instead the orb POLLS the spotify connector and shows the current track
// on the same status line, updating only when the track changes so it doesn't
// fight transcripts. Gated on the spotify connector being enabled.
let spotifyEnabled = false;
let spotifyTickN = 0;
async function refreshSpotifyEnabled() {
  try {
    const base = (SETTINGS.secretsUrl || "http://localhost:3010").replace(/\/$/, "");
    const res = await fetch(base + "/api/connectors", { cache: "no-store" });
    if (!res.ok) { spotifyEnabled = false; return; }
    const data = await res.json();
    spotifyEnabled = !!(data.connectors || []).find((x) => x.id === "spotify")?.enabled;
  } catch { spotifyEnabled = false; }
}
async function pollSpotifyNowPlaying() {
  if (!spotifyEnabled) { setSpotifyNowPlaying(null); return; }
  try {
    const base = (SETTINGS.secretsUrl || "http://localhost:3010").replace(/\/$/, "");
    const res = await fetch(base + "/api/connectors/spotify/actions/spotify_now_playing", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args: {} }),
    });
    const data = await res.json().catch(() => ({}));
    // Only show while actually playing: "Playing on Voxa: Title — Artist".
    const m = String(data.result || "").match(/^Playing(?: on [^:]+)?:\s*(.+)$/);
    setSpotifyNowPlaying(m ? m[1] : null);
  } catch { /* harness momentarily unreachable — leave the chip as-is */ }
}
// Refresh the enabled flag every ~30s; check the track every 5s.
setInterval(() => {
  if (spotifyTickN++ % 6 === 0) refreshSpotifyEnabled().then(pollSpotifyNowPlaying);
  else pollSpotifyNowPlaying();
}, 5000);
refreshSpotifyEnabled();

// Mirror the orb's music volume onto Spotify (librespot) so both players share one
// level and "turn it up" moves them together. Fire-and-forget; no-op if Spotify is
// off or nothing's playing on the device.
function syncSpotifyVolume(frac) {
  if (!spotifyEnabled) return;
  const pct = Math.round(Math.min(1, Math.max(0, frac)) * 100);
  try {
    const base = (SETTINGS.secretsUrl || "http://localhost:3010").replace(/\/$/, "");
    fetch(base + "/api/connectors/spotify/actions/spotify_set_volume", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: { percent: pct } }),
    }).catch(() => {});
  } catch {}
}

// Stop ALL music — used when the orb is closing. VibeEngine plays inside the orb
// (it dies with the window), but Spotify runs in librespot, a SEPARATE process, so
// it keeps playing after the orb is gone with no UI left to stop it. Tell the
// connector to tear the player down so nothing is left orphaned.
async function stopAllMusic() {
  try { stopMusic(); } catch {}            // VibeEngine (in-orb)
  if (!spotifyEnabled) return;
  try {
    const base = (SETTINGS.secretsUrl || "http://localhost:3010").replace(/\/$/, "");
    await fetch(base + "/api/connectors/spotify/actions/spotify_player_stop", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args: {} }),
    });
  } catch { /* harness unreachable — nothing more we can do from here */ }
}

// ── Ambient mode (V1): listen freely, speak only when it matters ────────────
// Two axes: ambientMode = whether Voxa stays quiet by default (engagement);
// replyMode = how it communicates when it does (voice vs text). Both persist.
let ambientMode = localStorage.getItem("voxa.ambient") === "1";
let replyMode = localStorage.getItem("voxa.replyMode") || "voice"; // "voice" | "text"
// Listen & Observe mode: listen-only, take NO actions, stay silent, and capture
// timestamped notes into the dedicated `observe` store (separate from lists).
let observeMode = localStorage.getItem("voxa.observe") === "1";

const AMBIENT_GUIDE =
  "\n\nAMBIENT MODE IS ACTIVE. The operator is working and talking freely; most of " +
  "what you hear is NOT directed at you. This OVERRIDES any earlier instruction to " +
  "narrate, acknowledge, or speak before acting.\n" +
  "- DEFAULT: call stay_quiet. Use it for anything not addressed to you and not " +
  "actionable — do not speak, do not notify.\n" +
  "- If asked to DO something: do it with tools, then call notify with a one-line " +
  "result. Do NOT speak it.\n" +
  "- SPEAK (a normal spoken reply) ONLY when: you are addressed by name, asked a " +
  "direct question, or you have a genuinely useful, non-obvious interjection (a fix " +
  "to a problem you overheard, a correction, a timely warning). One or two short " +
  "sentences, max.\n" +
  "- Never speak filler. Do not interject unprompted more than once every ~30 " +
  "seconds. When unsure, stay_quiet.";

const OBSERVE_GUIDE =
  "\n\nLISTEN & OBSERVE MODE IS ACTIVE. You are quietly listening in on a conversation " +
  "(e.g. a call). This OVERRIDES every earlier instruction.\n" +
  "- You have ONLY note tools: observe_start_session, observe_note, observe_read, " +
  "observe_sessions, observe_end_session. You have NO other tools and must take NO " +
  "actions of any kind (no home control, music, web, or memory writes).\n" +
  "- DO NOT SPEAK and do not narrate. Default to silence. As you hear distinct, " +
  "useful points, capture each as a concise observe_note (a fact, decision, name, " +
  "number, or follow-up). Skip small talk and filler.\n" +
  "- When a new conversation clearly begins, call observe_start_session with a short " +
  "name based on who or what it is about.\n" +
  "- ONLY when the operator directly asks you (e.g. 'what did I note', 'reflect on " +
  "this', 'any action points') may you respond — briefly and as TEXT only — using " +
  "observe_read. Never reflect, summarize, or propose actions on your own.";

// A silent "ping": chime + a text line in the feed (no speech).
function notifyPing(text) {
  const t = String(text || "").trim();
  if (!t) return;
  try { chime(); } catch {}
  addMsg("bot", "⚡ " + t);
  pushHistory("bot", t);
  setLine("⚡ " + t);
}

// Mode controls — always available so the operator can toggle by voice.
const AMBIENT_CONTROL_TOOLS = [
  {
    name: "set_ambient_mode",
    description:
      "Turn ambient mode on or off. In ambient mode you stay quiet by default and speak only when it matters. " +
      "Use when the operator says things like 'go ambient', 'just listen', 'stop replying to everything', or 'normal mode'.",
    parameters: { type: "object", properties: { on: { type: "boolean", description: "true = ambient, false = normal conversation." } }, required: ["on"] },
    handler: async (a) => {
      ambientMode = !!a?.on;
      localStorage.setItem("voxa.ambient", ambientMode ? "1" : "0");
      // Reconnect so the system prompt + tool set reflect the new mode.
      setTimeout(() => { if (state !== "idle") { stopSession(); startSession(); } }, 1000);
      return ambientMode
        ? "Ambient mode on — I'll stay quiet unless it matters. One moment."
        : "Back to normal conversation. One moment.";
    },
  },
  {
    name: "set_reply_mode",
    description:
      "Choose how you reply: 'text' (show replies as text with a soft chime, do NOT speak) or 'voice' (speak aloud). " +
      "Map 'mute'/'be quiet'/'text only' -> text, and 'unmute'/'speak' -> voice.",
    parameters: { type: "object", properties: { mode: { type: "string", description: "'text' or 'voice'." } }, required: ["mode"] },
    handler: async (a) => {
      const m = String(a?.mode || "").toLowerCase();
      replyMode = /text|mute|silent|quiet/.test(m) ? "text" : "voice";
      localStorage.setItem("voxa.replyMode", replyMode);
      if (session) session.setMuted(replyMode === "text");
      return replyMode === "text" ? "Text mode — I'll show replies instead of speaking." : "Voice mode — speaking again.";
    },
  },
  {
    name: "set_observe_mode",
    description:
      "Turn Listen & Observe mode on or off. In this mode you only listen and quietly take " +
      "timestamped notes — no actions, no speaking. Use when the operator says 'listen and " +
      "observe', 'observe mode', 'take notes on this call', 'just watch', or 'stop observing'.",
    parameters: { type: "object", properties: { on: { type: "boolean", description: "true = observe mode, false = back to normal." } }, required: ["on"] },
    handler: async (a) => {
      observeMode = !!a?.on;
      localStorage.setItem("voxa.observe", observeMode ? "1" : "0");
      // Reconnect so the tool surface + silence policy reflect the new mode.
      setTimeout(() => { if (state !== "idle") { stopSession(); startSession(); } }, 1000);
      return observeMode
        ? "Listen and observe mode on — I'll quietly take notes and stay out of the way. One moment."
        : "Leaving observe mode. One moment.";
    },
  },
];

// Tools that only make sense in ambient mode (added to the session only then).
const AMBIENT_TOOLS = [
  {
    name: "stay_quiet",
    description: "Say and do nothing — what you heard was not for you and needs no action. In ambient mode, call this BY DEFAULT.",
    parameters: { type: "object", properties: {} },
    handler: async () => "",
  },
  {
    name: "notify",
    description:
      "Silently report to the operator as TEXT with a soft chime (you are NOT speaking it). " +
      "Use after doing something ('Set a 5-minute timer') or for a brief non-urgent FYI.",
    parameters: { type: "object", properties: { text: { type: "string", description: "One short line." } }, required: ["text"] },
    handler: async (a) => { notifyPing(a?.text); return ""; },
  },
];

// ── Listen & Observe note tools ─────────────────────────────────────────────
// These wrap the `observe` connector's HTTP actions so notes persist server-side
// (durable, separate from lists). In observe mode the orb exposes ONLY these —
// no tool bridge — so no other actions are possible.
async function observeCall(action, args) {
  const base = (SETTINGS.secretsUrl || "http://localhost:3010").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/connectors/observe/actions/${action}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ args }),
    });
    const d = await res.json();
    return d.error ? `Couldn't reach the notes store: ${d.error}` : (d.result || "Done.");
  } catch (e) {
    return `Notes store offline (${e?.message || e}).`;
  }
}
const OBSERVE_TOOLS = [
  {
    name: "observe_start_session",
    description: "Start a new observation session named after the current conversation (e.g. 'Call with Anna'). New notes attach to it.",
    parameters: { type: "object", properties: { name: { type: "string", description: "Short conversation name." } }, required: ["name"] },
    handler: async (a) => observeCall("observe_start_session", { name: a?.name }),
  },
  {
    name: "observe_note",
    description: "Save one concise, timestamped note from what you're hearing (a fact, decision, name, number, or follow-up). Call once per distinct point.",
    parameters: { type: "object", properties: { text: { type: "string", description: "The note text." } }, required: ["text"] },
    handler: async (a) => {
      const r = await observeCall("observe_note", { text: a?.text });
      const t = String(a?.text || "").trim();
      if (t) { addMsg("bot", "📝 " + t); setLine("📝 " + t); } // silent on-screen capture, no chime
      return r;
    },
  },
  {
    name: "observe_read",
    description: "Read back the notes from the current (or a named) observation session. Use only when the operator asks to review or reflect.",
    parameters: { type: "object", properties: { session: { type: "string", description: "Session name keyword. Optional." }, limit: { type: "integer", description: "Max recent notes. Optional." } } },
    handler: async (a) => observeCall("observe_read", { session: a?.session, limit: a?.limit }),
  },
  {
    name: "observe_sessions",
    description: "List saved observation sessions (name, note count, when).",
    parameters: { type: "object", properties: {} },
    handler: async () => observeCall("observe_sessions", {}),
  },
  {
    name: "observe_end_session",
    description: "Close the active observation session (notes are kept).",
    parameters: { type: "object", properties: {} },
    handler: async () => observeCall("observe_end_session", {}),
  },
];

// ── Focus Area ──────────────────────────────────────────────────────────────
// The orb can "focus" on a running coding-agent terminal (Claude/Codex/Gemini/
// Copilot/Devin) surfaced by the brain, read what it's doing, and route prompts
// into it. Routing is SAFE: prompts are staged and only sent after a verbal
// "confirm" unless the operator turns on trust. One module-level manager holds
// the bound session + staged prompt. The brain URL is the :3000 source.
const focusMgr = new FocusManager({
  getBrainUrl: () => {
    const s = (SETTINGS.sources || []).map((x) => x.url).find((u) => /3000/.test(u));
    return s || "http://localhost:3000";
  },
  getConnectorUrl: () => {
    const s = (SETTINGS.sources || []).map((x) => x.url).find((u) => /3010/.test(u));
    return s || "http://localhost:3010";
  },
  getConfig: () => SETTINGS.focus,
});

const FOCUS_DISABLED_MSG = "Focus Area is disabled in settings.";
const focusEnabled = () => SETTINGS.focus && SETTINGS.focus.enabled !== false;

const FOCUS_TOOLS = [
  {
    name: "list_focus_candidates",
    description:
      "List the terminals the orb can FOCUS on — recognised agents (Claude, Codex, Gemini, Copilot, Devin) AND any live/active terminal on screen, including agents the operator started by hand (which the IDE may not have tagged). " +
      "Use when the operator asks 'what agents are running', 'what can you focus on', or before picking one to focus.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      if (!focusEnabled()) return FOCUS_DISABLED_MSG;
      const cands = await focusMgr.listCandidates();
      if (!cands.length) return "No focusable terminals are running right now.";
      return cands
        .slice(0, 14)
        .map((c, i) => {
          const who = c.external ? (c.kind === "claude-app" ? "Claude desktop app" : "Claude Code")
            : c.providerKnown ? c.provider : "terminal";
          const where = c.workspaceName || c.cwd || "";
          const idTail = c.sessionId ? ` [#${c.sessionId.slice(-4)}]` : "";
          const flag = c.onScreen ? " (on screen)" : c.active ? " (active)" : "";
          return `${i + 1}. ${who}${where ? " in " + where : ""}${flag}${idTail}`;
        })
        .join("; ");
    },
  },
  {
    name: "set_focus",
    description:
      "FOCUS on a coding agent so you can read it and route instructions to it. Targets can be a managed terminals OR an external Claude app " +
      "(the Claude desktop app, or a Claude Code CLI session). Pass a target (provider, directory, terminal name, Claude session title, or say 'desktop app') to choose one; " +
      "omit target to focus whatever is on screen / most recently active. Use for 'focus on Claude', 'focus my Claude desktop app', 'attach to the running agent'.",
    parameters: { type: "object", properties: { target: { type: "string", description: "Optional: provider/dir/name to match. Omit for the most recent agent terminal." } } },
    handler: async (a) => {
      if (!focusEnabled()) return FOCUS_DISABLED_MSG;
      return focusMgr.setFocus(a?.target);
    },
  },
  {
    name: "read_focus",
    description:
      "Read what the FOCUSED agent is currently doing (its recent terminal output). Use this BEFORE routing an instruction, " +
      "and whenever the operator asks 'what is it doing', 'check on the agent', or 'read the terminal'.",
    parameters: { type: "object", properties: { lines: { type: "integer", description: "Optional: how many trailing lines to read (default 80)." } } },
    handler: async (a) => {
      if (!focusEnabled()) return FOCUS_DISABLED_MSG;
      return focusMgr.read({ lines: a?.lines });
    },
  },
  {
    name: "get_focus_status",
    description: "Report the current focus: which agent is bound, whether auto-send (trust) is on, and any staged prompt awaiting confirm.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      if (!focusEnabled()) return FOCUS_DISABLED_MSG;
      return focusMgr.getStatus();
    },
  },
  {
    name: "route_prompt",
    description:
      "Send an instruction to the FOCUSED coding agent. IMPORTANT SAFETY BEHAVIOUR: unless auto-send (trust) is ON, this only STAGES the prompt — it does NOT send. " +
      "When it stages, you MUST read the exact prompt and the target agent back to the operator out loud, then WAIT for them to say 'confirm' before calling confirm_send. " +
      "Never assume confirmation. Use this when the operator asks you to tell/instruct the focused agent to do something.",
    parameters: { type: "object", properties: { prompt: { type: "string", description: "The exact instruction to send to the focused agent." } }, required: ["prompt"] },
    handler: async (a) => {
      if (!focusEnabled()) return FOCUS_DISABLED_MSG;
      return focusMgr.route(a?.prompt);
    },
  },
  {
    name: "confirm_send",
    description:
      "Send the previously STAGED prompt to the focused agent, verbatim. Call this ONLY after the operator has verbally confirmed (said 'confirm', 'yes send it', etc.).",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      if (!focusEnabled()) return FOCUS_DISABLED_MSG;
      return focusMgr.confirmSend();
    },
  },
  {
    name: "set_focus_trust",
    description:
      "Turn AUTO-SEND (trust) on or off for the current focus. When ON, route_prompt sends immediately with no confirm step. " +
      "Use for 'you can send directly', 'stop asking me to confirm', or 'go back to confirming each time'.",
    parameters: { type: "object", properties: { on: { type: "boolean", description: "true = auto-send without confirm, false = stage for confirm." } }, required: ["on"] },
    handler: async (a) => {
      if (!focusEnabled()) return FOCUS_DISABLED_MSG;
      return focusMgr.setTrust(!!a?.on);
    },
  },
  {
    name: "clear_focus",
    description: "Release the focus / stop attending to the agent terminal (the kill switch). Use for 'stop focusing', 'let go of the agent', 'release focus'.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      if (!focusEnabled()) return FOCUS_DISABLED_MSG;
      return focusMgr.clear();
    },
  },
];

// Read-only focus tools (safe in observe mode — never route/confirm/trust).
const FOCUS_READONLY_NAMES = ["list_focus_candidates", "set_focus", "read_focus", "get_focus_status", "clear_focus"];
const FOCUS_READONLY_TOOLS = FOCUS_TOOLS.filter((t) => FOCUS_READONLY_NAMES.includes(t.name));

const FOCUS_GUIDE =
  "\n\nFOCUS AREA: You can FOCUS on a running coding agent — either a managed terminals (Claude, Codex, Gemini, Copilot, Devin) or an " +
  "EXTERNAL Claude app (the Claude desktop app, or a Claude Code CLI session read from its transcripts). " +
  "Use list_focus_candidates to see what's running and set_focus to attach to one. Before acting, call read_focus to learn what it's doing. " +
  "To send an instruction, call route_prompt. CRITICAL: route_prompt only STAGES the prompt (the external Claude desktop app is ALWAYS staged, " +
  "never auto-sent — it's typed into a window by simulated keystrokes, so the right window must be open). You must read the EXACT prompt and the " +
  "target back to the operator and wait for a spoken 'confirm' before it goes (then call confirm_send). Never send without that confirmation. Use clear_focus to stop.";

// ── Viewport: a separate browser window Voxa can SHOW things in ───────────
// The output side of "vision" (the orb already SEES screenshots). Connectors stay
// data-only; these orb-local tools render a URL/HTML/image in a real Tauri webview
// window. Recreated per show so it can navigate to ANY site (top-level browse, so
// no iframe X-Frame-Options wall). Plan: docs/voxa-vision-action-plan.md.
const getWebviewWindow = () => (TAURI && (TAURI.webviewWindow?.WebviewWindow || TAURI.window?.WebviewWindow)) || null;
const VIEWPORT_PAYLOAD_PREFIX = "voxa.viewport.";
const VIEWPORT_STATUS_PREFIX = "voxa.viewport.status.";
const VIEWPORT_REQUEST_KEY = "voxa.viewport.request";
// What the viewport window currently shows: "shell" (our viewport.html, which polls
// for re-render requests so it can be REUSED without recreating) or "url" (navigated
// top-level to a real site, so it can't be reused for our staged content).
let viewportMode = null;

// Stage one render payload in localStorage; the viewport window reads it by id.
function stageViewportPayload(kind, value) {
  const id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
  localStorage.setItem(VIEWPORT_PAYLOAD_PREFIX + id, JSON.stringify({ kind, value, createdAt: Date.now() }));
  return id;
}

// Drop payloads the viewport never consumed (window failed to open / was closed
// mid-show) so large HTML blobs don't pile up in localStorage.
function purgeStaleViewportPayloads() {
  const now = Date.now();
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k || k.indexOf(VIEWPORT_PAYLOAD_PREFIX) !== 0) continue;
      if (k.indexOf(VIEWPORT_STATUS_PREFIX) === 0 || k === VIEWPORT_REQUEST_KEY) continue;
      let stale = true;
      try { stale = now - (JSON.parse(localStorage.getItem(k))?.createdAt || 0) > 60000; } catch {}
      if (stale) localStorage.removeItem(k);
    }
  } catch {}
}

async function waitForViewportStatus(id, timeoutMs = 4000) {
  if (!id) return null;
  const key = VIEWPORT_STATUS_PREFIX + id;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = localStorage.getItem(key);
    if (raw) {
      localStorage.removeItem(key);
      try { return JSON.parse(raw); }
      catch { return { ok: false, message: "Viewport reported an unreadable status." }; }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null; // opened but slow to confirm — treat as success, not "still loading"
}

function viewportStatusMessage(status) {
  if (status && status.ok === false) return status.message || "The viewport couldn't display that content.";
  return "It's on screen.";
}

// Render orb-generated content (html / image) in the viewport. Reuses the existing
// shell window when possible (poke a request key the shell polls) — no flicker, no
// recreation, size preserved — which is also the surface vision→action builds on.
async function viewportRenderShell(kind, value) {
  if (!TAURI) return "The viewport needs the desktop app.";
  const WebviewWindow = getWebviewWindow();
  if (!WebviewWindow) return "Viewport unavailable (Tauri webviewWindow API missing).";
  purgeStaleViewportPayloads();
  const id = stageViewportPayload(kind, value);
  try {
    const existing = await WebviewWindow.getByLabel("viewport");
    if (existing && viewportMode === "shell") {
      localStorage.setItem(VIEWPORT_REQUEST_KEY, JSON.stringify({ vpid: id, ts: Date.now() }));
      try { await existing.setFocus(); } catch {}
      return viewportStatusMessage(await waitForViewportStatus(id));
    }
    if (existing) { try { await existing.close(); } catch {} await new Promise((r) => setTimeout(r, 150)); }
    const win = new WebviewWindow("viewport", {
      url: "viewport.html?vpid=" + encodeURIComponent(id),
      title: "Voxa Viewport", width: 780, height: 580,
      resizable: true, decorations: true, alwaysOnTop: false, focus: true, center: true,
    });
    viewportMode = "shell";
    win.once("tauri://destroyed", () => { if (viewportMode === "shell") viewportMode = null; });
    await new Promise((res) => {
      let done = false; const fin = () => { if (!done) { done = true; res(); } };
      win.once("tauri://created", fin); win.once("tauri://error", fin); setTimeout(fin, 1800);
    });
    return viewportStatusMessage(await waitForViewportStatus(id));
  } catch (e) { return "Couldn't open the viewport: " + (e?.message || e); }
}

// Show a real web page by pointing a top-level window at it (no iframe, so no
// X-Frame-Options wall). Recreated per URL — JS can't navigate an existing Tauri
// webview; persistent in-place navigation is the Rust-backed Phase-3 follow-up.
async function viewportShowUrl(url) {
  if (!TAURI) return "The viewport needs the desktop app.";
  const WebviewWindow = getWebviewWindow();
  if (!WebviewWindow) return "Viewport unavailable (Tauri webviewWindow API missing).";
  try {
    const existing = await WebviewWindow.getByLabel("viewport");
    if (existing) { try { await existing.close(); } catch {} await new Promise((r) => setTimeout(r, 150)); }
    const win = new WebviewWindow("viewport", {
      url, title: "Voxa Viewport", width: 880, height: 640,
      resizable: true, decorations: true, alwaysOnTop: false, focus: true, center: true,
    });
    viewportMode = "url";
    win.once("tauri://destroyed", () => { if (viewportMode === "url") viewportMode = null; });
    await new Promise((res) => {
      let done = false; const fin = () => { if (!done) { done = true; res(); } };
      win.once("tauri://created", fin); win.once("tauri://error", fin); setTimeout(fin, 1800);
    });
    return "It's on screen.";
  } catch (e) { return "Couldn't open the viewport: " + (e?.message || e); }
}

// ── Tier A (vision -> action): read/drive the page inside the viewport ───────
// Inject a JS helper into the viewport webview (via the Rust `viewport_eval`
// command), and await the result it emits back on the `vp-result` event (matched
// by reqId). Returns { ok, data | error }. Only works if the viewport page exposes
// the Tauri global to emit — the spike below verifies that on a real page.
const tauriInvoke = () => (TAURI && (TAURI.core?.invoke || TAURI.invoke)) || null;
const tauriEvent = () => (TAURI && TAURI.event) || null;

function vpHelperJs(reqId, action, args) {
  return "(function(){var REQ=" + JSON.stringify(reqId) + ",ACT=" + JSON.stringify(action) + ",A=" + JSON.stringify(args || {}) + ";" +
    "function emit(p){try{window.__TAURI__&&window.__TAURI__.event&&window.__TAURI__.event.emit('vp-result',Object.assign({reqId:REQ},p));}catch(e){}}" +
    "try{if(ACT==='read'){" +
    "var sel='a,button,[role=button],input,textarea,select,[contenteditable=\"true\"]';var out=[],n=0;" +
    "document.querySelectorAll(sel).forEach(function(el){var r=el.getBoundingClientRect();if(r.width<=0||r.height<=0)return;if(out.length>=60)return;" +
    "var ref=++n;el.setAttribute('data-vp-ref',ref);" +
    "var lbl=((el.innerText||el.value||el.getAttribute('aria-label')||el.placeholder||el.name||'')+'').replace(/\\s+/g,' ').trim().slice(0,80);" +
    "out.push({ref:ref,kind:el.tagName.toLowerCase()+(el.type?(':'+el.type):''),label:lbl});});" +
    "emit({ok:true,data:{title:document.title,url:location.href,hasTauri:!!window.__TAURI__,count:out.length,items:out}});" +
    "}else{emit({ok:false,error:'unknown action '+ACT});}}catch(e){emit({ok:false,error:String(e&&e.message||e)});}})();";
}

async function viewportExec(action, args, timeoutMs = 6000) {
  if (!TAURI) return { ok: false, error: "needs the desktop app" };
  const invoke = tauriInvoke(), ev = tauriEvent();
  if (!invoke || !ev) return { ok: false, error: "Tauri APIs missing" };
  const reqId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const js = vpHelperJs(reqId, action, args);
  return new Promise((resolve) => {
    let done = false, un = null;
    const finish = (v) => { if (!done) { done = true; try { un && un(); } catch {} resolve(v); } };
    ev.listen("vp-result", (e) => { const p = e?.payload; if (p && p.reqId === reqId) finish(p); })
      .then((u) => { un = u; return invoke("viewport_eval", { js }); })
      .catch((e) => finish({ ok: false, error: "exec failed: " + (e?.message || e) }));
    setTimeout(() => finish({ ok: false, error: "timeout — no result (page may not expose the Tauri IPC)" }), timeoutMs);
  });
}

async function viewportRead() { return viewportExec("read"); }

const VIEWPORT_TOOLS = [
  {
    name: "viewport_show_url",
    description: "Show a web page in Voxa's viewport — a small browser window on the operator's screen. Use when something is better SEEN than read aloud (a page you found, a doc, a map, an article). Then say a one-line 'here's X on screen.'",
    parameters: { type: "object", properties: { url: { type: "string", description: "The http(s) URL to display." } }, required: ["url"] },
    handler: async (a) => {
      const u = String(a?.url || "").trim();
      if (!/^https?:\/\//i.test(u)) return "Give a full http(s) URL.";
      setLine("🖥 " + u);
      return viewportShowUrl(u);
    },
  },
  {
    name: "viewport_show_html",
    description: "Render HTML you generate (a table, a small chart, a formatted result) in Voxa's viewport window. Pass a full HTML document or a fragment. Scripts run (sandboxed), so JS charts are fine.",
    parameters: { type: "object", properties: { html: { type: "string", description: "HTML document or fragment to display." } }, required: ["html"] },
    handler: async (a) => {
      const h = String(a?.html || "").trim();
      if (!h) return "Nothing to show.";
      setLine("🖥 showing content");
      return viewportRenderShell("html", h);
    },
  },
  {
    name: "viewport_show_image",
    description: "Show an image (by URL) in Voxa's viewport window.",
    parameters: { type: "object", properties: { url: { type: "string", description: "Image URL." } }, required: ["url"] },
    handler: async (a) => {
      const u = String(a?.url || "").trim();
      if (!u) return "Give an image URL.";
      if (!/^https?:\/\//i.test(u)) return "Give a full http(s) image URL.";
      setLine("🖥 image");
      // Always open the window — the shell shows the image or an in-window error and
      // reports load failures back here via the status handshake, so you still learn
      // about a 404 without suppressing the window.
      return viewportRenderShell("image", u);
    },
  },
  {
    name: "viewport_close",
    description: "Close Voxa's viewport window.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      try { const WW = getWebviewWindow(); const w = WW && await WW.getByLabel("viewport"); if (w) await w.close(); viewportMode = null; return "Closed the viewport."; }
      catch (e) { return "Couldn't close the viewport."; }
    },
  },
];

// Pushed into the system prompt so the model actually SHOWS instead of narrating.
const VIEWPORT_GUIDE =
  "\n\nSHOWING THINGS ON SCREEN: You have a viewport — a real browser window on the " +
  "operator's screen. When the operator asks you to SHOW, DISPLAY, OPEN, PULL UP, or " +
  "render something — or asks for a TABLE, CHART, LIST, PAGE, or anything they'd want to " +
  "SEE — you MUST call a viewport tool, not just describe it aloud:\n" +
  "- a web page / article / map -> viewport_show_url\n" +
  "- a table / chart / formatted result you build from data -> viewport_show_html (write " +
  "clean, readable HTML; dark-friendly)\n" +
  "- an image -> viewport_show_image\n" +
  "If a request needs data first (e.g. a weather table), fetch it with the right tool, then " +
  "call viewport_show_html to render it. After showing, say ONE short line like \"it's on " +
  "screen\" — do not read the whole thing aloud.\n" +
  "NEVER INVENT URLs. Do NOT guess, construct, or recall a web-page or image URL from " +
  "memory — made-up links 404 (e.g. building a NASA APOD image filename from a date). The " +
  "URL you pass to viewport_show_url / viewport_show_image MUST come from a tool result " +
  "(web search, a connector) or from the operator verbatim. If you don't have a real URL, " +
  "use a search/connector tool to GET one first; if none exists, SAY you don't have a " +
  "verified link — never fabricate one. If a show tool returns a load/404 error, do NOT " +
  "retry the same URL — find the real one via a tool or tell the operator.";

// ── Session lifecycle ──────────────────────────────────────────────────────
async function startSession() {
  if (session || starting) return; // one session only (double-voice guard)
  starting = true;
  // Refresh externalised config first so this session uses the latest voice /
  // model / sources / secretsUrl authored in the desktop app (also fixes the
  // secretsUrl used for the key lookup just below).
  await loadVoxaConfig();
  await refreshVibeplayEnabled(); // gate in-orb playback on the vibeplay connector
  const provider = SETTINGS.provider || "gemini";
  let apiKey = store.key || hydratedGeminiKey;
  if (provider === "openai") apiKey = (localStorage.getItem("voxa.openaiKey") || "").trim();
  else if (provider === "gemini" && !apiKey) apiKey = await hydrateGeminiKeyFromHarness();
  if (provider === "gemini" && !apiKey) { starting = false; return askForKey(); }
  if (provider === "openai" && !apiKey) { starting = false; setState("idle"); setLine("Set an OpenAI API key in Settings."); return; }

  setState("connecting");
  setStatus("Connecting");
  setLine("…");

  // Listen & Observe: no tool bridge (so no actions are possible) and only the
  // note tools; always silent. Otherwise the normal brain + connector surface.
  const bridge = observeMode ? null : new ToolBridge(SETTINGS.sources);
  let localTools;
  if (observeMode) {
    // Observe mode: only the READ-ONLY focus tools (never route/confirm/trust).
    localTools = [...AMBIENT_CONTROL_TOOLS, ...APPEARANCE_TOOLS, ...OBSERVE_TOOLS, ...FOCUS_READONLY_TOOLS];
  } else {
    localTools = [...LOCAL_TOOLS, ...AMBIENT_CONTROL_TOOLS, ...APPEARANCE_TOOLS, ...FOCUS_TOOLS, ...VIEWPORT_TOOLS];
    if (vibeplayEnabled) localTools.push(...PLAYBACK_TOOLS);
    if (vibeplayEnabled || spotifyEnabled) localTools.push(...VOLUME_TOOLS);
    if (ambientMode) localTools.push(...AMBIENT_TOOLS);
  }
  const Provider = provider === "openai" ? OpenAiSession : provider === "daemon" ? DaemonSession : GeminiSession;
  session = new Provider({
    apiKey,
    model: provider === "openai" ? (SETTINGS.openaiModel || "gpt-realtime") : SETTINGS.model,
    voice: provider === "openai" ? (SETTINGS.openaiVoice || "marin") : SETTINGS.voice,
    daemonUrl: SETTINGS.daemonUrl,
    systemInstruction: SETTINGS.systemInstruction + (focusEnabled() ? FOCUS_GUIDE : "") + conversationContext(),
    extraInstruction: observeMode ? OBSERVE_GUIDE : ((ambientMode ? AMBIENT_GUIDE : "") + VIEWPORT_GUIDE),
    muted: observeMode || replyMode === "text",
    toolBridge: bridge,
    localTools,
    micDeviceId: store.micId || null,
    audio: audioParams(),
    on: {
      play: handlePlayDirective,
      status: (s, detail, lvl) => {
        if (lvl !== undefined) {
          // REAL mic RMS from MicCapture.onLevel — scaled into a usable 0..1.
          micLevel = Math.min(1, lvl * 4);
        }
        if (!s) return;
        if (s === "listening") {
          if (state === "speaking") sealTurn();
          setState("listening");
          setMusicDuck(false); // restore music volume after Voxa finishes
          if (SETTINGS.ui.pushToTalk && !pttHeld) {
            setStatus(`Push to talk · hold ${shortcutLabel()}`);
          } else if (observeMode) {
            setStatus("Observing · taking notes");
          } else {
            setStatus(`${ambientMode ? "Ambient" : "Listening"}${replyMode === "text" ? " · text" : ""} · ${bridge.declarations.length + localTools.length} tools`);
          }
          if (!turn.user && !turn.bot && (!els.line.textContent || els.line.textContent === "…")) {
            setLine(observeMode ? "Observing — I'll take notes quietly." : "Listening… how can I help you?");
          }
          // Flush any text the operator typed before the session was ready.
          if (pendingText && session) {
            const t = pendingText; pendingText = "";
            sealTurn();
            session.sendText(t);
          }
          // Deliver any proactive alerts (timers/reminders) that fired while the
          // session was closed/connecting — now that it's live, speak them.
          flushAlerts();
        } else if (s === "speaking") { setState("speaking"); setMusicDuck(true); setStatus("Speaking"); }
        else if (s === "connecting") { setState("connecting"); setStatus("Connecting"); }
        else if (s === "offline") {
          const message = detail ? `Gemini session closed: ${detail}` : "Gemini session closed";
          showSessionError(message);
          stopSession(true, { preserveLine: true });
          if (isAuthError(message)) {
            store.key = "";
            hydratedGeminiKey = "";
            askForKey();
          }
        }
      },
      userText: (t) => { setLine(t, "user"); streamMsg("user", t); },
      assistantText: (t) => { setLine(t); streamMsg("bot", t); },
      tool: (name, args, phase, info) => {
        if (phase === "running") { setStatus(`Tool · ${name}`); addMsg("tool", `⚙ ${name}`); }
        else {
          addMsg("tool", phase === "error" ? `✕ ${name} — ${String(info).slice(0, 80)}` : `✓ ${name}`);
          recordToolHistory(name, args, phase, info); // persist so it survives restarts
          setStatus(state === "speaking" ? "Speaking" : "Listening");
        }
      },
      error: (msg) => {
        const text = describeError(msg);
        console.error("[voxa]", msg);
        showSessionError(text);
        if (isAuthError(text)) {
          store.key = "";
          hydratedGeminiKey = "";
          stopSession(false, { preserveLine: true });
          askForKey();
        }
      },
    },
  });

  // Push-to-talk: start with the mic gated so audio only streams while the key
  // (or PTT button) is held. Open-mic mode leaves it live.
  if (SETTINGS.ui.pushToTalk && !pttHeld) session.setMicMuted(true);

  try {
    await session.start();
    starting = false;
  } catch (e) {
    showSessionError(describeError(e));
    if (isAuthError(lastSessionError)) {
      store.key = "";
      hydratedGeminiKey = "";
    }
    stopSession(false, { preserveLine: true });
  }
}

function stopSession(fromCallback = false, opts = {}) {
  if (session && !fromCallback) { try { session.stop(); } catch {} }
  session = null;
  starting = false;
  sealTurn();
  micLevel = 0;
  setState("idle");
  setStatus("Idle");
  if (!opts.preserveLine && (!els.line.textContent || els.line.textContent === "…")) {
    setLine("Tap the orb to start");
  }
}

els.orb.addEventListener("click", () => {
  if (state === "idle") startSession();
  else stopSession();
});

// ── Live composer (expanded chat) ──────────────────────────────────────────
// Typed messages go to the live model if a session is up; otherwise we start a
// session first and queue the text once it connects.
let pendingText = "";
function sendComposer() {
  const text = els.composerInput.value.trim();
  if (!text) return;
  els.composerInput.value = "";
  if (session && state !== "connecting") {
    streamMsg("user", text);
    sealTurn();
    session.sendText(text);
  } else {
    pendingText = text;
    streamMsg("user", text);
    if (state === "idle") startSession();
  }
}
els.send.addEventListener("click", sendComposer);
els.composerInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendComposer(); }
});

// ── Configurable shortcut + push-to-talk ───────────────────────────────────
// Driven by SETTINGS.ui (overridable via voxa-config.json `ui`):
//   pushToTalk false → the shortcut TOGGLES the session (open mic + server VAD).
//   pushToTalk true  → HOLD the shortcut to talk; releasing gates the mic again.
let pttHeld = false;

function modifierMatches(e) {
  switch (SETTINGS.ui.pttModifier) {
    case "ctrl": return e.ctrlKey;
    case "meta": return e.metaKey;
    case "alt": return e.altKey;
    case "shift": return e.shiftKey;
    case "ctrlmeta": return e.ctrlKey || e.metaKey;
    case "none": return !e.ctrlKey && !e.metaKey && !e.altKey; // bare key
    default: return e.ctrlKey || e.metaKey;
  }
}
function shortcutLabel() {
  const mod = SETTINGS.ui.pttModifier;
  const modTxt = mod === "ctrlmeta" ? "Ctrl/Cmd" : mod === "none" ? "" : mod.charAt(0).toUpperCase() + mod.slice(1);
  const key = String(SETTINGS.ui.pttKey).replace(/^Key/, "").replace(/^Digit/, "");
  return (modTxt ? modTxt + "+" : "") + key;
}
function applyShortcutHint() {
  if (!els.hint) return;
  els.hint.textContent = SETTINGS.ui.pushToTalk
    ? `Hold ${shortcutLabel()} to talk`
    : `Tip: press ${shortcutLabel()} to start/stop`;
  els.ptt.title = SETTINGS.ui.pushToTalk ? `Hold to talk (${shortcutLabel()})` : `Start/stop (${shortcutLabel()})`;
}

function toggleSession() {
  if (state === "idle") startSession();
  else stopSession();
}

// Hold-to-talk: open the mic while held; gate it again on release.
async function pttDown() {
  if (pttHeld) return;
  pttHeld = true;
  els.body.classList.add("talking");
  if (state === "idle") await startSession();   // starts gated; we open it below
  if (session) session.setMicMuted(false);
  if (state !== "connecting") setStatus("Listening… release to send");
}
function pttUp() {
  if (!pttHeld) return;
  pttHeld = false;
  els.body.classList.remove("talking");
  if (session) { session.setMicMuted(true); micLevel = 0; setStatus(`Push to talk · hold ${shortcutLabel()}`); }
}

const typingTarget = () => document.activeElement === els.composerInput || document.activeElement === els.key;

document.addEventListener("keydown", (e) => {
  if (e.code !== SETTINGS.ui.pttKey || !modifierMatches(e)) return;
  if (typingTarget()) return;          // never hijack typing
  e.preventDefault();
  if (e.repeat) return;
  if (SETTINGS.ui.pushToTalk) pttDown();
  else toggleSession();
});
document.addEventListener("keyup", (e) => {
  // Match on key alone: the modifier is often released a frame before the key.
  if (SETTINGS.ui.pushToTalk && e.code === SETTINGS.ui.pttKey) pttUp();
});
window.addEventListener("blur", () => { if (pttHeld) pttUp(); }); // release if focus is lost mid-hold

// PTT button: hold in push-to-talk mode, click-to-toggle otherwise.
els.ptt.addEventListener("click", () => { if (!SETTINGS.ui.pushToTalk) toggleSession(); });
els.ptt.addEventListener("pointerdown", (e) => { if (SETTINGS.ui.pushToTalk) { e.preventDefault(); pttDown(); } });
els.ptt.addEventListener("pointerup", () => { if (SETTINGS.ui.pushToTalk) pttUp(); });
els.ptt.addEventListener("pointerleave", () => { if (SETTINGS.ui.pushToTalk) pttUp(); });

els.close.addEventListener("click", async () => {
  stopSession();
  await stopAllMusic(); // don't leave Spotify/librespot playing with no UI to stop it
  if (TAURI) await TAURI.window.getCurrentWindow().close();
});

// Keyboard copy: Ctrl/Cmd+C copies the current selection; Ctrl/Cmd+A selects the feed.
document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === "c") {
    const sel = String(window.getSelection() || "");
    if (sel) { copyText(sel); e.preventDefault(); }
  } else if (k === "a" && !els.feed.classList.contains("hidden")) {
    const r = document.createRange();
    r.selectNodeContents(els.feed);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    e.preventDefault();
  }
});

// ── Window placement: dock bottom-right, then reveal ──────────────────────
async function dockBottomRight() {
  if (!TAURI) return;
  const { getCurrentWindow, currentMonitor, PhysicalPosition } = TAURI.window;
  const win = getCurrentWindow();
  const place = async () => {
    let mon = null;
    for (let i = 0; i < 12 && !mon; i++) {
      try { mon = await currentMonitor(); } catch {}
      if (!mon) await new Promise((r) => setTimeout(r, 50));
    }
    if (!mon) return false;
    const sf = mon.scaleFactor || 1;
    const margin = Math.round(24 * sf);
    const taskbar = Math.round(56 * sf);
    const w = Math.round(curLayout().collapsed.w * sf);
    const h = Math.round(curLayout().collapsed.h * sf);
    const x = mon.position.x + Math.max(0, mon.size.width - w - margin);
    const y = mon.position.y + Math.max(0, mon.size.height - h - taskbar);
    try { await win.setPosition(new PhysicalPosition(x, y)); return true; }
    catch (e) { console.warn("dock failed", e); return false; }
  };
  await place();      // try while hidden (no flash if it works)
  await win.show();   // reveal
  await place();      // and again after show — the window now has a monitor
}

dockBottomRight();
restoreFeed();
loadVoxaConfigWithRetry(); // pre-load desktop settings, retrying while the brain boots
applyShortcutHint(); // reflect the current shortcut in the composer hint immediately
setState("idle");
setStatus("Idle");
setLine("Tap the orb to start");
