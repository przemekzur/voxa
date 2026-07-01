// Shared audio primitives for the realtime-voice spike.
//
//   MicCapture  — getUserMedia → 16 kHz mono int16 PCM frames + RMS level.
//   PcmPlayer   — gapless low-latency scheduler for raw int16 PCM at an
//                 arbitrary sample rate, with stop() for barge-in.
//
// Both are provider/topology agnostic so the Gemini-direct and daemon
// adapters can share them. No build step, no deps.

const TARGET_SAMPLE_RATE = 16000;

export class MicCapture {
  // onFrame: (Int16Array) => void   — 16 kHz mono PCM frames
  // onLevel: (rms: number) => void  — 0..1, for the waveform/orb meter
  // deviceId: optional audioinput id from enumerateDevices()
  constructor({ onFrame, onLevel, deviceId, gain, noiseSuppression, autoGainControl, echoCancellation } = {}) {
    this.onFrame = onFrame || (() => {});
    this.onLevel = onLevel || (() => {});
    this.deviceId = deviceId || null;
    // Mic tuning (experiment from the orb settings). gain is a software make-up
    // multiplier applied to the captured signal; the constraints toggle the
    // browser's WebRTC processing (NS in particular can gate soft speech).
    this.gain = Number.isFinite(gain) ? gain : 1;
    this.noiseSuppression = noiseSuppression !== false; // default on
    this.autoGainControl = autoGainControl !== false;   // default on
    this.echoCancellation = echoCancellation !== false; // default on (don't hear ourselves)
    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.processor = null;
    this._tail = new Float32Array(0);
    this.active = false;
  }

  async start() {
    if (this.active) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: this.echoCancellation,
        noiseSuppression: this.noiseSuppression,
        autoGainControl: this.autoGainControl,
        ...(this.deviceId ? { deviceId: { exact: this.deviceId } } : {}),
      },
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.source = this.ctx.createMediaStreamSource(this.stream);
    // ScriptProcessor is deprecated but zero-dependency and battle-tested in
    // this repo (see voxa.js). AudioWorklet is the eventual upgrade.
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    this._tail = new Float32Array(0);
    this.active = true;

    this.processor.onaudioprocess = (ev) => {
      if (!this.active) return;
      const input = ev.inputBuffer.getChannelData(0);
      const ds = this._downsample(input, this.ctx.sampleRate);
      // Apply software make-up gain to the signal we actually send. floatToInt16
      // hard-clamps to [-1,1], so over-gain clips rather than wraps.
      if (this.gain !== 1) { for (let i = 0; i < ds.length; i++) ds[i] *= this.gain; }
      this.onLevel(rms(ds)); // post-gain level so the meter reflects what Gemini gets
      const pcm = floatToInt16(ds);
      if (pcm.length) this.onFrame(pcm);
    };

    this.source.connect(this.processor);
    this.processor.connect(this.ctx.destination); // required for the node to fire
  }

  // Live make-up gain change — no getUserMedia restart needed.
  setGain(g) { this.gain = Number.isFinite(g) ? g : 1; }

  stop() {
    this.active = false;
    try { this.processor && this.processor.disconnect(); } catch {}
    try { this.source && this.source.disconnect(); } catch {}
    try { this.stream && this.stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { this.ctx && this.ctx.close(); } catch {}
    this.processor = this.source = this.stream = this.ctx = null;
    this._tail = new Float32Array(0);
    this.onLevel(0);
  }

  // Block-average downsample to 16 kHz, carrying a tail across callbacks so we
  // don't drift. Whisper/Gemini are forgiving on anti-aliasing for speech.
  _downsample(float32, inRate) {
    if (inRate === TARGET_SAMPLE_RATE) return float32;
    const ratio = inRate / TARGET_SAMPLE_RATE;
    const merged = new Float32Array(this._tail.length + float32.length);
    merged.set(this._tail, 0);
    merged.set(float32, this._tail.length);
    const outLen = Math.floor(merged.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(merged.length, Math.floor((i + 1) * ratio));
      let sum = 0, n = 0;
      for (let j = start; j < end; j++) { sum += merged[j]; n++; }
      out[i] = n > 0 ? sum / n : 0;
    }
    const consumed = Math.floor(outLen * ratio);
    this._tail = merged.slice(consumed);
    return out;
  }
}

export class PcmPlayer {
  // sampleRate: output PCM rate (Gemini = 24000, daemon Piper = 22050).
  constructor(sampleRate = 24000) {
    this.sampleRate = sampleRate;
    this.ctx = null;
    this.nextStart = 0;
    this.firstFrame = true;
    this.sources = [];
    // Analyser tap on the output bus so callers can read a live TTS level
    // (drives the orb's audio-reactivity while speaking). Lazily created with
    // the AudioContext; sources connect through it instead of straight to dest.
    this.analyser = null;
    this._tap = new Uint8Array(0);
  }

  _ensureCtx() {
    if (!this.ctx || this.ctx.state === "closed") {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.6;
      this.analyser.connect(this.ctx.destination);
      this._tap = new Uint8Array(this.analyser.frequencyBinCount);
    }
    if (this.ctx.state === "suspended") { try { this.ctx.resume(); } catch {} }
    return this.ctx;
  }

  // 0..1 RMS of whatever is currently playing — 0 when idle/silent. Reading is
  // cheap; safe to call every animation frame.
  getLevel() {
    if (!this.analyser || !this.sources.length) return 0;
    this.analyser.getByteTimeDomainData(this._tap);
    let sum = 0;
    for (let i = 0; i < this._tap.length; i++) {
      const v = (this._tap[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / this._tap.length);
  }

  setSampleRate(rate) { this.sampleRate = rate; }

  // int16: Int16Array of mono PCM at this.sampleRate.
  enqueue(int16) {
    if (!int16 || !int16.length) return;
    const ctx = this._ensureCtx();
    const buf = ctx.createBuffer(1, int16.length, this.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < int16.length; i++) ch[i] = int16[i] / 0x8000;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.analyser || ctx.destination);

    let startAt;
    if (this.firstFrame) {
      startAt = ctx.currentTime + 0.03;   // small lead so the source fires
      this.firstFrame = false;
    } else if (this.nextStart < ctx.currentTime) {
      startAt = ctx.currentTime + 0.01;   // underrun recovery
    } else {
      startAt = this.nextStart;
    }
    src.start(startAt);
    this.nextStart = startAt + buf.duration;
    this.sources.push(src);
    src.onended = () => {
      const i = this.sources.indexOf(src);
      if (i >= 0) this.sources.splice(i, 1);
    };
  }

  // Barge-in: kill everything currently scheduled.
  stop() {
    for (const s of this.sources.splice(0)) {
      try { s.stop(); } catch {}
      try { s.disconnect(); } catch {}
    }
    this.firstFrame = true;
    if (this.ctx) this.nextStart = this.ctx.currentTime;
  }

  get playing() { return this.sources.length > 0; }
}

// ---- helpers ----

export function rms(buf) {
  if (!buf || !buf.length) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

export function floatToInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    let s = float32[i];
    if (s > 1) s = 1; else if (s < -1) s = -1;
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function int16ToBase64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToInt16(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // PCM16 LE — reinterpret. Handle odd byte length defensively.
  const usable = bytes.byteLength - (bytes.byteLength % 2);
  return new Int16Array(bytes.buffer, 0, usable / 2);
}
