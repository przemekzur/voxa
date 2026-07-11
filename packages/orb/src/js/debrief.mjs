// ── Session debrief ────────────────────────────────────────────────────────
// Pure helpers for the end-of-session debrief flow: the `session_debrief`
// local-tool declaration the model calls, a router that turns a debrief into
// a plan of memory-sink tool calls (executed by the caller), and the forced
// request texts sent to the model. Pure ESM with no browser globals, so it is
// importable by Node for tests as well as by the orb WebView.

// Tool declaration for the model. Parameters are a flat JSON Schema object
// (no $ref / nesting beyond string arrays) so every live-API tool schema
// translator can handle it.
export const DEBRIEF_TOOL = {
  name: "session_debrief",
  description:
    "Debrief the session into durable memory. Capture ONLY durable, concrete items " +
    "worth remembering across sessions — stable facts about the user or their world, " +
    "stated preferences, lessons about what worked or failed, corrections the user made, " +
    "and open loops to pick up later. Empty arrays are fine when a category has nothing. " +
    "Call it when asked to debrief, at a checkpoint, or before the session ends.",
  parameters: {
    type: "object",
    properties: {
      facts: {
        type: "array",
        items: { type: "string" },
        description: "Durable, concrete facts learned this session (one per item).",
      },
      preferences: {
        type: "array",
        items: { type: "string" },
        description: "User preferences observed or stated this session.",
      },
      lessons: {
        type: "array",
        items: { type: "string" },
        description: "Lessons learned — approaches that worked or failed.",
      },
      corrections: {
        type: "array",
        items: { type: "string" },
        description: "Corrections the user made to something previously believed or said.",
      },
      open_loops: {
        type: "array",
        items: { type: "string" },
        description: "Unfinished threads or follow-ups to pick up next session.",
      },
      summary: {
        type: "string",
        description: "One-paragraph summary of the session, written so future-you can pick up seamlessly.",
      },
    },
    required: ["summary"],
  },
};

// Coerce a debrief field into a clean array of non-empty strings.
function items(v) {
  return (Array.isArray(v) ? v : [])
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean);
}

const bulleted = (list) => list.map((s) => `- ${s}`).join("\n");

// Build a routing PLAN — an array of { tool, args } — mapping debrief
// categories onto whatever memory-sink tools are available this session.
// Pure: the caller executes the plan (e.g. via its tool bridge). Sinks, in
// preference order:
//   facts + preferences → `remember` (one call per item), else `fact_store`
//     (one call per item), else batched into one `memory_save` note.
//   lessons + corrections → one `memory_save` note when available, else
//     `fact_store` one call per item, else dropped from the plan.
// With no sink tools at all the plan is empty.
export function routeDebrief(args, availableToolNames) {
  const names = new Set(
    (Array.isArray(availableToolNames) ? availableToolNames : [...(availableToolNames || [])])
      .filter((n) => typeof n === "string")
  );
  const facts = [...items(args?.facts), ...items(args?.preferences)];
  const lessons = [...items(args?.lessons), ...items(args?.corrections)];
  const plan = [];

  if (facts.length) {
    if (names.has("remember")) {
      for (const fact of facts) plan.push({ tool: "remember", args: { action: "add", fact } });
    } else if (names.has("fact_store")) {
      for (const text of facts) plan.push({ tool: "fact_store", args: { action: "add", text } });
    } else if (names.has("memory_save")) {
      plan.push({ tool: "memory_save", args: { text: bulleted(facts), title: "learnings" } });
    }
  }

  if (lessons.length) {
    if (names.has("memory_save")) {
      plan.push({ tool: "memory_save", args: { text: bulleted(lessons), title: "learnings" } });
    } else if (names.has("fact_store")) {
      for (const text of lessons) plan.push({ tool: "fact_store", args: { action: "add", text } });
    }
    // No sink for lessons → dropped from the plan.
  }

  return plan;
}

// Forced final turn sent right before teardown so the session never ends
// without a debrief.
export function buildDebriefRequestText() {
  return (
    "SYSTEM: the session is ending. Call session_debrief NOW with everything durable " +
    "you learned (facts, preferences, lessons, corrections, open loops) and a " +
    "one-paragraph summary. Then say a brief goodbye."
  );
}

// Softer mid-session checkpoint variant — no goodbye, conversation continues.
export function buildMiniDebriefRequestText() {
  return (
    "SYSTEM: checkpoint — silently call session_debrief with anything durable you have " +
    "learned so far (facts, preferences, lessons, corrections, open loops) and a short " +
    "summary, then continue the conversation naturally. Do not mention this to the user."
  );
}
