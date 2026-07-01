// Crypto connector — spot cryptocurrency prices via CoinGecko. No API key
// (free public endpoint; rate-limited, fine for personal use).
//   https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,pln,eur
const API = "https://api.coingecko.com/api/v3/simple/price";

// Common spoken names / tickers → CoinGecko ids. Unknown input is passed through
// as an id so any coin still works if the user says the exact id.
const COINS = {
  btc: "bitcoin", bitcoin: "bitcoin", eth: "ethereum", ethereum: "ethereum",
  sol: "solana", solana: "solana", ada: "cardano", cardano: "cardano",
  xrp: "ripple", ripple: "ripple", doge: "dogecoin", dogecoin: "dogecoin",
  bnb: "binancecoin", ltc: "litecoin", litecoin: "litecoin", dot: "polkadot",
  polkadot: "polkadot", matic: "matic-network", usdt: "tether", usdc: "usd-coin",
  link: "chainlink", chainlink: "chainlink", avax: "avalanche-2", trx: "tron",
};
const SYM = { usd: "$", eur: "€", pln: "zł", gbp: "£" };

async function getJSON(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (r.status === 429) throw new Error("rate-limited by CoinGecko — try again in a moment");
  if (!r.ok) throw new Error(`${r.status} from CoinGecko`);
  return r.json();
}

export default {
  id: "crypto",
  name: "Crypto prices",
  description: "Spot cryptocurrency prices via CoinGecko (Bitcoin, Ethereum, …). No API key.",
  icon: "₿",
  config: [
    { key: "vs", label: "Default fiat", type: "text", default: "usd", help: "Default quote currency: usd, eur, pln, gbp…" },
  ],

  async test(cfg) {
    try {
      const vs = (cfg.vs || "usd").toLowerCase();
      const d = await getJSON(`${API}?ids=bitcoin&vs_currencies=${vs}`);
      return { ok: true, message: `Ready. BTC = ${d.bitcoin?.[vs]} ${vs.toUpperCase()}.` };
    } catch (e) { return { ok: false, message: e?.message || String(e) }; }
  },

  actions: [
    {
      name: "crypto_price",
      description: "Current price of a cryptocurrency. Give a coin name or ticker (bitcoin, btc, eth, solana…) and optionally a fiat currency (usd, eur, pln).",
      parameters: {
        type: "object",
        properties: {
          coin: { type: "string", description: "Coin name or ticker, e.g. bitcoin, eth, solana." },
          vs: { type: "string", description: "Fiat currency code (usd, eur, pln). Optional." },
        },
        required: ["coin"],
      },
      async handler(args, cfg) {
        try {
          const raw = String(args.coin || "").trim().toLowerCase();
          if (!raw) return { error: "Which coin?" };
          const id = COINS[raw] || raw.replace(/\s+/g, "-");
          const vs = String(args.vs || cfg.vs || "usd").trim().toLowerCase();
          const d = await getJSON(`${API}?ids=${encodeURIComponent(id)}&vs_currencies=${encodeURIComponent(vs)}&include_24hr_change=true`);
          const row = d[id];
          if (!row || row[vs] == null) return { error: `Couldn't find a price for "${args.coin}".` };
          const price = row[vs];
          const chg = row[`${vs}_24h_change`];
          const pretty = price >= 1 ? price.toLocaleString("en-US", { maximumFractionDigits: 2 }) : price.toPrecision(4);
          const ch = typeof chg === "number" ? `, ${chg >= 0 ? "+" : ""}${chg.toFixed(1)}% (24h)` : "";
          return { result: `${id}: ${pretty} ${vs.toUpperCase()}${ch}.` };
        } catch (e) { return { error: e?.message || String(e) }; }
      },
    },
  ],
};
