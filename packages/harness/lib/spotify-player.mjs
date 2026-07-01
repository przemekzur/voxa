// In-Voxa Spotify player — manages a librespot child process.
//
// Spotify audio is DRM-locked: there are no stream URLs to feed an <audio> tag
// (unlike VibeEngine). librespot is an open-source Spotify Connect *client* — we
// run it as a managed background process so a device named e.g. "Voxa" appears
// in the account's device list and plays through THIS machine's speakers. The
// spotify connector's playback actions then target that device.
//
// Auth: librespot does its OWN interactive OAuth (`--enable-oauth`) — the Spotify
// access point rejects third-party app tokens for the streaming protocol ("Bad
// credentials"), so we can't reuse the connector's token here. The first start
// opens a browser to approve; `--cache` then persists reusable credentials so
// every later start is silent (no browser).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openInBrowser } from "./open-browser.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "..", "data", "spotify-cache");

let proc = null;          // child process handle
let log = [];             // ring buffer of recent librespot stderr lines
let lastError = null;
let deviceName = "Voxa";

function pushLog(line) {
  log.push(line);
  if (log.length > 40) log.shift();
}

// Find the librespot executable: explicit config path, else cargo bin, else PATH.
export function resolveBinary(explicit) {
  if (explicit && existsSync(explicit)) return explicit;
  const exe = process.platform === "win32" ? "librespot.exe" : "librespot";
  const cargoBin = join(homedir(), ".cargo", "bin", exe);
  if (existsSync(cargoBin)) return cargoBin;
  return exe; // fall back to PATH lookup; spawn errors if absent
}

export function isRunning() { return !!proc && proc.exitCode === null; }

export function status() {
  return {
    running: isRunning(),
    deviceName,
    pid: proc?.pid || null,
    lastError,
    recentLog: log.slice(-6),
  };
}

// Start librespot. First run with no cached credentials does an interactive OAuth
// (opens a browser to approve); subsequent runs reuse the cache silently.
export async function start({ binary, name, bitrate } = {}) {
  if (isRunning()) return { ok: true, message: `Player already running as "${deviceName}".` };
  const bin = resolveBinary(binary);
  deviceName = name || "Voxa";
  lastError = null;
  log = [];
  await mkdir(CACHE_DIR, { recursive: true });

  const hasCachedCreds = existsSync(join(CACHE_DIR, "credentials.json"));
  const args = [
    "--name", deviceName,
    "--cache", CACHE_DIR,
    "--bitrate", String(bitrate || 320),
    "--device-type", "computer",
    "--backend", "rodio",
    "--initial-volume", "100", // match VibeEngine's 100% default (librespot's own default is 50%)
    "--disable-discovery",   // we authenticate via OAuth, not zeroconf
  ];
  if (!hasCachedCreds) args.push("--enable-oauth");

  try {
    proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    lastError = `couldn't launch librespot (${bin}): ${e.message}`;
    proc = null;
    return { ok: false, message: lastError };
  }

  // Resolves once on the first decisive signal: OAuth URL (first run), a
  // successful connection (cached run), or process death.
  let settle;
  const settled = new Promise((r) => { settle = r; });
  let done = false;
  const finish = (v) => { if (!done) { done = true; settle(v); } };

  const onLine = (line) => {
    pushLog(line);
    const m = line.match(/https?:\/\/\S+/);
    if (m && /oauth|accounts\.spotify|authorize|callback|browse/i.test(line)) {
      try { openInBrowser(m[0]); } catch { /* non-fatal */ }
      finish({ ok: true, message: `Approve the Spotify login in the browser I just opened. Once you click Agree, "${deviceName}" connects and stays cached for next time.`, authUrl: m[0] });
    } else if (/Authenticated as|Country:|Using StoredCredentials|credentials/i.test(line)) {
      finish({ ok: true, message: `Player "${deviceName}" connected — it's now a Spotify device on this machine.` });
    }
  };
  const pump = (d) => { for (const l of String(d).split(/\r?\n/)) if (l.trim()) onLine(l.trim()); };
  proc.stdout?.on("data", pump);
  proc.stderr?.on("data", pump);
  proc.on("exit", (code, sig) => {
    if (code && code !== 0) lastError = `librespot exited (code ${code}${sig ? ", " + sig : ""}). Recent: ${log.slice(-3).join(" | ")}`;
    proc = null;
    finish({ ok: false, message: lastError || "librespot exited unexpectedly." });
  });
  proc.on("error", (e) => { lastError = e.message; proc = null; finish({ ok: false, message: e.message }); });

  // Fallback: if nothing decisive within 8s but it's still alive, call it started.
  const timeout = new Promise((r) => setTimeout(() => r(
    isRunning()
      ? { ok: true, message: `Player "${deviceName}" started${hasCachedCreds ? " (using cached login)" : ""}.` }
      : { ok: false, message: lastError || `librespot failed to stay up. Recent: ${log.slice(-3).join(" | ")}` }
  ), 8000));

  return Promise.race([settled, timeout]);
}

export function stop() {
  if (!isRunning()) { proc = null; return { ok: true, message: "Player was not running." }; }
  try { proc.kill(); } catch { /* best effort */ }
  proc = null;
  return { ok: true, message: "Player stopped." };
}
