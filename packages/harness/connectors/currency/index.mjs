// Currency connector — live exchange rates + conversion via Frankfurter (ECB
// reference rates). No API key, no account. Built with the connector-builder
// skill as its worked example.
//
//   GET https://api.frankfurter.app/latest?amount=100&from=EUR&to=USD
//     -> { amount: 100, base: "EUR", date: "2026-06-13", rates: { USD: 108.4 } }

const API = "https://api.frankfurter.app/latest";

async function getJSON(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`${r.status} from frankfurter.app`);
  return r.json();
}

const code = (s) => String(s || "").trim().toUpperCase();

export default {
  id: "currency",
  name: "Currency",
  description: "Live exchange rates and currency conversion (ECB reference rates, no API key).",
  icon: "₳",

  config: [
    { key: "baseCurrency", label: "Default base currency", type: "text", default: "EUR", help: "3-letter code used when a request omits the 'from' currency, e.g. EUR, USD, PLN." },
  ],

  async test(cfg) {
    try {
      const from = code(cfg.baseCurrency) || "EUR";
      const to = from === "USD" ? "EUR" : "USD";
      const d = await getJSON(`${API}?from=${from}&to=${to}`);
      return { ok: true, message: `Ready. 1 ${from} = ${d.rates[to]} ${to} (${d.date}).` };
    } catch (e) {
      return { ok: false, message: e?.message || String(e) };
    }
  },

  actions: [
    {
      name: "currency_convert",
      description: "Convert an amount of money from one currency to another using today's ECB rates. Currencies are 3-letter codes (USD, EUR, GBP, PLN…).",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number", description: "How much to convert." },
          from: { type: "string", description: "Source currency code. Optional — defaults to the configured base." },
          to: { type: "string", description: "Target currency code." },
        },
        required: ["amount", "to"],
      },
      async handler(args, cfg) {
        try {
          const amount = Number(args.amount);
          if (!isFinite(amount)) return { error: "Amount must be a number." };
          const from = code(args.from) || code(cfg.baseCurrency) || "EUR";
          const to = code(args.to);
          if (!to) return { error: "Target currency (to) is required." };
          if (to === from) return { result: `${amount} ${from} = ${amount} ${to}.` };
          const d = await getJSON(`${API}?amount=${amount}&from=${from}&to=${to}`);
          const out = d.rates?.[to];
          if (out == null) return { error: `Unknown currency pair ${from}→${to}.` };
          return { result: `${amount} ${from} = ${out.toFixed(2)} ${to} (ECB, ${d.date}).` };
        } catch (e) {
          return { error: e?.message || String(e) };
        }
      },
    },
    {
      name: "currency_rate",
      description: "Get the current exchange rate between two currencies (3-letter codes). Omit 'from' to use the configured base currency.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Base currency code. Optional — defaults to the configured base." },
          to: { type: "string", description: "Quote currency code." },
        },
        required: ["to"],
      },
      async handler(args, cfg) {
        try {
          const from = code(args.from) || code(cfg.baseCurrency) || "EUR";
          const to = code(args.to);
          if (!to) return { error: "Quote currency (to) is required." };
          if (to === from) return { result: `1 ${from} = 1 ${to}.` };
          const d = await getJSON(`${API}?from=${from}&to=${to}`);
          const rate = d.rates?.[to];
          if (rate == null) return { error: `Unknown currency pair ${from}→${to}.` };
          return { result: `1 ${from} = ${rate} ${to} (ECB, ${d.date}).` };
        } catch (e) {
          return { error: e?.message || String(e) };
        }
      },
    },
  ],
};
