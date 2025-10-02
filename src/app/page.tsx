"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

// Timing mirrors Wang & Qian (2020): fixation 500ms, pre-blank 500ms,
// memory 500ms, ISI 800ms, response window 3000ms. Only blurred bars (BG).

// -------------------- Config --------------------
const FIX_MS = 500; // Fixation 500ms
const PRE_BLANK_MS = 500; // Pre-blank 500ms
const MEM_MS = 500; // Memory 500ms
const ISI_MS = 800; // ISI 500ms
const RESP_WINDOW_MS = 2500; // 2500ms

// Guided saccade timing (splits ISI across cue+blank)
const SAC_ON_MS = 350; // target visible window
const SAC_BLANK_MS = 450; // blank after target

const BAR_LEN = 120; // px
const BAR_W = 9; // px
const BLUR_PX = 2.5;
const ANGLE_CHANGE = 20; // deg

const BLOCK_SIZE = 20;
const SET_MIN = 2; // MIN num of bars per set
const SET_MAX = 10; // MAX num of bars per set

// -------------------- Spatial-frequency (Gabor) config --------------------
// Spatial frequency is parameterized in cycles per stimulus diameter (px).
// This approximates cpd without requiring precise viewing geometry.
const GABOR_DIAM_PX = 120; // match bar length footprint
const GABOR_SIGMA_FRAC = 0.45; // Gaussian envelope sigma as fraction of radius
const GABOR_CONTRAST = 0.55; // 0..1
const FREQ_MIN = 1.0; // cycles per stimulus
const FREQ_MAX = 6.0; // cycles per stimulus
const FREQ_STEP_FRAC = 0.25; // ±25% change for DIFFERENT trials
const FREQ_MIN_SEP_FRAC = 0.12; // ensure items are distinct by ≥12%

const RANKS: Array<[string, number]> = [
  ["Beginner", 0],
  ["Novice", 200],
  ["Competent", 600],
  ["Proficient", 1200],
  ["Expert", 2200],
];

const POINTS_CORRECT = 10;

// If a user answers correctly in 600 ms or less they are awarded 5 extra points
const FAST_BONUS_MS = 600;
const FAST_BONUS = 5;

// -------------------- Color-mode config (added) --------------------
const HUE_CHANGE = 30; // deg hue shift for "different" trials in color mode
const HUE_MIN_SEP = 30; // ensure items are distinct in the memory array

// -------------------- Numerosity config (added) --------------------
const NUM_SET_MIN = 1; // legacy min for other uses
const NUM_COUNT_MIN = 4; // enforced min for numerosity enumerate
const NUM_SET_MAX = 12; // legacy cap
const NUM_COUNT_MAX = 10; // enforced max for numerosity enumerate
const NUM_MEM_MS = 200; // default exposure; will be stateful per user
const NUM_MIN_SEP = 28; // default min separation; will be stateful
const NUM_SIZE_MIN = 12; // px (radius for circle, half-size for square)
const NUM_SIZE_MAX = 30; // px
const NUM_HUE_JITTER = 24; // base hue jitter window
type NumShapeKind = "circle" | "square" | "triangle" | "bar";
type NumShape = {
  x: number;
  y: number;
  size: number; // linear size (radius for circle)
  rot: number; // deg
  hue: number; // 0..360
  kind: NumShapeKind;
};

// -------------------- Audio --------------------
class Tone {
  ctx: AudioContext;
  unlocked = false;
  constructor() {
    // @ts-ignore — handle SSR
    this.ctx =
      typeof window !== "undefined" &&
      (window.AudioContext || (window as any).webkitAudioContext)
        ? new (window.AudioContext || (window as any).webkitAudioContext)()
        : (null as any);
  }
  async unlock() {
    try {
      await this.ctx.resume();
      this.unlocked = true;
    } catch {
      /* noop */
    }
  }
  beep(freq = 880, ms = 120, vol = 0.15) {
    if (!this.ctx) return;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = "sine";
    o.frequency.value = freq;
    g.gain.value = vol;
    o.connect(g);
    g.connect(this.ctx.destination);
    o.start();
    o.stop(this.ctx.currentTime + ms / 1000);
  }
  chord(freqs: number[], ms = 180, vol = 0.12) {
    if (!this.ctx) return;
    const g = this.ctx.createGain();
    g.gain.value = vol;
    g.connect(this.ctx.destination);
    const now = this.ctx.currentTime;
    freqs.forEach((f) => {
      const o = this.ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f;
      o.connect(g);
      o.start(now);
      o.stop(now + ms / 1000);
    });
  }
}

// -------------------- Utils --------------------
const deg2rad = (d: number) => (d * Math.PI) / 180;
const circularMinDiff = (a: number, b: number) =>
  Math.min(Math.abs(a - b), 180 - Math.abs(a - b));

function rankFor(points: number) {
  let name = RANKS[0][0];
  for (const [nm, t] of RANKS) if (points >= t) name = nm;
  return name;
}
function nextRank(points: number): [string, number | null] {
  for (const [nm, t] of RANKS) if (points < t) return [nm, t];
  return [RANKS[RANKS.length - 1][0], null];
}

// -------------------- Stimulus generation --------------------
function layoutPositions(
  cx: number,
  cy: number,
  radius: number,
  n: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    out.push([cx + Math.cos(th) * radius, cy + Math.sin(th) * radius]);
  }
  return out;
}

function randomOrientations(n: number) {
  const arr: number[] = [];
  for (let i = 0; i < n; i++) {
    let tries = 0;
    // ensure >= 20° value in paper
    while (tries++ < 999) {
      const ang = Math.floor(Math.random() * 180);
      if (arr.every((o) => circularMinDiff(o, ang) >= ANGLE_CHANGE)) {
        arr.push(ang);
        break;
      }
    }
  }
  return arr;
}

// (added) Distinct hues for color mode
function randomHues(n: number) {
  const arr: number[] = [];
  for (let i = 0; i < n; i++) {
    let tries = 0;
    while (tries++ < 999) {
      const h = Math.floor(Math.random() * 360);
      // circular hue distance
      const ok = arr.every((o) => {
        const d = Math.min(Math.abs(o - h), 360 - Math.abs(o - h));
        return d >= HUE_MIN_SEP;
      });
      if (ok) {
        arr.push(h);
        break;
      }
    }
  }
  return arr;
}

