// ── External Agents connector ───────────────────────────────────────────────
// Lets the orb FOCUS on coding agents that run OUTSIDE managed terminals:
//  • Claude Code (CLI + the Claude desktop app) — both write transcripts under
//    ~/.claude/projects, and the desktop app also keeps session metadata under
//    %APPDATA%\Claude\claude-code-sessions (title, cwd, lastFocusedAt, cliSessionId).
//
// READING is safe (filesystem only). SENDING into a GUI app has no API, so it is
// done by OS keystroke injection — guarded hard: we activate the target window,
// RE-VERIFY it is actually the foreground window, and REFUSE to type if it is
// not (so a prompt can never land in the wrong app). The orb still stages +
// confirms before ever calling the send action; the connector requires an
// explicit confirm flag as defence-in-depth.
//
// Exposes voice tools: external_focus_list, external_focus_foreground,
// external_focus_read, external_focus_send.

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const CLAUDE_HOME = () => join(homedir(), ".claude");
const PROJECTS_DIR = () => join(CLAUDE_HOME(), "projects");
const DESKTOP_SESSIONS_DIR = () => join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Claude", "claude-code-sessions");
const RECENT_CAP = 8;

// ── PowerShell exec (mirrors the screen connector's wrapper) ────────────────
function ps(command, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || "").trim() || err.message));
        resolve(String(stdout || ""));
      },
    );
  });
}

// Timestamps in desktop session files are epoch-millisecond integers; CLI
// transcripts use ISO strings. Accept either.
function toMs(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v) { const n = Date.parse(v); return Number.isFinite(n) ? n : 0; }
  return 0;
}

function rel(ms) {
  const d = Date.now() - ms;
  if (d < 60000) return "just now";
  if (d < 3600000) return `${Math.round(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.round(d / 3600000)}h ago`;
  return `${Math.round(d / 86400000)}d ago`;
}

// ── Transcript helpers (~/.claude/projects/<encoded-cwd>/<id>.jsonl) ─────────
async function listProjectDirs() {
  try {
    return (await readdir(PROJECTS_DIR(), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch { return []; }
}

async function recentTranscripts(cap) {
  const dirs = await listProjectDirs();
  const out = [];
  for (const d of dirs) {
    const dir = join(PROJECTS_DIR(), d);
    let files = [];
    try { files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      try {
        const s = await stat(join(dir, f));
        out.push({ file: join(dir, f), id: f.replace(/\.jsonl$/, ""), mtime: s.mtimeMs });
      } catch { /* skip */ }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return cap ? out.slice(0, cap) : out;
}

// Read the head of a session file to derive its title + cwd cheaply.
function headMeta(file, maxLines = 200) {
  return new Promise((resolve) => {
    let aiTitle = "", customTitle = "", cwd = "", n = 0, rl;
    try { rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity }); }
    catch { return resolve({ title: "", cwd: "" }); }
    rl.on("line", (line) => {
      if (++n > maxLines) { rl.close(); return; }
      let r; try { r = JSON.parse(line); } catch { return; }
      if (r.type === "ai-title" && r.aiTitle) aiTitle = r.aiTitle;
      if (r.type === "custom-title" && r.customTitle) customTitle = r.customTitle;
      if (!cwd && (r.cwd || r.message?.cwd)) cwd = r.cwd || r.message.cwd;
    });
    rl.on("close", () => resolve({ title: customTitle || aiTitle, cwd }));
    rl.on("error", () => resolve({ title: customTitle || aiTitle, cwd }));
  });
}

// Tail a session file for the last k user prompts + the latest assistant text.
function tailSession(file, k = 6) {
  return new Promise((resolve) => {
    const prompts = [];
    let lastAssistant = "", title = "", cwd = "", rl;
    try { rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity }); }
    catch { return resolve({ prompts, lastAssistant, title, cwd }); }
    rl.on("line", (line) => {
      if (!line) return;
      let r; try { r = JSON.parse(line); } catch { return; }
      if (r.type === "ai-title" && r.aiTitle) title = r.aiTitle;
      if (r.type === "custom-title" && r.customTitle) title = r.customTitle;
      if (!cwd && (r.cwd || r.message?.cwd)) cwd = r.cwd || r.message.cwd;
      let text = "";
      if (r.type === "last-prompt" && typeof r.prompt === "string") text = r.prompt;
      else if (r.type === "user" && typeof r.message?.content === "string") text = r.message.content;
      else if (r.type === "user" && Array.isArray(r.message?.content)) text = r.message.content.map((c) => c.text || "").join(" ");
      text = (text || "").replace(/\s+/g, " ").trim();
      if (text && !text.startsWith("<")) {
        prompts.push(text);
        if (prompts.length > k) prompts.shift();
      }
      if (r.type === "assistant") {
        let a = "";
        if (typeof r.message?.content === "string") a = r.message.content;
        else if (Array.isArray(r.message?.content)) a = r.message.content.map((c) => c.text || "").join(" ");
        a = (a || "").replace(/\s+/g, " ").trim();
        if (a) lastAssistant = a;
      }
    });
    rl.on("close", () => resolve({ prompts, lastAssistant, title, cwd }));
    rl.on("error", () => resolve({ prompts, lastAssistant, title, cwd }));
  });
}

async function findTranscriptById(id) {
  if (!id) return null;
  const dirs = await listProjectDirs();
  for (const d of dirs) {
    const p = join(PROJECTS_DIR(), d, `${id}.jsonl`);
    try { await stat(p); return p; } catch { /* not here */ }
  }
  // Fall back to a suffix match across recent transcripts.
  const recents = await recentTranscripts(0);
  const hit = recents.find((r) => r.id === id || r.id.endsWith(id) || id.endsWith(r.id));
  return hit ? hit.file : null;
}

// ── Desktop-app session metadata (%APPDATA%\Claude\claude-code-sessions) ────
async function walkJsonFiles(dir, acc, depth = 0) {
  if (depth > 4) return;
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walkJsonFiles(p, acc, depth + 1);
    else if (e.isFile() && e.name.endsWith(".json")) acc.push(p);
  }
}

