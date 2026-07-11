import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeSessionId,
  buildSessionPayload,
  postSession,
  getLearnBase,
  heuristicCompact,
} from "../src/js/learn.mjs";

const ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

test("makeSessionId format: s-<timestamp>-<4 base36 chars>, lowercase, id-safe", () => {
  const id = makeSessionId();
  assert.match(id, ID_RE);
  assert.match(id, /^s-\d{14}-[a-z0-9]{4}$/);
  assert.equal(id, id.toLowerCase());
});

test("makeSessionId uses the provided clock for the timestamp part", () => {
  const now = Date.UTC(2026, 0, 2, 3, 4, 5); // 2026-01-02 03:04:05 UTC
  const id = makeSessionId(now);
  assert.ok(id.startsWith("s-20260102030405-"), `unexpected id: ${id}`);
});

test("makeSessionId ids are unique-ish across calls", () => {
  const ids = new Set(Array.from({ length: 50 }, () => makeSessionId()));
  assert.ok(ids.size > 1, "random suffix should vary");
});

test("buildSessionPayload keeps valid fields and drops undefined ones", () => {
  const p = buildSessionPayload({
    sessionId: "s-1abc",
    startedAt: 100,
    endedAt: 200,
    persona: "Nova",
    turns: [{ who: "user", text: "hi" }],
    actions: [{ who: "tool", text: "did_thing() → ok" }],
    summary: "we talked",
    final: true,
  });
  assert.deepEqual(p, {
    sessionId: "s-1abc",
    startedAt: 100,
    endedAt: 200,
    persona: "Nova",
    turns: [{ who: "user", text: "hi" }],
    actions: [{ who: "tool", text: "did_thing() → ok" }],
    summary: "we talked",
    final: true,
  });
});

test("buildSessionPayload drops absent optionals, defaults arrays and final", () => {
  const p = buildSessionPayload({ sessionId: "s-2def" });
  assert.deepEqual(p, { sessionId: "s-2def", turns: [], actions: [], final: false });
  assert.ok(!("endedAt" in p));
  assert.ok(!("persona" in p));
  assert.ok(!("summary" in p));
  assert.ok(!("debrief" in p));
});

test("buildSessionPayload clamps turns to the last 500", () => {
  const turns = Array.from({ length: 620 }, (_, i) => ({ who: "user", text: `t${i}` }));
  const p = buildSessionPayload({ sessionId: "s-3ghi", turns });
  assert.equal(p.turns.length, 500);
  assert.equal(p.turns[0].text, "t120"); // oldest dropped
  assert.equal(p.turns[499].text, "t619"); // newest kept
});

test("buildSessionPayload passes a debrief object through untouched", () => {
  const debrief = { wins: ["a"], notes: "keep it", nested: { k: 1 } };
  const p = buildSessionPayload({ sessionId: "s-4jkl", debrief });
  assert.deepEqual(p.debrief, debrief);
  // non-objects are dropped
  assert.ok(!("debrief" in buildSessionPayload({ sessionId: "s-4jkl", debrief: "nope" })));
  assert.ok(!("debrief" in buildSessionPayload({ sessionId: "s-4jkl", debrief: [1, 2] })));
});

test("buildSessionPayload ignores invalid types", () => {
  const p = buildSessionPayload({
    sessionId: 42,
    startedAt: "not a number",
    persona: "   ",
    turns: "nope",
    actions: null,
    final: "yes",
  });
  assert.deepEqual(p, { turns: [], actions: [], final: false });
});

test("getLearnBase picks the :3010 entry from mixed sources", () => {
  const base = getLearnBase([
    { url: "http://localhost:3000" },
    { url: "http://localhost:3010/" },
  ]);
  assert.equal(base, "http://localhost:3010");
});

test("getLearnBase accepts plain-string sources", () => {
  assert.equal(getLearnBase(["http://localhost:3000", "http://localhost:3010"]), "http://localhost:3010");
});

