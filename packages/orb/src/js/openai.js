// OpenAI Realtime provider — browser → OpenAI via the official Agents SDK (WebRTC).
// The SDK auto-manages mic capture, playback, and barge-in; we feed it
// instructions + tools and surface its events into the orb's session contract
// (the same `on` callbacks GeminiSession uses). Pay-per-use from the account's
// OpenAI credits. Set an OpenAI API key in Settings.
//
// Implements the orb session interface: start/stop/sendText + the shims the orb
// calls (getOutputLevel, isLive, setMicMuted/setMuted, setAudioParams,
// setMicDevice, sendEvent) so it drops into startSession like GeminiSession.

const SDK_URL = "https://esm.sh/@openai/agents-realtime";

const TOOL_GUIDE =
  "\n\nYou are wired to live tools (memory/notes, connectors, and more). When the " +
  "operator asks about something a tool can answer — saved notes, facts, the weather, " +
  "search, etc. — CALL THE RELEVANT TOOL instead of guessing. Before a tool call, say a " +
  "short spoken heads-up (e.g. \"one sec, checking…\") so the operator isn't left waiting.";

async function mintEphemeralKey(apiKey, model) {
  const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ session: { type: "realtime", model } }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`ephemeral key mint failed (${r.status}): ${body.slice(0, 200)}`);
  }
  const data = await r.json();
  const key = data?.value || data?.client_secret?.value || data?.client_secret;
  if (!key) throw new Error("ephemeral key mint returned no token");
  return key;
}

export class OpenAiSession {
  constructor({ apiKey, model, voice, systemInstruction, toolBridge, on } = {}) {
    this.apiKey = apiKey;
    this.model = model || "gpt-realtime";
    this.voice = voice || "marin";
    this.systemInstruction = systemInstruction || "You are Voxa, a concise, dry-witted desktop voice assistant. Keep spoken replies short.";
    this.toolBridge = toolBridge || null;
    this.on = Object.assign(
      { status: () => {}, userText: () => {}, assistantText: () => {}, error: () => {}, tool: () => {} },
      on || {}
    );
    this.provider = "openai";
    this.mode = "open-mic";
    this.session = null;
    this.active = false;
    this._speakTimer = null;
    this._meter = null;
    this._micStream = null;
    this._outLevel = 0;
    this._lastUserText = ""; this._lastUserId = "";
    this._lastAssistantText = ""; this._lastAssistantId = "";
  }

