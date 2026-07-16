import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLearningReport,
  buildRecallQuery,
  effectiveMode,
  formatRecallBlock,
  LEARNING_MODE_ORDER,
  LEARNING_MODES,
  normalizeLearningMode,
  pickRecallTool,
} from "../src/js/learning.mjs";

// Minimal Storage-shaped fake — the orb settings window and set_learning_mode
// both read/write voxa.learningMode via window.localStorage; this stands in
// for it in Node without needing a DOM.
function makeFakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}

test("normalizes learning modes and gives valid overrides precedence", () => {
  assert.equal(normalizeLearningMode(" OFF "), "off");
  assert.equal(normalizeLearningMode("explicit"), "explicit");
  assert.equal(normalizeLearningMode("unknown"), "auto");
  assert.equal(normalizeLearningMode(), "auto");
  assert.equal(effectiveMode("off", "explicit"), "explicit");
  assert.equal(effectiveMode("off", "invalid"), "off");
});

test("builds a bounded recall query and handles an empty context", () => {
  assert.equal(buildRecallQuery({ summary: "", openLoops: [] }), "");
  const query = buildRecallQuery({
    summary: "x".repeat(300) + " important recent decision",
    openLoops: ["follow up tomorrow", "check the result"],
  });
  assert.ok(query.includes("important recent decision"));
  assert.ok(query.includes("open loops"));
  assert.ok(query.length <= 200);
});

test("prefers the brain recall tool over memory search", () => {
  assert.equal(pickRecallTool(["memory_search", "brain_query"]), "brain_query");
  assert.equal(pickRecallTool(["memory_search"]), "memory_search");
  assert.equal(pickRecallTool(["remember"]), null);
});

test("formats and clamps recalled context", () => {
  assert.equal(formatRecallBlock("  "), "");
  const block = formatRecallBlock("useful ".repeat(50), { maxChars: 120 });
  assert.match(block, /^REMEMBERED CONTEXT/);
  assert.ok(block.length <= 120);
});

test("learning report includes the mode and open loops", () => {
  const report = buildLearningReport({
    mode: "explicit",
    summary: "The operator prefers concise answers.",
    openLoops: ["finish the rollout"],
    sessionCount: 4,
  });
  assert.match(report, /mode is explicit/i);
  assert.match(report, /finish the rollout/i);
  assert.match(report, /4 recorded learning sessions/i);
});

test("LEARNING_MODE_ORDER lists exactly the three chips the settings window renders", () => {
  assert.deepEqual(LEARNING_MODE_ORDER, ["auto", "explicit", "off"]);
  for (const id of LEARNING_MODE_ORDER) {
    assert.equal(normalizeLearningMode(id), id, `${id} must be a valid mode`);
    assert.equal(LEARNING_MODES[id].id, id);
    assert.ok(LEARNING_MODES[id].name, `${id} needs a chip label`);
    assert.ok(LEARNING_MODES[id].blurb, `${id} needs a one-line description`);
  }
});

test("settings-window chip highlighting resolves the same precedence as voice: override > config > default auto", () => {
  // No config, no override -> default auto (fresh install / no voxa-config.json).
  assert.equal(effectiveMode(undefined, null), "auto");
  // Config only.
  assert.equal(effectiveMode("explicit", null), "explicit");
  assert.equal(effectiveMode("off", null), "off");
  // A valid override always wins over config, in either direction.
  assert.equal(effectiveMode("auto", "off"), "off");
  assert.equal(effectiveMode("off", "auto"), "auto");
  // An invalid/garbage override is ignored and falls back to config.
  assert.equal(effectiveMode("explicit", "not-a-mode"), "explicit");
  assert.equal(effectiveMode("explicit", ""), "explicit");
});

test("chip click persists voxa.learningMode and reopening the settings window reads it back", () => {
  const storage = makeFakeStorage();
  const readEffective = (configMode) => effectiveMode(configMode, storage.getItem("voxa.learningMode"));

  // Settings window opens for the first time: no override yet, config says auto.
  assert.equal(readEffective("auto"), "auto");

  // Clicking the "Explicit" chip runs the exact write set_learning_mode's handler
  // performs (localStorage.setItem("voxa.learningMode", mode)).
  storage.setItem("voxa.learningMode", "explicit");
  assert.equal(readEffective("auto"), "explicit", "override must win immediately");

  // Reopening the settings window (or a voice-driven change) must see the same
  // persisted value — this is the voice/UI parity requirement.
  assert.equal(readEffective("auto"), "explicit");

  // Clearing the override (e.g. via the documented console command) hands control
  // back to voxa-config.json.
  storage.removeItem("voxa.learningMode");
  assert.equal(readEffective("auto"), "auto");
  assert.equal(readEffective("off"), "off");
});
