import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLearningReport,
  buildRecallQuery,
  effectiveMode,
  formatRecallBlock,
  normalizeLearningMode,
  pickRecallTool,
} from "../src/js/learning.mjs";

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
