'use strict';

/**
 * secular.js — Laplace-Lagrange secular perturbation theory.
 *
 * PURE MODULE. Zero dependencies on DOM, canvas, or fetching.
 * Dual-environment: works in Node.js (require) and browser (inline script).
 *
 * Computes slow secular precession of ω and Ω for each asteroid
 * due to Jupiter and Saturn. Rates are pre-computed ONCE per asteroid
 * at load time; per-frame cost is O(1) — just two additions.
 *
 * Theory: Laplace-Lagrange secular disturbing function, first-order.
 * Reference: Murray & Dermott, Solar System Dynamics, §7.4.
 */

// Perturbing planets (masses in M_sun, semi-major axes in AU)
var _SEC_PLANETS = [
  { name: 'Jupiter', a: 5.204267, m: 9.55e-4  },
  { name: 'Saturn',  a: 9.582017, m: 2.86e-4  },
];

var _TWO_OVER_PI = 2 / Math.PI;

/**
 * Laplace coefficient b_s^{(j)}(α) by composite Simpson quadrature.
 *
 *   b_s^{(j)}(α) = (2/π) ∫₀^π cos(jθ) / (1 − 2α cos θ + α²)^s dθ
 *
 * For j=1, s=3/2 this is the coefficient that governs the leading-order
 * secular coupling between two co-planar orbits.
 *
 * Evaluated with n=64 intervals (65 points) — accuracy ≫ 1 ppm for α<0.95.
 *
 * @param {number} alpha  orbital ratio = min(a, a_p) / max(a, a_p)  [0, 1)
 * @param {number} s      exponent (1.5 for secular theory)
 * @param {number} j      harmonic order (1 for perihelion precession)
 * @param {number} [n=64] number of Simpson intervals (must be even)
 * @returns {number}
 */
function laplaceCoeff(alpha, s, j, n) {
  n = (n && n % 2 === 0) ? n : 64;
  var h = Math.PI / n;
  var a2 = alpha * alpha;
  var sum = 0;
  for (var k = 0; k <= n; k++) {
    var theta    = k * h;
    var cosT     = Math.cos(theta);
    var denom    = Math.pow(1 - 2 * alpha * cosT + a2, s);
    var f        = Math.cos(j * theta) / denom;
    var w = (k === 0 || k === n) ? 1 : (k % 2 === 0 ? 2 : 4);
    sum += w * f;
  }
  return _TWO_OVER_PI * (h / 3) * sum;
}

/**
 * Compute secular perihelion and node precession rates for one asteroid.
 * Call ONCE per asteroid at load time; cache the result on the object.
 *
 * Formula (first-order secular theory, inner-body case a < a_planet):
 *
 *   dϖ/dt = Σ_j (3/4) · n_ast · m_j · α_j³ · b_{3/2}^{(1)}(α_j)
 *
 * where α_j = a_ast / a_j  (asteroid inside planet → α < 1).
 * Node precesses at equal magnitude, opposite sign (retrograde).
 *
 * @param {object} ast  { a, e, i, w, node, H, epoch_jd }
 * @returns {{ dperi_dt: number, dnode_dt: number }}  rates in rad/day
 */
function computeSecularRates(ast) {
  var a = ast.a;
  if (!a || a <= 0 || !isFinite(a)) return { dperi_dt: 0, dnode_dt: 0 };

  // Asteroid mean motion (rad/day): n = 2π / T = 2π / (365.25 · a^1.5)
  var n_ast = (2 * Math.PI) / (365.25 * Math.pow(a, 1.5));

  var dperi_dt = 0;

  for (var k = 0; k < _SEC_PLANETS.length; k++) {
    var planet = _SEC_PLANETS[k];
    var a_j = planet.a;
    var m_j = planet.m;

    // α = a/a_j if asteroid is inside planet's orbit (all NEAs are)
    var alpha = a < a_j ? a / a_j : a_j / a;
    if (alpha >= 1) alpha = 0.9999; // guard against resonance singularity

    var b = laplaceCoeff(alpha, 1.5, 1, 64);

    // dϖ/dt contribution (rad/day)
    dperi_dt += (3 / 4) * n_ast * m_j * Math.pow(alpha, 3) * b;
  }

  return { dperi_dt: dperi_dt, dnode_dt: -dperi_dt };
}

/**
 * Apply secular perturbation to obtain current effective elements.
 * Called per frame but is O(1) — two floating-point additions.
 *
 * @param {object} ast                           original elements (angles in degrees)
 * @param {{ dperi_dt:number, dnode_dt:number }} rates  from computeSecularRates
 * @param {number} dt                            time since epoch (days)
 * @returns {{ w: number, node: number }}        updated elements in degrees
 */
function applySecular(ast, rates, dt) {
  var R2D = 180 / Math.PI;
  return {
    w:    ast.w    + rates.dperi_dt * R2D * dt,
    node: ast.node + rates.dnode_dt * R2D * dt,
  };
}

// ── Self-validation (testable via: node -e "...") ─────────────────────────────
// Apophis: a=0.9224, e=0.1914, i=3.34°
// Expected dϖ/dt ≈ 4-5e-8 rad/day (precession period ~350-450 kyr)
//   const rates = computeSecularRates({ a: 0.9224, e: 0.1914, i: 3.34 });
//   console.log(rates); // { dperi_dt: ~4.4e-8, dnode_dt: ~-4.4e-8 }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { laplaceCoeff, computeSecularRates, applySecular };
}
