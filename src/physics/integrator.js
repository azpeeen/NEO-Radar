'use strict';

/**
 * integrator.js — RK4 N-body integrator with adaptive timestep.
 *
 * PURE MODULE. Zero dependencies on DOM, canvas, or rendering.
 *
 * Integrates the full Newtonian N-body acceleration:
 *     aᵢ = −G · Σⱼ≠ᵢ mⱼ · (rᵢ − rⱼ) / |rᵢ − rⱼ|³
 *
 * Timestep is chosen per-step from local truncation error: one RK4 step at
 * Δt is compared against two steps at Δt/2. Step contracts toward 1e-3 d
 * inside a planet's Hill sphere and stays at 1.0 d in interplanetary space.
 */

const { G, BODIES } = require('./bodies');

const DT_MIN = 1e-3;   // days
const DT_MAX = 1.0;    // days
const EPS_TOL = 1e-10; // AU — local truncation error tolerance
const SOFTENING = 1e-9; // AU² — avoids singularity at r→0

/**
 * A "system" is the set of massive perturbers plus the massless test body.
 * State layout for a single test particle: [x, y, z, vx, vy, vz].
 * Perturber positions are supplied as a function of time (ephemeris) so the
 * integrator stays pure and never fetches data itself.
 */

/**
 * Compute gravitational acceleration on a test particle at position r,
 * given an array of perturbers each with { mass, pos: [x,y,z] }.
 *
 * @param {number[]} pos        - test particle position [x,y,z] (AU)
 * @param {Array<{mass:number, pos:number[]}>} perturbers
 * @returns {number[]} acceleration [ax, ay, az] (AU/day²)
 */
function acceleration(pos, perturbers) {
  let ax = 0, ay = 0, az = 0;

  for (let k = 0; k < perturbers.length; k++) {
    const m = perturbers[k].mass;
    const p = perturbers[k].pos;

    const dx = p[0] - pos[0];
    const dy = p[1] - pos[1];
    const dz = p[2] - pos[2];

    const r2 = dx * dx + dy * dy + dz * dz + SOFTENING;
    const r = Math.sqrt(r2);
    const inv = G * m / (r2 * r);   // G·m / r³

    ax += inv * dx;
    ay += inv * dy;
    az += inv * dz;
  }

  return [ax, ay, az];
}

/**
 * Single RK4 step for a 6-element state [x,y,z,vx,vy,vz].
 * Perturber positions are evaluated via the supplied ephemeris(t) function,
 * which returns the perturbers array at a given time.
 *
 * @param {number[]} state   - [x,y,z,vx,vy,vz]
 * @param {number} t         - current time (days)
 * @param {number} dt        - step size (days)
 * @param {(t:number)=>Array} ephemeris - returns perturbers at time t
 * @returns {number[]} new state after one step
 */
function rk4Step(state, t, dt, ephemeris) {
  const deriv = (s, tt) => {
    const pos = [s[0], s[1], s[2]];
    const a = acceleration(pos, ephemeris(tt));
    return [s[3], s[4], s[5], a[0], a[1], a[2]];
  };

  const add = (s, k, h) => s.map((v, idx) => v + k[idx] * h);

  const k1 = deriv(state, t);
  const k2 = deriv(add(state, k1, dt / 2), t + dt / 2);
  const k3 = deriv(add(state, k2, dt / 2), t + dt / 2);
  const k4 = deriv(add(state, k3, dt), t + dt);

  return state.map((v, idx) =>
    v + (dt / 6) * (k1[idx] + 2 * k2[idx] + 2 * k3[idx] + k4[idx])
  );
}

/**
 * Position residual between two states (Euclidean, position only).
 */
function positionError(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Adaptive RK4 step. Runs one full step and two half-steps, compares
 * position residual, and accepts or shrinks dt accordingly.
 *
 * PI step controller:  Δtnew = 0.9 · Δt · (εtol / εlocal)^(1/5)
 *
 * @param {number[]} state
 * @param {number} t
 * @param {number} dt          - proposed step (days)
 * @param {(t:number)=>Array} ephemeris
 * @param {object} [opts]
 * @returns {{ state: number[], t: number, dt: number, dtNext: number }}
 */
function adaptiveStep(state, t, dt, ephemeris, opts = {}) {
  const tol = opts.tol ?? EPS_TOL;
  const dtMin = opts.dtMin ?? DT_MIN;
  const dtMax = opts.dtMax ?? DT_MAX;

  let h = Math.max(dtMin, Math.min(dtMax, dt));

  for (let attempt = 0; attempt < 12; attempt++) {
    const full = rk4Step(state, t, h, ephemeris);
    const half1 = rk4Step(state, t, h / 2, ephemeris);
    const half2 = rk4Step(half1, t + h / 2, h / 2, ephemeris);

    const err = positionError(full, half2);

    if (err <= tol || h <= dtMin) {
      // Accept. Use the more accurate two-half-step result.
      const factor = err > 0
        ? 0.9 * Math.pow(tol / err, 0.2)
        : 4.0;
      const dtNext = Math.max(dtMin, Math.min(dtMax, h * factor));
      return { state: half2, t: t + h, dt: h, dtNext };
    }

    // Reject — shrink and retry.
    h = Math.max(dtMin, h * 0.5);
  }

  // Fell through at minimum step — accept what we have.
  const half1 = rk4Step(state, t, dtMin / 2, ephemeris);
  const half2 = rk4Step(half1, t + dtMin / 2, dtMin / 2, ephemeris);
  return { state: half2, t: t + dtMin, dt: dtMin, dtNext: dtMin };
}

/**
 * Propagate a test particle from t0 to t1, emitting state at fixed output
 * epochs. Internally uses adaptive substeps; output is sampled at the
 * requested cadence.
 *
 * @param {number[]} state0    - initial [x,y,z,vx,vy,vz]
 * @param {number} t0          - start time (days)
 * @param {number} t1          - end time (days)
 * @param {number} outputDt    - output sampling cadence (days)
 * @param {(t:number)=>Array} ephemeris
 * @param {object} [opts]
 * @returns {Array<{ t:number, state:number[] }>} frozen output frames
 */
function propagate(state0, t0, t1, outputDt, ephemeris, opts = {}) {
  const frames = [];
  let state = state0.slice();
  let t = t0;
  let dt = opts.dt0 ?? DT_MAX;

  let nextOut = t0;
  while (t < t1) {
    if (t >= nextOut) {
      frames.push({ t, state: Object.freeze(state.slice()) });
      nextOut += outputDt;
    }
    // Don't overshoot the end
    const remaining = t1 - t;
    const step = Math.min(dt, remaining);
    const res = adaptiveStep(state, t, step, ephemeris, opts);
    state = res.state;
    t = res.t;
    dt = res.dtNext;
  }
  frames.push({ t, state: Object.freeze(state.slice()) });
  return frames;
}

module.exports = {
  acceleration,
  rk4Step,
  adaptiveStep,
  propagate,
  positionError,
  DT_MIN, DT_MAX, EPS_TOL,
};
