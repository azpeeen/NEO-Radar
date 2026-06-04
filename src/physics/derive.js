'use strict';

/**
 * derive.js — Physical and orbital quantities derived from MPC elements.
 *
 * PURE MODULE. No DOM, canvas, or I/O dependencies.
 *
 * Given the six Keplerian elements (a, e, i, ω, Ω, M) and the absolute
 * magnitude H, this module extracts every physically meaningful quantity
 * that can be inferred without a full N-body integration:
 *   • orbital geometry (q, Q, P, v)
 *   • dynamical classification (Aten/Apollo/Amor/Atira, PHA)
 *   • MOID with Earth (sampled 3D geometry)
 *   • physical estimates from H (diameter, mass, impact energy)
 *   • Tisserand parameter relative to Jupiter
 *   • surface gravity and escape velocity
 */

const { keplerToCartesian, DEG2RAD } = require('./bodies');

// ── Physical constants ────────────────────────────────────────────────────────
const GM_SUN_SI    = 1.32712440018e20; // m³/s²
const AU_TO_M      = 1.495978707e11;   // m per AU
const AU_TO_KM     = 1.495978707e8;    // km per AU
const DAYS_TO_S    = 86400;
const G_AU_MSUN_D2 = (4 * Math.PI * Math.PI) / (365.25 * 365.25); // AU³ M☉⁻¹ day⁻²
const G_SI         = 6.674e-11;       // m³ kg⁻¹ s⁻²
const MSUN_KG      = 1.989e30;        // kg

// Earth J2000 mean elements (for MOID calculation)
const _EARTH = { a: 1.000000, e: 0.016709, i: 0.000013, Omega: 348.739, omega: 102.947 };

// Jupiter semi-major axis (for Tisserand)
const A_JUP = 5.204267;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Vis-viva orbital speed at distance r on orbit with semi-major axis a.
 * @param {number} a  semi-major axis (AU)
 * @param {number} r  current heliocentric distance (AU)
 * @returns {number}  speed in km/s
 */
function visViva_kms(a, r) {
  const vAUperD = Math.sqrt(G_AU_MSUN_D2 * (2 / r - 1 / a));
  return vAUperD * AU_TO_KM / DAYS_TO_S;
}

/**
 * 3-D heliocentric position on an orbit at true anomaly ν.
 * @param {object} el  { a, e, i, Omega, omega } — angles in degrees
 * @param {number} nu  true anomaly (radians)
 * @returns {number[]} [x, y, z] in AU
 */
function _orbitPoint(el, nu) {
  const { a, e } = el;
  const r  = a * (1 - e * e) / (1 + e * Math.cos(nu));
  const xP = r * Math.cos(nu);
  const yP = r * Math.sin(nu);

  const i  = el.i     * DEG2RAD;
  const W  = el.Omega * DEG2RAD;   // Ω
  const w  = el.omega * DEG2RAD;   // ω

  const cosW = Math.cos(W), sinW = Math.sin(W);
  const cosI = Math.cos(i), sinI = Math.sin(i);
  const cosw = Math.cos(w), sinw = Math.sin(w);

  const R11 =  cosW * cosw - sinW * sinw * cosI;
  const R12 = -cosW * sinw - sinW * cosw * cosI;
  const R21 =  sinW * cosw + cosW * sinw * cosI;
  const R22 = -sinW * sinw + cosW * cosw * cosI;
  const R31 =  sinw * sinI;
  const R32 =  cosw * sinI;

  return [R11 * xP + R12 * yP,
          R21 * xP + R22 * yP,
          R31 * xP + R32 * yP];
}

/**
 * Estimate the MOID (Minimum Orbit Intersection Distance) with Earth.
 * Samples N points on each orbit and finds the minimum 3-D separation.
 *
 * @param {object} ast  orbital elements of the asteroid
 * @param {number} [N=400] samples per orbit
 * @returns {number} MOID in AU
 */
function computeMOID(ast, N) {
  N = N || 400;
  const TWO_PI = 2 * Math.PI;
  const step = TWO_PI / N;

  const astPts   = [];
  const earthPts = [];

  for (let k = 0; k < N; k++) {
    const nu = k * step;
    astPts.push(_orbitPoint(ast,    nu));
    earthPts.push(_orbitPoint(_EARTH, nu));
  }

  let minD2 = Infinity;
  for (let a = 0; a < N; a++) {
    const pa = astPts[a];
    for (let e = 0; e < N; e++) {
      const pe = earthPts[e];
      const dx = pa[0] - pe[0];
      const dy = pa[1] - pe[1];
      const dz = pa[2] - pe[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < minD2) minD2 = d2;
    }
  }
  return Math.sqrt(minD2);
}

/**
 * Classify the asteroid's orbital type.
 * @param {number} a  semi-major axis (AU)
 * @param {number} e  eccentricity
 * @returns {string}  'Atira'|'Aten'|'Apollo'|'Amor'|'MBA'
 */
