// Unit tests for buildMemoryGuide — the per-session memory guidance that is
// derived from the tools actually loaded (WP-L1.2). Run with:
//   node --test test/memory-guide.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { buildMemoryGuide } from "../src/js/memory-guide.mjs";

const BRAIN_SET = ["brain_query", "fact_store", "fact_recall", "remember", "search_knowledge"];
const NOTES_SET = ["memory_save", "memory_search", "memory_read"];

test("brain toolset mentions brain tools, never notes tools", () => {
  const guide = buildMemoryGuide([...BRAIN_SET, "list_projects"]);
  assert.match(guide, /brain_query/);
  assert.match(guide, /fact_store/);
  assert.match(guide, /fact_recall/);
  assert.doesNotMatch(guide, /memory_save/);
  assert.doesNotMatch(guide, /memory_search/);
});

test("notes toolset mentions memory_save/memory_search, never brain tools", () => {
  const guide = buildMemoryGuide([...NOTES_SET, "run_command"]);
  assert.match(guide, /memory_save/);
  assert.match(guide, /memory_search/);
  assert.match(guide, /memory_read/);
  assert.doesNotMatch(guide, /fact_store/);
  assert.doesNotMatch(guide, /fact_recall/);
  assert.doesNotMatch(guide, /brain_query/);
  assert.doesNotMatch(guide, /search_knowledge/);
});

test("notes toolset without memory_read does not mention it", () => {
  const guide = buildMemoryGuide(["memory_save", "memory_search"]);
  assert.match(guide, /memory_save/);
  assert.match(guide, /memory_search/);
  assert.doesNotMatch(guide, /memory_read/);
});

test("empty toolset returns empty string", () => {
  assert.equal(buildMemoryGuide([]), "");
});

test("unrelated toolset returns empty string (zero memory claims)", () => {
  assert.equal(buildMemoryGuide(["list_projects", "run_terminal_command", "set_theme"]), "");
});

test("non-array input returns empty string", () => {
  assert.equal(buildMemoryGuide(undefined), "");
  assert.equal(buildMemoryGuide(null), "");
});

test("partial brain set (only remember) mentions only what exists", () => {
  const guide = buildMemoryGuide(["remember", "list_tasks"]);
  assert.match(guide, /remember/);
  assert.doesNotMatch(guide, /fact_store/);
  assert.doesNotMatch(guide, /fact_recall/);
  assert.doesNotMatch(guide, /brain_query/);
  assert.doesNotMatch(guide, /search_knowledge/);
  assert.doesNotMatch(guide, /memory_save/);
});

test("partial brain set (only brain_query) emits lookup guidance only", () => {
  const guide = buildMemoryGuide(["brain_query"]);
  assert.match(guide, /brain_query/);
  assert.doesNotMatch(guide, /fact_store/);
  assert.doesNotMatch(guide, /remember, save/); // no store guidance without a store tool
});

test("session_debrief line appears only when the tool is present", () => {
  const withDebrief = buildMemoryGuide([...BRAIN_SET, "session_debrief"]);
  assert.match(withDebrief, /session_debrief/);
  const withoutDebrief = buildMemoryGuide([...BRAIN_SET]);
  assert.doesNotMatch(withoutDebrief, /session_debrief/);
});

test("session_debrief line also appears alongside the notes tier", () => {
  const guide = buildMemoryGuide([...NOTES_SET, "session_debrief"]);
  assert.match(guide, /session_debrief/);
  assert.match(guide, /memory_save/);
});
