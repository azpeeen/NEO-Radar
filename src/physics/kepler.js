'use strict';

/**
 * kepler.js — Newton-Raphson solver for Kepler's equation.
 *
 * PURE MODULE. Zero dependencies on DOM, canvas, or rendering.
 * Communicates only through plain numbers and arrays.
 *
 * Kepler's equation (elliptical orbits):
 *     M = E − e·sin(E)
 *
 * Given mean anomaly M and eccentricity e, solve for eccentric anomaly E.
 * There is no closed-form solution, so we iterate.
 */

const TWO_PI = 2 * Math.PI;

/**
 * Normalize an angle to [−π, π] for numerical stability of the seed.
 * @param {number} angle - radians
 * @returns {number} angle wrapped to [−π, π]
 */
function wrapPi(angle) {
  let a = angle % TWO_PI;
  if (a > Math.PI) a -= TWO_PI;
  if (a < -Math.PI) a += TWO_PI;
  return a;
}

/**
 * Solve Kepler's equation M = E − e·sin(E) for E.
 *
 * Seed approximation E₀ = M + e·sin(M) is accurate to ~e² for moderate
 * eccentricity, giving quadratic convergence in 3–4 iterations for every
 * NEO in the catalog (e < 0.99).
 *
 * @param {number} M - mean anomaly (radians)
 * @param {number} e - eccentricity (0 ≤ e < 1 for elliptical orbits)
 * @param {object} [opts]
 * @param {number} [opts.tol=1e-12]    - convergence tolerance on |ΔE|
 * @param {number} [opts.maxIter=50]   - hard iteration cap
 * @returns {number} eccentric anomaly E (radians)
 * @throws {Error} if e is out of range or iteration fails to converge
 */
function solveKepler(M, e, opts = {}) {
  const tol = opts.tol ?? 1e-12;
  const maxIter = opts.maxIter ?? 50;

  if (!Number.isFinite(M) || !Number.isFinite(e)) {
    throw new Error(`solveKepler: non-finite input M=${M}, e=${e}`);
  }
  if (e < 0 || e >= 1) {
    throw new Error(`solveKepler: eccentricity out of range (0 ≤ e < 1), got e=${e}`);
  }

  const Mw = wrapPi(M);

  // Seed: E₀ = M + e·sin(M)
  let E = Mw + e * Math.sin(Mw);

  for (let i = 0; i < maxIter; i++) {
    const f  = E - e * Math.sin(E) - Mw;   // residual
    const fp = 1 - e * Math.cos(E);        // derivative
    const dE = f / fp;                       // Newton-Raphson step
    E -= dE;
    if (Math.abs(dE) < tol) return E;
  }

  throw new Error(`solveKepler: failed to converge after ${maxIter} iters (e=${e}, M=${M})`);
}

/**
 * Solve Kepler's equation and report iteration count.
 * Used by the methodology page to produce the convergence chart.
 *
 * @param {number} M - mean anomaly (radians)
 * @param {number} e - eccentricity
 * @param {object} [opts]
 * @returns {{ E: number, iterations: number, residuals: number[] }}
 */
function solveKeplerTraced(M, e, opts = {}) {
  const tol = opts.tol ?? 1e-12;
  const maxIter = opts.maxIter ?? 50;
  const Mw = wrapPi(M);

  let E = Mw + e * Math.sin(Mw);
  const residuals = [];

  for (let i = 0; i < maxIter; i++) {
    const f  = E - e * Math.sin(E) - Mw;
    const fp = 1 - e * Math.cos(E);
    const dE = f / fp;
    E -= dE;
    residuals.push(Math.abs(dE));
    if (Math.abs(dE) < tol) {
      return { E, iterations: i + 1, residuals };
    }
  }

  throw new Error(`solveKeplerTraced: failed to converge (e=${e}, M=${M})`);
}

/**
 * Convert eccentric anomaly E to true anomaly ν.
 *     ν = 2·atan2( √(1+e)·sin(E/2), √(1−e)·cos(E/2) )
 *
 * @param {number} E - eccentric anomaly (radians)
 * @param {number} e - eccentricity
 * @returns {number} true anomaly ν (radians)
 */
function trueAnomaly(E, e) {
  const halfE = E / 2;
  return 2 * Math.atan2(
    Math.sqrt(1 + e) * Math.sin(halfE),
    Math.sqrt(1 - e) * Math.cos(halfE)
  );
}

module.exports = { solveKepler, solveKeplerTraced, trueAnomaly, wrapPi };
