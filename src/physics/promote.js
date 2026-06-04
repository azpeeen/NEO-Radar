'use strict';

/**
 * promote.js — "Promote" a catalog asteroid to full RK4 N-body.
 *
 * PURE MODULE. No DOM, canvas, or network I/O.
 *
 * When a user clicks any of the 41k MPC background objects, this module
 * is invoked ONCE to:
 *   1. Convert the Keplerian elements to a Cartesian state at the
 *      requested epoch (advancing M from catalog epoch).
 *   2. Run the adaptive RK4 integrator with Sun + 5 planets as
 *      perturbers — exactly the same engine used by the 47 tracked NEOs.
 *   3. Detect the closest approach to Earth over the propagation window.
 *   4. Estimate trajectory uncertainty via Monte Carlo (N=64 clones).
 *
 * All computation is synchronous; the caller should run this in a
 * background fashion (route handler) and return JSON to the browser.
 */

const { keplerToCartesian, G, BODIES, orbitalPeriod } = require('./bodies');
const { propagate }                                    = require('./integrator');
const { ephemerisAt, planetPositions, PLANET_ELEMENTS, MEAN_MOTIONS } = require('./ephemeris');

const J2000_JD       = 2451545.0;
const DAYS_PER_YEAR  = 365.25;
const AU_TO_KM       = 1.495978707e8;
const DAYS_TO_S      = 86400;
const G_AU_MSUN_D2   = (4 * Math.PI * Math.PI) / (DAYS_PER_YEAR * DAYS_PER_YEAR);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Julian Date → days since J2000.0 */
function jdToJ2000(jd) { return jd - J2000_JD; }

/**
 * Compute Earth's heliocentric state [x,y,z,vx,vy,vz] at time t (J2000 days).
 */
function earthStateAt(t) {
  const el = PLANET_ELEMENTS.earth;
  const M  = el.M0 + MEAN_MOTIONS.earth * t;   // degrees
  return keplerToCartesian({ ...el, M });
}

/**
 * Build a Cartesian state vector for an MPC asteroid at a target JD.
 * Advances M from catalog epoch using Kepler's third law (Keplerian approx).
 *
 * @param {object} ast        MPC element record { a, e, i, w, node, M, epoch_jd }
 * @param {number} targetJD   Julian Date for which state is wanted
 * @returns {number[]} [x,y,z,vx,vy,vz] heliocentric (AU, AU/day)
 */
function stateAtJD(ast, targetJD) {
  const dt = targetJD - ast.epoch_jd;
  const n_deg = 0.9856076686 / Math.pow(ast.a, 1.5); // deg/day (Gaussian)
  let M = (ast.M + n_deg * dt) % 360;
  if (M < 0) M += 360;

  const { r, v } = keplerToCartesian({
    a: ast.a, e: ast.e, i: ast.i,
    Omega: ast.node, omega: ast.w, M,
  });
  return [r[0], r[1], r[2], v[0], v[1], v[2]];
}

/**
 * Find the epoch of minimum Earth distance within a set of propagation frames.
 *
 * @param {Array<{t:number, state:number[]}>} frames  integrator output
 * @returns {{ idx:number, dist_AU:number, t_j2000:number, rel_vel_kms:number }}
 */
function findCloseApproach(frames) {
  let minDist = Infinity, minIdx = 0;

  for (let k = 0; k < frames.length; k++) {
    const s = frames[k].state;
    const { r: re, v: ve } = earthStateAt(frames[k].t);

    const dx = s[0] - re[0];
    const dy = s[1] - re[1];
    const dz = s[2] - re[2];
    const d  = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (d < minDist) {
      minDist = d;
      minIdx  = k;
    }
  }

  const t_ca = frames[minIdx].t;
  const s_ca = frames[minIdx].state;
  const { r: re_ca, v: ve_ca } = earthStateAt(t_ca);

  // Relative velocity |v_ast − v_earth| in km/s
  const dvx = s_ca[3] - ve_ca[0];
  const dvy = s_ca[4] - ve_ca[1];
  const dvz = s_ca[5] - ve_ca[2];
  const rel_vel_AU_day = Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz);
  const rel_vel_kms    = rel_vel_AU_day * AU_TO_KM / DAYS_TO_S;

  return {
    idx:        minIdx,
    dist_AU:    minDist,
    dist_LD:    minDist / 0.00257,   // 1 LD ≈ 0.00257 AU
    t_j2000:    t_ca,
    jd:         t_ca + J2000_JD,
    rel_vel_kms,
  };
}

/**
 * Promote an MPC asteroid to full RK4 N-body and compute trajectory,
 * close-approach, and uncertainty envelope.
 *
 * @param {object} ast           MPC element record
 * @param {number} currentJD     Current Julian Date (sim time)
 * @param {object} [opts]
 * @param {number} [opts.backYears=2]   backward window (years)
 * @param {number} [opts.fwdYears=5]    forward window (years)
 * @param {number} [opts.outputDt=1]    trajectory cadence (days)
 * @param {number} [opts.N_MC=64]       Monte Carlo clones
 * @returns {object}  { trajectory, t0_j2000, t1_j2000, closeApproach, uncertainty }
 */
