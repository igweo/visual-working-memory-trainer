'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'

// Timing mirrors Wang & Qian (2020): fixation 500ms, pre‑blank 500ms,
// memory 500ms, ISI 800ms, response window 3000ms. Only blurred bars (BG).

// -------------------- Config --------------------
const FIX_MS = 500 // Fixation 500ms
const PRE_BLANK_MS = 500 // Pre-blank 500ms
const MEM_MS = 500 // Memory 500ms
const ISI_MS = 800 // ISI 500ms
const RESP_WINDOW_MS = 2500 // 2500ms

const BAR_LEN = 120 // px
const BAR_W = 9 // px
const BLUR_PX = 2.5
const ANGLE_CHANGE = 20 // deg

const BLOCK_SIZE = 20
const SET_MIN = 1 // MIN num of bars per set
const SET_MAX = 10 // MAX num of bars per set

const RANKS: Array<[string, number]> = [
  ['Beginner', 0],
  ['Novice', 200],
  ['Competent', 600],
  ['Proficient', 1200],
  ['Expert', 2200],
]

const POINTS_CORRECT = 10

// If a user answers correctly in 600 ms or less they are awarded 5 extra points
const FAST_BONUS_MS = 600
const FAST_BONUS = 5

// -------------------- Audio --------------------
class Tone {
  ctx: AudioContext
  unlocked = false
  constructor() {
    // @ts-ignore — handle SSR
    this.ctx = typeof window !== 'undefined' && (window.AudioContext || (window as any).webkitAudioContext)
      ? new (window.AudioContext || (window as any).webkitAudioContext)()
      : (null as any)
  }
  async unlock() {
    try { await this.ctx.resume(); this.unlocked = true } catch { /* noop */ }
  }
  beep(freq = 880, ms = 120, vol = 0.15) {
    if (!this.ctx) return
    const o = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    o.type = 'sine'; o.frequency.value = freq
    g.gain.value = vol
    o.connect(g); g.connect(this.ctx.destination)
    o.start()
    o.stop(this.ctx.currentTime + ms / 1000)
  }
  chord(freqs: number[], ms = 180, vol = 0.12) {
    if (!this.ctx) return
    const g = this.ctx.createGain(); g.gain.value = vol; g.connect(this.ctx.destination)
    const now = this.ctx.currentTime
    freqs.forEach(f => { const o = this.ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f; o.connect(g); o.start(now); o.stop(now + ms / 1000) })
  }
}

// -------------------- Utils --------------------
const deg2rad = (d: number) => (d * Math.PI) / 180
const circularMinDiff = (a: number, b: number) => Math.min(Math.abs(a - b), 180 - Math.abs(a - b))

function rankFor(points: number) {
  let name = RANKS[0][0]
  for (const [nm, t] of RANKS) if (points >= t) name = nm
  return name
}
function nextRank(points: number): [string, number | null] {
  for (const [nm, t] of RANKS) if (points < t) return [nm, t]
  return [RANKS[RANKS.length - 1][0], null]
}

// -------------------- Stimulus generation --------------------
function layoutPositions(cx: number, cy: number, radius: number, n: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n
    out.push([cx + Math.cos(th) * radius, cy + Math.sin(th) * radius])
  }
  return out
}

function randomOrientations(n: number) {
  const arr: number[] = []
  for (let i = 0; i < n; i++) {
    let tries = 0
    // ensure >= 20° value in paper
    while (tries++ < 999) {
      const ang = Math.floor(Math.random() * 180)
      if (arr.every(o => circularMinDiff(o, ang) >= ANGLE_CHANGE)) { arr.push(ang); break }
    }
  }
  return arr
}

// -------------------- Drawing --------------------
function drawFixation(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
  ctx.save()
  ctx.strokeStyle = '#111'
  ctx.lineWidth = 3
  ctx.beginPath(); ctx.moveTo(cx - 12, cy); ctx.lineTo(cx + 12, cy); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(cx, cy - 12); ctx.lineTo(cx, cy + 12); ctx.stroke()
  ctx.restore()
}

