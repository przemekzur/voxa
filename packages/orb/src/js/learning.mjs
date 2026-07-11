const MODES = new Set(["auto", "explicit", "off"]);

export function normalizeLearningMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return MODES.has(mode) ? mode : "auto";
}

export function effectiveMode(configMode, override) {
  const spoken = String(override || "").trim().toLowerCase();
  return MODES.has(spoken) ? spoken : normalizeLearningMode(configMode);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanLoops(value) {
  const list = Array.isArray(value) ? value : [];
  return list.map(cleanText).filter(Boolean);
}

export function buildRecallQuery({ summary, openLoops } = {}) {
  const cleanSummary = cleanText(summary);
  const loops = cleanLoops(openLoops);
  if (!cleanSummary && !loops.length) return "";

  const tail = cleanSummary.length > 120 ? cleanSummary.slice(-120) : cleanSummary;
  const parts = [];
  if (tail) parts.push(`recent context ${tail}`);
  if (loops.length) parts.push(`open loops ${loops.join("; ")}`);
  return parts.join(" | ").slice(0, 200).trim();
}

export function pickRecallTool(toolNames) {
  const names = new Set(Array.isArray(toolNames) ? toolNames : [...(toolNames || [])]);
  if (names.has("brain_query")) return "brain_query";
  if (names.has("memory_search")) return "memory_search";
  return null;
}

export function formatRecallBlock(resultText, { maxChars = 1500 } = {}) {
  const text = cleanText(resultText);
  if (!text) return "";
  const limit = Number.isFinite(maxChars) ? Math.max(1, Math.floor(maxChars)) : 1500;
  const heading = "REMEMBERED CONTEXT (from your long-term memory — use if relevant):\n";
  const available = Math.max(0, limit - heading.length);
  if (!available) return heading.slice(0, limit);
  const body = text.length > available
    ? (available === 1 ? "…" : text.slice(0, available - 1) + "…")
    : text;
  return heading + body;
}

export function buildLearningReport({ mode, summary, openLoops, sessionCount } = {}) {
  const activeMode = normalizeLearningMode(mode);
  const loops = cleanLoops(openLoops);
  const remembered = cleanText(summary);
  const sessions = Number.isInteger(sessionCount) && sessionCount >= 0
    ? `I have ${sessionCount} recorded learning session${sessionCount === 1 ? "" : "s"}.`
    : "I couldn't check the recorded session count right now.";
  const memory = remembered
    ? `My current conversation summary is: ${remembered}`
    : "I don't have a conversation summary saved yet.";
  const pending = loops.length
    ? `Open loops: ${loops.join("; ")}.`
    : "There are no saved open loops.";
  return `Learning mode is ${activeMode}. ${sessions} ${memory} ${pending}`;
}
