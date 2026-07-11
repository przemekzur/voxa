// Tests for lib/reflector.mjs — heuristic extraction, idempotence, markdown
// output, brain forwarding, and the LLM tier with fallback.
// All file writes go to fresh temp dirs; the real data/ dir is never touched.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { reflectSession, extractHeuristics, EXTRACTION_PROMPT, MODEL } from "../lib/reflector.mjs";

// The reflector reads these as fallbacks — a developer machine must not leak
// real endpoints or keys into the tests.
delete process.env.LEARN_BRAIN_URL;
delete process.env.LEARN_API_KEY;
delete process.env.GEMINI_API_KEY;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "reflector-test-"));
}

function turn(who, text, ts = "2026-07-10T10:00:00Z") {
  return { who, text, ts };
}

function baseRecord(overrides = {}) {
  return {
    sessionId: "sess-test-1",
    startedAt: "2026-07-10T10:00:00Z",
    endedAt: "2026-07-10T10:05:00Z",
    turns: [
      turn("bot", "Hello, how can I help?"),
      turn("user", "Remember that my dog is called Pixel"),
    ],
    final: true,
    ...overrides,
  };
}

// ── extractHeuristics ─────────────────────────────────────────────────────────

test("heuristic: 'remember that X' becomes a fact", () => {
  const out = extractHeuristics([turn("user", "Please remember that the garage code is 4412")]);
  assert.ok(out.facts.some((f) => f.includes("the garage code is 4412")));
});

test("heuristic: 'my <thing> is <value>' becomes a fact", () => {
  const out = extractHeuristics([turn("user", "By the way, my favorite editor is Neovim.")]);
  assert.ok(out.facts.some((f) => /my favorite editor is Neovim/i.test(f)));
});

test("heuristic: preference verbs become preferences", () => {
  const out = extractHeuristics([
    turn("user", "I really prefer short answers"),
    turn("user", "I hate long intros"),
    turn("user", "I don't like being interrupted"),
  ]);
  assert.strictEqual(out.preferences.length, 3);
  assert.ok(out.preferences.some((p) => /prefer short answers/i.test(p)));
  assert.ok(out.preferences.some((p) => /hate long intros/i.test(p)));
  assert.ok(out.preferences.some((p) => /like being interrupted/i.test(p)));
});

test("heuristic: pushback openers become corrections with preceding bot context", () => {
  const longBot = "The meeting is on Tuesday at three in the afternoon, in the usual room on the second floor of the annex building";
  const out = extractHeuristics([
    turn("bot", longBot),
    turn("user", "No, the meeting is on Wednesday"),
  ]);
  assert.strictEqual(out.corrections.length, 1);
  assert.ok(out.corrections[0].startsWith("No, the meeting is on Wednesday"));
  // Context is the preceding bot turn clipped to 80 chars.
  assert.ok(out.corrections[0].includes("(re: " + longBot.slice(0, 80)));
});

test("heuristic: 'actually,' and \"that's wrong\" also trigger corrections", () => {
  const out = extractHeuristics([
    turn("bot", "You said blue."),
    turn("user", "Actually, I said green"),
    turn("bot", "Noted as green."),
    turn("user", "That's wrong, it was teal"),
  ]);
  assert.strictEqual(out.corrections.length, 2);
});

test("heuristic: deferred intents become open loops", () => {
  const out = extractHeuristics([
    turn("user", "Remind me to water the plants"),
    turn("user", "Let's do the budget review tomorrow"),
  ]);
  assert.strictEqual(out.open_loops.length, 2);
});

test("heuristic: bot turns never produce learnings", () => {
  const out = extractHeuristics([
    turn("bot", "Remember that I am a bot"),
    turn("bot", "I really like helping"),
  ]);
  assert.strictEqual(out.facts.length, 0);
  assert.strictEqual(out.preferences.length, 0);
});

test("heuristic: debrief arrays merge first and dedupe against turn-derived items", () => {
  const debrief = {
    facts: ["User's dog is called Pixel"],
    lessons: ["Speak slower"],
    preferences: ["prefer short answers"],
  };
  const out = extractHeuristics(
    [turn("user", "I prefer short answers")],
    debrief
  );
  // Debrief item first, heuristic duplicate ("prefer short answers") deduped.
  assert.deepStrictEqual(out.preferences, ["prefer short answers"]);
  assert.deepStrictEqual(out.facts, ["User's dog is called Pixel"]);
  assert.deepStrictEqual(out.lessons, ["Speak slower"]);
});

test("heuristic: caps at 20 items per category and clamps items to 200 chars", () => {
  const turns = [];
  for (let i = 0; i < 30; i++) turns.push(turn("user", `remember that item number ${i} matters`));
  const long = "remember that " + "x".repeat(500);
  const out = extractHeuristics([turn("user", long), ...turns]);
  assert.strictEqual(out.facts.length, 20);
  for (const f of out.facts) assert.ok(f.length <= 200);
});

// ── reflectSession: markdown + idempotence ────────────────────────────────────

