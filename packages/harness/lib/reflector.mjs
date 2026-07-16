// Reflector for the conversation-learning loop (Phase 3).
// Distills a finished session record into durable markdown learnings under
// <dataDir>/learnings/. Three tiers, best available wins:
//   1. optional forward of the raw record to a private brain endpoint,
//   2. LLM extraction when an API key is configured,
//   3. key-free heuristic extraction (always available).
//
// Node stdlib only — no dependencies, no build step.
import fs from "node:fs";
import path from "node:path";

export const MODEL = "gemini-2.5-flash";

export const EXTRACTION_PROMPT = [
  "You extract durable learnings from a voice-assistant conversation transcript.",
  "Return ONLY a JSON object with exactly these keys:",
  '{"facts":[],"preferences":[],"lessons":[],"corrections":[],"open_loops":[],"summary":""}',
  "Rules:",
  "- Include only durable, concrete, user-specific items worth remembering across sessions.",
  "- facts: stable statements about the user or their world (names, setups, dates, relationships).",
  "- preferences: likes, dislikes, and how the user wants the assistant to behave.",
  "- lessons: things the assistant should do differently next time.",
  "- corrections: places the user corrected the assistant, stated as the corrected truth.",
  "- open_loops: unfinished business, reminders, or follow-ups the user expects.",
  "- summary: one or two sentences describing the session.",
  "- Prefer empty arrays over speculation. Never invent items. No duplicates.",
  "- Each item is a single short plain-text sentence.",
  "- Output raw JSON only: no markdown, no code fences, no commentary.",
].join("\n");

const CATEGORIES = ["facts", "preferences", "lessons", "corrections", "open_loops"];
const MAX_ITEMS_PER_CATEGORY = 20;
const MAX_ITEM_LENGTH = 200;

// Markdown bullet label for each category.
const BULLET_LABEL = {
  facts: "fact",
  preferences: "preference",
  lessons: "lesson",
  corrections: "correction",
  open_loops: "open loop",
};

// Log brain-forward failures only once per process — the forward is optional
// and a dead endpoint must not spam the harness log on every session.
let brainErrorLogged = false;

function clampItem(value) {
  return String(value).replace(/\s+/g, " ").trim().slice(0, MAX_ITEM_LENGTH);
}

function emptyLearnings() {
  const out = {};
  for (const c of CATEGORIES) out[c] = [];
  out.summary = "";
  return out;
}

// Normalize an arbitrary object into the canonical learnings shape:
// string arrays only, deduped (case-insensitive), capped and clamped.
function normalizeLearnings(raw) {
  const out = emptyLearnings();
  if (!raw || typeof raw !== "object") return out;
  for (const c of CATEGORIES) {
    // Accept snake_case (canonical) and camelCase (lenient) keys.
    const camel = c.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
    const arr = Array.isArray(raw[c]) ? raw[c] : Array.isArray(raw[camel]) ? raw[camel] : [];
    const seen = new Set();
    for (const item of arr) {
      if (item == null) continue;
      const text = clampItem(item);
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out[c].push(text);
      if (out[c].length >= MAX_ITEMS_PER_CATEGORY) break;
    }
  }
  if (typeof raw.summary === "string") out.summary = clampItem(raw.summary);
  return out;
}

