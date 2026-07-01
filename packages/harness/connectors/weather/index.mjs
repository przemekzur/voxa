// Weather connector — current conditions + short forecast via Open-Meteo.
// No API key, no account: Open-Meteo is free for non-commercial use. We geocode
// spoken place names through Open-Meteo's geocoding API, so "what's the weather
// in Kraków" just works. Falls back to a configured default location when the
// caller doesn't name one.
//
//   geocoding: https://geocoding-api.open-meteo.com/v1/search?name=Krakow&count=1
//   forecast:  https://api.open-meteo.com/v1/forecast?latitude=..&longitude=..&current=...

const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

// WMO weather interpretation codes → short spoken phrases.
const WMO = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
  45: "foggy", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
  56: "freezing drizzle", 57: "freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain",
  66: "freezing rain", 67: "freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "light showers", 81: "showers", 82: "violent showers",
  85: "snow showers", 86: "heavy snow showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with hail",
};
const sky = (code) => WMO[code] ?? `code ${code}`;

const units = (cfg) =>
  String(cfg.units || "metric").toLowerCase() === "imperial"
    ? { temperature_unit: "fahrenheit", wind_speed_unit: "mph", t: "°F", w: "mph" }
    : { temperature_unit: "celsius", wind_speed_unit: "kmh", t: "°C", w: "km/h" };

async function getJSON(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).hostname}`);
  return r.json();
}

// Resolve a place to { name, latitude, longitude }. Prefers the spoken arg, then
// the configured default; supports "lat,lon" passed directly.
async function resolvePlace(cfg, spoken) {
  const q = (spoken || cfg.defaultLocation || "").trim();
  if (!q) throw new Error("No location given and no default configured.");
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) return { name: `${m[1]}, ${m[2]}`, latitude: +m[1], longitude: +m[2] };
  const data = await getJSON(`${GEO_URL}?name=${encodeURIComponent(q)}&count=1&language=en&format=json`);
  const hit = data?.results?.[0];
  if (!hit) throw new Error(`Could not find a place named "${q}".`);
  const label = [hit.name, hit.admin1, hit.country_code].filter(Boolean).join(", ");
  return { name: label, latitude: hit.latitude, longitude: hit.longitude };
}

export default {
  id: "weather",
  name: "Weather",
  description: "Current conditions and short forecast for any place, via Open-Meteo (no API key).",
  icon: "☁",

  config: [
    { key: "defaultLocation", label: "Default location", type: "text", placeholder: "Warsaw", help: "City name or 'lat,lon'. Used when a request doesn't name a place." },
    { key: "units", label: "Units", type: "text", default: "metric", help: "metric (°C, km/h) or imperial (°F, mph)." },
  ],

  async test(cfg) {
    try {
      const p = await resolvePlace(cfg, null);
      return { ok: true, message: `Ready. Default location resolves to ${p.name}.` };
    } catch (e) {
      return { ok: false, message: e?.message || String(e) };
    }
  },

  actions: [
    {
      name: "weather_now",
      description: "Current weather (temperature, conditions, wind, humidity) for a place. Omit location to use the configured default.",
      parameters: {
        type: "object",
        properties: { location: { type: "string", description: "City name, or 'lat,lon'. Optional." } },
      },
      async handler(args, cfg) {
        try {
          const p = await resolvePlace(cfg, args.location);
          const u = units(cfg);
          const data = await getJSON(
            `${FORECAST_URL}?latitude=${p.latitude}&longitude=${p.longitude}` +
            `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
            `&temperature_unit=${u.temperature_unit}&wind_speed_unit=${u.wind_speed_unit}&timezone=auto`
          );
          const c = data.current;
          const feels = Math.round(c.apparent_temperature) !== Math.round(c.temperature_2m)
            ? `, feels like ${Math.round(c.apparent_temperature)}${u.t}` : "";
          return { result: `${p.name}: ${Math.round(c.temperature_2m)}${u.t}${feels}, ${sky(c.weather_code)}, wind ${Math.round(c.wind_speed_10m)} ${u.w}, humidity ${c.relative_humidity_2m}%.` };
        } catch (e) {
          return { error: e?.message || String(e) };
        }
      },
    },
    {
      name: "weather_forecast",
      description: "Daily forecast (high/low temperature and conditions) for the next few days. Omit location to use the default.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "City name, or 'lat,lon'. Optional." },
          days: { type: "integer", description: "How many days ahead, 1–7. Default 3." },
        },
      },
      async handler(args, cfg) {
        try {
          const p = await resolvePlace(cfg, args.location);
          const u = units(cfg);
          const days = Math.min(Math.max(parseInt(args.days, 10) || 3, 1), 7);
          const data = await getJSON(
            `${FORECAST_URL}?latitude=${p.latitude}&longitude=${p.longitude}` +
            `&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=${days}` +
            `&temperature_unit=${u.temperature_unit}&timezone=auto`
          );
          const d = data.daily;
          const parts = d.time.map((iso, i) => {
            const day = new Date(iso + "T00:00:00").toLocaleDateString("en-US", { weekday: "short" });
            return `${day}: ${Math.round(d.temperature_2m_max[i])}/${Math.round(d.temperature_2m_min[i])}${u.t}, ${sky(d.weather_code[i])}`;
          });
          return { result: `${p.name} — ${parts.join(". ")}.` };
        } catch (e) {
          return { error: e?.message || String(e) };
        }
      },
    },
    {
      name: "weather_rain_today",
      description: "Whether it will rain today: chance of precipitation and expected amount for a place. Omit location to use the default.",
      parameters: {
        type: "object",
        properties: { location: { type: "string", description: "City name, or 'lat,lon'. Optional." } },
      },
      async handler(args, cfg) {
        try {
          const p = await resolvePlace(cfg, args.location);
          const data = await getJSON(
            `${FORECAST_URL}?latitude=${p.latitude}&longitude=${p.longitude}` +
            `&daily=precipitation_probability_max,precipitation_sum&forecast_days=1&timezone=auto`
          );
          const prob = data.daily.precipitation_probability_max?.[0] ?? 0;
          const mm = data.daily.precipitation_sum?.[0] ?? 0;
          const verdict = prob >= 60 ? "likely" : prob >= 30 ? "possible" : "unlikely";
          return { result: `${p.name}: rain ${verdict} today — ${prob}% chance, about ${mm} mm expected.` };
        } catch (e) {
          return { error: e?.message || String(e) };
        }
      },
    },
  ],
};
