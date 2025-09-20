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
    "idle" | "fix" | "preblank" | "mem" | "isi" | "test"
  >("idle");

  // (added) training mode toggle
  const [mode, setMode] = useState<"orientation" | "color" | "spatial">(
    "orientation",
  );
  const [blurOn, setBlurOn] = useState(true); // BG (true) vs NBG (false)

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
    if (m === "color" || m === "orientation" || m === "spatial") setMode(m);
    const b = localStorage.getItem("blur_on");
    if (b === "0" || b === "1") setBlurOn(b === "1");
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
    const mid = `Set size: ${setSize}   Trial: ${trial + 1}`;
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
      } else {
        drawArray(ctx, posRef.current, memOrientsRef.current, blurOn);
      }
    } else if (phase === "test") {
      const [px, py] = posRef.current[probeIdxRef.current];
      highlightProbe(ctx, px, py);
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
      } else {
        drawArray(ctx, posRef.current, testOrientsRef.current, blurOn);
      }
      ctx.fillStyle = "#111";
      ctx.fillText(
        "LEFT = Same   |   RIGHT = Different",
        Math.floor(w / 2 - 150),
        h - 24,
      );
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
    posRef.current = layoutPositions(cx, cy, radius, setSize);
    memOrientsRef.current = randomOrientations(setSize);
    memHuesRef.current =
      mode === "color" ? randomHues(setSize) : new Array(setSize).fill(0);
    memFreqsRef.current =
      mode === "spatial" ? randomFreqs(setSize) : new Array(setSize).fill(FREQ_MIN);

    // Decide change and probe
    changeRef.current = Math.random() < 0.5;
    probeIdxRef.current = Math.floor(Math.random() * setSize);

    // Build test arrays
    testOrientsRef.current = [...memOrientsRef.current];
    testHuesRef.current = [...memHuesRef.current];
    testFreqsRef.current = [...memFreqsRef.current];

    if (changeRef.current) {
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
        setPhase("mem");
        setTimeout(() => {
          setPhase("isi");
          setTimeout(() => {
            testStartRef.current = performance.now();
            setPhase("test");
            respElapsedRef.current = 0;
            respTimeoutRef.current = window.setTimeout(() => {
              // timeout -> incorrect
              finishTrial(false, RESP_WINDOW_MS);
            }, RESP_WINDOW_MS);
          }, ISI_MS);
        }, MEM_MS);
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
            const remaining = Math.max(0, RESP_WINDOW_MS - respElapsedRef.current);
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
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      handleResponse(e.key === "ArrowRight");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, help, paused, points, setSize, barTotal, barCorrect]);

  // Kick off first trial when help dismissed
  useEffect(() => {
    if (!help && phase === "idle") startTrial();
  }, [help]);

  // persist mode choice (added)
  useEffect(() => {
    localStorage.setItem("mode", mode);
    localStorage.setItem("blur_on", blurOn ? "1" : "0");
  }, [mode]);

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
  }, [setSize, points, trial, barTotal, barCorrect]);

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
                  m === "orientation" ? "color" : m === "color" ? "spatial" : "orientation",
                )
              }
              className="px-3 py-1 rounded-md border border-neutral-300 text-xs font-mono hover:bg-neutral-50"
              aria-label="Cycle training mode"
            >
              Mode: {mode === "orientation" ? "Orientation" : mode === "color" ? "Color" : "Spatial"}
            </button>
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
          />
          <div className="mt-3 flex items-center justify-between text-xs text-neutral-600 font-mono">
            <div>
              LEFT = Same · RIGHT = Different · H = Help · P = Pause · R = Reset
              Stats
            </div>
            <div className="flex items-center gap-2">
              <div>
                Fix {FIX_MS} · Pre {PRE_BLANK_MS} · Mem {MEM_MS} · ISI {ISI_MS} ·
                Resp {RESP_WINDOW_MS}
              </div>
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
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
