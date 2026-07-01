// Topology A — browser → Gemini Live API directly (mirrors roast-me-tau).
//
// Uses the official @google/genai SDK loaded as an ESM module from a CDN so we
// stay no-build. The SDK tracks the BidiGenerateContent protocol for us, which
// is safer than hand-rolling the WebSocket frames given the API still churns.
//
// Open-mic: Gemini does server-side VAD + turn detection, so we stream the mic
// continuously and let the model decide when the user is done. Barge-in is the
// `interrupted` flag on serverContent — we just flush playback.
//
// Audio contract (per ai.google.dev/gemini-api/docs/live-api, June 2026):
//   in : raw 16-bit PCM, 16 kHz, mono, LE  → "audio/pcm;rate=16000"
//   out: raw 16-bit PCM, 24 kHz, mono, LE

import { GoogleGenAI, Modality } from "https://esm.run/@google/genai";
import { MicCapture, PcmPlayer, int16ToBase64, base64ToInt16 } from "./audio.js";

const GEMINI_OUTPUT_RATE = 24000;

// Tool results are echoed back into the Live session via sendToolResponse. A
// huge payload (e.g. a full terminal scrollback from read_terminal_buffer) blows
// past what the Live websocket will carry — the socket stalls/closes and the orb
// drops to Idle, unresponsive. So we clamp every tool result before returning it.
// WHY keep the TAIL: for terminals/logs the most recent output is the relevant
// part the operator is asking about.
const MAX_TOOL_RESULT_CHARS = 8000;
function safeStringify(v) {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}
function clampToolResponse(out) {
  if (!out || typeof out !== "object") return out;
  if (out.error != null) {
    const e = String(out.error);
    return { error: e.length > MAX_TOOL_RESULT_CHARS ? e.slice(0, MAX_TOOL_RESULT_CHARS) + " …[truncated]" : e };
  }
  if (out.result == null) return out;
  const s = safeStringify(out.result);
  if (s.length <= MAX_TOOL_RESULT_CHARS) return out;
  const tail = s.slice(s.length - MAX_TOOL_RESULT_CHARS);
  return { result: `[truncated — showing last ${MAX_TOOL_RESULT_CHARS} of ${s.length} chars]\n${tail}` };
}

// Always appended to the operator's system instruction so the model knows the
// full tool surface — especially the MEMORY tools. Without this the model
// assumes tools are only for terminals/UI and refuses memory lookups.
export const TOOL_GUIDE =
  "\n\nYou are wired to the the brain \"vibe brain\" via live tools: projects, " +
  "tasks, agents, epics, the knowledge base (search_knowledge, store_knowledge, " +
  "get_knowledge, list_knowledge), procedural memory (brain_query), stored facts " +
  "(fact_recall, fact_store), the agent runner, scheduler, budgets, sessions, " +
  "system metrics, terminals and the UI. When the operator asks about memory, " +
  "knowledge, facts, past decisions, projects, tasks, or system state, CALL THE " +
  "RELEVANT TOOL instead of guessing — e.g. brain_query or search_knowledge for " +
  "memory/knowledge lookups, fact_recall for stored facts, list_projects/list_tasks " +
  "for work items. Prefer acting via tools over saying you can't. IMPORTANT: tool " +
  "calls take a moment — BEFORE you call one, say a short spoken heads-up so the " +
  "operator isn't left waiting, e.g. \"let me query the brain…\", \"one sec, checking " +
  "the the brain agents…\", or \"hold on, pulling that up.\" Then call the tool and " +
  "report what you found." +
  "\n\nSTORING TO THE BRAIN: when the operator tells you to remember, save, note, " +
  "or \"put this in the brain\" — persist it by calling fact_store with action=\"add\" " +
  "and a clear, self-contained `content` sentence (add comma-separated `entities` for " +
  "the key people/projects/things it's about). These facts land in the long-term cold " +
  "tier and are later retrievable via brain_query / fact_recall. Use store_knowledge " +
  "instead only when it's clearly project/task documentation. Confirm out loud once " +
  "it's saved. Don't store throwaway chatter — only durable, reusable information." +
  "\n\nCONVERSATION MEMORY: your chat with the operator PERSISTS across sessions — " +
  "earlier context is provided to you at the start of each session. When the talk " +
  "gets long, or the operator says \"compact\"/\"summarize and clear\", or you want " +
  "to checkpoint important threads before they scroll away, call compact_conversation " +
  "with a concise summary of the decisions, facts, and open threads to remember. " +
  "That summary becomes your durable memory and the on-screen history is cleared.";