  async start() {
    if (this.active) return;
    if (!this.apiKey) throw new Error("Missing OpenAI API key — set it in Settings.");
    this.active = true;
    this.on.status("connecting");

    let RealtimeAgent, RealtimeSession, tool, OpenAIRealtimeWebRTC;
    try {
      ({ RealtimeAgent, RealtimeSession, tool, OpenAIRealtimeWebRTC } = await import(SDK_URL));
    } catch (e) {
      this.active = false;
      throw new Error("Failed to load OpenAI SDK: " + (e?.message || e));
    }

    let tools = [];
    if (this.toolBridge) {
      try {
        const decls = await this.toolBridge.load();
        tools = decls.map((d) => tool({
          name: d.name,
          description: d.description,
          parameters: d.parameters || { type: "object", properties: {}, additionalProperties: false },
          strict: false,
          execute: async (args) => {
            this.on.tool?.(d.name, args, "running");
            const out = await this.toolBridge.call(d.name, args || {});
            this.on.tool?.(d.name, args, out.error ? "error" : "done", out.error || out.result);
            return out.error ? { error: out.error } : { result: out.result };
          },
        }));
      } catch (e) {
        this.on.error("Tool bridge unavailable: " + (e?.message || e));
      }
    }

    const agent = new RealtimeAgent({
      name: "Voxa",
      instructions: this.systemInstruction + (this.toolBridge ? TOOL_GUIDE : ""),
      tools,
    });

    let connectKey = this.apiKey, usedEphemeral = false;
    try { connectKey = await mintEphemeralKey(this.apiKey, this.model); usedEphemeral = true; }
    catch (e) { this.on.error("Ephemeral key mint failed, trying raw key: " + (e?.message || e)); }

    let micStream = null;
    try { micStream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {}
    const transportOpts = {};
    if (!usedEphemeral) transportOpts.useInsecureApiKey = true;
    if (micStream) transportOpts.mediaStream = micStream;
    const transport = new OpenAIRealtimeWebRTC(transportOpts);
    this._micStream = micStream;
    this.session = new RealtimeSession(agent, {
      transport,
      model: this.model,
      config: { voice: this.voice, inputAudioTranscription: { model: "gpt-4o-mini-transcribe" } },
    });

    this._wireEvents();
    try {
      await this.session.connect({ apiKey: connectKey });
      this.on.status("listening");
      this._startMeter();
    } catch (e) {
      this.active = false;
      throw new Error("OpenAI connect failed: " + (e?.message || e));
    }
  }

  _wireEvents() {
    const s = this.session;
    s.on("audio", () => {
      this._outLevel = 0.6;
      this.on.status("speaking");
      clearTimeout(this._speakTimer);
      this._speakTimer = setTimeout(() => { this._outLevel = 0; if (this.active) this.on.status("listening"); }, 800);
    });
    s.on("audio_interrupted", () => { clearTimeout(this._speakTimer); this._outLevel = 0; this.on.status("listening"); });
    s.on("error", (e) => this.on.error(e?.error?.message || e?.message || "OpenAI error"));
    const onHistory = (history) => {
      const items = Array.isArray(history) ? history : (history?.history || this.session?.history || []);
      let lastUser = null, lastAssistant = null;
      for (const it of items) {
        if (it?.type !== "message") continue;
        const text = extractText(it);
        if (!text) continue;
        const id = it.itemId || it.id || "";
        if (it.role === "user") lastUser = { id, text };
        else if (it.role === "assistant") lastAssistant = { id, text };
      }
      if (lastUser && (lastUser.text !== this._lastUserText || lastUser.id !== this._lastUserId)) {
        this._lastUserText = lastUser.text; this._lastUserId = lastUser.id;
        this.on.userText(lastUser.text, lastUser.id);
      }
      if (lastAssistant && (lastAssistant.text !== this._lastAssistantText || lastAssistant.id !== this._lastAssistantId)) {
        this._lastAssistantText = lastAssistant.text; this._lastAssistantId = lastAssistant.id;
        this.on.assistantText(lastAssistant.text, lastAssistant.id);
      }
    };
    s.on("history_updated", onHistory);
    s.on("history_added", () => onHistory(this.session?.history));
  }

  async _startMeter() {
    try {
      const stream = this._micStream || await navigator.mediaDevices.getUserMedia({ audio: true });
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      if (ctx.state === "suspended") { try { await ctx.resume(); } catch {} }
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser(); analyser.fftSize = 512;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      this._meter = { stream, ctx, raf: 0 };
      const tick = () => {
        if (!this.active || !this._meter) return;
        analyser.getByteTimeDomainData(buf);
        let sum = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        this.on.status(undefined, undefined, Math.min(1, Math.sqrt(sum / buf.length) * 3));
        this._meter.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch {}
  }
  _stopMeter() {
    if (!this._meter) return;
    try { cancelAnimationFrame(this._meter.raf); } catch {}
    try { this._meter.stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { this._meter.ctx.close(); } catch {}
    this._meter = null;
  }

  sendText(text) {
    if (!text || !this.session) return;
    this.on.userText(text);
    try { this.session.sendMessage(text); } catch (e) { this.on.error("sendText: " + (e?.message || e)); }
  }

  stop() {
    this.active = false;
    clearTimeout(this._speakTimer);
    this._stopMeter();
    try { this._micStream?.getTracks().forEach((t) => t.stop()); } catch {}
    this._micStream = null;
    try { this.session?.close?.(); } catch {}
    try { this.session?.disconnect?.(); } catch {}
    this.session = null;
    this.on.status("offline");
  }

  // ── orb-compat shims (GeminiSession parity) ───────────────────────────────
  get isLive() { return this.active; }
  getOutputLevel() { return this._outLevel; }
  setMicMuted(b) { try { this._micStream?.getTracks().forEach((t) => (t.enabled = !b)); } catch {} }
  setMuted(b) { this.setMicMuted(b); }
  setAudioParams() {}   // gain/VAD handled by the SDK
  setMicDevice() {}     // SDK self-captures; device switch not wired
  sendEvent() {}
}

function extractText(item) {
  const parts = item?.content;
  if (!Array.isArray(parts)) return typeof item?.content === "string" ? item.content : "";
  const out = [];
  for (const p of parts) {
    if (typeof p === "string") out.push(p);
    else if (p?.transcript) out.push(p.transcript);
    else if (p?.text) out.push(p.text);
  }
  return out.join(" ").trim();
}
