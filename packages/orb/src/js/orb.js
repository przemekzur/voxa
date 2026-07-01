// Holographic VOXA orb — pure canvas 2D, now skin + palette driven.
//
// A luminous core, rotating wireframe sphere, orbiting particles, audio-reactive
// rings and a breathing glow — all additively blended. The PALETTE recolours
// every layer; the SKIN swaps the ornament style (orbit rings / docked halo /
// arc-reactor / lens iris / HUD brackets / minimal / image-art). Both switch live.
//
// Voice states drive intensity: idle (calm), connecting (dim scan), listening
// (cyan/accent, mic-reactive), speaking (core, TTS-reactive).
//
// API: createOrb(canvas) -> { setOrbState, setAudioLevel, setSkin, setPalette }.

import { getSkin, getPalette, DEFAULT_SKIN, DEFAULT_PALETTE } from "./skins.js";

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mix = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

// Crystal-cage skin geometry: a unit icosahedron (12 verts, 30 edges) caging an
// octahedron core. Constant, so computed once at module load.
const ICOSA_V = (() => {
  const P = (1 + Math.sqrt(5)) / 2;
  const v = [[-1, P, 0], [1, P, 0], [-1, -P, 0], [1, -P, 0], [0, -1, P], [0, 1, P], [0, -1, -P], [0, 1, -P], [P, 0, -1], [P, 0, 1], [-P, 0, -1], [-P, 0, 1]];
  return v.map((p) => { const l = Math.hypot(p[0], p[1], p[2]); return [p[0] / l, p[1] / l, p[2] / l]; });
})();
const ICOSA_E = [[0, 1], [0, 5], [0, 7], [0, 10], [0, 11], [1, 5], [1, 7], [1, 8], [1, 9], [2, 3], [2, 4], [2, 6], [2, 10], [2, 11], [3, 4], [3, 6], [3, 8], [3, 9], [4, 5], [4, 9], [4, 11], [5, 9], [5, 11], [6, 7], [6, 8], [6, 10], [7, 8], [7, 10], [8, 9], [10, 11]];
const OCTA_V = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const OCTA_F = [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]];
const rot3 = (p, ax, ay) => {
  let x = p[0], y = p[1], z = p[2];
  const c = Math.cos(ay), s = Math.sin(ay); const x1 = x * c + z * s, z1 = -x * s + z * c;
  const c2 = Math.cos(ax), s2 = Math.sin(ax); const y1 = y * c2 - z1 * s2, z2 = y * s2 + z1 * c2;
  return [x1, y1, z2];
};