// ── Heuristic tier ────────────────────────────────────────────────────────────
// Pure, key-free extraction over user turns, merged with the structured
// debrief object when the session produced one (debrief items first).
export function extractHeuristics(turns, debrief) {
  const found = emptyLearnings();
  const list = Array.isArray(turns) ? turns : [];

  for (let i = 0; i < list.length; i++) {
    const turn = list[i];
    if (!turn || turn.who !== "user" || typeof turn.text !== "string") continue;
    const text = turn.text.trim();
    if (!text) continue;

    // "remember (that) X" → fact
    const remember = text.match(/\bremember\s+(?:that\s+)?(.+)/i);
    if (remember) found.facts.push(clampItem(remember[1]));

    // "my <thing> is <value>" → fact
    const my = text.match(/\bmy\s+([a-z0-9' -]+?)\s+is\s+([^.!?\n]+)/i);
    if (my) found.facts.push(clampItem(`my ${my[1]} is ${my[2]}`));

    // "I (really) prefer/like/love/hate/don't like X" → preference
    const pref = text.match(/\bi\s+(?:really\s+)?(prefer|like|love|hate|don'?t\s+like)\s+(.+)/i);
    if (pref) found.preferences.push(clampItem(`${pref[1]} ${pref[2]}`));

    // Turns opening with a pushback marker → correction, paired with the
    // preceding bot turn (first 80 chars) for context.
    if (/^(no,|actually,|that'?s wrong)/i.test(text)) {
      let context = "";
      for (let j = i - 1; j >= 0; j--) {
        const prev = list[j];
        if (prev && prev.who !== "user" && typeof prev.text === "string" && prev.text.trim()) {
          context = prev.text.trim().slice(0, 80);
          break;
        }
      }
      found.corrections.push(clampItem(context ? `${text} (re: ${context})` : text));
    }

    // Deferred intent → open loop
    if (/\b(remind me|later|tomorrow)\b/i.test(text)) {
      found.open_loops.push(clampItem(text));
    }
  }

  // Merge: debrief items first (they are deliberate), heuristics after, deduped.
  const merged = emptyLearnings();
  const d = debrief && typeof debrief === "object" ? normalizeLearnings(debrief) : emptyLearnings();
  for (const c of CATEGORIES) merged[c] = [...d[c], ...found[c]];
  merged.summary = d.summary;
  return normalizeLearnings(merged);
}

// ── LLM tier ──────────────────────────────────────────────────────────────────
function transcriptText(record) {
  const turns = Array.isArray(record?.turns) ? record.turns : [];
  return turns
    .filter((t) => t && typeof t.text === "string" && t.text.trim())
    .map((t) => `${t.who === "user" ? "user" : "assistant"}: ${t.text.trim()}`)
    .join("\n");
}

function stripCodeFences(text) {
  let out = String(text).trim();
  const fence = out.match(/^```[a-z]*\s*([\s\S]*?)\s*```$/i);
  if (fence) out = fence[1].trim();
  return out;
}

async function extractWithModel(record, apiKey, fetchImpl) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const prompt = `${EXTRACTION_PROMPT}\n\nTranscript:\n${transcriptText(record)}`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });
  if (!res || res.ok === false) throw new Error(`model endpoint returned ${res?.status ?? "no response"}`);
  const data = await res.json();
  const text = (data?.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p?.text ?? "")
    .join("");
  if (!text.trim()) throw new Error("model returned empty text");
  const parsed = JSON.parse(stripCodeFences(text));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("model returned non-object JSON");
  }
  return normalizeLearnings(parsed);
}

// ── Brain forward (optional) ──────────────────────────────────────────────────
async function forwardToBrain(record, brainUrl, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const base = String(brainUrl).replace(/\/+$/, "");
    const res = await fetchImpl(`${base}/api/brain/ingest-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
      signal: controller.signal,
    });
    return !res || res.ok !== false;
  } catch (e) {
    if (!brainErrorLogged) {
      brainErrorLogged = true;
      console.error(`[reflector] brain forward failed (will not repeat): ${e?.message || e}`);
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ── Markdown output ───────────────────────────────────────────────────────────
function renderMarkdown(sessionId, when, learnings) {
  const lines = [`## session ${sessionId} (${when})`, ""];
  let any = false;
  for (const c of CATEGORIES) {
    for (const item of learnings[c]) {
      lines.push(`- ${BULLET_LABEL[c]}: ${item}`);
      any = true;
    }
  }
  if (!any) lines.push("- (no durable learnings extracted)");
  lines.push("");
  return lines.join("\n");
}

// ── Entry point ───────────────────────────────────────────────────────────────
// Called by the harness (fire-and-forget) when a session record is final.
export async function reflectSession(record, { dataDir, apiKey, brainUrl, fetchImpl = fetch } = {}) {
  if (!dataDir) throw new Error("reflectSession: dataDir is required");
  const sessionId = record?.sessionId;
  if (!sessionId || typeof sessionId !== "string") {
    throw new Error("reflectSession: record.sessionId is required");
  }

  const learningsDir = path.join(dataDir, "learnings");
  const markerDir = path.join(learningsDir, ".processed");
  const markerPath = path.join(markerDir, sessionId);

  // Idempotence: each session is distilled exactly once.
  if (fs.existsSync(markerPath)) return { skipped: true };

  // Optional forward of the raw record to a private brain. Runs in addition to
  // local distillation; failures never block the local path.
  const brainTarget = brainUrl ?? process.env.LEARN_BRAIN_URL;
  let forwarded = false;
  if (brainTarget) {
    forwarded = await forwardToBrain(record, brainTarget, fetchImpl);
  }

  // Distill: LLM when a key is available, heuristic otherwise or on ANY failure.
  const key = apiKey ?? process.env.LEARN_API_KEY ?? process.env.GEMINI_API_KEY;
  let learnings = null;
  if (key) {
    try {
      learnings = await extractWithModel(record, key, fetchImpl);
    } catch (e) {
      console.error(`[reflector] model extraction failed, using heuristics: ${e?.message || e}`);
      learnings = null;
    }
  }
  if (!learnings) {
    learnings = extractHeuristics(record?.turns, record?.debrief);
  }

  // Append to today's learnings file.
  fs.mkdirSync(markerDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const mdPath = path.join(learningsDir, `${day}.md`);
  const when = record?.endedAt ?? record?.startedAt ?? new Date().toISOString();
  fs.appendFileSync(mdPath, renderMarkdown(sessionId, when, learnings), "utf8");

  // Mark processed only after the write succeeded.
  fs.writeFileSync(markerPath, new Date().toISOString(), "utf8");

  return { learnings, written: [mdPath], forwarded };
}