function promoteAsteroid(ast, currentJD, opts) {
  opts = opts || {};
  const backYears = opts.backYears ?? 2;
  const fwdYears  = opts.fwdYears  ?? 5;
  const outputDt  = opts.outputDt  ?? 1;    // days
  const N_MC      = opts.N_MC      ?? 64;

  // Propagation window in JD
  const t0_jd = currentJD - backYears * DAYS_PER_YEAR;
  const t1_jd = currentJD + fwdYears  * DAYS_PER_YEAR;

  // Convert to J2000 time axis used by the integrator
  const t0 = jdToJ2000(t0_jd);
  const t1 = jdToJ2000(t1_jd);

  // Initial state at the start of the window
  const state0 = stateAtJD(ast, t0_jd);

  // ── Nominal RK4 propagation ───────────────────────────────────────────────
  const frames = propagate(state0, t0, t1, outputDt, ephemerisAt);

  // Extract XY positions for the browser to draw (skip Z for 2-D canvas)
  const trajectory = frames.map(f => [f.state[0], f.state[1], f.state[2]]);

  // ── Close approach detection ──────────────────────────────────────────────
  const ca = findCloseApproach(frames);

  // Convert t_j2000 → calendar date
  const caDate = new Date((J2000_JD - 2440587.5 + ca.t_j2000) * 86400000);
  ca.date = caDate.toISOString().slice(0, 10);

  // ── Monte Carlo uncertainty ───────────────────────────────────────────────
  // Element uncertainties (conservative, based on MPC catalog quality).
  // Real covariances are unavailable for most MPC objects, so we use
  // small but physically motivated perturbations.
  const sig_a    = ast.a     * 5e-5;   // 50 ppm in a
  const sig_e    = 5e-6;               // tiny eccentricity scatter
  const sig_i    = 5e-4;               // deg
  const sig_node = 1e-3;               // deg
  const sig_w    = 1e-3;               // deg
  const sig_M    = 0.05;               // deg (dominant scatter source)

  // Propagate each clone to the close-approach epoch for efficiency
  const t_ca_jd    = ca.jd;
  const t_ca_j2000 = jdToJ2000(t_ca_jd);

  const caPositions = [];

  for (let p = 0; p < N_MC; p++) {
    const perturbed = {
      ...ast,
      a:    Math.max(0.1, ast.a    + sig_a    * (Math.random() - 0.5) * 2),
      e:    Math.max(0,   Math.min(0.999,
                          ast.e    + sig_e    * (Math.random() - 0.5) * 2)),
      i:    ast.i    + sig_i    * (Math.random() - 0.5) * 2,
      node: ast.node + sig_node * (Math.random() - 0.5) * 2,
      w:    ast.w    + sig_w    * (Math.random() - 0.5) * 2,
      M:    ast.M    + sig_M    * (Math.random() - 0.5) * 2,
    };

    const s0 = stateAtJD(perturbed, t0_jd);
    // Only integrate to close approach (much faster than full window)
    const cloneFrames = propagate(s0, t0, t_ca_j2000, outputDt, ephemerisAt);
    if (cloneFrames.length > 0) {
      const last = cloneFrames[cloneFrames.length - 1].state;
      caPositions.push([last[0], last[1], last[2]]);
    }
  }

  // 3σ position spread at close approach epoch
  let sigma3_AU = 0;
  if (caPositions.length > 1) {
    let mx = 0, my = 0, mz = 0;
    for (const p of caPositions) { mx += p[0]; my += p[1]; mz += p[2]; }
    mx /= caPositions.length; my /= caPositions.length; mz /= caPositions.length;

    let sumSq = 0;
    for (const p of caPositions) {
      const dx = p[0] - mx, dy = p[1] - my, dz = p[2] - mz;
      sumSq += dx * dx + dy * dy + dz * dz;
    }
    sigma3_AU = 3 * Math.sqrt(sumSq / caPositions.length);
  }

  return {
    trajectory,            // Array of [x,y,z] in AU (heliocentric ecliptic)
    t0_j2000: t0,
    t1_j2000: t1,
    outputDt,
    closeApproach: {
      date:        ca.date,
      jd:          ca.jd,
      t_j2000:     ca.t_j2000,
      dist_AU:     ca.dist_AU,
      dist_LD:     ca.dist_LD,
      rel_vel_kms: ca.rel_vel_kms,
    },
    uncertainty: {
      sigma3_AU,
      caPositions,          // sample positions at CA for cone drawing
    },
  };
}

module.exports = { promoteAsteroid, stateAtJD, findCloseApproach, jdToJ2000 };