test("reflectSession writes markdown with session heading and bullets", async () => {
  const dataDir = tempDir();
  const record = baseRecord({
    turns: [
      turn("bot", "Hi there"),
      turn("user", "Remember that my sister's birthday is in May"),
      turn("user", "I really like jazz"),
      turn("user", "Remind me to call the dentist"),
    ],
  });
  const res = await reflectSession(record, { dataDir });
  assert.strictEqual(res.forwarded, false);
  assert.strictEqual(res.written.length, 1);
  const md = fs.readFileSync(res.written[0], "utf8");
  assert.ok(md.includes(`## session ${record.sessionId} (${record.endedAt})`));
  assert.ok(/- fact: .*birthday is in May/i.test(md));
  assert.ok(/- preference: .*like jazz/i.test(md));
  assert.ok(/- open loop: .*call the dentist/i.test(md));
});

test("reflectSession is idempotent: second call skips and file is written once", async () => {
  const dataDir = tempDir();
  const record = baseRecord();
  const first = await reflectSession(record, { dataDir });
  assert.ok(Array.isArray(first.written));
  const second = await reflectSession(record, { dataDir });
  assert.deepStrictEqual(second, { skipped: true });
  const md = fs.readFileSync(first.written[0], "utf8");
  const headings = md.split(`## session ${record.sessionId}`).length - 1;
  assert.strictEqual(headings, 1);
  // Processed marker exists.
  assert.ok(fs.existsSync(path.join(dataDir, "learnings", ".processed", record.sessionId)));
});

// ── reflectSession: brain forward ─────────────────────────────────────────────

test("reflectSession forwards the raw record to the brain endpoint", async () => {
  const dataDir = tempDir();
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({}) };
  };
  const record = baseRecord({ sessionId: "sess-brain-1" });
  const res = await reflectSession(record, {
    dataDir,
    brainUrl: "http://localhost:3000",
    fetchImpl,
  });
  assert.strictEqual(res.forwarded, true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, "http://localhost:3000/api/brain/ingest-session");
  assert.strictEqual(calls[0].opts.method, "POST");
  const body = JSON.parse(calls[0].opts.body);
  assert.strictEqual(body.sessionId, "sess-brain-1");
});

test("reflectSession survives a rejecting brain fetch and still distills locally", async () => {
  const dataDir = tempDir();
  const fetchImpl = async () => {
    throw new Error("connection refused");
  };
  const record = baseRecord({ sessionId: "sess-brain-2" });
  const res = await reflectSession(record, {
    dataDir,
    brainUrl: "http://localhost:3000",
    fetchImpl,
  });
  assert.strictEqual(res.forwarded, false);
  assert.strictEqual(res.written.length, 1);
  assert.ok(fs.readFileSync(res.written[0], "utf8").includes("## session sess-brain-2"));
});

// ── reflectSession: LLM tier ──────────────────────────────────────────────────

test("reflectSession parses fenced JSON from the model endpoint", async () => {
  const dataDir = tempDir();
  const payload = {
    facts: ["User works from home on Fridays"],
    preferences: ["Wants metric units"],
    lessons: [],
    corrections: [],
    open_loops: ["Book flights next week"],
    summary: "Planning session.",
  };
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      json: async () => ({
        candidates: [
          { content: { parts: [{ text: "```json\n" + JSON.stringify(payload) + "\n```" }] } },
        ],
      }),
    };
  };
  const record = baseRecord({ sessionId: "sess-llm-1" });
  const res = await reflectSession(record, { dataDir, apiKey: "test-key", fetchImpl });
  assert.deepStrictEqual(res.learnings.facts, payload.facts);
  assert.deepStrictEqual(res.learnings.open_loops, payload.open_loops);
  assert.strictEqual(res.learnings.summary, "Planning session.");
  // Called the right model, with the key in a header (never the URL).
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].url.includes(`models/${MODEL}:generateContent`));
  assert.ok(!calls[0].url.includes("test-key"));
  assert.strictEqual(calls[0].opts.headers["x-goog-api-key"], "test-key");
  // The request carries the extraction prompt plus the transcript.
  const sentText = JSON.parse(calls[0].opts.body).contents[0].parts[0].text;
  assert.ok(sentText.startsWith(EXTRACTION_PROMPT));
  assert.ok(sentText.includes("user: Remember that my dog is called Pixel"));
  const md = fs.readFileSync(res.written[0], "utf8");
  assert.ok(md.includes("- fact: User works from home on Fridays"));
  assert.ok(md.includes("- open loop: Book flights next week"));
});

test("reflectSession falls back to heuristics when the model returns garbage", async () => {
  const dataDir = tempDir();
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: "certainly! here are your learnings: none" }] } }],
    }),
  });
  const record = baseRecord({
    sessionId: "sess-llm-2",
    turns: [turn("user", "Remember that my train leaves at seven")],
  });
  const res = await reflectSession(record, { dataDir, apiKey: "test-key", fetchImpl });
  assert.ok(res.learnings.facts.some((f) => /train leaves at seven/i.test(f)));
  const md = fs.readFileSync(res.written[0], "utf8");
  assert.ok(/- fact: .*train leaves at seven/i.test(md));
});

test("reflectSession falls back to heuristics when the model endpoint errors", async () => {
  const dataDir = tempDir();
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const record = baseRecord({
    sessionId: "sess-llm-3",
    turns: [turn("user", "I really love hiking")],
  });
  const res = await reflectSession(record, { dataDir, apiKey: "test-key", fetchImpl });
  assert.ok(res.learnings.preferences.some((p) => /love hiking/i.test(p)));
});
