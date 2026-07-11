import test from "node:test";
import assert from "node:assert/strict";
import {
  DEBRIEF_TOOL,
  routeDebrief,
  buildDebriefRequestText,
  buildMiniDebriefRequestText,
} from "../src/js/debrief.mjs";

const SAMPLE = {
  facts: ["lives near the coast", "runs a home lab"],
  preferences: ["prefers short answers"],
  lessons: ["confirm before deleting timers"],
  corrections: ["the meeting is Tuesday, not Monday"],
  open_loops: ["follow up on the garden lights"],
  summary: "Chatted about home automation.",
};

// ── Tool declaration shape ─────────────────────────────────────────────────

test("DEBRIEF_TOOL is a flat schema with the expected fields", () => {
  assert.equal(DEBRIEF_TOOL.name, "session_debrief");
  assert.ok(DEBRIEF_TOOL.description.length > 0);
  const p = DEBRIEF_TOOL.parameters;
  assert.equal(p.type, "object");
  assert.deepEqual(p.required, ["summary"]);
  for (const key of ["facts", "preferences", "lessons", "corrections", "open_loops"]) {
    assert.equal(p.properties[key].type, "array", key);
    assert.equal(p.properties[key].items.type, "string", key);
  }
  assert.equal(p.properties.summary.type, "string");
  // Flat: no $ref anywhere in the schema.
  assert.ok(!JSON.stringify(DEBRIEF_TOOL).includes("$ref"));
});

// ── Routing: private toolset (remember present) ────────────────────────────

test("routes facts+preferences to remember and lessons+corrections to memory_save", () => {
  const plan = routeDebrief(SAMPLE, ["remember", "fact_store", "memory_save", "other_tool"]);
  const remembers = plan.filter((e) => e.tool === "remember");
  assert.equal(remembers.length, 3); // 2 facts + 1 preference
  assert.deepEqual(remembers[0].args, { action: "add", fact: "lives near the coast" });
  assert.deepEqual(remembers[2].args, { action: "add", fact: "prefers short answers" });

  const saves = plan.filter((e) => e.tool === "memory_save");
  assert.equal(saves.length, 1); // lessons + corrections batched into one note
  assert.equal(saves[0].args.title, "learnings");
  assert.ok(saves[0].args.text.includes("- confirm before deleting timers"));
  assert.ok(saves[0].args.text.includes("- the meeting is Tuesday, not Monday"));

  assert.equal(plan.length, 4);
});

// ── Routing: fact_store only ───────────────────────────────────────────────

test("falls back to fact_store one-per-item for everything", () => {
  const plan = routeDebrief(SAMPLE, ["fact_store"]);
  assert.equal(plan.length, 5); // 3 facts/prefs + 2 lessons/corrections
  for (const e of plan) {
    assert.equal(e.tool, "fact_store");
    assert.equal(e.args.action, "add");
    assert.ok(typeof e.args.text === "string" && e.args.text.length > 0);
  }
  assert.equal(plan[0].args.text, "lives near the coast");
  assert.equal(plan[3].args.text, "confirm before deleting timers");
});

// ── Routing: public toolset (memory_save only) ─────────────────────────────

test("batches into memory_save notes when only memory_save exists", () => {
  const plan = routeDebrief(SAMPLE, ["memory_save"]);
  assert.equal(plan.length, 2);
  for (const e of plan) {
    assert.equal(e.tool, "memory_save");
    assert.equal(e.args.title, "learnings");
  }
  // First note: facts + preferences as bulleted markdown.
  assert.ok(plan[0].args.text.includes("- lives near the coast"));
  assert.ok(plan[0].args.text.includes("- prefers short answers"));
  // Second note: lessons + corrections.
  assert.ok(plan[1].args.text.includes("- confirm before deleting timers"));
});

// ── Routing: edge cases ────────────────────────────────────────────────────

test("empty toolset yields an empty plan", () => {
  assert.deepEqual(routeDebrief(SAMPLE, []), []);
});

test("empty/missing categories yield an empty plan even with sinks", () => {
  assert.deepEqual(routeDebrief({ summary: "quiet session" }, ["remember", "memory_save"]), []);
  assert.deepEqual(routeDebrief({ facts: ["", "  "], lessons: [] }, ["remember", "memory_save"]), []);
});

test("non-string and blank items are dropped, whitespace trimmed", () => {
  const plan = routeDebrief({ facts: ["  keep me  ", 42, null, ""] }, ["remember"]);
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0], { tool: "remember", args: { action: "add", fact: "keep me" } });
});

test("accepts a Set of available tool names", () => {
  const plan = routeDebrief(SAMPLE, new Set(["remember", "memory_save"]));
  assert.equal(plan.filter((e) => e.tool === "remember").length, 3);
});

// ── Request texts ──────────────────────────────────────────────────────────

test("request texts are non-empty and mention session_debrief", () => {
  const full = buildDebriefRequestText();
  const mini = buildMiniDebriefRequestText();
  assert.ok(full.length > 0 && full.includes("session_debrief"));
  assert.ok(mini.length > 0 && mini.includes("session_debrief"));
  assert.notEqual(full, mini);
  assert.ok(full.includes("ending")); // forced final turn
  assert.ok(mini.toLowerCase().includes("checkpoint")); // softer mid-session variant
});
