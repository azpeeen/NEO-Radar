/**
 * NEO Radar — Orbital mechanics primitives.
 * Pure functions, no DOM, no Three.js, no side effects.
 * Exported as window.Physics for browser-global consumption.
 */

/**
 * Solves Kepler's equation M = E − e·sin(E) via Newton-Raphson.
 * @param {number} M       Mean anomaly (radians)
 * @param {number} e       Orbital eccentricity [0, 1)
 * @param {number} tol     Convergence tolerance (default 1e-10 rad)
 * @param {number} maxIter Maximum iterations (default 20)
 * @returns {{ E: number, iter: number }} Eccentric anomaly and iteration count
 */
function solveKepler(M, e, tol = 1e-10, maxIter = 20) {
  M = ((M + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  if (M > Math.PI) M -= 2 * Math.PI;
  let E = (e < 0.8) ? M : Math.PI;
  let i = 0;
  for (; i < maxIter; i++) {
    const f  = E - e * Math.sin(E) - M;
    const fp = 1 - e * Math.cos(E);
    const dE = f / fp;
    E -= dE;
    if (Math.abs(dE) < tol) break;
  }
  return { E, iter: i + 1 };
}

/**
 * Converts eccentric anomaly to heliocentric position in the orbital plane,
 * then rotates by argument of periapsis omega.
 * @param {number} a     Semi-major axis (AU or scene units)
 * @param {number} e     Eccentricity
 * @param {number} omega Argument of periapsis (radians)
 * @param {number} E     Eccentric anomaly (radians)
 * @returns {{ x: number, y: number, r: number }} Position and heliocentric distance
 */
function keplerXY(a, e, omega, E) {
  const xOrb = a * (Math.cos(E) - e);
  const yOrb = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(omega), sw = Math.sin(omega);
  return {
    x: xOrb * cw - yOrb * sw,
    y: xOrb * sw + yOrb * cw,
    r: Math.hypot(xOrb, yOrb)
  };
}

window.Physics = { solveKepler, keplerXY };
