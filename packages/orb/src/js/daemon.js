// Local daemon provider — browser → a local voice daemon over WebSocket.
//
// "Bring your own daemon": this speaks a simple WS protocol (stream 16 kHz int16
// PCM between {ptt.start}/{ptt.stop} envelopes; the daemon does STT + a model +
// TTS and streams raw PCM back). It is push-to-talk / turn-based, so enable
// Push-to-talk in Settings when using this provider. Nothing runs by default —
// point `daemonUrl` at your own daemon. Free + offline if your daemon is.
//
// Implements the orb session interface: the orb's mic-gating (setMicMuted) maps
// to the daemon's PTT turns (talkStart/talkStop).

import { MicCapture, PcmPlayer } from "./audio.js";

const DEFAULT_URL = "ws://127.0.0.1:7142/voxa";
const DAEMON_TTS_RATE = 22050;

export class DaemonSession {
  constructor({ on, daemonUrl } = {}) {
    this.on = Object.assign(
      { status: () => {}, userText: () => {}, assistantText: () => {}, error: () => {} },
      on || {}
    );
    this.url = daemonUrl || DEFAULT_URL;
    this.provider = "daemon";
    this.mode = "ptt";
    this.ws = null; this.mic = null;
    this.player = new PcmPlayer(DAEMON_TTS_RATE);
    this.active = false; this.talking = false;
    this._assistant = ""; this._speaking = false;
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.on.status("connecting");
    try { this.ws = new WebSocket(this.url); }
    catch { this.on.error("Daemon offline at " + this.url); this.active = false; return; }
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => this.on.status("listening", "Ready");
    this.ws.onmessage = (ev) => { if (typeof ev.data === "string") this._envelope(ev.data); else this._binaryAudio(ev.data); };
    this.ws.onerror = () => {};
    this.ws.onclose = () => { if (this.active) this.on.status("offline", "Daemon disconnected"); };
  }

  stop() {
    this.active = false;
    this.talkStop();
    try { this.player.stop(); } catch {}
    try { this.ws && this.ws.close(); } catch {}
    this.ws = null;
    this.on.status("offline");
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(obj)); return true;
  }

  async talkStart() {
    if (this.talking || !this.active) return;
    this.talking = true;
    this.on.status("listening", "Listening…");
    if (!this._send({ type: "ptt.start" })) { this.talking = false; return; }
    this.mic = new MicCapture({
      onFrame: (pcm) => { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(pcm.buffer); },
      onLevel: (lvl) => this.on.status(undefined, undefined, lvl),
    });
    try { await this.mic.start(); }
    catch (e) { this.on.error("Mic: " + (e?.message || e)); this._send({ type: "ptt.stop" }); this.talkStop(); }
  }

  talkStop() {
    if (!this.talking) { try { this.mic && this.mic.stop(); } catch {} this.mic = null; return; }
    this.talking = false;
    try { this.mic && this.mic.stop(); } catch {}
    this.mic = null;
    this._send({ type: "ptt.stop" });
    this.on.status("thinking", "Thinking…");
  }

  sendText(text) {
    if (!text) return;
    this.on.userText(text);
    if (this._send({ type: "chat", text })) this.on.status("thinking", "Thinking…");
  }

  _envelope(json) {
    let msg; try { msg = JSON.parse(json); } catch { return; }
    switch (msg.type) {
      case "status":       this.on.status(msg.state, msg.label || msg.state); break;
      case "stt.partial":  this.on.userText(msg.text || "…"); break;
      case "stt.final":    this.on.userText(msg.text || ""); break;
      case "assistant.delta": this._assistant += msg.text || ""; this.on.assistantText(this._assistant); break;
      case "assistant.done":  this._assistant = ""; break;
      case "tts.start": this.player.setSampleRate(msg.sampleRate || DAEMON_TTS_RATE); this.player.firstFrame = true; this._speaking = true; this.on.status("speaking", "Speaking…"); break;
      case "tts.end":   this._speaking = false; this.on.status("listening", "Ready"); break;
      case "error":     this.on.error(msg.message || "daemon error"); break;
    }
  }

  _binaryAudio(data) {
    const ab = data instanceof ArrayBuffer ? data : data?.buffer;
    if (!ab || ab.byteLength < 2) return;
    const usable = ab.byteLength - (ab.byteLength % 2);
    this.player.enqueue(new Int16Array(ab, 0, usable / 2));
  }

  // ── orb-compat shims (GeminiSession parity) ───────────────────────────────
  get isLive() { return this.active && !!this.ws && this.ws.readyState === WebSocket.OPEN; }
  getOutputLevel() { return this._speaking ? 0.6 : 0; }
  // The orb gates the mic via setMicMuted; for the PTT daemon that maps to a turn:
  // unmuted → start a turn (talkStart), muted → end it (talkStop).
  setMicMuted(b) { if (b) this.talkStop(); else this.talkStart(); }
  setMuted(b) { this.setMicMuted(b); }
  setAudioParams() {}
  setMicDevice() {}
  sendEvent() {}
}