test("getLearnBase skips :3000 and takes the first other entry when no :3010", () => {
  const base = getLearnBase([
    { url: "http://localhost:3000" },
    { url: "http://localhost:4020" },
    { url: "http://localhost:5050" },
  ]);
  assert.equal(base, "http://localhost:4020");
});

test("getLearnBase defaults when sources are empty, missing, or all :3000", () => {
  assert.equal(getLearnBase([]), "http://localhost:3010");
  assert.equal(getLearnBase(undefined), "http://localhost:3010");
  assert.equal(getLearnBase([{ url: "http://localhost:3000" }]), "http://localhost:3010");
  assert.equal(getLearnBase([{ bad: true }, null]), "http://localhost:3010");
});

test("heuristicCompact condenses exchanges into one line each and keeps the previous summary", () => {
  const out = heuristicCompact("Earlier: operator likes jazz.", [
    { who: "user", text: "play something" },
    { who: "bot", text: "Queued a jazz mix." },
    { who: "tool", text: "queue_music() → ok" }, // tool turns are not exchanges
    { who: "user", text: "louder please" },
    { who: "bot", text: "Volume up." },
  ]);
  const lines = out.split("\n");
  assert.equal(lines[0], "Earlier: operator likes jazz.");
  assert.equal(lines[1], "user: play something → assistant: Queued a jazz mix.");
  assert.equal(lines[2], "user: louder please → assistant: Volume up.");
  assert.equal(lines.length, 3);
});

test("heuristicCompact clamps to maxChars and keeps the most recent content", () => {
  const turns = Array.from({ length: 40 }, (_, i) => [
    { who: "user", text: `question number ${i} about a fairly long topic` },
    { who: "bot", text: `answer number ${i} with plenty of detail in it` },
  ]).flat();
  const out = heuristicCompact("old summary ".repeat(50), turns, { maxChars: 300 });
  assert.ok(out.length <= 300, `length ${out.length} > 300`);
  assert.ok(out.includes("39"), "most recent exchange must survive the clamp");
  assert.ok(out.startsWith("…"), "clamped output marks the truncated head");
});

test("heuristicCompact handles empty input", () => {
  assert.equal(heuristicCompact("", []), "");
  assert.equal(heuristicCompact("keep me", []), "keep me");
  assert.equal(heuristicCompact("", undefined), "");
});

test("heuristicCompact clamps a runaway single turn", () => {
  const out = heuristicCompact("", [{ who: "user", text: "x".repeat(5000) }], { maxChars: 200 });
  assert.ok(out.length <= 200);
});

test("postSession resolves {ok:false} when fetch rejects (never throws)", async () => {
  const res = await postSession("http://localhost:3010", { sessionId: "s-err" }, async () => {
    throw new Error("connection refused");
  });
  assert.equal(res.ok, false);
  assert.match(String(res.error), /connection refused/);
});

test("postSession resolves {ok:false} on a non-2xx response", async () => {
  const res = await postSession("http://localhost:3010", {}, async () => ({
    ok: false,
    status: 500,
  }));
  assert.deepEqual(res, { ok: false, error: "HTTP 500" });
});

test("postSession posts JSON to <base>/api/learn/session and resolves {ok:true}", async () => {
  let seenUrl = "";
  let seenInit = null;
  const res = await postSession(
    "http://localhost:3010/",
    { sessionId: "s-okay", turns: [] },
    async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return { ok: true, status: 200, json: async () => ({ stored: true }) };
    }
  );
  assert.equal(seenUrl, "http://localhost:3010/api/learn/session");
  assert.equal(seenInit.method, "POST");
  assert.equal(seenInit.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(seenInit.body), { sessionId: "s-okay", turns: [] });
  assert.ok(seenInit.signal, "should pass an abort signal for the timeout");
  assert.deepEqual(res, { ok: true, status: 200, data: { stored: true } });
});

test("postSession tolerates a non-JSON success body", async () => {
  const res = await postSession("http://localhost:3010", {}, async () => ({
    ok: true,
    status: 204,
    json: async () => { throw new Error("no body"); },
  }));
  assert.deepEqual(res, { ok: true, status: 204, data: null });
});