// The ~98 MCP brain tools carry zod-to-json-schema output (unions/anyOf, $ref,
// type-less nodes, arrays without items, extra keywords). Gemini's schema
// converter reads `.type` on every node and throws on anything it doesn't model
// ("Cannot read properties of undefined (reading 'type')"). So we don't *strip*
// — we *rebuild* each schema into the strict Gemini subset: every node gets a
// valid type; unions/$ref collapse to string; arrays always get items.
const GEMINI_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);
function normSchema(node) {
  if (!node || typeof node !== "object") return undefined;
  // Gemini's converter can't handle composite/ref schemas → degrade to string.
  if (node.anyOf || node.oneOf || node.allOf || node.$ref) {
    return { type: "string", ...(node.description ? { description: String(node.description) } : {}) };
  }
  let type = Array.isArray(node.type) ? node.type.find((t) => t !== "null") : node.type;
  if (!GEMINI_TYPES.has(type)) {
    if (node.enum) type = "string";
    else if (node.properties) type = "object";
    else if (node.items) type = "array";
    else return { type: "string", ...(node.description ? { description: String(node.description) } : {}) };
  }
  const out = { type };
  if (node.description) out.description = String(node.description);
  if (Array.isArray(node.enum)) out.enum = node.enum.map(String);
  if (type === "object") {
    const props = {};
    for (const [k, v] of Object.entries(node.properties || {})) {
      const s = normSchema(v);
      if (s) props[k] = s;
    }
    out.properties = props;
    if (Array.isArray(node.required)) {
      const req = node.required.filter((r) => props[r]);
      if (req.length) out.required = req;
    }
  }
  if (type === "array") out.items = normSchema(node.items) || { type: "string" };
  return out;
}
// Top level: omit `parameters` entirely for no-arg tools (Gemini wants it absent).
function geminiSchema(schema) {
  const n = normSchema(schema);
  if (n && n.type === "object" && (!n.properties || !Object.keys(n.properties).length)) return undefined;
  return n;
}

export class GeminiSession {
  constructor({ apiKey, model, voice, systemInstruction, toolBridge, on, micDeviceId, localTools, extraInstruction, muted, audio } = {}) {
    this.apiKey = apiKey;
    this.model = model || "gemini-3.1-flash-live-preview";
    this.voice = voice || "Puck";
    this.micDeviceId = micDeviceId || null;
    // Mic tuning the operator can experiment with from the orb settings.
    // gain/noiseSuppression/autoGainControl drive MicCapture; vadSensitivity sets
    // Gemini's server-side speech detection (applied at connect).
    this.audio = Object.assign(
      { gain: 1, noiseSuppression: true, autoGainControl: true, vadSensitivity: "" },
      audio || {}
    );
    this.systemInstruction = systemInstruction || "You are Voxa, a concise, dry-witted assistant. Keep replies short and spoken-friendly. You can control the IDE through tools — use them when asked about terminals, system load, or the UI.";
    // Appended AFTER the built-in tool guide so a mode policy (e.g. ambient) wins
    // on recency. Text mode (muted) suppresses spoken audio; the reply still shows
    // as text via outputAudioTranscription.
    this.extraInstruction = extraInstruction || "";
    this.muted = !!muted;
    // Push-to-talk gate: when true, captured mic frames are NOT sent to the model
    // (the mic keeps running for the level meter, but the operator's audio is held
    // until they press-to-talk). Toggled live via setMicMuted().
    this.micMuted = false;
    this.toolBridge = toolBridge || null;
    // Local (client-side) tools run in the orb itself instead of routing to an
    // HTTP source — used for things only the UI knows about, e.g. compacting the
    // persisted conversation. Shape: { name, description, parameters, handler }.
    this.localTools = (Array.isArray(localTools) ? localTools : []).filter((t) => t && t.name && typeof t.handler === "function");
    this._localByName = new Map(this.localTools.map((t) => [t.name, t]));
    this.on = Object.assign(
      { status: () => {}, userText: () => {}, assistantText: () => {}, error: () => {}, tool: () => {}, play: () => {} },
      on || {}
    );
    this.provider = "gemini";
    this.topology = "direct";

    this.ai = null;
    this.session = null;
    this.mic = null;
    this.player = new PcmPlayer(GEMINI_OUTPUT_RATE);
    this.active = false;
    // Gemini streams input/output transcripts as *incremental deltas*, not the
    // full string. If we surface each delta raw, the bubble only ever shows the
    // last fragment (~2 words). Accumulate per turn and reset on turn boundary.
    this._inBuf = "";
    this._outBuf = "";
  }