// (added) Distinct spatial frequencies for spatial mode
function randomFreqs(n: number) {
  const arr: number[] = [];
  for (let i = 0; i < n; i++) {
    let tries = 0;
    while (tries++ < 999) {
      const f = FREQ_MIN + Math.random() * (FREQ_MAX - FREQ_MIN);
      const ok = arr.every((o) => {
        const rel = Math.abs(f - o) / ((f + o) / 2);
        return rel >= FREQ_MIN_SEP_FRAC;
      });
      if (ok) {
        arr.push(f);
        break;
      }
    }
    if (arr.length < i + 1) arr.push(FREQ_MIN + (i * (FREQ_MAX - FREQ_MIN)) / Math.max(1, n - 1));
  }
  return arr;
}

// -------------------- Numerosity stimulus generation (added) --------------------
function randomInDisc(cx: number, cy: number, r: number): [number, number] {
  const th = Math.random() * Math.PI * 2;
  const rr = Math.sqrt(Math.random()) * r; // area-uniform
  return [cx + Math.cos(th) * rr, cy + Math.sin(th) * rr];
}
function generateNumerosityShapes(
  cx: number,
  cy: number,
  radius: number,
  n: number,
  minSepPx: number,
  similarity01: number, // 0 easy (heterogeneous), 1 hard (homogeneous)
): NumShape[] {
  const shapes: NumShape[] = [];
  const hueJitter = Math.max(0, NUM_HUE_JITTER * (1 - similarity01));
  const baseKind: NumShapeKind = ((): NumShapeKind => {
    const r = Math.random();
    return r < 0.25 ? "circle" : r < 0.5 ? "square" : r < 0.75 ? "triangle" : "bar";
  })();
  // Poisson-like rejection sampling for spacing
  let guard = 0;
  while (shapes.length < n && guard++ < 5000) {
    const [x, y] = randomInDisc(cx, cy, radius * 0.9);
    const size = NUM_SIZE_MIN + Math.random() * (NUM_SIZE_MAX - NUM_SIZE_MIN);
    const ok = shapes.every((s) => Math.hypot(s.x - x, s.y - y) >= minSepPx);
    if (!ok) continue;
    const rot = Math.floor(Math.random() * 180);
    const baseHue = Math.floor(Math.random() * 360);
    const hue = (baseHue + (Math.random() * 2 - 1) * hueJitter + 360) % 360;
    const sameKindProb = similarity01 * 0.84; // push to homogeneity as similarity rises
    const rnd = Math.random();
    const kind: NumShapeKind = rnd < sameKindProb
      ? baseKind
      : (() => {
          const r = Math.random();
          return r < 0.25 ? "circle" : r < 0.5 ? "square" : r < 0.75 ? "triangle" : "bar";
        })();
    shapes.push({ x, y, size, rot, hue, kind });
  }
  // Fallback: if not enough (rare), pad with ring layout
  for (let i = shapes.length; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    const rr = radius * 0.75;
    const x = cx + Math.cos(th) * rr;
    const y = cy + Math.sin(th) * rr;
    const size = (NUM_SIZE_MIN + NUM_SIZE_MAX) / 2;
    const hue = Math.floor(Math.random() * 360);
    shapes.push({ x, y, size, rot: 0, hue, kind: baseKind });
  }
  return shapes;
}

// -------------------- Drawing --------------------
// Utility to create an offscreen Gabor canvas for a given spatial frequency
function createGaborCanvas(freqCyclesPerStim: number, blurOn: boolean) {
  const size = GABOR_DIAM_PX;
  const off = document.createElement("canvas");
  off.width = size;
  off.height = size;
  const ctx = off.getContext("2d")!;

  // Draw sinusoidal grating (vertical) in grayscale
  const img = ctx.createImageData(size, size);
  const twoPi = Math.PI * 2;
  const contrast = GABOR_CONTRAST;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const phase = twoPi * freqCyclesPerStim * (x / size);
      const s = 0.5 + 0.5 * contrast * Math.sin(phase);
      const val = Math.max(0, Math.min(255, Math.round(s * 255)));
      img.data[idx] = val;
      img.data[idx + 1] = val;
      img.data[idx + 2] = val;
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Apply circular Gaussian-like envelope using radial gradient mask
  const mask = document.createElement("canvas");
  mask.width = size;
  mask.height = size;
  const mctx = mask.getContext("2d")!;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2;
  const sigma = r * GABOR_SIGMA_FRAC;
  const grd = mctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  // Approximate Gaussian with multiple stops
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(Math.min(1, sigma / r), "rgba(255,255,255,1)");
  grd.addColorStop(Math.min(1, (sigma / r) * 1.6), "rgba(255,255,255,0.6)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  mctx.fillStyle = grd;
  mctx.beginPath();
  mctx.arc(cx, cy, r, 0, Math.PI * 2);
  mctx.fill();

  // Composite mask
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(mask, 0, 0);
  ctx.globalCompositeOperation = "source-over";

  if (blurOn) {
    // Apply stimulus blur to match BG condition
    const tmp = document.createElement("canvas");
    tmp.width = size;
    tmp.height = size;
    const tctx = tmp.getContext("2d")!;
    tctx.filter = `blur(${BLUR_PX}px)`;
    tctx.drawImage(off, 0, 0);
    return tmp;
  }
  return off;
}

// (added) Draw varied numerosity shapes
function drawNumerosityShapes(
  ctx: CanvasRenderingContext2D,
  shapes: NumShape[],
  blurOn: boolean,
) {
  for (const s of shapes) {
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(deg2rad(s.rot));
    ctx.filter = blurOn ? `blur(${BLUR_PX}px)` : "none";
    ctx.fillStyle = `hsl(${Math.round(s.hue)}, 70%, 45%)`;
    ctx.strokeStyle = `hsl(${Math.round(s.hue)}, 70%, 30%)`;
    ctx.lineWidth = 2;
    if (s.kind === "circle") {
      ctx.beginPath();
      ctx.arc(0, 0, s.size, 0, Math.PI * 2);
      ctx.fill();
    } else if (s.kind === "square") {
      const a = s.size * 2;
      ctx.fillRect(-a / 2, -a / 2, a, a);
    } else if (s.kind === "triangle") {
      const a = s.size * 2.2;
      ctx.beginPath();
      ctx.moveTo(0, -a / 2);
      ctx.lineTo(a / 2, a / 2);
      ctx.lineTo(-a / 2, a / 2);
      ctx.closePath();
      ctx.fill();
    } else {
      // bar
      const len = s.size * 3.0;
      const w = Math.max(6, s.size * 0.5);
      ctx.fillRect(-len / 2, -w / 2, len, w);
    }
    ctx.restore();
  }
}

function drawGaborArray(
  ctx: CanvasRenderingContext2D,
  positions: Array<[number, number]>,
  freqs: number[],
  blurOn: boolean,
) {
  const size = GABOR_DIAM_PX;
  for (let i = 0; i < positions.length; i++) {
    const [x, y] = positions[i];
    const can = createGaborCanvas(freqs[i], blurOn);
    ctx.save();
    ctx.translate(x - size / 2, y - size / 2);
    ctx.drawImage(can, 0, 0);
    ctx.restore();
  }
}
function drawFixation(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
  ctx.save();
  ctx.strokeStyle = "#111";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx - 12, cy);
  ctx.lineTo(cx + 12, cy);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, cy - 12);
  ctx.lineTo(cx, cy + 12);
  ctx.stroke();
  ctx.restore();
}

function drawBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angleDeg: number,
  blurOn: boolean,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(deg2rad(angleDeg));
  ctx.filter = blurOn ? `blur(${BLUR_PX}px)` : "none"; // blur only for BG
  ctx.fillStyle = "#000";
  ctx.fillRect(-BAR_LEN / 2, -BAR_W / 2, BAR_LEN, BAR_W);
  ctx.restore();
}

// (added) Colored bar drawing without touching the existing drawBar
function drawBarColor(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angleDeg: number,
  hue: number,
  blurOn: boolean,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(deg2rad(angleDeg));
  ctx.filter = blurOn ? `blur(${BLUR_PX}px)` : "none";
  ctx.fillStyle = `hsl(${hue}, 80%, 45%)`;
  ctx.fillRect(-BAR_LEN / 2, -BAR_W / 2, BAR_LEN, BAR_W);
  ctx.restore();
}

function drawArray(
  ctx: CanvasRenderingContext2D,
  positions: Array<[number, number]>,
  orientations: number[],
  blurOn: boolean,
) {
  for (let i = 0; i < positions.length; i++) {
    const [x, y] = positions[i];
    drawBar(ctx, x, y, orientations[i], blurOn);
  }
}

// (added) Colored array drawing
function drawArrayColored(
  ctx: CanvasRenderingContext2D,
  positions: Array<[number, number]>,
  orientations: number[],
  hues: number[],
  blurOn: boolean,
) {
  for (let i = 0; i < positions.length; i++) {
    const [x, y] = positions[i];
    drawBarColor(ctx, x, y, orientations[i], hues[i] ?? 0, blurOn);
  }
}