function classifyOrbit(a, e) {
  const q = a * (1 - e);
  const Q = a * (1 + e);
  if (Q < 0.983)              return 'Atira';   // entirely inside Earth
  if (a < 1.0)                return 'Aten';    // a < 1, Q ≥ 0.983
  if (a >= 1.0 && q < 1.017) return 'Apollo';  // a ≥ 1, q < 1.017
  if (q >= 1.017 && q < 1.3) return 'Amor';    // 1.017 ≤ q < 1.3
  return 'MBA';
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Derive all physical and orbital quantities from MPC elements.
 *
 * @param {object} ast  { a, e, i, w, node, M, H, epoch_jd }
 * @returns {object}    rich derived-data object
 */
function deriveAll(ast) {
  const { a, e, H } = ast;
  const i = ast.i || 0;

  // ── Orbital geometry ──────────────────────────────────────────────────────
  const q      = a * (1 - e);              // perihelion (AU)
  const Q      = a * (1 + e);              // aphelion  (AU)
  const P_yr   = Math.pow(a, 1.5);         // period (yr), Kepler 3rd law
  const P_days = P_yr * 365.25;
  const n_deg  = 360 / P_days;             // mean motion (deg/day)

  // Vis-viva velocities
  const v_avg_kms  = visViva_kms(a, a);    // at mean distance ≈ a
  const v_peri_kms = visViva_kms(a, q);    // at perihelion
  const v_aph_kms  = visViva_kms(a, Q);    // at aphelion

  // Specific orbital energy (J/kg): ε = −GM / 2a
  const energy_J_kg = -(GM_SUN_SI / (2 * a * AU_TO_M));

  // Specific angular momentum (m²/s): h = √(GM · a(1−e²))
  const h_m2s = Math.sqrt(GM_SUN_SI * a * AU_TO_M * (1 - e * e));

  // ── Classification ────────────────────────────────────────────────────────
  const type = classifyOrbit(a, e);

  // ── MOID ──────────────────────────────────────────────────────────────────
  // Prepare element object for MOID
  const astEl = { a, e, i, Omega: ast.node || 0, omega: ast.w || 0 };
  const MOID_AU = computeMOID(astEl, 400);

  // Potentially Hazardous: MOID ≤ 0.05 AU AND H ≤ 22.0
  const isPHA = (H != null) && (H <= 22.0) && (MOID_AU <= 0.05);

  // ── Physical estimates from H magnitude ──────────────────────────────────
  // D(km) = 1.329 / √pv × 10^(−H/5)  (standard photometric formula)
  let diam_dark_km = null, diam_mid_km = null, diam_bright_km = null;
  let mass_kg = null, impact_Mt = null;
  let impact_vs_hiroshima = null, impact_vs_tunguska = null;
  let g_surface_ms2 = null, v_escape_ms = null;

  if (H != null && isFinite(H)) {
    const mag = Math.pow(10, -H / 5);
    diam_dark_km   = (1329 / Math.sqrt(0.05)) * mag;   // dark/C-type, pv=0.05
    diam_mid_km    = (1329 / Math.sqrt(0.14)) * mag;   // typical,     pv=0.14
    diam_bright_km = (1329 / Math.sqrt(0.25)) * mag;   // bright/S-type, pv=0.25

    // Mass: sphere at 2600 kg/m³ (average rocky asteroid density)
    const r_m = (diam_mid_km * 1000) / 2;
    mass_kg = (4 / 3) * Math.PI * r_m * r_m * r_m * 2600;

    // Impact energy: ½mv² using v at perihelion (worst-case for Earth crossers)
    const v_ms    = v_peri_kms * 1000;
    const E_J     = 0.5 * mass_kg * v_ms * v_ms;
    const MT_PER_J = 1 / 4.184e15;  // 1 Mt TNT = 4.184×10¹⁵ J
    impact_Mt = E_J * MT_PER_J;
    impact_vs_hiroshima = impact_Mt / 0.015; // Little Boy ≈ 15 kt = 0.015 Mt
    impact_vs_tunguska  = impact_Mt / 12;    // Tunguska ≈ 12 Mt

    // Surface gravity and escape velocity
    g_surface_ms2 = G_SI * mass_kg / (r_m * r_m);
    v_escape_ms   = Math.sqrt(2 * G_SI * mass_kg / r_m);
  }

  // ── Tisserand parameter relative to Jupiter ───────────────────────────────
  // T_J = a_J/a + 2·cos(i)·√(a/a_J · (1−e²))
  const i_rad = i * DEG2RAD;
  const tisserand = A_JUP / a + 2 * Math.cos(i_rad) * Math.sqrt((a / A_JUP) * (1 - e * e));

  return {
    // Geometry
    q_AU: q,
    Q_AU: Q,
    q_km: q * AU_TO_KM,
    Q_km: Q * AU_TO_KM,
    P_yr,
    P_days,
    n_deg,

    // Velocities (km/s)
    v_avg_kms,
    v_peri_kms,
    v_aph_kms,

    // Energy / momentum
    energy_J_kg,
    h_m2s,

    // Classification
    type,
    isPHA,
    MOID_AU,

    // Physical estimates
    diam_dark_km,
    diam_mid_km,
    diam_bright_km,
    mass_kg,

    // Impact hazard
    impact_Mt,
    impact_vs_hiroshima,
    impact_vs_tunguska,

    // Surface
    g_surface_ms2,
    v_escape_ms,

    // Tisserand
    tisserand,
  };
}

module.exports = { deriveAll, computeMOID, classifyOrbit, visViva_kms };
