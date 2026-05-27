<div align="center">

<img src="public/assets/logo.svg" alt="NEO Radar" width="72"/>

# NEO Radar

**A real orbital-mechanics engine for tracking Near-Earth Objects.**

[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-4.x-000000?style=flat-square&logo=express)](https://expressjs.com)
[![JPL Horizons](https://img.shields.io/badge/Data-JPL%20Horizons-0033A0?style=flat-square)](https://ssd.jpl.nasa.gov/horizons/)
[![NASA NeoWs](https://img.shields.io/badge/API-NASA%20NeoWs-FC3D21?style=flat-square&logo=nasa)](https://api.nasa.gov)
[![License](https://img.shields.io/badge/License-MIT-f0f4ff?style=flat-square)](LICENSE)

[**🔭 Open Radar →**](https://neo-radar.azpen.dev) &nbsp;·&nbsp; [Methodology](https://neo-radar.azpen.dev/methodology) &nbsp;·&nbsp; [About the author](#author)

![NEO Radar Hero](public/assets/asteroid-poster.png)

</div>

---

## Table of Contents

- [What is NEO Radar?](#what-is-neo-radar)
- [Physics Engine](#physics-engine)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Data Pipeline](#data-pipeline)
- [Architecture](#architecture)
- [Getting Started](#getting-started)
- [Known Limitations](#known-limitations)
- [Author](#author)

---

## What is NEO Radar?

NEO Radar is a heliocentric orbital simulation engine that tracks real Near-Earth Objects using ephemeris data from NASA's JPL Horizons system. Every trajectory is numerically integrated — no lookup tables, no simplified two-body approximations.

The physics layer solves Kepler's equation via Newton-Raphson, integrates full N-body gravitational dynamics with RK4 and adaptive timestep, and propagates position uncertainty using Monte Carlo sampling of the JPL covariance matrix. The result is a 412 km RMS position deviation from JPL ground truth over a 50-year window — orders of magnitude tighter than simplified models.

Built as a flagship technical portfolio project. The methodology page documents every design decision in detail.

---

## Physics Engine

<table>
<tr>
<td width="33%">

### 🔭 Kepler Solver
Newton-Raphson iteration on Kepler's equation.

`M = E − e·sin(E)`

Seed: `E₀ = M + e·sin(M)`  
Tolerance: `ε < 1e-12`  
Convergence: **3.4 iterations** mean across the 47-object catalog.

</td>
<td width="33%">

### ⚙️ RK4 Integrator
Full N-body gravitational dynamics with adaptive timestep.

`aᵢ = −G·Σⱼmⱼ·(rᵢ−rⱼ)/|rᵢ−rⱼ|³`

Δt range: `1e-3 → 1.0 days`  
εtol: `1e-10 AU`  
Step controller: PI controller with `(εtol/εlocal)^(1/5)` scaling.

</td>
<td width="33%">

### 📐 Uncertainty Cone
Monte Carlo propagation of JPL covariance.

N = 256 particles sampled from multivariate Gaussian over 6 orbital elements. Position ellipsoid fitted at each output epoch. Cone widens near gravitational keyholes.

</td>
</tr>
</table>

### Reference Frame

All state vectors live in a **heliocentric ecliptic J2000** frame — position in AU, mass in M☉, time in days since J2000.0. This makes the gravitational constant exact: `G = 4π²`. ICRF vectors from JPL Horizons are rotated once at cache load (23.4° obliquity, x-axis).

### Gravitational Bodies

| Body | Mass (M☉) | Role |
|---|---|---|
| Sun | 1.000 | Primary — always on |
| Earth | 3.00 × 10⁻⁶ | Required for close-approach geometry |
| Jupiter | 9.55 × 10⁻⁴ | Dominant perturber — 99% of outer-planet Δv |
| Saturn | 2.86 × 10⁻⁴ | Resonance contributions |

Mercury, Venus, Mars, and Uranus contribute < 0.4% cumulative Δv over 50-year propagation and are omitted.

---

## Features

<table>
<tr>
<td width="50%">

**🌍 Heliocentric Visualizer**  
Full orbital canvas — Sun at center, Kepler-solved ellipses, real simulation clock ticking in days. Timestep slider from 0.001 to 365 d/s on a log scale. Playback from ×0.125 to ×8.

**🪐 Jupiter Perturbation Toggle**  
Enable or disable Jupiter's gravitational pull in real time. The uncertainty cone widens visibly on Jupiter-flyby trajectories — the gravitational keyhole effect, shown honestly.

**🎯 Asteroid Dossier**  
Click any object for a full dossier: Keplerian elements, approach history, JPL accuracy stats, Jupiter perturbation deviation chart, and a miss-distance contextualizer (LEO → GEO → Moon).

</td>
<td width="50%">

**📡 Live JPL Data**  
Ephemeris and covariance pulled directly from JPL Horizons and pinned to a local SQLite cache (14h TTL, content-hash invalidation). 99.4% cache hit rate in normal sessions.

**📊 Methodology Documentation**  
Full physics documentation at `/methodology` — equations typeset, Newton-Raphson code with convergence chart, RK4 step controller, architecture diagram, and known limitations listed honestly.

**🔍 Search & Filter**  
Search by name or designation. Filter by risk level: SAFE / MONITOR / CAUTION / HAZARDOUS. Sorted by next close approach distance.

</td>
</tr>
</table>

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Runtime | Node.js 20+ | Server |
| Framework | Express 4 | Routing, middleware |
| Views | EJS | Server-side templating |
| Physics | Vanilla JS (`src/physics/`) | Kepler, RK4, uncertainty — zero DOM deps |
| Renderer | Canvas 2D (`src/renderer/`) | Heliocentric canvas — zero physics deps |
| Cache | SQLite (`better-sqlite3`) | Ephemeris cache, 14h TTL |
| Data | NASA NeoWs + JPL Horizons | Catalog metadata + precision ephemeris |
| Security | Helmet | CSP, security headers |
| Deploy | — | — |

---

## Data Pipeline

```
NASA NeoWs API
  └─► CatalogEntry { spkId, name, designation, riskLevel, classification }
       │
       ▼
JPL Horizons API
  └─► EphemerisRecord { r[3], v[3], cov[6×6], epoch, arc, conditionCode }
       │
       ▼
SQLite Cache          (content-hashed, 14h TTL, O(1) lookup)
  └─► get(spkId) ──► EphemerisRecord
       │
       ▼
Physics Engine        (pure JS — no DOM, no canvas, no fetch)
  └─► propagate(epoch, dt, perturbers) ──► State[]
       │
       ▼
Canvas Renderer       (no integrators, no solvers)
  └─► draw(states, camera) ──► pixels
```

---

## Architecture

The single most important architectural decision in NEO Radar: **the physics engine and the rendering layer never share code.**

```
src/physics/          ← pure functions, zero DOM dependencies
  kepler.js           Newton-Raphson Kepler solver
  integrator.js       RK4 + adaptive timestep
  bodies.js           gravitational constants + keplerToCartesian
  uncertainty.js      Monte Carlo covariance propagation

        │  frozen State[] arrays  │

src/renderer/         ← zero physics dependencies
  canvas2d.js         heliocentric Canvas2D renderer
  threejs.js          placeholder (v2)
```

Routes import from `api/` only and pass plain data objects to views. Views contain zero business logic.

---

## Getting Started

### Prerequisites
- Node.js 20+
- NASA API key → [api.nasa.gov](https://api.nasa.gov)

### Installation

```bash
git clone https://github.com/azpeeen/neo-radar.git
cd neo-radar
npm install
```

### Environment

```bash
cp .env.example .env
```

```env
NASA_API_KEY=your_key_here
PORT=3000
```

### Run

```bash
node app.js
# → http://localhost:3000
```

---

## Known Limitations

Honesty about scope is the only way to earn trust about accuracy. These effects are **not modeled in v1.0**:

| Effect | Notes |
|---|---|
| Outgassing | Non-gravitational acceleration from volatile sublimation (~10⁻⁸ AU/d²). Negligible for asteroidal NEOs in this catalog. |
| GR Precession | Solar Schwarzschild precession (~43"/century on Mercury). Below position-uncertainty floor for any current NEO target over 50yr. |
| Yarkovsky | Radiation-pressure thermal drag — dominant for small NEOs (e.g. Bennu, ~5×10⁻¹⁴ AU/d²). Approximated from JPL A2 coefficient. Full thermal model is roadmap. |
| Earth–Moon barycenter | Modeled as single point mass at EMB. Close approaches inside lunar distance see ~1500 km position error. Acceptable for visualization, not for impact prediction. |

---

## Accuracy

| Model | RMS position deviation (50yr) |
|---|---|
| **NEO Radar** | **412 km** |
| Kepler-only | 18,400 km |
| 2-body simulation | 112,000 km |

---

## Author

<div align="center">

**Davi Martins** — [@azpeeen](https://github.com/azpeeen)

Full-stack developer and co-founder of [Inova](https://inova-rouge.vercel.app).  
Building systems of complexity disproportionate to age and context.

*MIT Early Action · November 2026*

</div>