export function createOrb(canvas) {
  const ctx = canvas.getContext("2d");

  let W = 0, H = 0;
  let dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));

  function resize() {
    const r = canvas.getBoundingClientRect();
    W = Math.max(40, r.width);
    H = Math.max(40, r.height);
    dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  // ---- skin + palette state ----
  let pal = getPalette(DEFAULT_PALETTE);
  let skin = getSkin(DEFAULT_SKIN);
  let skinImg = null; // HTMLImageElement for image skins (lazy-loaded)

  function setPalette(id) { pal = getPalette(id); }
  function setSkin(id) {
    skin = getSkin(id);
    skinImg = null;
    if (skin.sphere === "image" && skin.image) {
      const img = new Image();
      img.onload = () => { if (skin.image && img.src.endsWith(skin.image.split("/").pop())) skinImg = img; };
      img.src = skin.image;
    }
  }

  // ---- particles ---- (colour resolved from palette at draw time)
  const PARTICLES = 46;
  const particles = [];
  for (let i = 0; i < PARTICLES; i++) {
    particles.push({
      a: Math.random() * Math.PI * 2,
      rr: 0.55 + Math.random() * 0.72,
      tilt: 0.18 + Math.random() * 0.5,
      speed: (0.12 + Math.random() * 0.5) * (Math.random() < 0.5 ? 1 : -1),
      size: 0.6 + Math.random() * 1.8,
      accent: Math.random() < 0.2, // true -> palette accent, else core
      phase: Math.random() * Math.PI * 2,
    });
  }
  const handoffDust = [];
  for (let i = 0; i < 118; i++) {
    handoffDust.push({
      a: Math.random() * Math.PI * 2,
      lane: 0.62 + Math.random() * 1.42,
      y: (Math.random() - 0.5) * 1.15,
      speed: (0.08 + Math.random() * 0.42) * (Math.random() < 0.5 ? -1 : 1),
      drift: Math.random() * Math.PI * 2,
      size: 0.35 + Math.random() * 1.35,
      cyan: Math.random() < 0.13,
    });
  }

  // ---- state ----
  let state = "idle";
  let energy = 0, level = 0, smoothLevel = 0;
  // ── Spin: ONE knob, BOUNDED ────────────────────────────────────────────────
  // The angle ACCUMULATES (spin += rate*dt), so it never grows with runtime and
  // can't lurch on a state change. Speed = idle + boost*energy (energy: 0 idle /
  // 0.4 connecting / 1 active). No audio term -> repeatable. Hard-bounded to
  // [SPIN_IDLE, SPIN_IDLE+SPIN_BOOST] rad/s — it can never spin out of control.
  let spin = 0;
  const SPIN_IDLE = 0.45;   // resting spin (rad/s, ~14s / full turn)
  const SPIN_BOOST = 1.10;  // added when listening/speaking (-> 1.55 rad/s, ~4s/turn)
  const SPIN_RAMP = 6;      // transition ease toward idle/active (higher = snappier, ~0.5s)
  const spinRate = () => SPIN_IDLE + SPIN_BOOST * energy;

  function setAudioLevel(v) { level = Math.max(0, Math.min(1, Number(v) || 0)); }
  function setOrbState(next) { if (["idle", "connecting", "listening", "speaking"].includes(next)) state = next; }

  // ---- shared layers ----
  function drawGlow(cx, cy, R, breath) {
    const g = ctx.createRadialGradient(cx, cy, R * 0.15, cx, cy, R * (1.28 + 0.1 * breath));
    g.addColorStop(0, rgba(pal.core, 0.32 + 0.14 * energy + 0.2 * smoothLevel));
    g.addColorStop(0.45, rgba(pal.core, 0.10 + 0.05 * energy));
    g.addColorStop(1, rgba(pal.core, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.42, 0, Math.PI * 2); ctx.fill();
  }

  function drawSphereBody(cx, cy, R, soft) {
    const hy = cy - R * 0.14;
    const midDeep = mix(pal.core, pal.deep, 0.5);
    const g = ctx.createRadialGradient(cx, hy, R * 0.04, cx, cy, R);
    g.addColorStop(0, rgba(pal.hot, (soft ? 0.5 : 0.62) + 0.12 * energy + 0.12 * smoothLevel));
    g.addColorStop(0.32, rgba(pal.core, soft ? 0.3 : 0.42));
    g.addColorStop(0.7, rgba(midDeep, soft ? 0.16 : 0.24));
    g.addColorStop(1, rgba(pal.deep, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
  }

  // Image-art body: the embedded render, clipped to the core disc + tinted glow.
  function drawImageBody(cx, cy, R) {
    if (!skinImg) { drawSphereBody(cx, cy, R, true); return; }
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
    const iw = skinImg.naturalWidth || 1, ih = skinImg.naturalHeight || 1;
    // focus {x,y} (0..1) is the point in the image to centre on the disc; zoom
    // scales it in. Lets us land the disc on the orb in a full UI render.
    const fx = skin.focus?.x ?? 0.5, fy = skin.focus?.y ?? 0.5;
    const zoom = skin.zoom || 1;
    const d = R * 2 * (1 + 0.16 * smoothLevel); // gentle breathe with audio
    const base = Math.max(d / iw, d / ih) * zoom;
    const dw = iw * base, dh = ih * base;
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 0.95;
    ctx.drawImage(skinImg, cx - dw * fx, cy - dh * fy, dw, dh);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "lighter";
    // tint wash so it picks up the active palette
    const g = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R);
    g.addColorStop(0, rgba(pal.hot, 0.10)); g.addColorStop(0.7, rgba(pal.core, 0.10)); g.addColorStop(1, rgba(pal.deep, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function drawSphere(cx, cy, R, rot) {
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
    ctx.lineWidth = 1;
    const M = 6;
    for (let k = 0; k < M; k++) {
      const phi = rot + (k * Math.PI) / M;
      const rx = Math.abs(Math.cos(phi)) * R;
      ctx.strokeStyle = rgba(pal.line, 0.07 + 0.12 * (rx / R) + 0.06 * energy);
      ctx.beginPath(); ctx.ellipse(cx, cy, Math.max(0.5, rx), R, 0, 0, Math.PI * 2); ctx.stroke();
    }
    const P = 6;
    for (let k = 1; k < P; k++) {
      const lat = (k / P) * Math.PI - Math.PI / 2;
      const ry = Math.cos(lat) * R, y = Math.sin(lat) * R;
      ctx.strokeStyle = rgba(pal.line, 0.05 + 0.09 * Math.cos(lat) + 0.04 * energy);
      ctx.beginPath(); ctx.ellipse(cx, cy + y, ry, ry * 0.32, 0, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = rgba(pal.line, 0.12 + 0.08 * energy);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  }

  function drawParticles(cx, cy, R, t) {
    const pulse = 1 + 0.18 * smoothLevel * (state === "speaking" ? 1.4 : 1);
    for (const p of particles) {
      p.a += p.speed * (0.006 + 0.012 * energy + 0.02 * smoothLevel);
      const rr = p.rr * R * pulse;
      const z = Math.sin(p.a) * rr * p.tilt;
      const depth = (Math.sin(p.a) + 1) / 2;
      const px = cx + Math.cos(p.a) * rr, py = cy + z;
      const tw = 0.6 + 0.4 * Math.sin(t * 2 + p.phase);
      const size = p.size * (0.5 + depth) * (1 + 0.4 * energy + 0.5 * smoothLevel);
      const alpha = (0.1 + 0.45 * depth) * tw;
      const col = p.accent ? pal.accent : pal.core;
      const g = ctx.createRadialGradient(px, py, 0, px, py, size * 3);
      g.addColorStop(0, rgba(col, alpha)); g.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(px, py, size * 3, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ---- ornaments (skin-specific) ----
  const ORBITS = [
    { rx: 1.14, tilt: -0.34, squish: 0.34, speed: 0.32, dots: 2, phase: 0.0 },
    { rx: 1.32, tilt: 0.2, squish: 0.28, speed: -0.22, dots: 2, phase: 1.4 },
  ];
  function drawOrbitRings(cx, cy, R, t) {
    for (const o of ORBITS) {
      const rx = R * o.rx, ry = rx * o.squish;
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(o.tilt);
      ctx.strokeStyle = rgba(pal.core, 0.1 + 0.05 * energy); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
      for (let d = 0; d < o.dots; d++) {
        const a = t * o.speed + o.phase + (d * Math.PI * 2) / o.dots;
        const x = Math.cos(a) * rx, y = Math.sin(a) * ry;
        const depth = (Math.sin(a) + 1) / 2, sz = 1.2 + 1.8 * depth;
        const col = d % 2 === 0 ? pal.core : pal.accent;
        const al = (0.45 + 0.55 * depth) * (0.7 + 0.5 * energy);
        const g = ctx.createRadialGradient(x, y, 0, x, y, sz * 3.5);
        g.addColorStop(0, rgba(col, al)); g.addColorStop(1, rgba(col, 0));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, sz * 3.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = rgba(pal.white, al);
        ctx.beginPath(); ctx.arc(x, y, Math.max(0.6, sz * 0.6), 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
  }

  // Docked Halo (Concept 1): one bold tilted ring with a bright travelling arc.
  function drawHalo(cx, cy, R, t) {
    const rx = R * 1.34, ry = rx * 0.3, tilt = -0.22;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(tilt);
    ctx.strokeStyle = rgba(pal.core, 0.22 + 0.12 * energy + 0.4 * smoothLevel);
    ctx.lineWidth = 2.2 + 3 * smoothLevel; // ring swells with the voice
    ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = rgba(pal.white, 0.12 + 0.2 * smoothLevel); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(0, 0, rx * 0.86, ry * 0.86, 0, 0, Math.PI * 2); ctx.stroke();
    const a = t * (0.5 + 1.4 * smoothLevel); // glint races on speech
    const x = Math.cos(a) * rx, y = Math.sin(a) * ry, sz = 3.4 + 5 * smoothLevel;
    const g = ctx.createRadialGradient(x, y, 0, x, y, sz * 3);
    g.addColorStop(0, rgba(pal.white, 0.95)); g.addColorStop(0.4, rgba(pal.core, 0.7)); g.addColorStop(1, rgba(pal.core, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, sz * 3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // Arc Reactor (Concept 7): concentric segmented rings counter-rotating.
  function drawReactor(cx, cy, R, t) {
    const rings = [
      { r: 1.12, seg: 12, gap: 0.34, sp: 0.5, w: 3 },
      { r: 1.34, seg: 18, gap: 0.22, sp: -0.32, w: 2 },
      { r: 1.52, seg: 24, gap: 0.16, sp: 0.2, w: 1.4 },
    ];
    for (const rg of rings) {
      const rr = R * rg.r * (1 + 0.12 * smoothLevel); // rings pulse outward with voice
      const step = (Math.PI * 2) / rg.seg;
      const arc = step * (1 - rg.gap);
      ctx.strokeStyle = rgba(pal.core, 0.3 + 0.22 * energy + 0.4 * smoothLevel);
      ctx.lineWidth = rg.w + 1.5 * smoothLevel;
      ctx.lineCap = "round";
      for (let i = 0; i < rg.seg; i++) {
        const a0 = t * rg.sp * (1 + 1.2 * smoothLevel) + i * step; // spin up on speech
        ctx.beginPath(); ctx.arc(cx, cy, rr, a0, a0 + arc); ctx.stroke();
      }
    }
    ctx.lineCap = "butt";
  }

  function drawSpectrumRings(cx, cy, R, t) {
    const voice = Math.max(smoothLevel, state === "speaking" || state === "listening" ? 0.12 : 0);
    const nodeCount = 22;
    const nodes = [];
    const glow = ctx.createRadialGradient(cx, cy, R * 0.05, cx, cy, R * (1.55 + 0.08 * voice));
    glow.addColorStop(0, rgba(pal.white, 0.24 + 0.18 * voice));
    glow.addColorStop(0.36, rgba(pal.core, 0.14 + 0.12 * energy));
    glow.addColorStop(0.72, rgba(pal.accent, 0.05 + 0.06 * voice));
    glow.addColorStop(1, rgba(pal.deep, 0));
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(cx, cy, R * (1.72 + 0.08 * voice), 0, Math.PI * 2); ctx.fill();

    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.04, 0, Math.PI * 2); ctx.clip();
    for (let i = 0; i < nodeCount; i++) {
      const p = i / nodeCount;
      const a = p * Math.PI * 2 + t * (0.08 + 0.05 * (i % 3)) + Math.sin(t * 0.7 + i) * 0.08;
      const lane = R * (0.24 + 0.7 * ((i * 37) % 100) / 100);
      const x = cx + Math.cos(a) * lane;
      const y = cy + Math.sin(a) * lane * (0.74 + 0.18 * Math.sin(i));
      nodes.push([x, y, i]);
    }
    ctx.lineWidth = 0.65 + 0.45 * voice;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i][0] - nodes[j][0], dy = nodes[i][1] - nodes[j][1];
        const d = Math.hypot(dx, dy);
        if (d > R * 0.55) continue;
        const a = (1 - d / (R * 0.55)) * (0.08 + 0.22 * voice);
        ctx.strokeStyle = rgba((i + j) % 4 === 0 ? pal.accent : pal.line, a);
        ctx.beginPath(); ctx.moveTo(nodes[i][0], nodes[i][1]); ctx.lineTo(nodes[j][0], nodes[j][1]); ctx.stroke();
      }
    }
    for (const [x, y, i] of nodes) {
      const pulse = 0.65 + 0.35 * Math.sin(t * 4 + i * 1.7);
      const col = i % 5 === 0 ? pal.accent : pal.core;
      const sz = R * (0.018 + 0.018 * pulse + 0.022 * voice * (i % 4 === 0 ? 1 : 0.3));
      const g = ctx.createRadialGradient(x, y, 0, x, y, sz * 4.2);
      g.addColorStop(0, rgba(pal.white, 0.82));
      g.addColorStop(0.28, rgba(col, 0.55 + 0.35 * voice));
      g.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, sz * 4.2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    ctx.lineCap = "round";
    for (let k = 0; k < 4; k++) {
      const rr = R * (1.04 + k * 0.18 + 0.04 * voice * Math.sin(t * 2 + k));
      const seg = 36 + k * 14;
      const step = Math.PI * 2 / seg;
      const arc = step * (0.24 + 0.08 * Math.sin(t + k));
      ctx.lineWidth = 0.7 + 0.55 * voice;
      ctx.strokeStyle = rgba(k % 2 ? pal.accent : pal.core, 0.11 + 0.2 * voice + 0.08 * energy);
      for (let i = 0; i < seg; i += 2) {
        const a0 = i * step + t * (k % 2 ? -0.13 : 0.18) * (1 + voice);
        ctx.beginPath(); ctx.arc(cx, cy, rr, a0, a0 + arc); ctx.stroke();
      }
    }
    ctx.lineCap = "butt";
  }

  function drawHandoffSkin(cx, cy, R, t, breath, rot) {
    const voice = Math.max(smoothLevel, state === "speaking" || state === "listening" ? 0.18 : 0);
    const listen = state === "listening" ? 1 : 0;
    const speak = state === "speaking" ? 1 : 0;
    const hot = mix(pal.hot, pal.white, 0.28 + 0.25 * voice);
    const corona = ctx.createRadialGradient(cx, cy, R * 0.06, cx, cy, R * (1.42 + 0.12 * voice));
    corona.addColorStop(0, rgba(pal.white, 0.28 + 0.22 * voice));
    corona.addColorStop(0.22, rgba(hot, 0.18 + 0.28 * speak));
    corona.addColorStop(0.62, rgba(pal.core, 0.05 + 0.1 * energy));
    corona.addColorStop(1, rgba(pal.deep, 0));
    ctx.fillStyle = corona;
    ctx.beginPath(); ctx.arc(cx, cy, R * (1.56 + 0.12 * voice), 0, Math.PI * 2); ctx.fill();

    const shell = ctx.createRadialGradient(cx - R * 0.2, cy - R * 0.24, R * 0.08, cx, cy, R * 1.08);
    shell.addColorStop(0, rgba(pal.white, 0.85));
    shell.addColorStop(0.18, rgba(pal.hot, 0.62 + 0.18 * voice));
    shell.addColorStop(0.48, rgba(pal.core, 0.28 + 0.12 * speak));
    shell.addColorStop(0.78, rgba(pal.deep, 0.18));
    shell.addColorStop(1, rgba(pal.deep, 0));
    ctx.fillStyle = shell;
    ctx.beginPath(); ctx.arc(cx, cy, R * (0.98 + 0.04 * breath + 0.06 * voice), 0, Math.PI * 2); ctx.fill();

    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.02, 0, Math.PI * 2); ctx.clip();
    ctx.lineCap = "round";
    for (let i = 0; i < 18; i++) {
      const a = rot * (1.8 + 0.7 * voice) + i * 0.93;
      const r1 = R * (0.18 + 0.025 * (i % 5));
      const r2 = R * (0.88 - 0.02 * (i % 4));
      const wob = Math.sin(t * 2.4 + i * 1.7) * R * (0.07 + 0.08 * voice);
      const x1 = cx + Math.cos(a) * r1;
      const y1 = cy + Math.sin(a * 0.8) * r1;
      const x2 = cx + Math.cos(a + 0.72 + voice) * r2;
      const y2 = cy + Math.sin(a + 0.72) * r2 * 0.72;
      const grd = ctx.createLinearGradient(x1, y1, x2, y2);
      grd.addColorStop(0, rgba(pal.white, 0));
      grd.addColorStop(0.42, rgba(i % 4 === 0 ? pal.accent : pal.hot, 0.12 + 0.34 * voice));
      grd.addColorStop(1, rgba(pal.core, 0));
      ctx.strokeStyle = grd;
      ctx.lineWidth = R * (0.012 + 0.012 * voice);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.bezierCurveTo(cx + Math.cos(a + 1.1) * R * 0.56, cy + wob, cx - wob, cy + Math.sin(a - 0.4) * R * 0.48, x2, y2);
      ctx.stroke();
    }
    ctx.restore();

    const ringSet = [
      { r: 0.76, n: 42, gap: 0.68, sp: 0.36, w: 0.8, col: pal.hot },
      { r: 0.98, n: 54, gap: 0.76, sp: -0.2, w: 0.7, col: pal.line },
      { r: 1.18, n: 32, gap: 0.34, sp: 0.28, w: 1.3, col: pal.core },
      { r: 1.38, n: 74, gap: 0.84, sp: -0.13, w: 0.55, col: pal.line },
      { r: 1.62, n: 22, gap: 0.42, sp: 0.1, w: 0.9, col: pal.core },
      { r: 1.86, n: 96, gap: 0.9, sp: -0.055, w: 0.45, col: pal.core },
    ];
    ctx.lineCap = "round";
    for (const rg of ringSet) {
      const rr = R * rg.r * (1 + 0.08 * voice * Math.sin(t * 3 + rg.r));
      const step = Math.PI * 2 / rg.n;
      const span = step * (1 - rg.gap);
      ctx.strokeStyle = rgba(rg.col, 0.12 + 0.18 * energy + 0.38 * voice * (rg.r < 1.3 ? 1 : 0.65));
      ctx.lineWidth = rg.w + 1.2 * voice * (rg.r < 1.25 ? 1 : 0.35);
      for (let i = 0; i < rg.n; i++) {
        const noise = Math.sin(i * 2.31 + t * 2.2) * 0.018;
        const a0 = i * step + t * rg.sp * (1 + voice * 1.8) + noise;
        ctx.beginPath(); ctx.arc(cx, cy, rr, a0, a0 + span); ctx.stroke();
      }
    }

    for (let i = 0; i < handoffDust.length; i++) {
      const p = handoffDust[i];
      p.a += p.speed * (0.004 + 0.012 * voice + 0.008 * energy);
      const lane = R * p.lane * (1 + 0.08 * Math.sin(t * 1.7 + p.drift));
      const x = cx + Math.cos(p.a) * lane;
      const y = cy + p.y * R + Math.sin(p.a * 1.7 + p.drift) * R * 0.11;
      const field = Math.hypot((x - cx) / (R * 1.74), (y - cy) / (R * 1.24));
      const fade = Math.max(0, 1 - Math.pow(field, 2.4));
      if (fade <= 0.015) continue;
      const depth = 0.45 + 0.55 * (Math.sin(p.a + p.drift) * 0.5 + 0.5);
      const col = p.cyan || listen && i % 7 === 0 ? pal.accent : pal.core;
      const sz = p.size * (0.8 + depth + 2.2 * voice * (i % 11 === 0 ? 1 : 0.25));
      const a = fade * (0.04 + 0.34 * depth) * (0.55 + 0.8 * energy + 1.4 * voice * (i % 13 === 0 ? 1 : 0.12));
      const g = ctx.createRadialGradient(x, y, 0, x, y, sz * 4.8);
      g.addColorStop(0, rgba(pal.white, Math.min(0.95, a + 0.16)));
      g.addColorStop(0.26, rgba(col, a));
      g.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, sz * 4.8, 0, Math.PI * 2); ctx.fill();
    }

    const bars = 64;
    const spread = R * (2.1 + voice * 0.7);
    const col = listen ? pal.accent : pal.core;
    ctx.lineWidth = Math.max(0.8, R * 0.012);
    for (const side of [-1, 1]) {
      const inner = cx + side * R * 1.36;
      for (let i = 0; i < bars; i++) {
        const p = i / (bars - 1);
        const taper = Math.sin(p * Math.PI);
        const y = cy - spread / 2 + spread * p;
        const beat = Math.sin(t * 18 + i * 0.72) * 0.5 + Math.sin(t * 7.5 - i * 0.37) * 0.5;
        const burst = Math.max(0, Math.sin(t * 3.2 + i * 0.19));
        const len = R * (0.05 + taper * (0.16 + 0.72 * voice) * (0.48 + Math.abs(beat) + 0.42 * burst * speak));
        const skip = i % 3 === 0 ? 0.52 : 1;
        ctx.strokeStyle = rgba(col, (0.012 + 0.62 * voice * taper) * skip);
        ctx.beginPath(); ctx.moveTo(inner + side * R * 0.08, y); ctx.lineTo(inner + side * (R * 0.08 + len), y); ctx.stroke();
      }
    }

    const cr = R * (0.2 + 0.08 * Math.sin(t * 4.4) + 0.18 * voice);
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr * 2.8);
    core.addColorStop(0, rgba(pal.white, 1));
    core.addColorStop(0.18, rgba(hot, 0.96));
    core.addColorStop(0.48, rgba(speak ? pal.core : pal.hot, 0.46 + 0.26 * voice));
    core.addColorStop(1, rgba(pal.core, 0));
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(cx, cy, cr * 2.8, 0, Math.PI * 2); ctx.fill();

    const sweepA = rot * 4.8 + voice * 2.2;
    for (let i = 0; i < 3; i++) {
      const rr = R * (1.08 + i * 0.29 + 0.05 * voice);
      const a0 = sweepA * (i % 2 ? -0.74 : 1) + i * 1.95;
      const grad = ctx.createLinearGradient(cx - rr, cy, cx + rr, cy);
      grad.addColorStop(0, rgba(i === 1 ? pal.accent : pal.core, 0));
      grad.addColorStop(0.5, rgba(i === 1 ? pal.accent : pal.white, 0.12 + 0.42 * voice));
      grad.addColorStop(1, rgba(i === 1 ? pal.accent : pal.core, 0));
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.1 + 2.2 * voice;
      ctx.beginPath(); ctx.arc(cx, cy, rr, a0, a0 + Math.PI * (0.24 + 0.18 * voice)); ctx.stroke();
    }

    ctx.lineCap = "butt";
  }

  // Holo Dock (Concept 10): angular HUD corner brackets around the orb.
  function drawBrackets(cx, cy, R, t) {
    const s = R * 1.6, len = R * 0.42, off = s;
    ctx.strokeStyle = rgba(pal.accent, 0.4 + 0.3 * energy); ctx.lineWidth = 1.6;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (const [sx, sy] of corners) {
      const x = cx + sx * off, y = cy + sy * off;
      ctx.beginPath();
      ctx.moveTo(x - sx * len, y); ctx.lineTo(x, y); ctx.lineTo(x, y - sy * len);
      ctx.stroke();
    }
    // faint ticking frame edge
    ctx.strokeStyle = rgba(pal.accent, 0.08);
    ctx.strokeRect(cx - s, cy - s, s * 2, s * 2);
  }

  // Lens iris (Concept 2): aperture blades + concentric lens rings over the body.
  function drawLensIris(cx, cy, R, rot) {
    const blades = 7, rOut = R * 0.98, rIn = R * (0.46 - 0.32 * smoothLevel); // aperture opens with voice
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
    for (let i = 0; i < blades; i++) {
      const a = rot * (0.3 + 1.2 * smoothLevel) + (i / blades) * Math.PI * 2; // iris spins on speech
      const a2 = a + (Math.PI * 2) / blades;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * rIn, cy + Math.sin(a) * rIn);
      ctx.lineTo(cx + Math.cos(a) * rOut, cy + Math.sin(a) * rOut);
      ctx.lineTo(cx + Math.cos(a2) * rOut, cy + Math.sin(a2) * rOut);
      ctx.closePath();
      ctx.fillStyle = rgba(pal.deep, 0.10 + 0.04 * (i % 2));
      ctx.fill();
      ctx.strokeStyle = rgba(pal.line, 0.18); ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.restore();
    for (const f of [1.04, 0.7]) {
      ctx.strokeStyle = rgba(pal.line, 0.14 + 0.1 * energy); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, Math.PI * 2); ctx.stroke();
    }
  }

  function drawScanArc(cx, cy, R, rot) {
    const scan = state === "listening" || state === "connecting" ? 1 : 0;
    if (scan <= 0 && energy < 0.05) return;
    const arcR = R * 1.16;
    ctx.strokeStyle = rgba(pal.accent, 0.05 + 0.04 * energy); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, arcR, 0, Math.PI * 2); ctx.stroke();
    const start = rot * 2.2;
    const grad = ctx.createLinearGradient(cx - arcR, cy, cx + arcR, cy);
    grad.addColorStop(0, rgba(pal.accent, 0));
    grad.addColorStop(0.5, rgba(pal.accent, 0.45 * Math.max(scan, energy) + 0.2 * energy));
    grad.addColorStop(1, rgba(pal.accent, 0));
    ctx.strokeStyle = grad; ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.arc(cx, cy, arcR, start, start + Math.PI * 0.55); ctx.stroke();
  }

  function drawWaveRing(cx, cy, R, t) {
    // Only react to REAL audio (no idle "flower"), and keep it as a tight ring
    // hugging the sphere rather than a big scalloped shape.
    if (state !== "listening" && state !== "speaking") return;
    if (smoothLevel < 0.01 && state !== "speaking") return;
    const color = state === "speaking" ? pal.core : pal.accent;
    const base = R * 1.15, amp = R * (0.03 + 0.3 * smoothLevel), N = 96;
    ctx.lineWidth = 1.6; ctx.strokeStyle = rgba(color, 0.25 + 0.5 * smoothLevel);
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const wob = Math.sin(a * 6 + t * 6) * 0.5 + Math.sin(a * 11 - t * 4) * 0.5;
      const rr = base + amp * wob;
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Minimal/Nebula reactivity: clean concentric ripples that surge with the voice.
  function drawRipples(cx, cy, R, t) {
    if (smoothLevel < 0.02 && state !== "speaking") return;
    const col = state === "speaking" ? pal.core : pal.accent;
    const rings = 3;
    for (let i = 0; i < rings; i++) {
      const phase = (t * (0.45 + smoothLevel) + i / rings) % 1;
      const rr = R * (1.0 + phase * (0.38 + 0.55 * smoothLevel));
      const al = (1 - phase) * (0.16 + 0.5 * smoothLevel);
      if (al <= 0.01) continue;
      ctx.strokeStyle = rgba(col, al);
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.stroke();
    }
  }

  // Holo reactivity: a HUD equaliser bar under the orb that dances with the voice.
  function drawHudBar(cx, cy, R, t) {
    const lvl = smoothLevel;
    if (lvl < 0.015 && state !== "speaking") return;
    const w = R * 1.4, y = cy + R * 1.42, n = 26;
    ctx.lineWidth = 2; ctx.lineCap = "round";
    for (let i = 0; i < n; i++) {
      const x = cx - w + (i / (n - 1)) * w * 2;
      const seed = Math.sin(i * 1.7 + t * 9) * 0.5 + 0.5;
      const h = 1.5 + R * 0.3 * lvl * (0.4 + seed);
      ctx.strokeStyle = rgba(pal.accent, 0.22 + 0.55 * lvl * seed);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - h); ctx.stroke();
    }
    ctx.lineCap = "butt";
  }

  function drawCore(cx, cy, R, breath) {
    const cr = R * (0.3 + 0.04 * breath) * (1 + 0.12 * energy + 0.16 * smoothLevel);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr);
    g.addColorStop(0, rgba(pal.white, 0.98));
    g.addColorStop(0.22, rgba(pal.hot, 0.85 + 0.1 * energy));
    g.addColorStop(0.6, rgba(pal.core, 0.3));
    g.addColorStop(1, rgba(pal.core, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, cr, 0, Math.PI * 2); ctx.fill();
    if (skin.flare) {
      const fw = R * 1.15;
      const fl = ctx.createLinearGradient(cx - fw, cy, cx + fw, cy);
      fl.addColorStop(0, rgba(pal.hot, 0)); fl.addColorStop(0.5, rgba(pal.white, 0.45 + 0.25 * smoothLevel + 0.1 * energy)); fl.addColorStop(1, rgba(pal.hot, 0));
      ctx.fillStyle = fl;
      const fh = Math.max(1, R * 0.045);
      ctx.fillRect(cx - fw, cy - fh / 2, fw * 2, fh);
    }
  }

  // Crystal Cage skin — a metallic wireframe icosahedron caging a glowing crystal
  // octahedron core. PALETTE-DRIVEN: idle uses the palette ACCENT (calm), listening
  // ramps to the palette CORE, and SPEAKING heats the core to orange -> red.
  let crystalWarm = 0;
  function drawCrystalCage(cx, cy, R, t, breath) {
    const STEEL_FAR = [40, 50, 64], STEEL_NEAR = [200, 210, 226];
    // Palette-driven signature: idle = accent (cool), active = core. Distinct hues.
    const SIG = mix(pal.accent, pal.core, energy);
    const SIG_DEEP = mix(pal.deep, pal.core, energy * 0.6);
    // Smoothed "speaking" warmth — drives the core orange -> red.
    crystalWarm += (((state === "speaking") ? 1 : 0) - crystalWarm) * 0.08;
    const W_HOT = [255, 168, 64], W_MID = [255, 96, 30], W_DEEP = [208, 32, 26], W_CORE = [255, 214, 158];
    const lvl = smoothLevel;
    const active = state === "speaking" || state === "listening";
    const amp = Math.min(1, lvl * (state === "speaking" ? 1.25 : 1) + 0.05);
    // Idle stays slow; listening/speaking spin up a bit (driven by energy/state,
    // NOT by loudness — so it won't whip around on loud syllables).
    const ay = spin;              // main cage rotation — the single accumulated spin
    const ax = 0.42 + spin * 0.3; // gentle secondary tilt
    // Voice reactivity is SIZE, not spin: the cage swells/shrinks with the level.
    const scale = 1 + (active ? lvl * 0.26 : 0) + 0.012 * breath;
    const d = 3.2;
    const proj = (p) => { const f = d / (d - p[2]); return [cx + p[0] * R * scale * f, cy + p[1] * R * scale * f, p[2]]; };

    ctx.globalCompositeOperation = "lighter";
    const glowR = R * scale * (0.5 + amp * 0.55);
    const gg = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
    const ga = 0.28 + amp * 0.42 + energy * 0.12;
    gg.addColorStop(0, rgba(mix(SIG, W_HOT, crystalWarm), ga));
    gg.addColorStop(0.4, rgba(mix(SIG_DEEP, W_MID, crystalWarm), ga * 0.4));
    gg.addColorStop(1, rgba(mix(SIG_DEEP, W_DEEP, crystalWarm), 0));
    ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(cx, cy, glowR, 0, Math.PI * 2); ctx.fill();

    const coreR = 0.42 * (0.9 + amp * 0.18);
    const ocv = OCTA_V.map((p) => proj(rot3([p[0] * coreR, p[1] * coreR, p[2] * coreR], -ax * 1.0, ay * 1.2 + t * 0.05)));
    const faceCol = mix(SIG_DEEP, W_MID, crystalWarm);
    const coreEdge = mix(SIG, W_HOT, crystalWarm);
    for (const f of OCTA_F) {
      const a = ocv[f[0]], b = ocv[f[1]], c = ocv[f[2]];
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(c[0], c[1]); ctx.closePath();
      ctx.fillStyle = rgba(faceCol, 0.06 + amp * 0.14); ctx.fill();
      ctx.strokeStyle = rgba(coreEdge, 0.25 + amp * 0.4); ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.fillStyle = rgba(mix([225, 250, 255], W_CORE, crystalWarm), 0.6 + amp * 0.4);
    ctx.beginPath(); ctx.arc(cx, cy, 2.2 + amp * 3.5, 0, Math.PI * 2); ctx.fill();

    ctx.globalCompositeOperation = "source-over";
    const pv = ICOSA_V.map((p) => proj(rot3(p, ax, ay)));
    const edges = ICOSA_E.map((e) => ({ e, z: (pv[e[0]][2] + pv[e[1]][2]) / 2 })).sort((m, n) => m.z - n.z);
    for (const o of edges) {
      const A = pv[o.e[0]], B = pv[o.e[1]]; const b = (o.z + 1) / 2;
      let col = mix(STEEL_FAR, STEEL_NEAR, b);
      col = mix(col, mix(SIG, W_MID, crystalWarm * 0.35), energy * 0.5);
      const w = 1 + b * 2.2;
      ctx.strokeStyle = rgba([4, 7, 11], 0.4 + b * 0.45); ctx.lineWidth = w + 1.4;
      ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke();
      ctx.strokeStyle = rgba(col, 0.35 + b * 0.6); ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke();
    }

    ctx.globalCompositeOperation = "lighter";
    for (const p of pv) {
      const b = (p[2] + 1) / 2; const rr = 1.6 + b * 2;
      const vc = mix([200, 214, 228], mix(SIG, W_HOT, crystalWarm * 0.5), energy * 0.6);
      const vg = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], rr * 3);
      vg.addColorStop(0, rgba(vc, 0.4 + b * 0.55)); vg.addColorStop(1, rgba(vc, 0));
      ctx.fillStyle = vg; ctx.beginPath(); ctx.arc(p[0], p[1], rr * 3, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ---- render ----
  function render(now, dt) {
    const r = canvas.getBoundingClientRect();
    if (Math.abs(r.width - W) > 1 || Math.abs(r.height - H) > 1) resize();

    const target = (state === "listening" || state === "speaking") ? 1 : state === "connecting" ? 0.4 : 0;
    energy += (target - energy) * Math.min(1, dt * SPIN_RAMP);
    const drive = (state === "idle" || state === "connecting") ? 0.04 + 0.03 * (Math.sin(now / 900) * 0.5 + 0.5) : level;
    smoothLevel += (drive - smoothLevel) * Math.min(1, dt * 12);

    const t = now / 1000;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = "lighter";

    const cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.3;
    const breath = Math.sin(t * (1.1 + 0.6 * energy));
    spin += spinRate() * dt;
    const rot = spin;

    if (skin.id === "crystal") {
      drawCrystalCage(cx, cy, R, t, breath);
    } else if (skin.id === "handoff") {
      drawHandoffSkin(cx, cy, R, t, breath, rot);
    } else {
      drawGlow(cx, cy, R, breath);

      if (skin.sphere === "image") drawImageBody(cx, cy, R);
      else drawSphereBody(cx, cy, R, skin.sphere === "soft");

      if (skin.sphere === "wire") drawSphere(cx, cy, R, rot);
      if (skin.sphere === "lens") drawLensIris(cx, cy, R, rot);

      drawParticles(cx, cy, R, t);

      if (skin.ring === "orbit") drawOrbitRings(cx, cy, R, t);
      else if (skin.ring === "halo") drawHalo(cx, cy, R, t);
      else if (skin.ring === "reactor") drawReactor(cx, cy, R, t);
      else if (skin.ring === "spectrum") drawSpectrumRings(cx, cy, R, t);
      if (skin.brackets) drawBrackets(cx, cy, R, t);
      if (skin.scan) drawScanArc(cx, cy, R, rot);

      if (skin.id === "orbit") drawWaveRing(cx, cy, R, t);
      else if (skin.id === "minimal" || skin.id === "nebula") drawRipples(cx, cy, R, t);
      else if (skin.id === "holo") drawHudBar(cx, cy, R, t);

      drawCore(cx, cy, R, breath);
    }

    ctx.globalCompositeOperation = "source-over";
  }

  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    render(now, dt);
  }
  requestAnimationFrame(frame);

  return { setOrbState, setAudioLevel, setSkin, setPalette };
}
