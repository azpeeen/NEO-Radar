'use strict';

// RK4 + adaptive timestep N-body integrator.
// state: { pos: [x,y,z], vel: [vx,vy,vz] }  (AU, AU/day)
// perturbers: [{ pos: [x,y,z], mass: M☉ }, ...]
// ZERO imports from renderer, DOM, or canvas.

const { G } = require('./bodies');

const DT_MIN = 1e-3; // days
const DT_MAX = 1.0;  // days

function acceleration(state, perturbers) {
  let ax = 0, ay = 0, az = 0;
  for (const body of perturbers) {
    const dx = body.pos[0] - state.pos[0];
    const dy = body.pos[1] - state.pos[1];
    const dz = body.pos[2] - state.pos[2];
    const r2 = dx * dx + dy * dy + dz * dz;
    const r3 = r2 * Math.sqrt(r2);
    const gm = G * body.mass;
    ax += gm * dx / r3;
    ay += gm * dy / r3;
    az += gm * dz / r3;
  }
  return [ax, ay, az];
}

function addScaled(a, b, s) {
  return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
}

function rk4Step(state, perturbers, dt) {
  const k1v = acceleration(state, perturbers);
  const k1p = state.vel;

  const s2 = { pos: addScaled(state.pos, k1p, dt / 2), vel: addScaled(state.vel, k1v, dt / 2) };
  const k2v = acceleration(s2, perturbers);
  const k2p = s2.vel;

  const s3 = { pos: addScaled(state.pos, k2p, dt / 2), vel: addScaled(state.vel, k2v, dt / 2) };
  const k3v = acceleration(s3, perturbers);
  const k3p = s3.vel;

  const s4 = { pos: addScaled(state.pos, k3p, dt), vel: addScaled(state.vel, k3v, dt) };
  const k4v = acceleration(s4, perturbers);
  const k4p = s4.vel;

  const w = dt / 6;
  return {
    pos: [
      state.pos[0] + w * (k1p[0] + 2 * k2p[0] + 2 * k3p[0] + k4p[0]),
      state.pos[1] + w * (k1p[1] + 2 * k2p[1] + 2 * k3p[1] + k4p[1]),
      state.pos[2] + w * (k1p[2] + 2 * k2p[2] + 2 * k3p[2] + k4p[2]),
    ],
    vel: [
      state.vel[0] + w * (k1v[0] + 2 * k2v[0] + 2 * k3v[0] + k4v[0]),
      state.vel[1] + w * (k1v[1] + 2 * k2v[1] + 2 * k3v[1] + k4v[1]),
      state.vel[2] + w * (k1v[2] + 2 * k2v[2] + 2 * k3v[2] + k4v[2]),
    ],
  };
}

// Adaptive step: run one full step and two half-steps, compare position residuals.
// Accept if residual < tol; otherwise halve dt and retry.
// Δt_new = 0.9 · Δt · (tol / ε)^(1/5)
function adaptiveStep(state, perturbers, dt, tol = 1e-10) {
  const s1 = rk4Step(state, perturbers, dt);

  const sh = rk4Step(state, perturbers, dt / 2);
  const s2 = rk4Step(sh,    perturbers, dt / 2);

  const dx = s2.pos[0] - s1.pos[0];
  const dy = s2.pos[1] - s1.pos[1];
  const dz = s2.pos[2] - s1.pos[2];
  const eps = Math.sqrt(dx * dx + dy * dy + dz * dz);

  const dtNew = Math.min(DT_MAX, Math.max(DT_MIN, 0.9 * dt * Math.pow(tol / (eps + 1e-15), 0.2)));

  if (eps < tol || dt <= DT_MIN) {
    return { state: s2, dt: dtNew };
  }
  return adaptiveStep(state, perturbers, Math.max(DT_MIN, dt / 2), tol);
}

module.exports = { acceleration, rk4Step, adaptiveStep };
