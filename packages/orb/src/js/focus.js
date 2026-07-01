// ── Focus Area ─────────────────────────────────────────────────────────────
// Lets the orb "focus" on a running coding-agent terminal (Claude, Codex,
// Gemini, Copilot, Devin) surfaced by the brain, read what it's doing,
// and route instructions into it — SAFELY. Routing never sends silently: unless
// the operator has explicitly trusted the focus, prompts are STAGED and only go
// out after a verbal "confirm". This is intentionally dependency-free (browser
// ESM, global fetch) and never throws out of a method.
//
// IMPORTANT (why "active" matters): the IDE only TAGS a session with a provider
// when it was created from a parseable resume command. If the operator launches
// `codex`/`claude` by hand inside a plain shell session, provider stays null even
// though an agent is clearly running on screen. So we surface ANY active session
// as a focus candidate (so the orb can SEE/READ what's on screen) and detect the
// agent from the buffer. The "is this safe to send into" decision is separate —
// it sniffs the live buffer rather than trusting the (often missing) tag.
//
// Bridge contract (the brain on :3000):
//   POST <brainUrl>/api/voice/tools/call  body { name, args }
//     -> { result: <string>, isError?: boolean, error?: string }
//   list_terminals       -> result is JSON text (array of session objects)
//   read_terminal_buffer -> result is the raw buffer text
//   run_terminal_command -> sends { sessionId, command } into a session

const STORAGE_KEY = "voxa.focus";
const AGENT_PROVIDERS = ["claude", "codex", "gemini", "copilot", "devin"];
const READ_CAP = 4000;       // keep the tail when a buffer is huge
const DEFAULT_TAIL_LINES = 80;
const SNIFF_LINES = 60;      // how much tail to read when detecting the agent
const LIST_LIMIT = 14;       // keep the spoken candidate list manageable

function nowISO() {
  try { return new Date().toISOString(); } catch { return ""; }
}

// Strip ANSI/VT escape sequences and leftover control bytes so the model gets
// readable text instead of cursor-positioning soup. Keeps newlines and tabs.
function stripAnsi(input) {
  let s = typeof input === "string" ? input : String(input == null ? "" : input);
  // OSC sequences: ESC ] ... (BEL | ESC \)
  s = s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
  // CSI sequences: ESC [ ... final-byte
  s = s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  // Other two-char escapes: ESC <single char>
  s = s.replace(/\x1b[@-Z\\-_]/g, "");
  // Remaining control chars except \n (0x0A) and \t (0x09).
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  return s;
}

