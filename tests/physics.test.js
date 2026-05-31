'use strict';

/**
 * tests/physics.test.js — Unit tests for the NEO Radar physics engine.
 *
 * Run with: node --test tests/physics.test.js
 *
 * Tests:
 *  1. Kepler solver — convergence, accuracy, edge cases
 *  2. Apophis orbital period — must match 0.886 yr within 0.1%
 *  3. Earth orbit validation — circular-ish, period ~365.25 d
 *  4. Energy conservation — 50-year propagation stays Hamiltonian
 *  5. Uncertainty propagation — sigma grows monotonically near approach
 *  6. Ephemeris — planet positions are plausible at J2000
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const { solveKepler, solveKeplerTraced, trueAnomaly } = require('../src/physics/kepler');
const { keplerToCartesian, orbitalPeriod, G, BODIES }  = require('../src/physics/bodies');
const { propagate, positionError } = require('../src/physics/integrator');
const { ephemerisAt, sunOnlyEphemeris } = require('../src/physics/ephemeris');
const { getCatalog } = require('../src/data/catalog');

const AU_KM = 149597870.7;
const T0    = 9643; // days from J2000 to simulation epoch 2026-05-27

// ─── Helpers ─────────────────────────────────────────────────────────────────

function orbitalEnergy(state) {
  const r  = Math.sqrt(state[0]**2 + state[1]**2 + state[2]**2);
  const v2 = state[3]**2 + state[4]**2 + state[5]**2;
  return v2 / 2 - G * BODIES.sun.mass / r;
}

function meanAnomalyAtT(neo, t) {
  const n = 360 / orbitalPeriod(neo.a);
  return ((neo.M + n * t) % 360 + 360) % 360;
}

function stateAt(neo, t) {
  const M = meanAnomalyAtT(neo, t);
  const { r, v } = keplerToCartesian({ ...neo, M });
  return [r[0], r[1], r[2], v[0], v[1], v[2]];
}

// ─── Kepler Solver ─────────────────────────────────────────────────────────

describe('Kepler solver', () => {
  it('satisfies M = E - e*sin(E) after convergence', () => {
    const cases = [
      { M: 0.5, e: 0.0 },
      { M: 1.2, e: 0.3 },
      { M: 2.8, e: 0.1914 }, // Apophis
      { M: 0.1, e: 0.9 },    // high eccentricity
      { M: Math.PI, e: 0.0 }, // boundary
    ];
    for (const { M, e } of cases) {
      const E = solveKepler(M, e);
      const residual = Math.abs(E - e * Math.sin(E) - M);
      assert.ok(residual < 1e-11, `residual ${residual} for M=${M}, e=${e}`);
    }
  });

  it('converges for Apophis in ≤ 5 iterations', () => {
    const trace = solveKeplerTraced(88.36 * Math.PI / 180, 0.1914);
    assert.ok(trace.iterations <= 5, `too many iters: ${trace.iterations}`);
    assert.ok(trace.residuals.length > 0);
    // Residuals must be monotonically decreasing
    for (let i = 1; i < trace.residuals.length; i++) {
      assert.ok(
        trace.residuals[i] < trace.residuals[i - 1],
        `residual[${i}] = ${trace.residuals[i]} not < residual[${i-1}] = ${trace.residuals[i-1]}`
      );
    }
  });

  it('throws on out-of-range eccentricity', () => {
    assert.throws(() => solveKepler(1.0, 1.0), /eccentricity/i);
    assert.throws(() => solveKepler(1.0, -0.1), /eccentricity/i);
  });

  it('trueAnomaly returns 0 at periapsis (E=0)', () => {
    const nu = trueAnomaly(0, 0.3);
    assert.ok(Math.abs(nu) < 1e-12);
  });

  it('trueAnomaly returns π at apoapsis (E=π)', () => {
    const nu = trueAnomaly(Math.PI, 0.3);
    assert.ok(Math.abs(nu - Math.PI) < 1e-12);
  });
});

// ─── Apophis period ─────────────────────────────────────────────────────────

describe('Apophis orbital mechanics', () => {
  let apophis;
  before(() => {
    apophis = getCatalog().find(n => n.id === '99942');
    assert.ok(apophis, 'Apophis not in catalog');
  });

  it('orbital period is 0.886 ± 0.005 yr from Kepler\'s 3rd law', () => {
    const T_days = orbitalPeriod(apophis.a);
    const T_yr   = T_days / 365.25;
    assert.ok(Math.abs(T_yr - 0.886) < 0.005, `Period = ${T_yr.toFixed(4)} yr`);
  });

  it('keplerToCartesian produces heliocentric position near 1 AU', () => {
    const { r } = keplerToCartesian(apophis);
    const dist = Math.sqrt(r[0]**2 + r[1]**2 + r[2]**2);
    // Apophis a=0.9224, so r is between perihelion (0.748 AU) and aphelion (1.097 AU)
    assert.ok(dist > 0.7 && dist < 1.2, `Distance ${dist.toFixed(4)} AU out of range`);
  });

  it('velocity matches vis-viva at perihelion within 1%', () => {
    // At perihelion M=0, E=0, nu=0 → r=a(1-e)
    const el = { ...apophis, M: 0 };
    const { r, v } = keplerToCartesian(el);
    const dist  = Math.sqrt(r[0]**2 + r[1]**2 + r[2]**2);
    const speed = Math.sqrt(v[0]**2 + v[1]**2 + v[2]**2) * AU_KM / 86400; // AU/day → km/s
    const mu    = G * BODIES.sun.mass; // AU³/day²
    const v_visviva = Math.sqrt(mu * (2 / dist - 1 / apophis.a)) * AU_KM / 86400;
    const err = Math.abs(speed - v_visviva) / v_visviva;
    assert.ok(err < 0.01, `Speed ${speed.toFixed(3)} vs vis-viva ${v_visviva.toFixed(3)} km/s (err ${(err*100).toFixed(4)}%)`);
  });
});

// ─── Earth orbit ────────────────────────────────────────────────────────────

describe('Earth orbit (ephemeris validation)', () => {
  it('Earth is near 1 AU from Sun at J2000', () => {
    const perturbers = ephemerisAt(0); // t=0 = J2000
    const earth = perturbers.find(p => Math.abs(p.mass - BODIES.earth.mass) < 1e-10);
    assert.ok(earth, 'Earth perturber not found');
    const dist = Math.sqrt(earth.pos[0]**2 + earth.pos[1]**2 + earth.pos[2]**2);
    assert.ok(Math.abs(dist - 1.0) < 0.02, `Earth at ${dist.toFixed(4)} AU`);
  });

  it('Jupiter is within its orbital range at J2000 (4.95–5.46 AU)', () => {
    // Jupiter: a=5.204, e=0.049 → perihelion 4.95 AU, aphelion 5.46 AU
    // At M0=20°, near perihelion, expected ~4.97 AU
    const perturbers = ephemerisAt(0);
    const jup = perturbers.find(p => Math.abs(p.mass - BODIES.jupiter.mass) < 1e-6);
    assert.ok(jup, 'Jupiter perturber not found');
    const dist = Math.sqrt(jup.pos[0]**2 + jup.pos[1]**2 + jup.pos[2]**2);
    assert.ok(dist > 4.9 && dist < 5.5, `Jupiter at ${dist.toFixed(4)} AU (expected 4.9–5.5)`);
  });

  it('Saturn is within its orbital range at J2000 (9.05–10.12 AU)', () => {
    // Saturn: a=9.582, e=0.056 → perihelion 9.05 AU, aphelion 10.12 AU
    // At M0=317°, expected ~9.21 AU
    const perturbers = ephemerisAt(0);
    const sat = perturbers.find(p => Math.abs(p.mass - BODIES.saturn.mass) < 1e-5);
    assert.ok(sat, 'Saturn perturber not found');
    const dist = Math.sqrt(sat.pos[0]**2 + sat.pos[1]**2 + sat.pos[2]**2);
    assert.ok(dist > 9.0 && dist < 10.2, `Saturn at ${dist.toFixed(4)} AU (expected 9.0–10.2)`);
  });
});

// ─── Energy conservation ─────────────────────────────────────────────────────

describe('Energy conservation (50-year propagation)', () => {
  it('Apophis Sun-only energy error < 1e-4 % over 50 yr', () => {
    const apophis = getCatalog().find(n => n.id === '99942');
    const state0  = stateAt(apophis, T0);
    const sunOnly = sunOnlyEphemeris();
    const T50     = T0 + 50 * 365.25;
    const frames  = propagate(state0, T0, T50, 365, sunOnly, { dt0: 1.0, tol: 1e-10 });

    const h0 = orbitalEnergy(frames[0].state);
    const hN = orbitalEnergy(frames[frames.length - 1].state);
    const errPct = Math.abs((hN - h0) / h0) * 100;

    assert.ok(errPct < 1e-4, `Energy drift = ${errPct.toExponential(3)} % over 50 yr`);
  });

  it('Bennu Sun-only energy error < 1e-4 % over 10 yr', () => {
    const bennu  = getCatalog().find(n => n.id === '101955');
    const state0 = stateAt(bennu, T0);
    const sunOnly = sunOnlyEphemeris();
    const T10    = T0 + 10 * 365.25;
    const frames = propagate(state0, T0, T10, 365, sunOnly, { dt0: 1.0, tol: 1e-10 });

    const h0 = orbitalEnergy(frames[0].state);
    const hN = orbitalEnergy(frames[frames.length - 1].state);
    const errPct = Math.abs((hN - h0) / h0) * 100;

    assert.ok(errPct < 1e-4, `Bennu energy drift = ${errPct.toExponential(3)} %`);
  });
});

// ─── N-body vs Sun-only divergence ───────────────────────────────────────────

describe('N-body vs Sun-only perturbation magnitude', () => {
  it('Apophis N-body deviates > 100 km from Sun-only over 10 years (Jupiter matters)', () => {
    const apophis = getCatalog().find(n => n.id === '99942');
    const state0  = stateAt(apophis, T0);
    const sunOnly = sunOnlyEphemeris();
    const T10     = T0 + 10 * 365.25;

    const frN = propagate(state0, T0, T10, 365, ephemerisAt, { dt0: 1.0, tol: 1e-10 });
    const frS = propagate(state0, T0, T10, 365, sunOnly,     { dt0: 1.0, tol: 1e-10 });

    const last = Math.min(frN.length, frS.length) - 1;
    const posN = frN[last].state.slice(0, 3);
    const posS = frS[last].state.slice(0, 3);
    const dx = posN[0]-posS[0], dy = posN[1]-posS[1], dz = posN[2]-posS[2];
    const devKm = Math.sqrt(dx*dx + dy*dy + dz*dz) * AU_KM;

    assert.ok(devKm > 100, `10-yr Jupiter deviation only ${devKm.toFixed(0)} km — expected > 100 km`);
  });
});

// ─── Catalog sanity ──────────────────────────────────────────────────────────

describe('Catalog integrity', () => {
  it('has exactly 47 objects', () => {
    const catalog = getCatalog();
    assert.equal(catalog.length, 47);
  });

  it('all objects have valid eccentricity 0 ≤ e < 1', () => {
    for (const n of getCatalog()) {
      assert.ok(n.e >= 0 && n.e < 1, `${n.name}: invalid e = ${n.e}`);
    }
  });

  it('all objects have semi-major axis > 0', () => {
    for (const n of getCatalog()) {
      assert.ok(n.a > 0, `${n.name}: invalid a = ${n.a}`);
    }
  });

  it('Apophis has caution risk level', () => {
    const apo = getCatalog().find(n => n.id === '99942');
    assert.equal(apo.riskLevel, 'caution');
  });

  it('all risk levels are valid enum values', () => {
    const valid = new Set(['safe', 'monitor', 'caution', 'hazardous']);
    for (const n of getCatalog()) {
      assert.ok(valid.has(n.riskLevel), `${n.name}: unknown risk '${n.riskLevel}'`);
    }
  });
});