  async start() {
    if (this.active) return;
    if (!this.apiKey) throw new Error("Missing Gemini API key (set it in Settings).");
    this.active = true;
    this.on.status("connecting");

    this.ai = new GoogleGenAI({ apiKey: this.apiKey });

    // Pull live tool declarations from the tool bridge, if wired, and merge
    // in any local tools. Local tools win on a name clash.
    let tools;
    const localDecls = this.localTools.map((t) => ({
      name: t.name,
      description: t.description || "",
      parameters: geminiSchema(t.parameters),
    }));
    const fnDecls = [...localDecls];
    if (this.toolBridge) {
      try {
        const decls = await this.toolBridge.load();
        for (const d of decls) {
          if (this._localByName.has(d.name)) continue;
          fnDecls.push({ name: d.name, description: d.description, parameters: geminiSchema(d.parameters) });
        }
      } catch (e) {
        this.on.error("Tool bridge unavailable: " + (e?.message || e));
      }
    }
    if (fnDecls.length) tools = [{ functionDeclarations: fnDecls }];

    this.session = await this.ai.live.connect({
      model: this.model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: this.systemInstruction + ((this.toolBridge || this.localTools.length) ? TOOL_GUIDE : "") + (this.extraInstruction || ""),
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } },
        },
        // Ask the server to also stream text transcripts so we can show the
        // conversation, not just hear it.
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        // Server-side VAD sensitivity — only sent when the operator opts in, so the
        // default behaviour is untouched. HIGH detects quieter speech onsets.
        ...(this.audio.vadSensitivity === "high"
          ? { realtimeInputConfig: { automaticActivityDetection: { startOfSpeechSensitivity: "START_SENSITIVITY_HIGH" } } }
          : this.audio.vadSensitivity === "low"
          ? { realtimeInputConfig: { automaticActivityDetection: { startOfSpeechSensitivity: "START_SENSITIVITY_LOW" } } }
          : {}),
        ...(tools ? { tools } : {}),
      },
      callbacks: {
        onopen: () => this._onOpen(),
        onmessage: (m) => this._onMessage(m),
        onerror: (e) => this.on.error(describeLiveError(e)),
        onclose: (e) => {
          if (!this.active) return;
          const code = e?.code ? `code ${e.code}` : "";
          const reason = e?.reason || "";
          this.on.status("offline", [code, reason].filter(Boolean).join(" - ") || "closed");
        },
      },
    });
  }

  async _onOpen() {
    this.on.status("listening");
    await this._startMic();
  }

  async _startMic() {
    this.mic = new MicCapture({
      deviceId: this.micDeviceId,
      gain: this.audio.gain,
      noiseSuppression: this.audio.noiseSuppression,
      autoGainControl: this.audio.autoGainControl,
      onFrame: (pcm) => {
        if (!this.session || !this.active || this.micMuted) return;
        try {
          this.session.sendRealtimeInput({
            audio: { data: int16ToBase64(pcm), mimeType: "audio/pcm;rate=16000" },
          });
        } catch (e) { this.on.error(e?.message || String(e)); }
      },
      onLevel: (lvl) => this.on.status(undefined, undefined, lvl),
    });
    try {
      await this.mic.start();
    } catch (e) {
      this.on.error("Mic: " + (e?.message || e));
      this.stop();
    }
  }

  // Apply mic tuning live. gain changes are instant; noiseSuppression /
  // autoGainControl need a getUserMedia restart (re-runs _startMic). vadSensitivity
  // is stored but only takes effect on the next session connect.
  async setAudioParams(params = {}) {
    const prev = this.audio;
    this.audio = Object.assign({}, prev, params);
    if (!this.active || !this.mic) return;
    const constraintsChanged =
      (params.noiseSuppression !== undefined && params.noiseSuppression !== prev.noiseSuppression) ||
      (params.autoGainControl !== undefined && params.autoGainControl !== prev.autoGainControl);
    if (constraintsChanged) {
      try { this.mic.stop(); } catch {}
      await this._startMic();
    } else if (params.gain !== undefined) {
      this.mic.setGain(this.audio.gain);
    }
  }

  // Hot-swap the input device mid-session (picker in the orb settings).
  async setMicDevice(deviceId) {
    this.micDeviceId = deviceId || null;
    if (!this.active) return;
    try { this.mic && this.mic.stop(); } catch {}
    await this._startMic();
  }

  _onMessage(msg) {
    // Function calls — the Live API does NOT auto-execute; we run them via the
    // tool bridge and post results back with sendToolResponse.
    if (msg?.toolCall?.functionCalls?.length) {
      this._handleToolCalls(msg.toolCall.functionCalls);
      return;
    }

    const sc = msg?.serverContent;
    if (!sc) return;

    // Barge-in: the model was interrupted by user speech mid-utterance.
    if (sc.interrupted) {
      this.player.stop();
      this._outBuf = ""; // assistant turn cut — next reply starts fresh
      this.on.status("listening");
    }

    // Live transcripts (deltas) — accumulate so the bubble shows the whole
    // utterance, not just the trailing chunk. Reset on turnComplete below.
    if (sc.inputTranscription?.text) {
      this._inBuf += sc.inputTranscription.text;
      this.on.userText(this._inBuf);
    }
    if (sc.outputTranscription?.text) {
      this._outBuf += sc.outputTranscription.text;
      this.on.assistantText(this._outBuf);
    }

    // Model audio out.
    const parts = sc.modelTurn?.parts || [];
    for (const p of parts) {
      const data = p?.inlineData?.data;
      if (data && !this.muted) {
        this.on.status("speaking");
        this.player.enqueue(base64ToInt16(data));
      }
      // When muted (text mode) we drop the audio; the reply still surfaces as text
      // via outputAudioTranscription above.
      if (p?.text) this.on.assistantText(p.text);
    }

    if (sc.turnComplete) {
      this._inBuf = "";
      this._outBuf = "";
      this.on.status("listening");
    }
  }

  async _handleToolCalls(calls) {
    const responses = [];
    // Images a tool handed back (e.g. the screen connector). A tool's text
    // response can't carry a picture the model can SEE, so we acknowledge the
    // call with a short string and inject the image(s) as session content turns
    // AFTER sending the tool responses (the call must be closed first).
    const pendingImages = [];
    for (const fc of calls) {
      this.on.tool(fc.name, fc.args, "running");
      let out;
      const local = this._localByName.get(fc.name);
      if (local) {
        try { out = { result: await local.handler(fc.args || {}) }; }
        catch (e) { out = { error: String(e?.message || e) }; }
      } else if (this.toolBridge) {
        out = await this.toolBridge.call(fc.name, fc.args || {});
      } else {
        out = { error: "no tool bridge" };
      }
      // Client-action: a tool result carrying a `play` directive is handled in the
      // orb (audio playback). The model only ever sees the human-friendly `speak`
      // line, never the stream URLs.
      if (!out.error && typeof out.result === "string") {
        let directive;
        try { directive = JSON.parse(out.result); } catch { /* normal string result */ }
        if (directive && directive.play) {
          try { this.on.play(directive.play); } catch (e) { this.on.error("play: " + (e?.message || e)); }
          out = { result: directive.speak || "Done." };
        }
      }
      // Vision: a tool can hand back an image for the model to SEE. Stash it and
      // replace the response with a short ack — the base64 never goes to the model
      // as a tool result (it'd be unreadable + huge); it's injected as content below.
      if (!out.error && out.image && out.image.data) {
        pendingImages.push(out.image);
        out = { result: (typeof out.result === "string" && out.result) || "Captured — viewing it now." };
      }
      this.on.tool(fc.name, fc.args, out.error ? "error" : "done", out.error || out.result);
      responses.push({ id: fc.id, name: fc.name, response: clampToolResponse(out) });
    }
    try {
      this.session?.sendToolResponse({ functionResponses: responses });
    } catch (e) {
      this.on.error("sendToolResponse: " + (e?.message || e));
    }
    // Now deliver any captured images as user content turns so the model sees them
    // and continues the operator's request (describe / read / act on the screen).
    for (const img of pendingImages) {
      this._sendImageTurn(img, "Here is the screen capture you requested. Look at it and continue with what the operator asked.");
    }
  }

  // Live 0..1 level of the TTS output bus — drives the orb while speaking.
  getOutputLevel() {
    try { return this.player ? this.player.getLevel() : 0; } catch { return 0; }
  }

  sendText(text) {
    if (!text || !this.session) return;
    this.on.userText(text);
    try { this.session.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: true }); }
    catch (e) { this.on.error("sendText: " + (e?.message || e)); }
  }

  // Inject a system/proactive event so the model speaks on its own (timer fired,
  // background job done). Unlike sendText it is NOT echoed as a user message.
  sendEvent(text) {
    if (!text || !this.session) return;
    try { this.session.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: true }); }
    catch (e) { this.on.error("sendEvent: " + (e?.message || e)); }
  }

  // Inject an image (e.g. a screenshot from the screen connector) as a user
  // content turn so the model can SEE it. Gemini Live takes images as inlineData
  // parts; this is how vision reaches the model (tool text results cannot).
  _sendImageTurn(image, text) {
    if (!this.session || !image || !image.data) return;
    const parts = [{ inlineData: { mimeType: image.mimeType || "image/jpeg", data: image.data } }];
    if (text) parts.push({ text });
    try { this.session.sendClientContent({ turns: [{ role: "user", parts }], turnComplete: true }); }
    catch (e) { this.on.error("sendImageTurn: " + (e?.message || e)); }
  }

  get isLive() {
    return !!this.session && this.active;
  }

  // Text mode: drop spoken audio (reply still shows as text). Stops any in-flight
  // playback when switching to muted.
  setMuted(b) {
    this.muted = !!b;
    if (this.muted) { try { this.player.stop(); } catch {} }
  }

  // Push-to-talk: gate whether captured mic audio is streamed to the model.
  // true = hold the operator's audio (don't send); false = send live.
  setMicMuted(b) {
    this.micMuted = !!b;
  }

  stop() {
    this.active = false;
    try { this.mic && this.mic.stop(); } catch {}
    try { this.player.stop(); } catch {}
    try { this.session && this.session.close(); } catch {}
    this.mic = null;
    this.session = null;
    this.on.status("offline");
  }
}

function describeLiveError(err) {
  if (!err) return "Unknown Gemini Live error";
  if (typeof err === "string") return err;
  const bits = [];
  if (err.name) bits.push(err.name);
  if (err.message) bits.push(err.message);
  if (err.code) bits.push(`code ${err.code}`);
  if (err.reason) bits.push(err.reason);
  return bits.length ? bits.join(": ") : String(err);
}
