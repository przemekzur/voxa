// Quotes connector — dad jokes, advice, and inspirational quotes. All keyless.
// A little personality for the orb. Each endpoint is a single GET.
//   joke:    https://icanhazdadjoke.com/        (Accept: application/json)
//   advice:  https://api.adviceslip.com/advice
//   inspire: https://zenquotes.io/api/random    -> [{ q, a }]
async function getJSON(url, headers = {}) {
  const r = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).hostname}`);
  return r.json();
}

export default {
  id: "quotes",
  name: "Jokes & Quotes",
  description: "Dad jokes, a piece of advice, or an inspirational quote on demand. No API key.",
  icon: "🎭",
  config: [],

  async test() {
    try { const d = await getJSON("https://icanhazdadjoke.com/"); return { ok: true, message: `Ready. e.g. "${String(d.joke).slice(0, 60)}…"` }; }
    catch (e) { return { ok: false, message: e?.message || String(e) }; }
  },

  actions: [
    {
      name: "quotes_joke",
      description: "Tell a (corny) dad joke.",
      parameters: { type: "object", properties: {} },
      async handler() {
        try { const d = await getJSON("https://icanhazdadjoke.com/"); return { result: d.joke || "I'm fresh out of jokes." }; }
        catch (e) { return { error: e?.message || String(e) }; }
      },
    },
    {
      name: "quotes_advice",
      description: "Give a random piece of life advice.",
      parameters: { type: "object", properties: {} },
      async handler() {
        try { const d = await getJSON("https://api.adviceslip.com/advice"); return { result: d?.slip?.advice || "No advice right now." }; }
        catch (e) { return { error: e?.message || String(e) }; }
      },
    },
    {
      name: "quotes_inspire",
      description: "Share an inspirational quote with its author.",
      parameters: { type: "object", properties: {} },
      async handler() {
        try {
          const d = await getJSON("https://zenquotes.io/api/random");
          const q = Array.isArray(d) ? d[0] : null;
          return { result: q ? `"${q.q.trim()}" — ${q.a}` : "No quote right now." };
        } catch (e) { return { error: e?.message || String(e) }; }
      },
    },
  ],
};
