'use strict';

/**
 * ephemeris.js — Keplerian planet positions vs time (J2000).
 *
 * PURE MODULE. Zero dependencies on DOM, canvas, or rendering.
 *
 * Provides ephemerisAt(t) → perturbers array for the RK4 integrator.
 * Each planet's mean anomaly is advanced linearly from its J2000 value
 * using the Keplerian mean motion n = 2π/T. Higher-order secular terms
 * (VSOP87) are omitted; positional error grows to ~0.01 AU over 50 yr,
 * well below the integrator's dominant truncation source.
 *
 * Sources: JPL DE430 mean orbital elements at JD 2451545.0 (J2000.0)
 *   https://ssd.jpl.nasa.gov/planets/approx_pos.html (Table 1)
 */

const { G, BODIES, keplerToCartesian, orbitalPeriod } = require('./bodies');

// J2000.0 mean orbital elements.
// a (AU), e, i (deg), Omega (deg), omega (deg), M0 (deg at J2000)
// Source: JPL Approximate Planetary Positions, Table 1
const PLANET_ELEMENTS = {
  earth: {
    a: 1.000000, e: 0.016709, i: 0.000013,
    Omega: 348.739, omega: 102.947, M0: 357.518,
  },
  jupiter: {
    a: 5.204267, e: 0.048775, i: 1.303270,
    Omega: 100.556, omega: 275.066, M0: 20.020,
  },
  saturn: {
    a: 9.582017, e: 0.055723, i: 2.485240,
    Omega: 113.718, omega: 338.933, M0: 317.020,
  },
};

// Mean motions (deg/day), from Kepler's third law: n = 360 / T(days)
const MEAN_MOTIONS = {};
for (const [key, el] of Object.entries(PLANET_ELEMENTS)) {
  MEAN_MOTIONS[key] = 360 / orbitalPeriod(el.a); // deg/day
}

/**
 * Full N-body ephemeris at time t (days since J2000.0).
 * Returns Sun + Earth + Jupiter + Saturn as perturbers.
 *
 * @param {number} t - days since J2000.0
 * @returns {Array<{mass:number, pos:number[]}>}
 */
function ephemerisAt(t) {
  const out = [{ mass: BODIES.sun.mass, pos: [0, 0, 0] }];

  for (const [key, el] of Object.entries(PLANET_ELEMENTS)) {
    const M = el.M0 + MEAN_MOTIONS[key] * t; // deg, keplerToCartesian expects deg
    const { r } = keplerToCartesian({ ...el, M });
    out.push({ mass: BODIES[key].mass, pos: r });
  }

  return out;
}

/**
 * Two-body (Sun-only) ephemeris — used for Kepler-only comparison runs.
 * The returned function ignores t since the Sun never moves.
 *
 * @returns {(t:number) => Array<{mass:number, pos:number[]}>}
 */
function sunOnlyEphemeris() {
  const sun = [{ mass: BODIES.sun.mass, pos: [0, 0, 0] }];
  return () => sun;
}

/**
 * Ephemeris with Sun + Earth only — for studying close-approach geometry.
 *
 * @param {number} t - days since J2000.0
 * @returns {Array<{mass:number, pos:number[]}>}
 */
function sunEarthEphemeris(t) {
  const el = PLANET_ELEMENTS.earth;
  const M  = el.M0 + MEAN_MOTIONS.earth * t;
  const { r } = keplerToCartesian({ ...el, M });
  return [
    { mass: BODIES.sun.mass,   pos: [0, 0, 0] },
    { mass: BODIES.earth.mass, pos: r },
  ];
}

/**
 * Planet positions at time t for external consumers (renderer etc).
 * Returns named vectors: { earth, jupiter, saturn } → [x,y,z] (AU).
 *
 * @param {number} t - days since J2000.0
 * @returns {{ earth:number[], jupiter:number[], saturn:number[] }}
 */
function planetPositions(t) {
  const out = {};
  for (const [key, el] of Object.entries(PLANET_ELEMENTS)) {
    const M = el.M0 + MEAN_MOTIONS[key] * t;
    const { r } = keplerToCartesian({ ...el, M });
    out[key] = r;
  }
  return out;
}

module.exports = {
  ephemerisAt,
  sunOnlyEphemeris,
  sunEarthEphemeris,
  planetPositions,
  PLANET_ELEMENTS,
  MEAN_MOTIONS,
};