async function desktopSessions(cap = RECENT_CAP) {
  const files = [];
  await walkJsonFiles(DESKTOP_SESSIONS_DIR(), files);
  const out = [];
  for (const f of files) {
    try {
      const o = JSON.parse(await readFile(f, "utf8"));
      const last = toMs(o.lastActivityAt) || toMs(o.lastFocusedAt) || toMs(o.createdAt);
      out.push({
        cliSessionId: o.cliSessionId || o.sessionId || "",
        title: o.title || "",
        cwd: o.cwd || o.originCwd || "",
        model: o.model || "",
        lastActivity: last,
        lastFocusedAt: toMs(o.lastFocusedAt),
        archived: !!o.isArchived,
      });
    } catch { /* skip unparseable */ }
  }
  out.sort((a, b) => b.lastActivity - a.lastActivity);
  return out.filter((s) => !s.archived).slice(0, cap);
}

// ── Window detection / keystroke (PowerShell + user32) ──────────────────────
const USER32 = [
  'Add-Type @"',
  "using System;using System.Text;using System.Runtime.InteropServices;",
  "public class W {",
  ' [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  ' [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  ' [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
  ' [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
  "}",
  '"@',
].join("\n");

function sanitizeProcName(name) {
  return String(name || "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 60) || "claude";
}

// Resolve a target hint to a PowerShell process-selection expression. We only
// ever target a GUI window (MainWindowHandle != 0).
function targetSelector(target) {
  const t = String(target || "claude-app").toLowerCase();
  if (t === "claude-app" || t.includes("claude")) {
    return "Get-Process | Where-Object { $_.ProcessName -eq 'claude' -and $_.MainWindowHandle -ne 0 } | Sort-Object StartTime | Select-Object -Last 1";
  }
  const name = sanitizeProcName(target);
  return `Get-Process | Where-Object { $_.ProcessName -eq '${name}' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1`;
}

async function foreground() {
  const cmd = [
    USER32,
    "$h=[W]::GetForegroundWindow();",
    "$pid2=0;[void][W]::GetWindowThreadProcessId($h,[ref]$pid2);",
    "$sb=New-Object System.Text.StringBuilder 512;[void][W]::GetWindowText($h,$sb,512);",
    "$p=(Get-Process -Id $pid2 -ErrorAction SilentlyContinue).ProcessName;",
    '$o=@{proc=$p;title=$sb.ToString();pid=$pid2}|ConvertTo-Json -Compress;Write-Output $o',
  ].join("\n");
  try {
    const out = await ps(cmd, 8000);
    return JSON.parse(out.trim() || "{}");
  } catch (e) { return { error: e.message }; }
}

async function sendKeys(target, text, pressEnter) {
  const b64 = Buffer.from(String(text), "utf8").toString("base64");
  const selector = targetSelector(target);
  const enter = pressEnter ? "$true" : "$false";
  const cmd = [
    USER32,
    `$txt=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'));`,
    `$proc=${selector};`,
    'if(-not $proc){ Write-Output (@{sent=$false;reason="target window not found"}|ConvertTo-Json -Compress); exit }',
    "$h=$proc.MainWindowHandle;",
    "$ws=New-Object -ComObject WScript.Shell;",
    "$fgpid=0;$sb=New-Object System.Text.StringBuilder 512;$ok=$false;",
    // Retry activation a few times — foreground-stealing is restricted/racy on Windows.
    "for($i=0;$i -lt 4 -and -not $ok;$i++){",
    "  [void][W]::ShowWindow($h,9);",            // SW_RESTORE
    "  [void]$ws.AppActivate($proc.Id);",
    "  Start-Sleep -Milliseconds 300;",
    "  $fg=[W]::GetForegroundWindow();[void][W]::GetWindowThreadProcessId($fg,[ref]$fgpid);",
    "  if($fgpid -eq $proc.Id){ $ok=$true }",
    "}",
    "[void][W]::GetWindowText([W]::GetForegroundWindow(),$sb,512);",
    "if(-not $ok){ Write-Output (@{sent=$false;reason=\"target not foreground after activate\";foreground=$sb.ToString();fgpid=$fgpid}|ConvertTo-Json -Compress); exit }",
    // Type via CLIPBOARD PASTE, not per-character SendKeys: immune to Caps Lock
    // case-inversion and to SendKeys metacharacters. Save + restore the clipboard.
    "$prevClip=$null; try { $prevClip=Get-Clipboard -Raw } catch {}",
    "Set-Clipboard -Value $txt;",
    "Start-Sleep -Milliseconds 80;",
    "[void]$ws.SendKeys('^v');",
    `if(${enter}){ Start-Sleep -Milliseconds 140; [void]$ws.SendKeys('{ENTER}') }`,
    "Start-Sleep -Milliseconds 90;",
    "if($null -ne $prevClip){ try { Set-Clipboard -Value $prevClip } catch {} } else { try { Set-Clipboard -Value ' ' } catch {} }",
    '$o=@{sent=$true;window=$sb.ToString();pid=$proc.Id}|ConvertTo-Json -Compress;Write-Output $o',
  ].join("\n");
  try {
    const out = await ps(cmd, 12000);
    return JSON.parse(out.trim() || '{"sent":false,"reason":"no output"}');
  } catch (e) { return { sent: false, reason: e.message }; }
}

export default {
  id: "external-agents",
  name: "External Agents",
  description: "Focus on coding agents outside the IDE: Claude Code CLI + the Claude desktop app. Read their transcripts; send prompts via guarded keystroke injection.",
  icon: "◎",
  config: [
    { key: "recentCap", label: "How many recent sessions to list", type: "text", default: "8", help: "Caps the candidate list per source." },
  ],

  async test() {
    const fg = await foreground();
    const tx = await recentTranscripts(1);
    return { ok: true, message: `Foreground: ${fg.proc || "?"} ("${fg.title || ""}"). Claude transcripts found: ${tx.length ? "yes" : "none"}.` };
  },

  actions: [
    {
      name: "external_focus_list",
      description:
        "List coding agents running OUTSIDE managed terminals that the orb can focus on: recent Claude Code sessions (CLI + the Claude desktop app). " +
        "Returns each with a short id, kind (claude-code | claude-app), title, working directory and how recent it is. Use for 'what Claude sessions are open', 'focus on my Claude desktop app'.",
      parameters: { type: "object", properties: {} },
      async handler(_args, cfg) {
        const cap = Math.max(1, parseInt(cfg?.recentCap, 10) || RECENT_CAP);
        const out = [];
        // Claude desktop app sessions (richer metadata; mark the most-recently-focused).
        try {
          const desk = await desktopSessions(cap);
          let topFocus = 0;
          for (const d of desk) if (d.lastFocusedAt > topFocus) topFocus = d.lastFocusedAt;
          for (const d of desk) {
            out.push({
              id: d.cliSessionId,
              kind: "claude-app",
              title: d.title || "(untitled)",
              cwd: d.cwd,
              lastActivity: d.lastActivity ? rel(d.lastActivity) : "",
              lastActivityMs: d.lastActivity || 0,
              onScreen: d.lastFocusedAt > 0 && d.lastFocusedAt === topFocus,
            });
          }
        } catch { /* desktop sessions optional */ }
        // Claude Code CLI transcripts (covers plain-CLI sessions too).
        try {
          const seen = new Set(out.map((o) => o.id));
          const tx = await recentTranscripts(cap);
          for (const t of tx) {
            if (seen.has(t.id)) continue;
            const meta = await headMeta(t.file);
            out.push({
              id: t.id,
              kind: "claude-code",
              title: meta.title || "(untitled)",
              cwd: meta.cwd || "",
              lastActivity: rel(t.mtime),
              lastActivityMs: t.mtime || 0,
              onScreen: false,
            });
          }
        } catch { /* transcripts optional */ }
        if (!out.length) return { result: "No external Claude sessions found." };
        return { result: JSON.stringify(out) };
      },
    },
    {
      name: "external_focus_foreground",
      description: "Report which application window is currently in the FOREGROUND on screen (process name + title). Use to confirm what the operator is actually looking at before focusing or sending.",
      parameters: { type: "object", properties: {} },
      async handler() {
        const fg = await foreground();
        if (fg.error) return { error: fg.error };
        return { result: JSON.stringify(fg) };
      },
    },
    {
      name: "external_focus_read",
      description:
        "Read recent activity of an external Claude session by its id (from external_focus_list): the last few user prompts and the latest assistant reply, from its transcript. " +
        "Use to answer 'what is my Claude desktop app working on'.",
      parameters: { type: "object", properties: { id: { type: "string", description: "Session id from external_focus_list." } }, required: ["id"] },
      async handler(args) {
        const file = await findTranscriptById(args?.id);
        if (!file) return { result: `No transcript found for session "${args?.id}". The desktop app may not have written one yet.` };
        const { prompts, lastAssistant, title } = await tailSession(file, 6);
        const lines = [];
        if (title) lines.push(`Title: ${title}`);
        if (prompts.length) lines.push(`Recent prompts: ${prompts.map((p) => `“${p.slice(0, 160)}”`).join(" | ")}`);
        if (lastAssistant) lines.push(`Latest reply: ${lastAssistant.slice(0, 400)}`);
        return { result: lines.join("\n") || "(transcript is empty)" };
      },
    },
    {
      name: "external_focus_send",
      description:
        "Send a prompt to an external Claude app by simulated typing into its window. SAFETY: this activates the target window and only types if that window is verified foreground, otherwise it refuses. " +
        "Requires confirm=true — the orb must read the prompt + target back to the operator and get a spoken confirmation first. Never call this without an explicit confirmation.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The exact prompt to type." },
          target: { type: "string", description: "Which window: 'claude-app' for the Claude desktop app (default), or a process name." },
          pressEnter: { type: "boolean", description: "Press Enter after typing to submit (default true)." },
          confirm: { type: "boolean", description: "Must be true. Defence-in-depth: refuses to type without it." },
        },
        required: ["text"],
      },
      async handler(args) {
        if (!args || args.confirm !== true) {
          return { error: "Refused: external_focus_send needs confirm=true (read the prompt back and get a spoken confirmation first)." };
        }
        const text = String(args.text || "").replace(/[\x00-\x1F\x7F]/g, " ").trim();
        if (!text) return { error: "Nothing to send (empty after sanitizing)." };
        if (text.length > 2000) return { error: `Prompt is ${text.length} chars, over the 2000 limit.` };
        const pressEnter = args.pressEnter !== false;
        const r = await sendKeys(args.target || "claude-app", text, pressEnter);
        if (r.sent) return { result: `Typed into "${r.window}" (pid ${r.pid})${pressEnter ? " and submitted" : ""}: ${text}` };
        return { error: `Did not send — ${r.reason || "unknown"}. (Foreground was "${r.foreground || "?"}".) Bring the Claude window up and try again.` };
      },
    },
  ],
};
