'use strict';

// Heliocentric ecliptic J2000 — units: AU, M☉, days
// Solves M = E − e·sin(E) for E given M and e.

function solveKepler(M, e) {
  let E = M + e * Math.sin(M); // adaptive seed
  for (let i = 0; i < 20; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-12) return E;
  }
  throw new Error(`Kepler non-convergence: e=${e}, M=${M}`);
}

module.exports = { solveKepler };