function highlightProbe(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.save();
  ctx.strokeStyle = "rgb(30,144,255)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, BAR_LEN / 2 + 22, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// -------------------- Main Component --------------------
export default function Page() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [w, h] = [1024, 700]; // fixed safe area inside the card

  // Session state
  const [setSize, setSetSize] = useState(1);
  const [trial, setTrial] = useState(0);
  const [points, setPoints] = useState(0);
  const [help, setHelp] = useState(true);
  const [paused, setPaused] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [barCorrect, setBarCorrect] = useState(0);
  const [barTotal, setBarTotal] = useState(0);

  const [phase, setPhase] = useState<
    "idle" | "fix" | "preblank" | "mem" | "memA" | "isiA" | "memB" | "isiB" | "saccade" | "isi" | "test"
  >("idle");

  // (added) training mode toggle
  const [mode, setMode] = useState<
    "orientation" | "color" | "spatial" | "numerosity" | "saccade"
  >(
    "orientation",
  );
  const [numerositySubmode, setNumerositySubmode] = useState<"enumerate" | "compare">(
    "enumerate",
  );
  const [blurOn, setBlurOn] = useState(true); // BG (true) vs NBG (false)
  const [sacTotal, setSacTotal] = useState(0);
  const [sacHits, setSacHits] = useState(0);
  // Numerosity adaptive knobs
  const [numExposureMs, setNumExposureMs] = useState(NUM_MEM_MS);
  const [numMinSepPx, setNumMinSepPx] = useState(NUM_MIN_SEP);
  const [numSimilarity01, setNumSimilarity01] = useState(0.2); // 0 easy, 1 hard
  const [numAnchorSetSize, setNumAnchorSetSize] = useState(5); // center of distribution (4–10 bracket)
  const [numCompareDelta, setNumCompareDelta] = useState(2); // difference between A and B in compare mode
  const recentOutcomesRef = useRef<Array<{ ok: boolean; rt: number }>>([]);

  const rank = useMemo(() => rankFor(points), [points]);
  const [nextRankName, nextRankThresh] = useMemo(
    () => nextRank(points),
    [points],
  );

  // Setting up the context for the current user
  const getDataAsNum = (key: string) =>
    parseInt(localStorage.getItem(key) ?? "0");
  useEffect(() => {
    setSetSize(getDataAsNum("set_size") == 0 ? 1 : getDataAsNum("set_size"));
    setPoints(getDataAsNum("points"));
    setTrial(getDataAsNum("set_trial"));
    setBarTotal(getDataAsNum("bar_total"));
    setBarCorrect(getDataAsNum("bar_correct"));
    const m = localStorage.getItem("mode");
    if (
      m === "color" ||
      m === "orientation" ||
      m === "spatial" ||
      m === "numerosity" ||
      m === "saccade"
    )
      setMode(m);
    const b = localStorage.getItem("blur_on");
    if (b === "0" || b === "1") setBlurOn(b === "1");
    const sacT = getDataAsNum("sac_total");
    const sacH = getDataAsNum("sac_hits");
    setSacTotal(Number.isFinite(sacT) && sacT >= 0 ? sacT : 0);
    setSacHits(Number.isFinite(sacH) && sacH >= 0 ? sacH : 0);
    const nsm = localStorage.getItem("numerosity_submode");
    if (nsm === "enumerate" || nsm === "compare") setNumerositySubmode(nsm as any);
    const e = getDataAsNum("num_exposure_ms");
    if (Number.isFinite(e) && e > 50) setNumExposureMs(e);
    const sep = getDataAsNum("num_min_sep");
    if (Number.isFinite(sep) && sep >= 16) setNumMinSepPx(sep);
    const simRaw = localStorage.getItem("num_similarity01");
    if (simRaw != null) {
      const sim = parseFloat(simRaw);
      if (Number.isFinite(sim) && sim >= 0 && sim <= 1) setNumSimilarity01(sim);
    }
    const anc = getDataAsNum("num_anchor_setsize");
    if (Number.isFinite(anc) && anc >= NUM_SET_MIN && anc <= NUM_SET_MAX) setNumAnchorSetSize(anc);
    const delta = getDataAsNum("num_compare_delta");
    if (Number.isFinite(delta) && delta >= 1 && delta <= 3) setNumCompareDelta(delta);
  }, []);

  // Trial content refs
  const memOrientsRef = useRef<number[]>([]);
  const testOrientsRef = useRef<number[]>([]);
  const memHuesRef = useRef<number[]>([]); // (added)
  const testHuesRef = useRef<number[]>([]); // (added)
  const memFreqsRef = useRef<number[]>([]);
  const testFreqsRef = useRef<number[]>([]);
  const posRef = useRef<Array<[number, number]>>([]);
  const probeIdxRef = useRef(0);
  const changeRef = useRef(false);
  const testStartRef = useRef(0);
  const respTimeoutRef = useRef<number | null>(null);
  const correctStreakRef = useRef(0);
  const respElapsedRef = useRef(0);
  const sacTargetRef = useRef<[number, number] | null>(null);
  const sacHitRef = useRef(false);
  const numShapesRef = useRef<NumShape[]>([]);
  const numShapesBRef = useRef<NumShape[]>([]); // for compare
  const numTargetCountRef = useRef(0);
  // Compare-specific refs
  const numCountARef = useRef(0);
  const numCountBRef = useRef(0);
  const numBLargerRef = useRef(false);

  const toneRef = useRef<Tone | null>(null);
  useEffect(() => {
    toneRef.current = new Tone();
  }, []);

  // Centralized trial finishing logic
  const finishTrial = (correct: boolean, rt: number) => {
    if (correct) {
      const add = POINTS_CORRECT + (rt <= FAST_BONUS_MS ? FAST_BONUS : 0);
      const newPts = points + add;
      const oldRank = rankFor(points);
      const newRank = rankFor(newPts);
      setPoints(newPts);
      toneRef.current?.beep(880, 120, 0.18);
      if (newRank !== oldRank) {
        setToast(`Rank up → ${newRank}`);
        toneRef.current?.chord([1046, 1318, 1568], 220, 0.16);
        setTimeout(() => setToast(null), 1200);
      }
      setBarCorrect((c) => c + 1);
    } else {
      toneRef.current?.beep(220, 160, 0.2);
    }

    // Adaptive rules
    if (mode === "spatial") {
      // Block-based adjustment handled at block boundary below
      if (!correct) correctStreakRef.current = 0;
      if (correct) correctStreakRef.current += 1; // tracked but not used here
    } else if (mode === "numerosity") {
      // Multi-parameter adaptation (hide count predictability)
      const windowSize = 16;
      recentOutcomesRef.current.push({ ok: correct, rt });
      if (recentOutcomesRef.current.length > windowSize) recentOutcomesRef.current.shift();
      const acc = recentOutcomesRef.current.reduce((a, o) => a + (o.ok ? 1 : 0), 0) / Math.max(1, recentOutcomesRef.current.length);
      const medianRt = (() => {
        const arr = recentOutcomesRef.current.map((o) => o.rt).slice().sort((a, b) => a - b);
        const mid = Math.floor(arr.length / 2);
        return arr.length ? (arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2) : rt;
      })();
      // Targets: ~75% accuracy, median RT < 900ms
      const targetAcc = 0.75;
      const fastThresh = 900;
      // Adjust exposure (harder when good)
      if (acc >= targetAcc && medianRt <= fastThresh) {
        setNumExposureMs((ms) => Math.max(120, ms - 20));
        setNumMinSepPx((sep) => Math.max(18, sep - 2));
        setNumSimilarity01((s) => Math.min(1, s + 0.06));
        setNumAnchorSetSize((a) => Math.min(NUM_COUNT_MAX - 1, a + 1));
        if (numerositySubmode === "compare") {
          setNumCompareDelta((d) => Math.max(1, d - 1)); // shrink delta: harder
        }
      } else if (acc < targetAcc - 0.1 || medianRt > fastThresh + 250) {
        setNumExposureMs((ms) => Math.min(350, ms + 20));
        setNumMinSepPx((sep) => Math.min(48, sep + 2));
        setNumSimilarity01((s) => Math.max(0, s - 0.06));
        setNumAnchorSetSize((a) => Math.max(NUM_COUNT_MIN + 1, a - 1));
        if (numerositySubmode === "compare") {
          setNumCompareDelta((d) => Math.min(3, d + 1)); // grow delta: easier
        }
      }
      // Randomize next count around anchor (prevents knowing ahead of time)
      if (numerositySubmode === "enumerate") {
        const jitter = Math.floor(Math.random() * 3) - 1; // -1,0,+1
        const next = Math.max(NUM_COUNT_MIN, Math.min(NUM_COUNT_MAX, (numAnchorSetSize + jitter)));
        setSetSize(next);
      }
      correctStreakRef.current = 0;
    } else {
      // 3-up/1-down adaptive rule for original modes
      if (correct) {
        correctStreakRef.current += 1;
        if (correctStreakRef.current >= 3) {
          setSetSize((s) => Math.min(SET_MAX, s + 1));
          correctStreakRef.current = 0;
        }
      } else {
        setSetSize((s) => Math.max(SET_MIN, s - 1));
        correctStreakRef.current = 0;
      }
    }

    setBarTotal((t) => t + 1);
    setTrial((t) => t + 1);

    // Block accounting and continuation
    setTimeout(() => {
      if ((barTotal + 1) % BLOCK_SIZE === 0) {
        const acc = (barCorrect + (correct ? 1 : 0)) / BLOCK_SIZE;
        setToast(`Block complete — accuracy ${(acc * 100).toFixed(1)}%`);
        setBarCorrect(0);
        setBarTotal(0);
        if (mode === "spatial") {
          // Block rule: if accuracy ≥ 90% → +2 (cap 7), else −1 (floor 1)
          const SP_MIN = 1;
          const SP_MAX = 7;
          setSetSize((s) => {
            if (acc >= 0.9) return Math.min(SP_MAX, s + 2);
            return Math.max(SP_MIN, s - 1);
          });
        }
        setTimeout(() => setToast(null), 1500);
      }
      startTrial();
    }, 40);
  };

  const handleResponse = (respChange: boolean) => {
    if (help || paused || phase !== "test") return;
    if (respTimeoutRef.current != null) {
      clearTimeout(respTimeoutRef.current);
      respTimeoutRef.current = null;
    }
    const rt = performance.now() - testStartRef.current;
    const correct = respChange === changeRef.current;
    finishTrial(correct, rt);
  };

  const handleNumerosityAnswer = (ans: number) => {
    if (help || paused || phase !== "test" || mode !== "numerosity") return;
    if (respTimeoutRef.current != null) {
      clearTimeout(respTimeoutRef.current);
      respTimeoutRef.current = null;
    }
    const rt = performance.now() - testStartRef.current;
    const correct = ans === numTargetCountRef.current;
    finishTrial(correct, rt);
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (help || paused || mode !== "saccade" || phase !== "saccade") return;
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
    const tgt = sacTargetRef.current;
    if (!tgt) return;
    const dx = x - tgt[0];
    const dy = y - tgt[1];
    const dist = Math.hypot(dx, dy);
    const HIT_R = 45;
    if (dist <= HIT_R && !sacHitRef.current) {
      sacHitRef.current = true;
      setSacHits((v) => v + 1);
      toneRef.current?.beep(660, 90, 0.14);
    }
  };

  // Draw frame by phase
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;

    ctx.fillStyle = "#e7e7e7"; // lab-clean gray
    ctx.fillRect(0, 0, w, h);

    const cx = Math.floor(w / 2);
    const cy = Math.floor(h / 2) + 20;

    // HUD bar (top)
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, w, 56);

    ctx.fillStyle = "#fff";
    ctx.font = "16px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(`Score: ${points}   Rank: ${rank}`, 16, 36);
    const mid = mode === "numerosity"
      ? `Trial: ${trial + 1}`
      : `Set size: ${setSize}   Trial: ${trial + 1}`;
    const midW = ctx.measureText(mid).width;
    ctx.fillText(mid, Math.floor(w / 2 - midW / 2), 36);
    const right = nextRankThresh
      ? `Next: ${nextRankName} (+${Math.max(0, nextRankThresh - points)})`
      : "Max rank";
    const rightW = ctx.measureText(right).width;
    ctx.fillText(right, w - rightW - 16, 36);

    // Progress bar (block of 20)
    const frac = (trial % BLOCK_SIZE) / BLOCK_SIZE;
    const pbw = Math.floor(w * 0.6);
    const pbx = Math.floor((w - pbw) / 2);
    ctx.fillStyle = "#555";
    ctx.fillRect(pbx, 64, pbw, 10);
    ctx.fillStyle = "rgb(30,144,255)";
    ctx.fillRect(pbx, 64, Math.floor(pbw * frac), 10);

    // Content region
    if (phase === "fix") {
      drawFixation(ctx, cx, cy);
    } else if (phase === "memA") {
      // Compare mode: draw array A with label
      drawNumerosityShapes(ctx, numShapesRef.current, blurOn);
      ctx.save();
      ctx.fillStyle = "#111";
      ctx.font = "bold 48px ui-sans-serif, system-ui";
      ctx.fillText("A", 32, 120);
      ctx.restore();
    } else if (phase === "memB") {
      // Compare mode: draw array B with label
      drawNumerosityShapes(ctx, numShapesBRef.current, blurOn);
      ctx.save();
      ctx.fillStyle = "#111";
      ctx.font = "bold 48px ui-sans-serif, system-ui";
      ctx.fillText("B", 32, 120);
      ctx.restore();
    } else if (phase === "mem") {
      if (mode === "color") {
        drawArrayColored(
          ctx,
          posRef.current,
          memOrientsRef.current,
          memHuesRef.current,
          blurOn,
        );
      } else if (mode === "spatial") {
        drawGaborArray(ctx, posRef.current, memFreqsRef.current, blurOn);
      } else if (mode === "numerosity") {
        drawNumerosityShapes(ctx, numShapesRef.current, blurOn);
      } else {
        drawArray(ctx, posRef.current, memOrientsRef.current, blurOn);
      }
    } else if (phase === "saccade" && mode === "saccade") {
      drawFixation(ctx, cx, cy);
      const tgt = sacTargetRef.current;
      if (tgt) {
        ctx.save();
        ctx.fillStyle = "rgb(255,140,0)";
        ctx.beginPath();
        ctx.arc(tgt[0], tgt[1], 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,140,0,0.7)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(tgt[0], tgt[1], 18, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      ctx.fillStyle = "#111";
      ctx.fillText("Click the orange dot", Math.floor(w / 2 - 90), h - 24);
    } else if (phase === "test") {
      if (mode !== "numerosity") {
        const [px, py] = posRef.current[probeIdxRef.current];
        highlightProbe(ctx, px, py);
      }
      if (mode === "color") {
        drawArrayColored(
          ctx,
          posRef.current,
          testOrientsRef.current,
          testHuesRef.current,
          blurOn,
        );
      } else if (mode === "spatial") {
        drawGaborArray(ctx, posRef.current, testFreqsRef.current, blurOn);
      } else if (mode === "numerosity") {
        if (numerositySubmode === "compare") {
          // Show prompt for compare
          ctx.fillStyle = "#111";
          const s = "LEFT = A has more   |   RIGHT = B has more";
          const sw = ctx.measureText(s).width;
          ctx.fillText(s, Math.floor(w / 2 - sw / 2), h - 48);
        }
        // Enumerate: do not redraw items; force recall without re-encoding
      } else {
        drawArray(ctx, posRef.current, testOrientsRef.current, blurOn);
      }
      ctx.fillStyle = "#111";
      const instr =
        mode === "numerosity"
          ? numerositySubmode === "compare"
            ? "LEFT=A more   |   RIGHT=B more"
            : "Type the count (4–10) or tap a number below"
          : "LEFT = Same   |   RIGHT = Different";
      const iw = ctx.measureText(instr).width;
      ctx.fillText(instr, Math.floor(w / 2 - iw / 2), h - 24);
    }

    // Overlays
    if (help) {
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#fff";
      ctx.font = "24px ui-sans-serif, system-ui, -apple-system, Segoe UI";
      const title =
        mode === "color"
          ? "Change Detection (Color Bars)"
          : mode === "spatial"
          ? `Change Detection (Spatial Frequency · ${blurOn ? "Blurred" : "No Blur"})`
          : mode === "numerosity"
          ? `Numerosity — ${numerositySubmode === "compare" ? "Compare" : "Enumerate"} (${blurOn ? "Blurred" : "No Blur"})`
          : mode === "saccade"
          ? `Guided Saccade + Orientation · ${blurOn ? "Blurred" : "No Blur"}`
          : `Change Detection (Orientation · ${blurOn ? "Blurred" : "No Blur"})`;
      ctx.fillText(
        title,
        Math.floor(w / 2 - ctx.measureText(title).width / 2),
        140,
      );
      ctx.font = "16px ui-sans-serif, system-ui";
      const lines =
        mode === "color"
          ? [
              `MEMORY: A brief array of ${blurOn ? "blurred" : "clear"} COLORED bars appears.`,
              `TEST: One item is cued; its color may differ by ${HUE_CHANGE}° hue.`,
              "TASK: Decide if the test array is the SAME or DIFFERENT.",
              "Keys — LEFT: Same, RIGHT: Different, H: Help, P: Pause, R: Reset Stats",
              "Scoring — +10 correct, +5 bonus if ≤ 600 ms.",
              "Adaptive — 3-up/1-down: +1 after 3 correct, −1 after 1 incorrect (2–10).",
              `${blurOn ? "Blurred (BG)" : "No blur (NBG)"} condition.`,
              "Press any key to begin / close help.",
            ]
          : mode === "spatial"
          ? [
              `MEMORY: A brief array of ${blurOn ? "blurred" : "clear"} circular GABOR patches appears.`,
              `TEST: One item is cued; its spatial frequency may differ by ±${Math.round(
                FREQ_STEP_FRAC * 100,
              )}% of the original.`,
              "TASK: Decide if the test array is the SAME or DIFFERENT.",
              "Keys — LEFT: Same, RIGHT: Different, H: Help, P: Pause, R: Reset Stats",
              "Scoring — +10 correct, +5 bonus if ≤ 600 ms.",
              "Adaptive — Block rule: after 20 trials, ≥90% → +2, else −1 (1–7).",
              `${blurOn ? "Blurred (BG)" : "No blur (NBG)"} condition.`,
              "Press any key to begin / close help.",
            ]
          : mode === "numerosity"
          ? numerositySubmode === "compare"
            ? [
                `SEQUENCE: Two brief arrays (~${Math.round(Math.max(120, numExposureMs))} ms each) appear A then B.`,
                "TASK: Decide which has MORE items (LEFT=A, RIGHT=B).",
                "Scoring — +10 correct, +5 bonus if ≤ 600 ms.",
                "Adaptive — exposure, spacing, similarity, and anchor ranges adjust.",
                `${blurOn ? "Blurred (BG)" : "No blur (NBG)"} condition.`,
                "Press any key to begin / close help.",
              ]
            : [
                `MEMORY: A brief array (~${Math.round(Math.max(120, numExposureMs))} ms) of ${blurOn ? "blurred" : "clear"} varied shapes appears.`,
                "TASK: Report how many items you saw (4–10).",
                "Keys — 4–9, 0→10; on-screen buttons also work.",
                "Scoring — +10 correct, +5 bonus if ≤ 600 ms.",
                "Adaptive — exposure, spacing, similarity, and count jitter adjust to performance.",
                `${blurOn ? "Blurred (BG)" : "No blur (NBG)"} condition.`,
                "Press any key to begin / close help.",
              ]
          : mode === "saccade"
          ? [
              `MEMORY: A brief array of ${blurOn ? "blurred" : "clear"} bars appears.`,
              "GUIDE: During the delay, an ORANGE DOT briefly appears at an unpredictable location.",
              "ACTION: Saccade to it and CLICK the dot while it is visible.",
              "TEST: Afterwards, one item is cued; its orientation may differ by 20°.",
              "TASK: Decide if the test array is the SAME or DIFFERENT.",
              "Keys — LEFT: Same, RIGHT: Different, H: Help, P: Pause, R: Reset Stats",
              "Scoring — +10 correct, +5 bonus if ≤ 600 ms. Dot clicks are tracked for compliance.",
              "Adaptive — 3-up/1-down: +1 after 3 correct, −1 after 1 incorrect (2–10).",
              `${blurOn ? "Blurred (BG)" : "No blur (NBG)"} condition.`,
              "Press any key to begin / close help.",
            ]
          : [
              `MEMORY: A brief array of ${blurOn ? "blurred" : "clear"} bars appears.`,
              "TEST: One item is cued; its orientation may differ by 20°.",
              "TASK: Decide if the test array is the SAME or DIFFERENT.",
              "Keys — LEFT: Same, RIGHT: Different, H: Help, P: Pause, R: Reset Stats",
              "Scoring — +10 correct, +5 bonus if ≤ 600 ms.",
              "Adaptive — 3-up/1-down: +1 after 3 correct, −1 after 1 incorrect (2–10).",
              `${blurOn ? "Blurred (BG)" : "No blur (NBG)"} condition.`,
              "Press any key to begin / close help.",
            ];
      let y = 180;
      for (const ln of lines) {
        ctx.fillText(ln, Math.floor(w / 2 - 300), y);
        y += 28;
      }
    }
    if (paused && !help) {
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#111";
      ctx.font = "28px ui-sans-serif, system-ui";
      const p = "Paused — press P to resume";
      ctx.fillText(
        p,
        Math.floor(w / 2 - ctx.measureText(p).width / 2),
        Math.floor(h / 2),
      );
    }

    if (toast) {
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(0, 0, w, 90);
      ctx.fillStyle = "#fff";
      ctx.font = "20px ui-sans-serif, system-ui";
      ctx.fillText(
        toast,
        Math.floor(w / 2 - ctx.measureText(toast).width / 2),
        56,
      );
    }
  }, [
    phase,
    points,
    rank,
    nextRankName,
    nextRankThresh,
    setSize,
    trial,
    help,
    paused,
    toast,
    mode,
    numerositySubmode,
    blurOn,
    sacHits,
    sacTotal,
    numExposureMs,
  ]);

  // Trial FSM
  const startTrial = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (respTimeoutRef.current != null) {
      clearTimeout(respTimeoutRef.current);
      respTimeoutRef.current = null;
    }
    const cx = Math.floor(w / 2),
      cy = Math.floor(h / 2) + 20;
    const radius = Math.min(w, h) / 3;

    // Generate memory array
    if (mode === "numerosity") {
      if (numerositySubmode === "compare") {
        // Generate two arrays A and B with difference = delta
        // Randomize which is larger (50% swap)
        const base = numAnchorSetSize;
        const delta = numCompareDelta;
        const smaller = Math.max(NUM_COUNT_MIN, base - Math.floor(delta / 2));
        const larger = Math.min(NUM_COUNT_MAX, smaller + delta);
        const swap = Math.random() < 0.5;
        const cntA = swap ? larger : smaller;
        const cntB = swap ? smaller : larger;
        numCountARef.current = cntA;
        numCountBRef.current = cntB;
        numBLargerRef.current = cntB > cntA;
        // Generate shapes for both A and B
        numShapesRef.current = generateNumerosityShapes(cx, cy, radius, cntA, numMinSepPx, numSimilarity01);
        numShapesBRef.current = generateNumerosityShapes(cx, cy, radius, cntB, numMinSepPx, numSimilarity01);
        posRef.current = [];
      } else {
        // Enumerate
        numTargetCountRef.current = Math.max(NUM_COUNT_MIN, Math.min(NUM_COUNT_MAX, setSize));
        numShapesRef.current = generateNumerosityShapes(
          cx,
          cy,
          radius,
          numTargetCountRef.current,
          numMinSepPx,
          numSimilarity01,
        );
        posRef.current = [];
      }
    } else {
      posRef.current = layoutPositions(cx, cy, radius, setSize);
      memOrientsRef.current = randomOrientations(setSize);
      memHuesRef.current =
        mode === "color" ? randomHues(setSize) : new Array(setSize).fill(0);
      memFreqsRef.current =
        mode === "spatial" ? randomFreqs(setSize) : new Array(setSize).fill(FREQ_MIN);
    }

    // Decide change and probe
    if (mode === "numerosity") {
      if (numerositySubmode === "compare") {
        changeRef.current = false; // not used in compare (we use bLarger instead)
        probeIdxRef.current = 0;
      } else {
        changeRef.current = false; // not used
        probeIdxRef.current = 0;
      }
    } else {
      changeRef.current = Math.random() < 0.5;
      probeIdxRef.current = Math.floor(Math.random() * setSize);
    }

    // Build test arrays
    if (mode !== "numerosity") {
      testOrientsRef.current = [...memOrientsRef.current];
      testHuesRef.current = [...memHuesRef.current];
      testFreqsRef.current = [...memFreqsRef.current];
    }

    if (mode !== "numerosity" && changeRef.current) {
      if (mode === "color") {
        const sign = Math.random() < 0.5 ? 1 : -1;
        testHuesRef.current[probeIdxRef.current] =
          (testHuesRef.current[probeIdxRef.current] + sign * HUE_CHANGE + 360) %
          360;
      } else if (mode === "spatial") {
        const base = testFreqsRef.current[probeIdxRef.current];
        const sign = Math.random() < 0.5 ? 1 : -1;
        let f = base * (1 + sign * FREQ_STEP_FRAC);
        f = Math.max(FREQ_MIN, Math.min(FREQ_MAX, f));
        testFreqsRef.current[probeIdxRef.current] = f;
      } else {
        const delta = Math.random() < 0.5 ? ANGLE_CHANGE : -ANGLE_CHANGE;
        testOrientsRef.current[probeIdxRef.current] =
          (testOrientsRef.current[probeIdxRef.current] + delta + 180) % 180;
      }
    }

    // Sequence
    setPhase("fix");
    setTimeout(() => {
      setPhase("preblank");
      setTimeout(() => {
        // Compare mode: memA -> isiA -> memB -> isiB -> test
        if (mode === "numerosity" && numerositySubmode === "compare") {
          setPhase("memA");
          setTimeout(() => {
            setPhase("isiA");
            setTimeout(() => {
              setPhase("memB");
              setTimeout(() => {
                setPhase("isiB");
                setTimeout(() => {
                  testStartRef.current = performance.now();
                  setPhase("test");
                  respElapsedRef.current = 0;
                  respTimeoutRef.current = window.setTimeout(() => {
                    finishTrial(false, RESP_WINDOW_MS);
                  }, RESP_WINDOW_MS);
                }, ISI_MS / 2); // brief isiB
              }, numExposureMs); // memB
            }, ISI_MS / 2); // brief isiA
          }, numExposureMs); // memA
        } else {
          setPhase("mem");
          sacTargetRef.current = null;
          sacHitRef.current = false;
          setTimeout(() => {
            if (mode === "saccade") {
              const th = Math.random() * Math.PI * 2;
              const r2 = radius * 0.78;
              sacTargetRef.current = [
                cx + Math.cos(th) * r2,
                cy + Math.sin(th) * r2,
              ];
              sacHitRef.current = false;
              setSacTotal((v) => v + 1);
              setPhase("saccade");
              setTimeout(() => {
                sacTargetRef.current = null;
                if (!sacHitRef.current) {
                  toneRef.current?.beep(300, 90, 0.08);
                }
                setPhase("isi");
                setTimeout(() => {
                  testStartRef.current = performance.now();
                  setPhase("test");
                  respElapsedRef.current = 0;
                  respTimeoutRef.current = window.setTimeout(() => {
                    finishTrial(false, RESP_WINDOW_MS);
                  }, RESP_WINDOW_MS);
                }, SAC_BLANK_MS);
              }, SAC_ON_MS);
            } else {
              setPhase("isi");
              setTimeout(() => {
                testStartRef.current = performance.now();
                setPhase("test");
                respElapsedRef.current = 0;
                respTimeoutRef.current = window.setTimeout(() => {
                  finishTrial(false, RESP_WINDOW_MS);
                }, RESP_WINDOW_MS);
              }, ISI_MS);
            }
          }, mode === "numerosity" ? numExposureMs : MEM_MS);
        }
      }, PRE_BLANK_MS);
    }, FIX_MS);
  };

  // Key handling
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if (help) {
        setHelp(false);
        toneRef.current?.unlock();
        return;
      }
      // Reset stats
      if (e.key === "r" || e.key === "R") {
        localStorage.setItem("set_size", "0");
        localStorage.setItem("points", "0");
        localStorage.setItem("set_trial", "0"); // fixed key
        localStorage.setItem("bar_total", "0");
        localStorage.setItem("bar_correct", "0");
        return;
      }
      if (e.key === "h" || e.key === "H") {
        setHelp((v) => !v);
        return;
      }
      if (e.key === "p" || e.key === "P") {
        if (!paused) {
          if (phase === "test") {
            respElapsedRef.current = performance.now() - testStartRef.current;
            if (respTimeoutRef.current != null) {
              clearTimeout(respTimeoutRef.current);
              respTimeoutRef.current = null;
            }
          }
          setPaused(true);
        } else {
          if (phase === "test") {
            const remaining = Math.max(
              0,
              RESP_WINDOW_MS - respElapsedRef.current,
            );
            testStartRef.current = performance.now() - respElapsedRef.current;
            respTimeoutRef.current = window.setTimeout(() => {
              finishTrial(false, RESP_WINDOW_MS);
            }, remaining);
          }
          setPaused(false);
        }
        return;
      }
      if (paused) return;
      if (phase !== "test") return;
      if (mode === "numerosity") {
        if (numerositySubmode === "compare") {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            // LEFT = A more, RIGHT = B more
            if (respTimeoutRef.current != null) {
              clearTimeout(respTimeoutRef.current);
              respTimeoutRef.current = null;
            }
            const rt = performance.now() - testStartRef.current;
            const userSaysAMore = e.key === "ArrowLeft";
            const userSaysBMore = e.key === "ArrowRight";
            const correct = (userSaysAMore && !numBLargerRef.current) || (userSaysBMore && numBLargerRef.current);
            finishTrial(correct, rt);
          }
          return;
        }
        // Enumerate: number keys 4-9, 0->10
        if (e.key >= "4" && e.key <= "9") {
          handleNumerosityAnswer(parseInt(e.key, 10));
          return;
        }
        if (e.key === "0") {
          handleNumerosityAnswer(10);
          return;
        }
        return;
      }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      handleResponse(e.key === "ArrowRight");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, help, paused, points, setSize, barTotal, barCorrect, mode]);

  // Kick off first trial when help dismissed
  useEffect(() => {
    if (!help && phase === "idle") startTrial();
  }, [help]);

  // persist mode choice (added)
  useEffect(() => {
    localStorage.setItem("mode", mode);
    localStorage.setItem("blur_on", blurOn ? "1" : "0");
    if (mode === "numerosity") {
      localStorage.setItem("numerosity_submode", numerositySubmode);
    }
  }, [mode, blurOn]);

  useEffect(() => {
    localStorage.setItem("blur_on", blurOn ? "1" : "0");
  }, [blurOn]);

  // Persist session state reliably
  useEffect(() => {
    localStorage.setItem("set_size", JSON.stringify(setSize));
    localStorage.setItem("points", JSON.stringify(points));
    localStorage.setItem("set_trial", JSON.stringify(trial));
    localStorage.setItem("bar_total", JSON.stringify(barTotal));
    localStorage.setItem("bar_correct", JSON.stringify(barCorrect));
    localStorage.setItem("sac_total", JSON.stringify(sacTotal));
    localStorage.setItem("sac_hits", JSON.stringify(sacHits));
    localStorage.setItem("num_exposure_ms", JSON.stringify(numExposureMs));
    localStorage.setItem("num_min_sep", JSON.stringify(numMinSepPx));
    localStorage.setItem("num_similarity01", JSON.stringify(numSimilarity01));
    localStorage.setItem("num_anchor_setsize", JSON.stringify(numAnchorSetSize));
    localStorage.setItem("num_compare_delta", JSON.stringify(numCompareDelta));
  }, [setSize, points, trial, barTotal, barCorrect, sacTotal, sacHits, numExposureMs, numMinSepPx, numSimilarity01, numAnchorSetSize, numCompareDelta]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (respTimeoutRef.current != null) clearTimeout(respTimeoutRef.current);
    };
  }, []);

  return (
    <div className="min-h-screen bg-neutral-100 text-neutral-900 flex items-center justify-center p-6">
      <div className="w-[1100px] max-w-full rounded-2xl shadow-sm border border-neutral-200 bg-white">
        <div className="px-6 py-4 border-b border-neutral-200 flex items-center justify-between">
          <div className="font-mono text-sm tracking-tight">
            VWM Training · blurred bars
          </div>
          {/* added: simple toggle button */}
          <div className="flex items-center gap-2">
            <button
              onClick={() =>
                setMode((m) =>
                  m === "orientation"
                    ? "color"
                    : m === "color"
                    ? "spatial"
                    : m === "spatial"
                    ? "numerosity"
                    : m === "numerosity"
                    ? "saccade"
                    : "orientation",
                )
              }
              className="px-3 py-1 rounded-md border border-neutral-300 text-xs font-mono hover:bg-neutral-50"
              aria-label="Cycle training mode"
            >
              Mode: {mode === "orientation"
                ? "Orientation"
                : mode === "color"
                ? "Color"
                : mode === "spatial"
                ? "Spatial"
                : mode === "numerosity"
                ? "Numerosity"
                : "Saccade"}
            </button>
            {mode === "numerosity" && (
              <div className="flex items-center gap-1">
                <span className="text-[10px] uppercase text-neutral-500">Submode</span>
                <button
                  onClick={() => setNumerositySubmode("enumerate")}
                  className={`px-2 py-1 rounded-md border text-xs ${
                    numerositySubmode === "enumerate"
                      ? "border-blue-500 text-blue-600"
                      : "border-neutral-300 text-neutral-700"
                  }`}
                >
                  Enumerate
                </button>
                <button
                  onClick={() => setNumerositySubmode("compare")}
                  className={`px-2 py-1 rounded-md border text-xs ${
                    numerositySubmode === "compare"
                      ? "border-blue-500 text-blue-600"
                      : "border-neutral-300 text-neutral-700"
                  }`}
                >
                  Compare
                </button>
              </div>
            )}
            <button
              onClick={() => setBlurOn((b) => !b)}
              className="px-3 py-1 rounded-md border border-neutral-300 text-xs font-mono hover:bg-neutral-50"
              aria-label="Toggle blur condition"
            >
              {blurOn ? "BG: Blurred" : "NBG: No Blur"}
            </button>
          </div>
        </div>
        <div className="p-4">
          <canvas
            ref={canvasRef}
            width={1024}
            height={700}
            className="w-full rounded-xl border border-neutral-200 bg-neutral-200"
            onClick={handleCanvasClick}
          />
          <div className="mt-3 flex items-center justify-between text-xs text-neutral-600 font-mono">
            <div>
              {mode === "numerosity"
                ? numerositySubmode === "compare"
                  ? "LEFT=A more · RIGHT=B more · H = Help · P = Pause · R = Reset Stats"
                  : "4–9, 0→10 · H = Help · P = Pause · R = Reset Stats"
                : "LEFT = Same · RIGHT = Different · H = Help · P = Pause · R = Reset Stats"}
            </div>
            <div className="flex items-center gap-2">
              <div>
                Fix {FIX_MS} · Pre {PRE_BLANK_MS} · Mem {MEM_MS} · ISI {ISI_MS} ·
                Resp {RESP_WINDOW_MS}
              </div>
              {mode !== "numerosity" ? (
                <>
                  <button
                    onClick={() => handleResponse(false)}
                    disabled={help || paused || phase !== "test"}
                    className="px-3 py-1 rounded-md border border-neutral-300 text-xs hover:bg-neutral-50 disabled:opacity-50"
                  >
                    Same
                  </button>
                  <button
                    onClick={() => handleResponse(true)}
                    disabled={help || paused || phase !== "test"}
                    className="px-3 py-1 rounded-md border border-neutral-300 text-xs hover:bg-neutral-50 disabled:opacity-50"
                  >
                    Different
                  </button>
                </>
              ) : (
                numerositySubmode === "compare" ? null : (
                <div className="flex flex-wrap gap-1">
                  {[4,5,6,7,8,9,10].map((n) => (
                    <button
                      key={n}
                      onClick={() => handleNumerosityAnswer(n)}
                      disabled={help || paused || phase !== "test"}
                      className="px-2 py-1 rounded-md border border-neutral-300 text-xs hover:bg-neutral-50 disabled:opacity-50"
                    >
                      {n}
                    </button>
                  ))}
                </div>
                )
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
