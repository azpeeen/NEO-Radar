'use strict';

/**
 * bodies.js — Gravitational constants and orbital-element conversions.
 *
 * PURE MODULE. Zero dependencies on DOM, canvas, or rendering.
 *
 * Unit system: heliocentric ecliptic J2000
 *   - position:  AU  (astronomical units)
 *   - mass:      M☉  (solar masses)
 *   - time:      days (since J2000.0, JD 2451545.0)
 *
 * In these units the gravitational constant is exact:
 *     G = 4π²   (AU³ · M☉⁻¹ · yr⁻²)  →  but we work in DAYS, so:
 *     G = 4π² / (365.25)²   in AU³ · M☉⁻¹ · day⁻²
 */

const { solveKepler, trueAnomaly } = require('./kepler');

const DAYS_PER_YEAR = 365.25;

// G = 4π² in AU³ M☉⁻¹ yr⁻², converted to days
const G = (4 * Math.PI * Math.PI) / (DAYS_PER_YEAR * DAYS_PER_YEAR);

/**
 * Gravitational bodies included in N-body integration.
 * Masses in solar masses. These four cover >99.6% of cumulative Δv
 * for 50-year propagation of typical NEO orbits.
 */
const BODIES = {
  sun:     { name: 'Sun',     mass: 1.0,          color: '#f5c542' },
  earth:   { name: 'Earth',   mass: 3.00e-6,      color: '#1a6cf6' },
  jupiter: { name: 'Jupiter', mass: 9.55e-4,      color: '#d8a26a' },
  saturn:  { name: 'Saturn',  mass: 2.86e-4,      color: '#c9b079' },
};

const DEG2RAD = Math.PI / 180;

/**
 * Convert classical Keplerian orbital elements to a Cartesian state vector
 * in the heliocentric ecliptic frame.
 *
 * @param {object} el - orbital elements
 * @param {number} el.a     - semi-major axis (AU)
 * @param {number} el.e     - eccentricity
 * @param {number} el.i     - inclination (degrees)
 * @param {number} el.Omega - longitude of ascending node Ω (degrees)
 * @param {number} el.omega - argument of periapsis ω (degrees)
 * @param {number} el.M     - mean anomaly at epoch (degrees)
 * @param {number} [mu=G]   - gravitational parameter G·M_sun (defaults to G·1)
 * @returns {{ r: number[], v: number[] }} position (AU) and velocity (AU/day)
 */
function keplerToCartesian(el, mu = G * BODIES.sun.mass) {
  const a = el.a;
  const e = el.e;
  const i = el.i * DEG2RAD;
  const Omega = el.Omega * DEG2RAD;
  const omega = el.omega * DEG2RAD;
  const M = el.M * DEG2RAD;

  // Solve Kepler's equation for eccentric anomaly, then true anomaly
  const E = solveKepler(M, e);
  const nu = trueAnomaly(E, e);

  // Distance from focus
  const r = a * (1 - e * Math.cos(E));

  // Position in orbital plane (perifocal frame)
  const xP = r * Math.cos(nu);
  const yP = r * Math.sin(nu);

  // Velocity in perifocal frame
  const p = a * (1 - e * e);                 // semi-latus rectum
  const sqrtMuP = Math.sqrt(mu / p);
  const vxP = -sqrtMuP * Math.sin(nu);
  const vyP =  sqrtMuP * (e + Math.cos(nu));

  // Rotation: perifocal → ecliptic (3-1-3 Euler: Ω, i, ω)
  const cosO = Math.cos(Omega), sinO = Math.sin(Omega);
  const cosI = Math.cos(i),     sinI = Math.sin(i);
  const cosW = Math.cos(omega), sinW = Math.sin(omega);

  const R11 = cosO * cosW - sinO * sinW * cosI;
  const R12 = -cosO * sinW - sinO * cosW * cosI;
  const R21 = sinO * cosW + cosO * sinW * cosI;
  const R22 = -sinO * sinW + cosO * cosW * cosI;
  const R31 = sinW * sinI;
  const R32 = cosW * sinI;

  const rx = R11 * xP + R12 * yP;
  const ry = R21 * xP + R22 * yP;
  const rz = R31 * xP + R32 * yP;

  const vx = R11 * vxP + R12 * vyP;
  const vy = R21 * vxP + R22 * vyP;
  const vz = R31 * vxP + R32 * vyP;

  return { r: [rx, ry, rz], v: [vx, vy, vz] };
}

/**
 * Orbital period from semi-major axis (Kepler's third law).
 *     T = 2π · √(a³ / μ)
 * @param {number} a  - semi-major axis (AU)
 * @param {number} [mu=G] - gravitational parameter
 * @returns {number} period in days
 */
function orbitalPeriod(a, mu = G * BODIES.sun.mass) {
  return TWO_PI_SAFE * Math.sqrt((a * a * a) / mu);
}
const TWO_PI_SAFE = 2 * Math.PI;

module.exports = { G, BODIES, keplerToCartesian, orbitalPeriod, DEG2RAD };
