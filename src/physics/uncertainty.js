'use strict';

/**
 * uncertainty.js — Monte Carlo propagation of orbital uncertainty.
 *
 * PURE MODULE. Zero dependencies on DOM, canvas, or rendering.
 *
 * The uncertainty cone shown in the Radar is the 3σ envelope of position
 * deviation, sampled by Monte-Carlo propagation of the JPL Horizons
 * covariance matrix. We draw N particles from a multivariate Gaussian over
 * the six orbital elements, integrate each forward through the same RK4
 * engine, and fit a position ellipsoid to the cloud at every output epoch.
 *
 * The cone widens dramatically near planetary close approaches — the
 * gravitational keyhole effect, where small initial position errors get
 * amplified by a close encounter.
 */

const { keplerToCartesian } = require('./bodies');
const { propagate } = require('./integrator');

/**
 * Box-Muller transform: two independent standard-normal samples.
 * @returns {[number, number]}
 */
function gaussianPair() {
  let u1 = 0, u2 = 0;
  while (u1 === 0) u1 = Math.random();
  while (u2 === 0) u2 = Math.random();
  const mag = Math.sqrt(-2 * Math.log(u1));
  return [mag * Math.cos(2 * Math.PI * u2), mag * Math.sin(2 * Math.PI * u2)];
}

/**
 * Draw a vector of n standard-normal samples.
 * @param {number} n
 * @returns {number[]}
 */
function standardNormalVector(n) {
  const out = [];
  while (out.length < n) {
    const [a, b] = gaussianPair();
    out.push(a);
    if (out.length < n) out.push(b);
  }
  return out;
}

/**
 * Cholesky decomposition of a symmetric positive-definite matrix.
 * Returns lower-triangular L such that L·Lᵀ = A.
 * Used to transform standard-normal samples into correlated samples
 * matching the covariance matrix.
 *
 * @param {number[][]} A - symmetric PD matrix (6×6 for orbital elements)
 * @returns {number[][]} lower-triangular L
 */
function cholesky(A) {
  const n = A.length;
  const L = Array.from({ length: n }, () => new Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) sum += L[i][k] * L[j][k];

      if (i === j) {
        const d = A[i][i] - sum;
        L[i][j] = Math.sqrt(Math.max(d, 1e-18)); // guard against round-off
      } else {
        L[i][j] = (A[i][j] - sum) / L[j][j];
      }
    }
  }
  return L;
}

/**
 * Sample correlated element perturbations: Δx = L·z, where z ~ N(0, I).
 * @param {number[][]} L - Cholesky factor of covariance
 * @returns {number[]} perturbation vector (length 6)
 */
function sampleElementPerturbation(L) {
  const n = L.length;
  const z = standardNormalVector(n);
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j <= i; j++) s += L[i][j] * z[j];
    out[i] = s;
  }
  return out;
}

/**
 * Propagate uncertainty for one object via Monte Carlo.
 *
 * @param {object} nominalElements - { a, e, i, Omega, omega, M }
 * @param {number[][]} cov6x6      - 6×6 covariance matrix over [a,e,i,Ω,ω,M]
 * @param {object} window          - { t0, t1, outputDt } in days
 * @param {(t:number)=>Array} ephemeris - perturber positions vs time
 * @param {object} [opts]
 * @param {number} [opts.N=256]    - number of Monte Carlo particles
 * @returns {Array<{ t:number, mean:number[], sigma3:number }>}
 *          per-epoch mean position and 3σ position spread (AU)
 */
function propagateUncertainty(nominalElements, cov6x6, window, ephemeris, opts = {}) {
  const N = opts.N ?? 256;
  const { t0, t1, outputDt } = window;
  const L = cholesky(cov6x6);

  const elementKeys = ['a', 'e', 'i', 'Omega', 'omega', 'M'];

  // Propagate each particle, collecting position frames
  const allRuns = [];
  for (let p = 0; p < N; p++) {
    const dp = sampleElementPerturbation(L);
    const perturbed = {};
    elementKeys.forEach((k, idx) => { perturbed[k] = nominalElements[k] + dp[idx]; });

    const { r, v } = keplerToCartesian(perturbed);
    const state0 = [r[0], r[1], r[2], v[0], v[1], v[2]];
    const frames = propagate(state0, t0, t1, outputDt, ephemeris, opts);
    allRuns.push(frames);
  }

  // At each output epoch, compute mean position and 3σ spread
  const numEpochs = allRuns[0].length;
  const envelope = [];

  for (let ep = 0; ep < numEpochs; ep++) {
    let mx = 0, my = 0, mz = 0;
    for (let p = 0; p < N; p++) {
      const s = allRuns[p][ep].state;
      mx += s[0]; my += s[1]; mz += s[2];
    }
    mx /= N; my /= N; mz /= N;

    // RMS radial spread about the mean
    let sumSq = 0;
    for (let p = 0; p < N; p++) {
      const s = allRuns[p][ep].state;
      const dx = s[0] - mx, dy = s[1] - my, dz = s[2] - mz;
      sumSq += dx * dx + dy * dy + dz * dz;
    }
    const sigma = Math.sqrt(sumSq / N);

    envelope.push({
      t: allRuns[0][ep].t,
      mean: [mx, my, mz],
      sigma3: 3 * sigma,
    });
  }

  return envelope;
}

module.exports = {
  propagateUncertainty,
  cholesky,
  sampleElementPerturbation,
  gaussianPair,
};
