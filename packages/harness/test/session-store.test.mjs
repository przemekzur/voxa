// Tests for lib/session-store.mjs — runs entirely in a temp dir, never touches
// the real data/ dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSessionStore, isValidSessionId } from "../lib/session-store.mjs";

function makeStore(opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-test-"));
  return { store: createSessionStore({ dataDir, ...opts }), dataDir };
}

test("append + get roundtrip persists a session record", () => {
  const { store, dataDir } = makeStore();
  const rec = store.append({
    sessionId: "sess-001",
    startedAt: "2026-07-10T10:00:00Z",
    persona: "assistant",
    turns: [
      { who: "user", text: "hello", ts: 1 },
      { who: "bot", text: "hi there", ts: 2 },
    ],
    actions: [{ tool: "memory_save", ok: true }],
  });
  assert.equal(rec.sessionId, "sess-001");
  assert.equal(rec.turns.length, 2);

  const got = store.get("sess-001");
  assert.ok(got, "get() should return the stored record");
  assert.equal(got.startedAt, "2026-07-10T10:00:00Z");
  assert.equal(got.persona, "assistant");
  assert.equal(got.turns.length, 2);
  assert.equal(got.actions.length, 1);
  assert.ok(fs.existsSync(path.join(dataDir, "sessions", "sess-001.json")), "one file per session");
  assert.equal(store.get("no-such-session"), null);
});

test("double post merges: dedupes turns, appends actions, overwrites end fields", () => {
  const { store } = makeStore();
  store.append({
    sessionId: "sess-merge",
    startedAt: "2026-07-10T10:00:00Z",
    turns: [
      { who: "user", text: "hello", ts: 1 },
      { who: "bot", text: "hi", ts: 2 },
    ],
    actions: [{ tool: "a" }],
  });
  const rec = store.append({
    sessionId: "sess-merge",
    turns: [
      { who: "bot", text: "hi", ts: 2 }, // duplicate — must not double up
      { who: "user", text: "bye", ts: 3 },
    ],
    actions: [{ tool: "b" }],
    endedAt: "2026-07-10T10:05:00Z",
    summary: "short chat",
  });
  assert.equal(rec.turns.length, 3, "duplicate turn deduped by ts+who+text");
  assert.deepEqual(rec.turns.map((t) => t.text), ["hello", "hi", "bye"]);
  assert.equal(rec.actions.length, 2, "actions appended");
  assert.equal(rec.endedAt, "2026-07-10T10:05:00Z");
  assert.equal(rec.summary, "short chat");
  assert.equal(rec.startedAt, "2026-07-10T10:00:00Z", "startedAt kept from first post");
});

test("sessionId sanitization rejects traversal and junk ids", () => {
  const { store, dataDir } = makeStore();
  assert.throws(() => store.append({ sessionId: "../evil", turns: [] }), /invalid sessionId/);
  assert.throws(() => store.append({ sessionId: "a", turns: [] }), /invalid sessionId/, "too short");
  assert.throws(() => store.append({ sessionId: "has space", turns: [] }), /invalid sessionId/);
  assert.throws(() => store.append({ sessionId: 42, turns: [] }), /invalid sessionId/);
  assert.equal(store.get("../evil"), null);
  assert.ok(!fs.existsSync(path.join(dataDir, "evil.json")), "nothing written outside sessions dir");
  assert.equal(isValidSessionId("ok-id-123"), true);
  assert.equal(isValidSessionId("-leading-hyphen"), false);
});

test("list() returns newest-first summaries", () => {
  const { store } = makeStore();
  store.append({ sessionId: "sess-old", startedAt: "2026-07-01T00:00:00Z", turns: [{ who: "user", text: "x", ts: 1 }] });
  store.append({ sessionId: "sess-new", startedAt: "2026-07-09T00:00:00Z", turns: [{ who: "user", text: "y", ts: 1 }], final: true, endedAt: "2026-07-09T01:00:00Z" });
  store.append({ sessionId: "sess-mid", startedAt: "2026-07-05T00:00:00Z", turns: [] });

  const items = store.list();
  assert.deepEqual(items.map((i) => i.sessionId), ["sess-new", "sess-mid", "sess-old"]);
  const newest = items[0];
  assert.equal(newest.turnCount, 1);
  assert.equal(newest.final, true);
  assert.equal(newest.endedAt, "2026-07-09T01:00:00Z");
  assert.equal(items[1].final, false);
});

test("prune() removes files older than retentionDays (and runs on final append)", () => {
  const { store, dataDir } = makeStore({ retentionDays: 30 });
  store.append({ sessionId: "sess-stale", startedAt: "2026-05-01T00:00:00Z", turns: [] });
  store.append({ sessionId: "sess-fresh", startedAt: "2026-07-10T00:00:00Z", turns: [] });

  // Age the stale file's mtime past the retention window.
  const staleFile = path.join(dataDir, "sessions", "sess-stale.json");
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  fs.utimesSync(staleFile, old, old);

  const removed = store.prune();
  assert.equal(removed, 1);
  assert.ok(!fs.existsSync(staleFile), "stale session deleted");
  assert.ok(store.get("sess-fresh"), "fresh session kept");

  // prune() also runs internally when a final payload lands.
  store.append({ sessionId: "sess-stale2", startedAt: "2026-05-01T00:00:00Z", turns: [] });
  const staleFile2 = path.join(dataDir, "sessions", "sess-stale2.json");
  fs.utimesSync(staleFile2, old, old);
  store.append({ sessionId: "sess-fresh", turns: [], final: true });
  assert.ok(!fs.existsSync(staleFile2), "final append triggered a prune");
});

test("LEARN_RETENTION_DAYS env overrides the retentionDays option", () => {
  const { store, dataDir } = makeStore({ retentionDays: 30 });
  store.append({ sessionId: "sess-envtest", startedAt: "2026-07-05T00:00:00Z", turns: [] });
  const file = path.join(dataDir, "sessions", "sess-envtest.json");
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
  fs.utimesSync(file, fiveDaysAgo, fiveDaysAgo);

  const prev = process.env.LEARN_RETENTION_DAYS;
  try {
    process.env.LEARN_RETENTION_DAYS = "3";
    assert.equal(store.prune(), 1, "5-day-old file pruned under 3-day env retention");
    assert.ok(!fs.existsSync(file));

    // Garbage env values fall back to the option (30 days — nothing to prune).
    store.append({ sessionId: "sess-envtest2", startedAt: "2026-07-05T00:00:00Z", turns: [] });
    const file2 = path.join(dataDir, "sessions", "sess-envtest2.json");
    fs.utimesSync(file2, fiveDaysAgo, fiveDaysAgo);
    process.env.LEARN_RETENTION_DAYS = "not-a-number";
    assert.equal(store.prune(), 0);
    assert.ok(fs.existsSync(file2));
  } finally {
    if (prev === undefined) delete process.env.LEARN_RETENTION_DAYS;
    else process.env.LEARN_RETENTION_DAYS = prev;
  }
});