// Sanitize a prompt before it ever reaches a terminal: no embedded escape
// sequences, no newlines (collapse to spaces), trimmed.
function sanitizePrompt(input) {
  let s = typeof input === "string" ? input : String(input == null ? "" : input);
  s = s.replace(/[\x00-\x1F\x7F]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

// Best-effort: figure out what's running in a terminal from its recent output.
// Returns one of: "codex" | "claude" | "gemini" | "copilot" | "devin" | "shell" | "unknown".
function detectAgent(rawBuffer) {
  const t = stripAnsi(rawBuffer || "").toLowerCase();
  if (!t.trim()) return "unknown";
  // Look mostly at the tail (current state), but keep a decent window.
  const tail = t.length > 4000 ? t.slice(t.length - 4000) : t;
  if (/openai codex|\bcodex\b|gpt-5|gpt-4|\/model to change/.test(tail)) return "codex";
  if (/claude code|anthropic|\bclaude\b/.test(tail)) return "claude";
  if (/gemini|google ai|\bbard\b/.test(tail)) return "gemini";
  if (/copilot/.test(tail)) return "copilot";
  if (/\bdevin\b/.test(tail)) return "devin";
  // Bare shell prompt at the very end (PowerShell / cmd / bash).
  if (/(?:ps )?[a-z]:\\[^\n]*>\s*$|\$\s*$|#\s*$|>\s*$/m.test(tail.trimEnd())) return "shell";
  return "unknown";
}

function isAgentName(a) {
  return AGENT_PROVIDERS.includes(String(a || "").toLowerCase());
}

export class FocusManager {
  constructor({ getBrainUrl, getConnectorUrl, getConfig } = {}) {
    this._getBrainUrl = typeof getBrainUrl === "function" ? getBrainUrl : () => "http://localhost:3000";
    this._getConnectorUrl = typeof getConnectorUrl === "function" ? getConnectorUrl : () => "http://localhost:3010";
    this._getConfig = typeof getConfig === "function" ? getConfig : () => ({});
    // state: { sessionId, kind, external, provider, agentName, cwd, displayName,
    //          workspaceName, detected, trusted, staged } | null
    // kind: "managed" (managed PTY) | "claude-app" | "claude-code" (external).
    this.state = null;
    this._restore();
  }

  // ── config / persistence ──────────────────────────────────────────────────
  _cfg() {
    const c = this._getConfig() || {};
    return {
      enabled: c.enabled !== false,
      providerFilter: Array.isArray(c.providerFilter) ? c.providerFilter : AGENT_PROVIDERS,
      confirmBeforeSend: c.confirmBeforeSend !== false,
      snapshotOnFocus: c.snapshotOnFocus !== false,
      maxPromptChars: Number.isFinite(c.maxPromptChars) ? c.maxPromptChars : 2000,
    };
  }

  _brainUrl() {
    let u = "";
    try { u = String(this._getBrainUrl() || ""); } catch { u = ""; }
    return (u || "http://localhost:3000").replace(/\/$/, "");
  }

  _connectorUrl() {
    let u = "";
    try { u = String(this._getConnectorUrl() || ""); } catch { u = ""; }
    return (u || "http://localhost:3010").replace(/\/$/, "");
  }

  _restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved && typeof saved.sessionId === "string" && saved.sessionId) {
        this.state = {
          sessionId: saved.sessionId,
          kind: typeof saved.kind === "string" ? saved.kind : "managed",
          external: saved.external === true,
          provider: typeof saved.provider === "string" ? saved.provider : "",
          agentName: typeof saved.agentName === "string" ? saved.agentName : "",
          cwd: typeof saved.cwd === "string" ? saved.cwd : "",
          displayName: typeof saved.displayName === "string" ? saved.displayName : "",
          workspaceName: typeof saved.workspaceName === "string" ? saved.workspaceName : "",
          detected: typeof saved.detected === "string" ? saved.detected : "",
          trusted: saved.trusted === true,
          staged: null,
        };
      }
    } catch { /* corrupt entry — ignore */ }
  }

  _persist() {
    try {
      if (!this.state) { localStorage.removeItem(STORAGE_KEY); return; }
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        sessionId: this.state.sessionId,
        kind: this.state.kind || "managed",
        external: !!this.state.external,
        provider: this.state.provider,
        agentName: this.state.agentName,
        cwd: this.state.cwd,
        displayName: this.state.displayName,
        workspaceName: this.state.workspaceName,
        detected: this.state.detected,
        trusted: !!this.state.trusted,
      }));
    } catch { /* storage full / unavailable — non-fatal */ }
  }

  // ── bridge ────────────────────────────────────────────────────────────────
  async _post(base, name, args) {
    try {
      const res = await fetch(`${base}/api/voice/tools/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, args: args || {} }),
      });
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (!res.ok) {
        return { error: (data && data.error) || `HTTP ${res.status}`, result: data && data.result };
      }
      if (data && (data.isError || data.error)) {
        return { error: data.error || "tool error", result: data.result };
      }
      return { result: data ? data.result : undefined };
    } catch (e) {
      return { error: `bridge unreachable (${e && e.message ? e.message : e})` };
    }
  }

  async _call(name, args) { return this._post(this._brainUrl(), name, args); }
  async _callConnector(name, args) { return this._post(this._connectorUrl(), name, args); }

  // ── candidates ────────────────────────────────────────────────────────────
  // A session is a candidate if it's ACTIVE (a live PTY — likely what's on
  // screen) regardless of tag, OR it carries a recognised agent provider (so
  // tagged-but-idle sessions stay reachable). Untagged idle sessions are skipped.
  async listCandidates() {
    const { result, error } = await this._call("list_terminals", {});
    if (error && result === undefined) return [];
    let arr = [];
    try {
      const parsed = typeof result === "string" ? JSON.parse(result) : result;
      if (Array.isArray(parsed)) arr = parsed;
      else if (parsed && Array.isArray(parsed.terminals)) arr = parsed.terminals;
      else if (parsed && Array.isArray(parsed.sessions)) arr = parsed.sessions;
    } catch { arr = []; }
    const filter = this._cfg().providerFilter.map((p) => String(p).toLowerCase());
    const out = [];
    for (const s of arr) {
      if (!s || typeof s !== "object") continue;
      const provider = s.provider ? String(s.provider) : "";
      const state = s.state ? String(s.state) : "";
      const active = state.toLowerCase() === "active";
      const known = !!provider && (!filter.length || filter.includes(provider.toLowerCase()));
      // Surface live sessions (on screen) + recognised agents; skip idle untagged.
      if (!active && !known) continue;
      out.push({
        sessionId: s.id != null ? String(s.id) : "",
        kind: "managed",
        external: false,
        provider,
        providerKnown: known,
        agentName: s.agentName ? String(s.agentName) : "",
        cwd: s.cwd ? String(s.cwd) : "",
        displayName: String(s.displayName || s.name || ""),
        workspaceName: s.workspaceName ? String(s.workspaceName) : "",
        lastActiveAt: typeof s.lastActiveAt === "string" ? s.lastActiveAt : "",
        recencyMs: typeof s.lastActiveAt === "string" ? (Date.parse(s.lastActiveAt) || 0) : 0,
        state,
        active,
        onScreen: s.uiFocused === true,
      });
    }
    // Merge external Claude targets (desktop app + CLI) from the connector. Best
    // effort — if the connector is down, managed terminals still work.
    try {
      const ext = await this._callConnector("external_focus_list", {});
      if (ext && typeof ext.result === "string" && ext.result.trim().startsWith("[")) {
        const items = JSON.parse(ext.result);
        if (Array.isArray(items)) {
          for (const it of items) {
            if (!it || !it.id) continue;
            out.push({
              sessionId: String(it.id),
              kind: it.kind === "claude-app" ? "claude-app" : "claude-code",
              external: true,
              provider: "claude",
              providerKnown: true,
              agentName: "Claude",
              cwd: it.cwd ? String(it.cwd) : "",
              displayName: it.title ? String(it.title) : "",
              workspaceName: it.title ? String(it.title) : "",
              lastActiveAt: "",
              recencyMs: Number.isFinite(it.lastActivityMs) ? it.lastActivityMs : 0,
              state: "external",
              active: false,
              onScreen: it.onScreen === true,
            });
          }
        }
      }
    } catch { /* connector optional */ }
    // Rank: on-screen first, then live managed panes, then most recent.
    out.sort((a, b) => {
      if (!!a.onScreen !== !!b.onScreen) return a.onScreen ? -1 : 1;
      if (a.active !== b.active) return a.active ? -1 : 1;
      return (b.recencyMs || 0) - (a.recencyMs || 0);
    });
    return out;
  }

  _label(c) {
    const who = c.external ? (c.kind === "claude-app" ? "Claude desktop" : "Claude Code")
      : c.providerKnown ? c.provider : "terminal";
    const where = c.workspaceName || c.cwd || "";
    return `${who}${where ? " · " + where : ""}`;
  }

  _summarizeCandidates(cands) {
    if (!cands.length) return "no focusable terminals were found";
    return cands.slice(0, LIST_LIMIT)
      .map((c) => `${this._label(c)}${c.active ? " [active]" : ""}`)
      .join("; ");
  }

  // ── focus binding ─────────────────────────────────────────────────────────
  async setFocus(target) {
    const cands = await this.listCandidates();
    if (!cands.length) return "No focusable terminals are available right now.";

    let pick = null;
    const t = typeof target === "string" ? target.trim().toLowerCase() : "";
    if (t) {
      pick = cands.find((c) =>
        c.sessionId.toLowerCase() === t ||
        c.sessionId.toLowerCase().includes(t) ||
        c.displayName.toLowerCase().includes(t) ||
        c.workspaceName.toLowerCase().includes(t) ||
        c.provider.toLowerCase().includes(t) ||
        (c.agentName && c.agentName.toLowerCase().includes(t)) ||
        (c.cwd && c.cwd.toLowerCase().includes(t))
      );
      if (!pick) {
        return `Couldn't match "${target}" to a terminal. Candidates: ${this._summarizeCandidates(cands)}.`;
      }
    } else {
      pick = cands[0]; // newest active (already sorted active-first, recent-first)
    }

    this.state = {
      sessionId: pick.sessionId,
      kind: pick.kind || "managed",
      external: !!pick.external,
      provider: pick.external ? "claude" : pick.provider,
      agentName: pick.agentName,
      cwd: pick.cwd,
      displayName: pick.displayName,
      workspaceName: pick.workspaceName,
      detected: "",
      trusted: false,
      staged: null,
    };

    // Identify what we bound to. External Claude is known by kind; for a managed
    // pane with no provider tag, sniff the buffer (Codex/Claude/…/shell).
    let identity;
    if (this.state.external) {
      identity = this.state.kind === "claude-app" ? "the Claude desktop app" : "an external Claude Code session";
    } else if (isAgentName(this.state.provider)) {
      identity = this.state.provider;
    } else {
      const det = detectAgent(await this._readRaw(SNIFF_LINES));
      this.state.detected = det;
      identity = det === "shell" ? "a plain shell (no agent detected)"
        : isAgentName(det) ? `${det} (detected from the screen)`
        : "an unrecognised program";
    }
    this._persist();

    let snapshot = "";
    if (this._cfg().snapshotOnFocus) {
      try {
        const text = await this.read({ lines: 40 });
        if (text && !/^Couldn't|^No focus|^Nothing|^\(/.test(text)) {
          const tail = text.length > 400 ? "…" + text.slice(text.length - 400) : text;
          snapshot = ` Recent activity: ${tail}`;
        }
      } catch { /* snapshot is best-effort */ }
    }
    const where = this.state.workspaceName || this.state.cwd;
    const sendNote = this.state.external
      ? "To send, I'll bring its window to the front and type after you confirm."
      : "Auto-send is OFF; I'll read prompts back and wait for your confirm before sending.";
    return `Focused on ${identity}${where ? ` in ${where}` : ""}. ${sendNote}${snapshot}`;
  }

  getStatus() {
    if (!this.state) return "No focus set.";
    const s = this.state;
    const id = s.external ? (s.kind === "claude-app" ? "the Claude desktop app" : "an external Claude Code session")
      : isAgentName(s.provider) ? s.provider
      : isAgentName(s.detected) ? `${s.detected} (detected)`
      : s.detected === "shell" ? "a plain shell" : "a terminal";
    const where = s.workspaceName || s.cwd;
    const parts = [`Focused on ${id}${where ? " @ " + where : ""}.`];
    parts.push(`Auto-send (trust) is ${s.trusted ? "ON" : "OFF"}.`);
    if (s.staged && s.staged.prompt) parts.push(`Staged prompt awaiting confirm: "${s.staged.prompt}".`);
    else parts.push("Nothing staged.");
    return parts.join(" ");
  }

  clear() {
    const had = this.state;
    this.state = null;
    this._persist();
    return had ? "Focus released. I'm no longer attached to any terminal." : "No focus was set.";
  }

  // ── read ──────────────────────────────────────────────────────────────────
  async _readRaw(lines) {
    if (!this.state || this.state.external) return "";
    const tailLines = Number.isFinite(lines) && lines > 0 ? Math.round(lines) : DEFAULT_TAIL_LINES;
    const { result } = await this._call("read_terminal_buffer", {
      sessionId: this.state.sessionId,
      tailLines,
    });
    return typeof result === "string" ? result : (result == null ? "" : String(result));
  }

  async read({ lines } = {}) {
    if (!this.state) return "No focus set — set focus on a terminal first.";
    if (this.state.external) {
      const { result, error } = await this._callConnector("external_focus_read", { id: this.state.sessionId });
      if (error && (result === undefined || result === null)) {
        return `Couldn't read the external Claude session: ${error}`;
      }
      const t = typeof result === "string" ? result : "";
      return t.trim() || "(no recent activity found for that Claude session)";
    }
    const tailLines = Number.isFinite(lines) && lines > 0 ? Math.round(lines) : DEFAULT_TAIL_LINES;
    const { result, error } = await this._call("read_terminal_buffer", {
      sessionId: this.state.sessionId,
      tailLines,
    });
    if (error && (result === undefined || result === null)) {
      return `Couldn't read the focused terminal: ${error}`;
    }
    let text = stripAnsi(typeof result === "string" ? result : (result == null ? "" : String(result)));
    text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
    if (text.length > READ_CAP) text = "…" + text.slice(text.length - READ_CAP); // keep the tail
    return text.trim() || "(the focused terminal buffer is empty)";
  }

  // ── trust ─────────────────────────────────────────────────────────────────
  setTrust(on) {
    if (!this.state) return "No focus set — can't change trust. Set focus first.";
    this.state.trusted = !!on;
    this._persist();
    return this.state.trusted
      ? `Auto-send ON. Routed prompts will go straight through to a recognised agent — be careful.`
      : `Auto-send OFF. Prompts will be staged for your confirm.`;
  }

  // ── route (the safe send) ─────────────────────────────────────────────────
  async route(prompt) {
    // 1. Must have a focus.
    if (!this.state) {
      return "No terminal is focused. Call set_focus first (optionally name the agent, directory, or workspace).";
    }
    // 1b. External Claude (GUI) — sent by guarded keystroke, ALWAYS staged.
    if (this.state.external) {
      const cfgX = this._cfg();
      const cleanX = sanitizePrompt(prompt);
      if (!cleanX) return "There's nothing to send — the prompt was empty after sanitizing.";
      if (cleanX.length > cfgX.maxPromptChars) {
        return `That prompt is ${cleanX.length} chars, over the ${cfgX.maxPromptChars}-char limit. Shorten it.`;
      }
      if (this.state.kind !== "claude-app") {
        return "I can read this external Claude Code session, but to SEND I can only type into the Claude desktop app window. Open it there, or run the agent in a managed terminals.";
      }
      this.state.staged = { prompt: cleanX, at: nowISO(), agent: "claude-app" };
      this._persist();
      return `Staged for the Claude desktop app: "${cleanX}". On confirm I'll bring its window to the front and type it — make sure the right Claude conversation is open first. Say "confirm" to send.`;
    }
    // 2. Re-list and verify the focused session still exists.
    const cands = await this.listCandidates();
    const match = cands.find((c) => c.sessionId === this.state.sessionId);
    if (!match) {
      this.clear();
      return "The focused session has ended, so I've released focus. Set focus again to continue.";
    }
    // Refresh metadata from the live listing.
    this.state.provider = match.provider || this.state.provider;
    this.state.cwd = match.cwd || this.state.cwd;
    this.state.displayName = match.displayName || this.state.displayName;
    this.state.workspaceName = match.workspaceName || this.state.workspaceName;

    // 3. Sanitize + enforce length (reject, don't silently truncate).
    const cfg = this._cfg();
    const clean = sanitizePrompt(prompt);
    if (!clean) return "There's nothing to send — the prompt was empty after sanitizing.";
    if (clean.length > cfg.maxPromptChars) {
      return `That prompt is ${clean.length} chars, over the ${cfg.maxPromptChars}-char limit. Shorten it and try again.`;
    }

    // 4. Determine what we're sending into. Trust the tag if present; otherwise
    //    sniff the live buffer. This is the safety classification.
    let agent = String(this.state.provider || "").toLowerCase();
    if (!isAgentName(agent)) {
      agent = detectAgent(await this._readRaw(SNIFF_LINES));
      this.state.detected = agent;
    }
    const recognisedAgent = isAgentName(agent);
    const looksLikeShell = agent === "shell";
    const where = this.state.workspaceName || this.state.cwd || "the focused terminal";

    // 5. Auto-send ONLY into a recognised agent, and only when trusted. Never
    //    auto-send into a plain shell or an unidentified program.
    if (this.state.trusted === true && recognisedAgent) {
      const sent = await this._send(clean);
      if (sent.error) return `Couldn't send to ${agent}: ${sent.error}`;
      return `Sent to ${agent} (${where}): ${clean}`;
    }

    // 6. Otherwise STAGE — do NOT send. Add a warning for risky targets.
    this.state.staged = { prompt: clean, at: nowISO(), agent };
    this._persist();
    let warn = "";
    if (looksLikeShell) {
      warn = " ⚠ This looks like a plain shell, not an agent — sending will run it as a SHELL COMMAND, not an agent prompt.";
    } else if (!recognisedAgent) {
      warn = " ⚠ I couldn't confirm which agent is running here, so be sure before you confirm.";
    }
    const who = recognisedAgent ? agent : (looksLikeShell ? "a shell" : "an unidentified terminal");
    return `Staged for ${who} (${where}): "${clean}".${warn} Say "confirm" to send.`;
  }

  async confirmSend() {
    if (!this.state) return "No focus set — nothing staged.";
    if (!this.state.staged || !this.state.staged.prompt) return "Nothing staged.";
    const prompt = this.state.staged.prompt; // send the EXACT staged prompt
    // External Claude desktop app → guarded keystroke via the connector.
    if (this.state.external) {
      const { result, error } = await this._callConnector("external_focus_send", {
        text: prompt, target: "claude-app", pressEnter: true, confirm: true,
      });
      if (error) return `Couldn't send to the Claude desktop app: ${error}`;
      this.state.staged = null;
      this._persist();
      return typeof result === "string" && result ? result : `Sent to the Claude desktop app: ${prompt}`;
    }
    const sent = await this._send(prompt);
    if (sent.error) return `Couldn't send: ${sent.error}`;
    const where = this.state.workspaceName || this.state.cwd || "the focused terminal";
    this.state.staged = null;
    this._persist();
    return `Sent to ${where}: ${prompt}`;
  }

  async _send(command) {
    const { error } = await this._call("run_terminal_command", {
      sessionId: this.state.sessionId,
      command,
    });
    return { error };
  }
}
