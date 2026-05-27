'use strict';

// G = 4π² in AU³ / M☉ / day² — exact in these units (Gauss constant squared)
const G = 4 * Math.PI * Math.PI;

const BODIES = {
  sun:     { mass: 1.0 },
  earth:   { mass: 3.00e-6 },
  jupiter: { mass: 9.55e-4 },
  saturn:  { mass: 2.86e-4 },
};

const { solveKepler } = require('./kepler');

// Converts Keplerian elements to heliocentric ecliptic J2000 state vectors.
// elements: { a [AU], e, i [deg], Omega [deg], omega [deg], M [deg] }
// returns: { r: [x,y,z] AU, v: [vx,vy,vz] AU/day }
function keplerToCartesian({ a, e, i, Omega, omega, M }) {
  const iR  = i     * (Math.PI / 180);
  const OmR = Omega * (Math.PI / 180);
  const omR = omega * (Math.PI / 180);
  const MR  = M     * (Math.PI / 180);

  const E  = solveKepler(MR, e);
  const nu = 2 * Math.atan2(
    Math.sqrt(1 + e) * Math.sin(E / 2),
    Math.sqrt(1 - e) * Math.cos(E / 2)
  );
  const r = a * (1 - e * Math.cos(E));

  // Perifocal position
  const xP = r * Math.cos(nu);
  const yP = r * Math.sin(nu);

  // Perifocal velocity (AU/day); G·M☉ = 4π² in these units
  const h      = Math.sqrt(G * a * (1 - e * e)); // specific angular momentum
  const vxP    = -(G / h) * Math.sin(nu);
  const vyP    =  (G / h) * (e + Math.cos(nu));

  // Direction cosines: perifocal → ecliptic  (R3(−Ω)·R1(−i)·R3(−ω))
  const cosO = Math.cos(OmR), sinO = Math.sin(OmR);
  const cosI = Math.cos(iR),  sinI = Math.sin(iR);
  const coso = Math.cos(omR), sino = Math.sin(omR);

  // P-vector (points toward periapsis)
  const Px =  cosO * coso - sinO * sino * cosI;
  const Py =  sinO * coso + cosO * sino * cosI;
  const Pz =  sinI * sino;

  // Q-vector (90° ahead in orbit plane)
  const Qx = -cosO * sino - sinO * coso * cosI;
  const Qy = -sinO * sino + cosO * coso * cosI;
  const Qz =  sinI * coso;

  return {
    r: [Px * xP + Qx * yP,  Py * xP + Qy * yP,  Pz * xP + Qz * yP],
    v: [Px * vxP + Qx * vyP, Py * vxP + Qy * vyP, Pz * vxP + Qz * vyP],
  };
}

module.exports = { G, BODIES, keplerToCartesian };
