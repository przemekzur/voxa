// Memory guidance assembled at session start from the tools that are ACTUALLY
// loaded. The static tool guide stays memory-agnostic; this module inspects the
// live tool list and emits instructions only for memory tools that exist, so the
// model is never pointed at tools a given build doesn't ship (e.g. a public
// build where long-term memory is a notes connector instead of a brain tier).
//
// Pure ESM, no browser globals — unit-testable under Node.

const BRAIN_TOOLS = ["brain_query", "fact_store", "fact_recall", "remember", "search_knowledge"];
const NOTES_TOOLS = ["memory_save", "memory_search"];

// Render a short tool mention: "a" or "a (or b)".
function mention(list) {
  return list.length > 1 ? `${list[0]} (or ${list[1]})` : list[0];
}

/**
 * Build the memory section of the system instruction from the loaded tool set.
 * @param {string[]} toolNames — names of every tool declared for this session
 *   (bridge tools + local tools).
 * @returns {string} guidance to append to the system instruction, or "" when
 *   no memory tools are loaded (the guide must make zero memory claims then).
 */
export function buildMemoryGuide(toolNames) {
  const names = new Set(
    (Array.isArray(toolNames) ? toolNames : []).filter((n) => typeof n === "string")
  );
  const has = (n) => names.has(n);
  const sections = [];

  if (BRAIN_TOOLS.some(has)) {
    // Brain tier: long-term procedural/fact memory. Mention ONLY what exists.
    const store = ["fact_store", "remember"].filter(has);
    const lookup = ["brain_query", "search_knowledge"].filter(has);
    const bits = [];
    if (store.length) {
      bits.push(
        `when the operator says to remember, save, or note something, persist it by calling ${mention(store)} ` +
        "with a clear, self-contained sentence, then confirm out loud. Don't store throwaway chatter — " +
        "only durable, reusable information"
      );
    }
    if (lookup.length) {
      bits.push(
        `for memory or knowledge lookups and past decisions, call ${mention(lookup)} instead of guessing`
      );
    }
    if (has("fact_recall")) {
      bits.push("for previously stored facts, call fact_recall");
    }
    sections.push("\n\nMEMORY: " + bits.join("; ") + ".");
  } else if (NOTES_TOOLS.some(has)) {
    // Notes tier: simple durable notes connector.
    const bits = [];
    if (has("memory_save")) {
      bits.push("to remember something durable, call memory_save");
    }
    if (has("memory_search")) {
      bits.push(
        `to recall, call memory_search${has("memory_read") ? " then memory_read" : ""}, ` +
        "and base your answers on what you actually find"
      );
    }
    sections.push("\n\nMEMORY: " + bits.join("; ") + ".");
  }

  if (has("session_debrief")) {
    sections.push(
      "\n\nWhen the session ends you will be asked to call session_debrief — do it, with concrete " +
      "facts, preferences, lessons, corrections, and open loops, plus a short summary."
    );
  }

  return sections.join("");
}
