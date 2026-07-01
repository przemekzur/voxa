// Minimal MCP client over Streamable HTTP, for stateless servers.
//
// vibeEngine's MCP (https://vibeengine.live/mcp) is stateless — no Mcp-Session-Id
// is required — and authenticates with `Authorization: Bearer <token>`. So a tool
// call is a single JSON-RPC POST; no initialize/handshake needed per call.
//
// mcpCall(endpoint, toolName, args, {bearer}) -> the tool's result, JSON-parsed
// from result.content[].text when possible. Throws on JSON-RPC or tool errors.

function extractText(payload) {
  // Direct JSON response.
  try { return JSON.parse(payload); } catch { /* maybe SSE */ }
  // SSE framing: pull the last `data:` line and parse it.
  const dataLines = payload.split(/\r?\n/).filter((l) => l.startsWith("data:"));
  if (dataLines.length) {
    const last = dataLines[dataLines.length - 1].slice(5).trim();
    try { return JSON.parse(last); } catch { /* fall through */ }
  }
  return null;
}

export async function mcpCall(endpoint, name, args = {}, { bearer } = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(bearer ? { authorization: "Bearer " + bearer } : {}),
  };
  const body = { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } };
  let res;
  try {
    res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (e) {
    throw new Error(`MCP unreachable: ${e.message}`);
  }
  const raw = await res.text();
  const j = extractText(raw);
  if (!j) throw new Error(`MCP non-JSON response (HTTP ${res.status})`);
  if (j.error) throw new Error(j.error.message || `MCP error ${j.error.code}`);
  const content = j.result?.content || [];
  const textPart = content.find((c) => c.type === "text")?.text;
  if (j.result?.isError) throw new Error(textPart || "MCP tool error");
  if (textPart == null) return j.result ?? null;
  try { return JSON.parse(textPart); } catch { return textPart; }
}
