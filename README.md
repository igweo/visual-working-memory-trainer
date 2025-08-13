# Visual Working Memory Training

An adaptive **change‑detection** training task that uses **only blurred bar stimuli** (matching the blurred‑group condition) to train visual working memory (VWM). Implements the key timings and staircase from Wang & Qian (2020).

> **Task gist:** Brief memory array → delay → test array with a cued item; decide **Same** vs **Different** (±20° orientation change). Every 20 trials, if accuracy ≥ 90% set size increases by +2 (max 10), otherwise decreases by −1 (min 1).

---

## Features

* **HUD**: score, rank, set size, trial number
* **Progress bar** for the current 20‑trial block
* **Help overlay** (`H`) and **Pause** (`P`)
* **WebAudio** beeps + rank‑up chord (web)
* **Adaptive staircase** (1–10 items, +2/−1 rule)
* **Scoring**: +10 correct, +5 bonus if RT ≤ 600 ms; ranks: Beginner → Expert
* **Only blurred bars** for training difficulty

---

## Controls

* `LEFT` → **Same**
* `RIGHT` → **Different**
* `H` → Toggle help overlay
* `P` → Pause / resume
* `ESC` (Python version) → Quit

---

## Timings and Parameters

* Fixation: **500 ms**
* Pre‑blank: **500 ms**
* Memory array: **500 ms**
* ISI: **800 ms**
* Response window: **2500 ms**
* Orientation change: **±20°** (change trials only)
* Set size: **1–10**, adapted every **20 trials** using ≥90% rule
* Stimuli: **black oriented bars**, blurred via **Gaussian blur** (web: CSS blur; Python: PIL GaussianBlur)

> These values reflect most of the change‑detection protocol reported by Wang & Qian (2020), applied here with blurred stimuli only.

---

## Web (Next.js) — Quick Start

1. Create a Next.js app with Tailwind (recommended):

   ```bash
   npx create-next-app@latest vwm-training --ts --tailwind --eslint
   cd visual-working-memory-trainer
   ```
2. Dev run:

   ```bash
   npm run dev
   ```
3. Visit `http://localhost:3000` and use the key bindings above.

### Notes on Dependencies

* Next.js, React, Tailwind are **MIT‑licensed**. If you redistribute a packaged build or the repository, include their license notices (see **Licensing** below).

---

## Roadmap / Nice‑to‑haves

* Export per‑trial CSV (set size, change/same, correct, RT)
* Session summary (accuracy by set size, quick plots)
* Pashler’s K estimator readout
* Theme toggle (dark vs lab)
* Touch UI (Same/Different buttons) for tablets

---

## Citation / Attribution

* Wang, K., & Qian, J. (2020). **Training with high perceptual difficulty improves the capacity and fidelity of internal representation in VWM.** *Psychological Research, 85*(6), 2408–2419. [https://doi.org/10.1007/s00426-020-01404-2](https://doi.org/10.1007/s00426-020-01404-2)
This project **does not** include or reproduce any figures or text from that paper.

---

## Licensing (read this)
* **Source‑available** (**BSL 1.1**) 

If you bundle/distribute the web app, include third‑party notices for **Next.js/React/Tailwind** (MIT). If you only deploy to Vercel, you’re hosting a service (no distribution obligations), but a PUBLIC repo should still include proper license files.

> **Not legal advice.** For commercial deployments, talk to counsel if you need strong restrictions.

---

## Acknowledgements

* Built with Next.js + Tailwind.
* Sounds via WebAudio API; no external assets required.

---

## Disclaimer

This is a **research training tool**, not a medical product. No claims about clinical efficacy.

