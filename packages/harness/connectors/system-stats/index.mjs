// System Stats — live host metrics: CPU %, RAM %, GPU % and temperatures.
//
// Cross-platform (Windows / macOS / Linux). CPU% and RAM% work everywhere via
// node:os. GPU% and temperature are best-effort and degrade to null when the
// platform has no unprivileged source:
//   • GPU%  — Windows: GPU Engine perf counters (PowerShell). macOS/Linux:
//             nvidia-smi if an NVIDIA GPU is present. Integrated GPUs expose no
//             portable utilization API, so they read null.
//   • Temp  — Any OS: a LibreHardwareMonitor-compatible web server if configured
//             and reachable (the usual Windows path). Linux also falls back to
//             /sys/class/thermal. macOS has no unprivileged temp API → null.
// Every external call is time-boxed and failure-safe: a missing tool or sensor
// yields null, never a crash or a hang.
import os from "node:os";
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";

const DEFAULT_LHM_URL = "http://localhost:8085";
const clampPct = (n) => Math.min(100, Math.max(0, Math.round(n)));

// Run a command and resolve its trimmed stdout, or null on any error/timeout.
// Used for both PowerShell (Windows) and nvidia-smi (any OS). Wrapped so a
// missing binary (ENOENT) or a synchronous spawn throw can never bubble up.
function spawnText(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = "", done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let ps;
    try {
      ps = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch { return finish(null); }
    const kill = setTimeout(() => { try { ps.kill(); } catch {} finish(null); }, timeoutMs);
    ps.stdout.on("data", (d) => { out += d; });
    ps.on("error", () => { clearTimeout(kill); finish(null); });
    ps.on("close", () => { clearTimeout(kill); finish(out.trim() || null); });
  });
}

// ── CPU % ── sample-on-demand: keep the previous os.cpus() snapshot in module
// scope and report the busy fraction since then. If there's no usable previous
// sample (first call, or a stale one), take a short two-point measurement.
let _prevCpu = null; // { idle, total, ts }

function cpuSnapshot() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    for (const t of Object.values(c.times)) total += t;
  }
  return { idle, total, ts: Date.now() };
}

async function cpuPct() {
  const now = cpuSnapshot();
  const prev = _prevCpu;
  _prevCpu = now;
  const age = prev ? now.ts - prev.ts : Infinity;
  if (prev && age >= 250 && age <= 5 * 60_000) {
    const total = now.total - prev.total;
    const idle = now.idle - prev.idle;
    if (total > 0) return clampPct((1 - idle / total) * 100);
  }
  // No usable delta — measure over a short window instead.
  await new Promise((r) => setTimeout(r, 300));
  const b = cpuSnapshot();
  _prevCpu = b;
  const total = b.total - now.total;
  const idle = b.idle - now.idle;
  if (total <= 0) return null;
  return clampPct((1 - idle / total) * 100);
}

// ── RAM % ──
function ram() {
  const total = os.totalmem();
  const free = os.freemem();
  return {
    ram: Math.round(((total - free) / total) * 100),
    ramUsedBytes: total - free,
    ramTotalBytes: total,
  };
}

// ── GPU % ── Get-Counter (Windows) takes a ~1s sample and nvidia-smi can be
// slow too, so cache the result and refresh out-of-band — a snapshot call never
// waits more than GPU_WAIT_MS for it.
let _gpu = { value: null, ts: 0, promise: null };
const GPU_TTL_MS = 4000;
const GPU_WAIT_MS = 2500;

// Windows: sum GPU Engine utilization per engine type (3D, Copy, VideoDecode, …)
// and take the busiest type — the Task-Manager-style "GPU %".
const GPU_PS =
  "$s=(Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples;" +
  "if($s){$g=$s|Group-Object{($_.InstanceName -split 'engtype_')[1]}|ForEach-Object{($_.Group|Measure-Object CookedValue -Sum).Sum};" +
  "'{0:N1}' -f (($g|Measure-Object -Maximum).Maximum)}";

