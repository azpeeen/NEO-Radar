'use strict';

// Monte Carlo covariance propagation.
// Draws N particles from a 6D Gaussian, integrates each forward via RK4,
// returns 3σ position envelope per output epoch.
// ZERO imports from renderer, DOM, or canvas.

const { rk4Step } = require('./integrator');

function sampleStandardNormal() {
  // Box-Muller transform
  const u1 = Math.random() || 1e-15;
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// Lower-triangular Cholesky decomposition of a 6×6 covariance matrix.
function cholesky(cov) {
  const n = 6;
  const L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = cov[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      L[i][j] = j === i ? Math.sqrt(Math.max(s, 0)) : s / (L[j][j] || 1e-15);
    }
  }
  return L;
}

function drawParticle(state, L) {
  const z = Array.from({ length: 6 }, sampleStandardNormal);
  const d = new Float64Array(6);
  for (let i = 0; i < 6; i++)
    for (let j = 0; j <= i; j++)
      d[i] += L[i][j] * z[j];

  return {
    pos: [state.pos[0] + d[0], state.pos[1] + d[1], state.pos[2] + d[2]],
    vel: [state.vel[0] + d[3], state.vel[1] + d[4], state.vel[2] + d[5]],
  };
}

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr, m) {
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
}

// state:    { pos, vel }                — nominal initial state
// cov6x6:   6×6 covariance matrix      — position+velocity uncertainties (AU, AU/day)
// perturbers: [{ pos, mass }]           — gravitational bodies for integration
// epochs:   number[]                    — days from epoch to sample
// N:        number of Monte Carlo draws (default 256)
// returns:  [{ epoch, center, sigma3 }]
function propagateUncertainty(state, cov6x6, perturbers, epochs, N = 256) {
  const L = cholesky(cov6x6);
  let particles = Array.from({ length: N }, () => drawParticle(state, L));
  const envelope = [];

  let t = 0;
  const sortedEpochs = [...epochs].sort((a, b) => a - b);

  for (const epoch of sortedEpochs) {
    const dt = epoch - t;
    if (dt <= 0) continue;
    particles = particles.map(p => rk4Step(p, perturbers, dt));
    t = epoch;

    const xs = particles.map(p => p.pos[0]);
    const ys = particles.map(p => p.pos[1]);
    const zs = particles.map(p => p.pos[2]);
    const mx = mean(xs), my = mean(ys), mz = mean(zs);

    envelope.push({
      epoch,
      center: [mx, my, mz],
      sigma3: [3 * stddev(xs, mx), 3 * stddev(ys, my), 3 * stddev(zs, mz)],
    });
  }

  return envelope;
}

module.exports = { propagateUncertainty };