function drawBar(ctx: CanvasRenderingContext2D, x: number, y: number, angleDeg: number) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(deg2rad(angleDeg))
  ctx.filter = `blur(${BLUR_PX}px)` // This line determines the blur effect and is very important
  ctx.fillStyle = '#000'
  ctx.fillRect(-BAR_LEN / 2, -BAR_W / 2, BAR_LEN, BAR_W)
  ctx.restore()
}

function drawArray(ctx: CanvasRenderingContext2D, positions: Array<[number, number]>, orientations: number[]) {
  for (let i = 0; i < positions.length; i++) {
    const [x, y] = positions[i]
    drawBar(ctx, x, y, orientations[i])
  }
}

function highlightProbe(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.save()
  ctx.strokeStyle = 'rgb(30,144,255)'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.arc(x, y, BAR_LEN / 2 + 22, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

// -------------------- Main Component --------------------
export default function Page() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [w, h] = [1024, 700] // fixed safe area inside the card

  // Session state
  const [setSize, setSetSize] = useState(1)
  const [trial, setTrial] = useState(0)
  const [points, setPoints] = useState(0)
  const [help, setHelp] = useState(true)
  const [paused, setPaused] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [barCorrect, setBarCorrect] = useState(0)
  const [barTotal, setBarTotal] = useState(0)

  const [phase, setPhase] = useState<'idle' | 'fix' | 'preblank' | 'mem' | 'isi' | 'test'>('idle')

  const rank = useMemo(() => rankFor(points), [points])
  const [nextRankName, nextRankThresh] = useMemo(() => nextRank(points), [points])


  // Setting up the context for the current user
  const getDataAsNum = (key: string) => parseInt(localStorage.getItem(key) ?? "0")
  useEffect(() => {
    setSetSize(getDataAsNum("set_size") == 0 ? 1 : getDataAsNum("set_size"))
    setPoints(getDataAsNum("points"))
    setTrial(getDataAsNum("set_trial"))
    setBarTotal(getDataAsNum("bar_total"))
    setBarCorrect(getDataAsNum("bar_correct"))
  }, [])

  // Trial content refs
  const memOrientsRef = useRef<number[]>([])
  const testOrientsRef = useRef<number[]>([])
  const posRef = useRef<Array<[number, number]>>([])
  const probeIdxRef = useRef(0)
  const changeRef = useRef(false)
  const testStartRef = useRef(0)

  const toneRef = useRef<Tone | null>(null)
  useEffect(() => { toneRef.current = new Tone() }, [])

  // Draw frame by phase
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return
    const ctx = canvas.getContext('2d')!

    ctx.fillStyle = '#e7e7e7' // lab‑clean gray
    ctx.fillRect(0, 0, w, h)

    const cx = Math.floor(w / 2)
    const cy = Math.floor(h / 2) + 20

    // HUD bar (top)
    ctx.fillStyle = '#111'
    ctx.fillRect(0, 0, w, 56)

    ctx.fillStyle = '#fff'
    ctx.font = '16px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.fillText(`Score: ${points}   Rank: ${rank}`, 16, 36)
    const mid = `Set size: ${setSize}   Trial: ${trial + 1}`
    const midW = ctx.measureText(mid).width
    ctx.fillText(mid, Math.floor(w / 2 - midW / 2), 36)
    const right = nextRankThresh ? `Next: ${nextRankName} (+${Math.max(0, nextRankThresh - points)})` : 'Max rank'
    const rightW = ctx.measureText(right).width
    ctx.fillText(right, w - rightW - 16, 36)

    // Progress bar (block of 20)
    const frac = (trial % BLOCK_SIZE) / BLOCK_SIZE
    const pbw = Math.floor(w * 0.6)
    const pbx = Math.floor((w - pbw) / 2)
    ctx.fillStyle = '#555'; ctx.fillRect(pbx, 64, pbw, 10)
    ctx.fillStyle = 'rgb(30,144,255)'; ctx.fillRect(pbx, 64, Math.floor(pbw * frac), 10)

    // Content region
    if (phase === 'fix') {
      drawFixation(ctx, cx, cy)
    } else if (phase === 'mem') {
      drawArray(ctx, posRef.current, memOrientsRef.current)
    } else if (phase === 'test') {
      const [px, py] = posRef.current[probeIdxRef.current]
      highlightProbe(ctx, px, py)
      drawArray(ctx, posRef.current, testOrientsRef.current)
      ctx.fillStyle = '#111'; ctx.fillText('LEFT = Same   |   RIGHT = Different', Math.floor(w / 2 - 150), h - 24)
    }

    // Overlays
    if (help) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#fff'
      ctx.font = '24px ui-sans-serif, system-ui, -apple-system, Segoe UI'
      const title = 'Change Detection (Blurred Bars)'
      ctx.fillText(title, Math.floor(w / 2 - ctx.measureText(title).width / 2), 140)
      ctx.font = '16px ui-sans-serif, system-ui'
      const lines = [
        'MEMORY: A brief array of blurred bars appears.',
        'TEST: One item is cued; its orientation may differ by 20°.',
        'TASK: Decide if the test array is the SAME or DIFFERENT.',
        'Keys — LEFT: Same, RIGHT: Different, H: Help, P: Pause',
        'Scoring — +10 correct, +5 bonus if ≤ 600 ms.',
        'Progression — every 20 trials: ≥ 90% → set size +2 (max 7), else −1 (min 1).',
        'All stimuli are blurred (BG condition).',
        'Press any key to begin / close help.'
      ]
      let y = 180
      for (const ln of lines) { ctx.fillText(ln, Math.floor(w / 2 - 300), y); y += 28 }
    }
    if (paused && !help) {
      ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#111'; ctx.font = '28px ui-sans-serif, system-ui'
      const p = 'Paused — press P to resume'
      ctx.fillText(p, Math.floor(w / 2 - ctx.measureText(p).width / 2), Math.floor(h / 2))
    }

    if (toast) {
      ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(0, 0, w, 90)
      ctx.fillStyle = '#fff'; ctx.font = '20px ui-sans-serif, system-ui'
      ctx.fillText(toast, Math.floor(w / 2 - ctx.measureText(toast).width / 2), 56)
    }
  }, [phase, points, rank, nextRankName, nextRankThresh, setSize, trial, help, paused, toast])

  // Trial FSM
  const startTrial = () => {
    const canvas = canvasRef.current; if (!canvas) return
    const cx = Math.floor(w / 2), cy = Math.floor(h / 2) + 20
    const radius = Math.min(w, h) / 3

    // Generate memory array
    posRef.current = layoutPositions(cx, cy, radius, setSize)
    memOrientsRef.current = randomOrientations(setSize)

    // Decide change and probe
    changeRef.current = Math.random() < 0.5
    probeIdxRef.current = Math.floor(Math.random() * setSize)

    // Build test orientations
    testOrientsRef.current = [...memOrientsRef.current]
    if (changeRef.current) {
      const delta = Math.random() < 0.5 ? ANGLE_CHANGE : -ANGLE_CHANGE
      testOrientsRef.current[probeIdxRef.current] = (testOrientsRef.current[probeIdxRef.current] + delta + 180) % 180
    }

    // Sequence
    setPhase('fix')
    setTimeout(() => {
      setPhase('preblank')
      setTimeout(() => {
        setPhase('mem')
        setTimeout(() => {
          setPhase('isi')
          setTimeout(() => {
            testStartRef.current = performance.now()
            setPhase('test')
          }, ISI_MS)
        }, MEM_MS)
      }, PRE_BLANK_MS)
    }, FIX_MS)
  }

  // Key handling
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if (help) { setHelp(false); toneRef.current?.unlock(); return }
      // Reset stats
      if(e.key === 'r' || e.key === 'R') {
        localStorage.setItem("set_size", "0")
        localStorage.setItem("points", "0")
        localStorage.setItem("trial", "0")
        localStorage.setItem("bar_total", "0")
        localStorage.setItem("bar_correct", "0")
        return
      }
      if (e.key === 'h' || e.key === 'H') { setHelp((v) => !v); return }
      if (e.key === 'p' || e.key === 'P') { setPaused(v => !v); return }
      if (paused) return
      if (phase !== 'test') return
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return

      const rt = performance.now() - testStartRef.current
      const respChange = e.key === 'ArrowRight'
      const correct = (respChange === changeRef.current)

      if (correct) {
        let add = POINTS_CORRECT + (rt <= FAST_BONUS_MS ? FAST_BONUS : 0)
        const newPts = points + add
        const oldRank = rankFor(points)
        const newRank = rankFor(newPts)
        setPoints(newPts)
        toneRef.current?.beep(880, 120, 0.18)
        if (newRank !== oldRank) {
          setToast(`Rank up → ${newRank}`)
          toneRef.current?.chord([1046, 1318, 1568], 220, 0.16)
          setTimeout(() => setToast(null), 1200)
        }
        setBarCorrect(c => c + 1)
      } else {
        toneRef.current?.beep(220, 160, 0.2)
      }
      setBarTotal(t => t + 1)
      setTrial(t => t + 1)

      // Staircase every 20
      setTimeout(() => {
        if ((barTotal + 1) % BLOCK_SIZE === 0) {
          const acc = (barCorrect + (correct ? 1 : 0)) / BLOCK_SIZE
          const next = acc >= 0.9 ? Math.min(SET_MAX, setSize + 2) : Math.max(SET_MIN, setSize - 1)
          setSetSize(next)
          setBarCorrect(0); setBarTotal(0)
          setToast(`Block complete — accuracy ${(acc * 100).toFixed(1)}%  ·  New set size → ${next}`)
          setTimeout(() => setToast(null), 1500)
        }
      // On each question, answer save data
      localStorage.setItem("set_size", JSON.stringify(setSize))
      localStorage.setItem("points", JSON.stringify(points))
      localStorage.setItem("trial", JSON.stringify(trial))
      localStorage.setItem("bar_total", JSON.stringify(barTotal))
      localStorage.setItem("bar_correct", JSON.stringify(barCorrect))
        startTrial()
      }, 40)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, help, paused, points, setSize, barTotal, barCorrect])

  // Kick off first trial when help dismissed
  useEffect(() => { if (!help && phase === 'idle') startTrial() }, [help])

  return (
    <div className="min-h-screen bg-neutral-100 text-neutral-900 flex items-center justify-center p-6">
      <div className="w-[1100px] max-w-full rounded-2xl shadow-sm border border-neutral-200 bg-white">
        <div className="px-6 py-4 border-b border-neutral-200 flex items-center justify-between">
          <div className="font-mono text-sm tracking-tight">VWM Training · blurred bars</div>
        </div>
        <div className="p-4">
          <canvas ref={canvasRef} width={1024} height={700} className="w-full rounded-xl border border-neutral-200 bg-neutral-200" />
          <div className="mt-3 flex items-center justify-between text-xs text-neutral-600 font-mono">
            <div>LEFT = Different · RIGHT = Same · H = Help · P = Pause</div>
            <div>Fix {FIX_MS} · Pre {PRE_BLANK_MS} · Mem {MEM_MS} · ISI {ISI_MS} · Resp {RESP_WINDOW_MS}</div>
          </div>
        </div>
      </div>
    </div>
  )
}