async function readGpu() {
  if (process.platform === "win32") {
    const out = await spawnText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", GPU_PS], 6000);
    const n = out ? parseFloat(out.replace(",", ".")) : NaN;
    return Number.isFinite(n) ? clampPct(n) : null;
  }
  // macOS/Linux: NVIDIA discrete GPUs via nvidia-smi. Integrated GPUs (Apple,
  // Intel, most AMD APUs) have no portable utilization API → null.
  const out = await spawnText("nvidia-smi", ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"], 4000);
  const n = out ? parseFloat(String(out).split(/\r?\n/)[0]) : NaN;
  return Number.isFinite(n) ? clampPct(n) : null;
}

function refreshGpu() {
  if (_gpu.promise) return _gpu.promise;
  _gpu.promise = (async () => {
    const value = await readGpu().catch(() => null);
    _gpu = { value, ts: Date.now(), promise: null };
    return value;
  })();
  return _gpu.promise;
}

async function gpuPct() {
  if (Date.now() - _gpu.ts <= GPU_TTL_MS) { refreshGpu().catch(() => {}); return _gpu.value; }
  const fresh = refreshGpu();
  const timeout = new Promise((r) => setTimeout(() => r(undefined), GPU_WAIT_MS));
  const v = await Promise.race([fresh, timeout]);
  return v === undefined ? _gpu.value : v;
}

// ── Temperatures ──
let _temps = { cpu: null, gpu: null, ts: 0, source: null };
const TEMP_TTL_MS = 2000;

// LibreHardwareMonitor-style data.json is a tree of { Text, Value, Children };
// temperature sensors have Values like "67.0 °C" (or "67,0 °C" on comma-decimal
// locales).
function collectTemps(node, out) {
  if (!node || typeof node !== "object") return;
  if (typeof node.Value === "string" && node.Value.includes("°C")) {
    const v = parseFloat(String(node.Value).replace(",", "."));
    if (Number.isFinite(v)) out.push({ name: String(node.Text || ""), v });
  }
  for (const c of node.Children || []) collectTemps(c, out);
}

async function readLhmTemps(base) {
  const res = await fetch(base + "/data.json", { signal: AbortSignal.timeout(1500) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const tree = await res.json();
  const all = [];
  collectTemps(tree, all);
  const pick = (re) => all.find((t) => re.test(t.name))?.v ?? null;
  return {
    cpu: pick(/cpu package|package|tctl|cpu die/i) ?? pick(/core average|cpu/i),
    gpu: pick(/gpu (core|temperature|hot ?spot)/i) ?? pick(/gpu/i),
  };
}

// Linux: pick a CPU-ish zone from /sys/class/thermal (x86_pkg_temp, coretemp,
// k10temp), else the hottest plausible zone. temp files are milli-°C. No spawn.
async function linuxCpuTemp() {
  try {
    const base = "/sys/class/thermal";
    const zones = await readdir(base);
    const found = [];
    for (const z of zones) {
      if (!z.startsWith("thermal_zone")) continue;
      let type = "";
      try { type = (await readFile(`${base}/${z}/type`, "utf8")).trim(); } catch {}
      let milli = NaN;
      try { milli = parseInt((await readFile(`${base}/${z}/temp`, "utf8")).trim(), 10); } catch {}
      if (Number.isFinite(milli)) found.push({ type, c: milli / 1000 });
    }
    const cpu = found.find((z) => /x86_pkg_temp|coretemp|k10temp|cpu|package/i.test(z.type));
    const pick = cpu ?? found.filter((z) => z.c > 0 && z.c < 130).sort((a, b) => b.c - a.c)[0];
    return pick ? Math.round(pick.c) : null;
  } catch { return null; }
}

async function readTemps(cfg) {
  if (Date.now() - _temps.ts <= TEMP_TTL_MS) return _temps;
  // 1. A LibreHardwareMonitor-compatible web server (Windows default; any OS if
  //    the user points lhm_url at one).
  const base = String(cfg?.lhm_url || DEFAULT_LHM_URL).replace(/\/$/, "");
  try {
    const t = await readLhmTemps(base);
    if (t.cpu != null || t.gpu != null) {
      _temps = { cpu: t.cpu, gpu: t.gpu, ts: Date.now(), source: "lhm" };
      return _temps;
    }
  } catch { /* not reachable — fall through to native sources */ }
  // 2. Linux sysfs thermal zones (no server needed).
  if (process.platform === "linux") {
    const cpu = await linuxCpuTemp();
    _temps = { cpu, gpu: null, ts: Date.now(), source: cpu != null ? "sysfs" : null };
    return _temps;
  }
  // 3. macOS / Windows-without-LHM: no unprivileged temperature source.
  _temps = { cpu: null, gpu: null, ts: Date.now(), source: null };
  return _temps;
}

async function snapshot(cfg) {
  const [cpu, gpu, temps] = await Promise.all([cpuPct(), gpuPct(), readTemps(cfg)]);
  return {
    cpu,                              // % 0-100 or null
    ...ram(),                         // ram %, used/total bytes
    gpu,                              // % 0-100 or null
    cpuTemp: temps.cpu,               // °C or null
    gpuTemp: temps.gpu,               // °C or null
    tempSource: temps.source,         // "lhm" | "sysfs" | null
  };
}

// Platform-specific hint when temperature can't be read, for test() + docs.
function tempHint() {
  if (process.platform === "win32") return `run LibreHardwareMonitor's web server (default ${DEFAULT_LHM_URL})`;
  if (process.platform === "linux") return "no readable /sys/class/thermal CPU zone, or point the URL at a sensor web server";
  return "macOS has no unprivileged CPU-temperature source (CPU %, RAM % and NVIDIA GPU % still work)";
}

export default {
  id: "system-stats",
  name: "System Stats",
  description: "Live host metrics — CPU %, RAM %, GPU % and CPU/GPU temperature (°C). CPU and RAM work on every OS; GPU % and temperature are best-effort per platform and read null when no source is available.",
  icon: "📈",

  config: [
    {
      key: "lhm_url",
      label: "Sensor web-server URL",
      type: "text",
      default: DEFAULT_LHM_URL,
      help: "Base URL of a LibreHardwareMonitor-compatible Remote Web Server for temperatures (on Windows: LibreHardwareMonitor → Options → Remote Web Server → Run). CPU %, RAM % and GPU % don't need it; Linux also reads CPU temp from /sys/class/thermal without it.",
    },
  ],

  async test(cfg) {
    const s = await snapshot(cfg);
    const bits = [`CPU ${s.cpu ?? "?"}%`, `RAM ${s.ram}%`, s.gpu != null ? `GPU ${s.gpu}%` : "GPU n/a"];
    if (s.tempSource) bits.push(`CPU ${s.cpuTemp ?? "?"}°C${s.gpuTemp != null ? `, GPU ${s.gpuTemp}°C` : ""}`);
    const msg = bits.join(" · ");
    if (!s.tempSource) return { ok: true, message: `${msg} — temperature unavailable: ${tempHint()}.` };
    return { ok: true, message: msg };
  },

  actions: [
    {
      name: "sysstats_snapshot",
      description: "Read current system load: CPU usage %, RAM usage %, GPU usage %, and CPU/GPU temperature in °C (null when a sensor is unavailable on this OS). Returns compact JSON. Use when the user asks about system load, memory, how hot the machine is, or performance.",
      parameters: { type: "object", properties: {} },
      handler: async (_args, cfg) => {
        try {
          const s = await snapshot(cfg);
          return { result: JSON.stringify(s) };
        } catch (e) {
          return { error: `failed to read system stats: ${e?.message || e}` };
        }
      },
    },
  ],
};
