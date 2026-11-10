/* NEO Radar — ThreeJSRenderer (WebGL heliocentric view)
   Loaded as a classic <script> (served at /js/renderer3d.js) AFTER three.min.js.
   ZERO physics: no integrators, no Kepler solvers. The page (radar.ejs) solves
   all orbits and hands this class flat arrays of positions — this file only
   turns those arrays into pixels.

   Camera — free-orbit PerspectiveCamera, NASA Eyes on Asteroids style.
   The ecliptic plane is world XY, +z is ecliptic north ("up"). The page owns
   the camera state {tx,ty,tz, dist, theta, phi} (frame.cam) and this file
   derives the position by spherical coordinates:
       px = tx + dist·cos(phi)·sin(theta)
       py = ty + dist·cos(phi)·cos(theta)
       pz = tz + dist·sin(phi)          up = (0,0,1), lookAt(tx,ty,tz)
   Every render() writes the combined view-projection matrix into a shared
   Float32Array(16) (getVPMatrix()) — the page's ws() projects world→screen
   through it, which keeps hover/labels/spatial-hash math renderer-agnostic.

   Body scale: every body carries its REAL radius in AU and a minimum pixel
   size — the mesh scale is max(realRadiusAU, minPx·worldPerPixel(dist)).
   From afar everything is a fixed-px clickable dot; up close the perspective
   projection takes over and sizes become physically true.

   Text labels, dashed conjunction lines and pulse rings are drawn on a thin
   transparent 2D overlay canvas (pointer-events: none) — WebGL carries all
   heavy geometry (41k-point cloud, meshes, orbit lines, starfield). */

'use strict';

/* ── Shared constants ────────────────────────────────────────────────────── */

var RISK_COLOR = {
  safe:    '#2fd07a',
  monitor: '#6fb4ff',
  caution: '#f5c542',
  hazard:  '#ff3b50',
};

// Per-planet overlay label colors — each tinted to the body, brighter than the
// old flat gray so the names read at a glance in the radar view.
var PLANET_LABEL_COLOR = {
  mercury: 'rgba(180, 170, 160, 0.90)',  // gray-beige
  venus:   'rgba(230, 200, 140, 0.90)',  // gold
  earth:   'rgba(100, 180, 255, 0.90)',  // blue
  mars:    'rgba(220, 100,  60, 0.90)',  // red-orange
  jupiter: 'rgba(210, 170, 120, 0.90)',  // orange-beige
  saturn:  'rgba(210, 190, 130, 0.90)',  // pale gold
  uranus:  'rgba(130, 210, 210, 0.90)',  // light cyan
  neptune: 'rgba( 80, 120, 220, 0.90)',  // deep blue
};

// Orbit-line colors + opacities carried over from the Canvas 2D drawNEO()
var ORBIT_STYLE = {
  hazard:  { color: '#ff6b2b', base: 0.35, sel: 0.70 },
  caution: { color: '#ffb450', base: 0.30, sel: 0.60 },
  monitor: { color: '#6fb4ff', base: 0.25, sel: 0.55 },
  safe:    { color: '#aab4d2', base: 0.18, sel: 0.45 },
};

// Real body radii in AU — physical truth, applied as a floor of minPx on screen
var REAL_RADIUS_AU = {
  sun:     4.65e-3,
  mercury: 1.63e-5, venus:  4.05e-5, earth:   4.26e-5, mars:    2.27e-5,
  jupiter: 4.78e-4, saturn: 4.03e-4, uranus:  1.71e-4, neptune: 1.65e-4,
  moon:    1.16e-5,
};

// Minimum on-screen radius in px so every body stays a clickable dot from afar
var MIN_PX = {
  sun:      12,
  mercury:  3,
  venus:    4,
  earth:    5,
  mars:     3,
  jupiter:  7,
  saturn:   6,
  uranus:   4,
  neptune:  4,
  moon:     2,
  asteroid: 1.5,   // general map
  neo:      1.5,
};

// Focused/promoted asteroid mesh floor — deliberately large (focus close-up)
var PROMO_MIN_PX = 60;

// Focus-entry framing distance for asteroids (AU) — matches the asteroid
// _focusDistTarget in radar.ejs. While focused, the promo min-px floor is
// frozen at this distance so dollying closer actually grows the rock on
// screen instead of the floor re-shrinking it to a constant 60 px.
var FOCUS_FRAME_DIST = 6e-4;

// Same idea for focused moons / dwarf planets / comets: the 'luna' focus
// framing bottoms out at 5e-5 AU (radar.ejs _setFocusDollyTargets), and a
// km-scale body (Phobos, 67P) at that range is a sub-pixel dot without a
// floor. 48 px, frozen at the framing distance — big bodies (Moon, Ceres)
// beat it at real size, tiny ones read as actual rocks.
var FOCUS_BODY_MIN_PX = 48;
var FOCUS_BODY_FRAME_DIST = 5e-5;

var FOV_DEG = 45;

// Sidereal rotation period in days (negative = retrograde: Venus, Uranus)
var SIDEREAL_DAY = {
  mercury: 58.646, venus: -243.025, earth:  0.99727, mars:    1.02596,
  jupiter: 0.41354, saturn: 0.44401, uranus: -0.71833, neptune: 0.67125,
};

// Axial tilt relative to the ecliptic, degrees
var AXIAL_TILT = {
  mercury: 0.034, venus: 177.4, earth:  23.44, mars:    25.19,
  jupiter: 3.13,  saturn: 26.73, uranus: 97.77, neptune: 28.32,
};

// ── Moons — visual-only circular orbits around their parent planets ──────────
// a in AU, T in days (negative = retrograde: Triton), i in degrees vs the
// ecliptic (simplified), r = physical radius in AU (radius_km / 1.496e8).
// Shared with the page: classic scripts share the global scope, so radar.ejs
// reads MOONS / MOONS_BY_ID / moonLocalPos for hit tests and focus follow.
var MOONS = [
  // Earth
  { id:'moon',      parent:'earth',   a:0.00257,  T:27.3217, i:5.145, r:1.161e-5, name:'Moon',      tidal:true },
  // Mars
  { id:'phobos',    parent:'mars',    a:6.267e-5, T:0.3189,  i:1.093, r:7.41e-8,  name:'Phobos',    tidal:true },
  { id:'deimos',    parent:'mars',    a:1.568e-4, T:1.2624,  i:1.788, r:4.14e-8,  name:'Deimos',    tidal:true },
  // Jupiter (Galilean)
  { id:'io',        parent:'jupiter', a:2.819e-3, T:1.7691,  i:0.036, r:1.218e-5, name:'Io',        tidal:true },
  { id:'europa',    parent:'jupiter', a:4.486e-3, T:3.5512,  i:0.466, r:1.043e-5, name:'Europa',    tidal:true },
  { id:'ganymede',  parent:'jupiter', a:7.155e-3, T:7.1546,  i:0.177, r:1.761e-5, name:'Ganymede',  tidal:true },
  { id:'callisto',  parent:'jupiter', a:1.259e-2, T:16.689,  i:0.192, r:1.611e-5, name:'Callisto',  tidal:true },
  // Saturn
  { id:'mimas',     parent:'saturn',  a:1.243e-3, T:0.9424,  i:1.574, r:1.325e-6, name:'Mimas',     tidal:true },
  { id:'enceladus', parent:'saturn',  a:1.593e-3, T:1.3702,  i:0.009, r:1.685e-6, name:'Enceladus', tidal:true },
  { id:'tethys',    parent:'saturn',  a:1.971e-3, T:1.8878,  i:1.091, r:3.550e-6, name:'Tethys',    tidal:true },
  { id:'dione',     parent:'saturn',  a:2.524e-3, T:2.7369,  i:0.028, r:3.753e-6, name:'Dione',     tidal:true },
  { id:'rhea',      parent:'saturn',  a:3.523e-3, T:4.5175,  i:0.333, r:5.106e-6, name:'Rhea',      tidal:true },
  { id:'titan',     parent:'saturn',  a:8.168e-3, T:15.945,  i:0.349, r:1.721e-5, name:'Titan',     tidal:true },
  { id:'iapetus',   parent:'saturn',  a:2.381e-2, T:79.330,  i:15.47, r:4.910e-6, name:'Iapetus',   tidal:true },
  // Uranus
  { id:'miranda',   parent:'uranus',  a:8.711e-4, T:1.4135,  i:4.338, r:1.576e-6, name:'Miranda',   tidal:true },
  { id:'ariel',     parent:'uranus',  a:1.276e-3, T:2.5204,  i:0.041, r:3.870e-6, name:'Ariel',     tidal:true },
  { id:'umbriel',   parent:'uranus',  a:1.780e-3, T:4.1442,  i:0.128, r:3.908e-6, name:'Umbriel',   tidal:true },
  { id:'titania',   parent:'uranus',  a:2.917e-3, T:8.7059,  i:0.079, r:5.270e-6, name:'Titania',   tidal:true },
  { id:'oberon',    parent:'uranus',  a:3.910e-3, T:13.463,  i:0.068, r:5.090e-6, name:'Oberon',    tidal:true },
  // Neptune
  { id:'triton',    parent:'neptune', a:2.371e-3, T:-5.877,  i:156.8, r:9.047e-6, name:'Triton',    tidal:true },
];

var MOONS_BY_ID = {};
for (var _mn = 0; _mn < MOONS.length; _mn++) MOONS_BY_ID[MOONS[_mn].id] = MOONS[_mn];

// Flat-color fallbacks — Solar System Scope only ships a map for the Moon,
// every other moon texture 404s and keeps its color.
var MOON_FALLBACK = {
  io: 0xd4a843, europa: 0xc8b89a, ganymede: 0x808080, callisto: 0x808080,
  titan: 0xd4823c,
};

// ── Dwarf planets — real Kepler elements (J2000, deg / AU / days) ─────────────
// body = slug prefix for the manifest model lookup (category dwarf_planets).
// Shared with the page (classic-script global): radar.ejs converts these to
// orbitPos()-style elements and solves positions — this file never does.
var DWARF_PLANETS = [
  {
    id: 'ceres', name: 'Ceres', body: 'ceres',
    a: 2.7691, e: 0.0785, i: 10.593, node: 80.329, w: 73.115,
    M: 352.1, T: 1681.63,
    r: 3.16e-6,            // 473 km / 1.496e8
    color: 0x888880, minPx: 3,
  },
  {
    id: 'pluto', name: 'Pluto', body: 'pluto',
    a: 39.482, e: 0.2488, i: 17.14, node: 110.3, w: 113.8,
    M: 14.53, T: 90560.0,
    r: 7.94e-6,            // 1188 km / 1.496e8
    color: 0xc8b89a, minPx: 3,
  },
  // ── Trans-Neptunian dwarf planets ─────────────────────────────────────────
  // Heliocentric osculating elements, each at its OWN epoch_jd (propagated to
  // the sim epoch by radar.ejs _elemsFromEpoch, same as the comets).
  // Sources, read 2026-11-10 (JPL itself was not reachable from the build box):
  //   [S] JPL Small-Body Database elements as republished by TheSkyLive
  //   [W] Wikipedia infobox, which cites JPL SBDB
  // Cross-check: heliocentric distance on 1 Jan 2026 vs the JPL Horizons values
  // quoted in Wikipedia's list of most distant objects: Eris 95.53 vs 95.5 AU,
  // Gonggong 89.70 vs 89.7, Sedna 83.03 vs 83.0. Haumea, Makemake, Quaoar and
  // Orcus have NO independent check yet.
  // r = mean radius. Colors are artistic approximations of the published
  // spectral slopes (neutral/white vs red), not measured RGB. No shape models:
  // all render as spheres (Haumea is really a triaxial ellipsoid with a ring).
  {
    id: 'eris', name: 'Eris', body: 'eris', epoch_jd: 2460800.5,       // [S] 4 May 2025
    a: 68.05060149, e: 0.43567548, i: 43.82162477, node: 36.046036082, w: 150.714363559,
    M: 211.032077671, T: 205043.676,
    r: 7.77e-6,            // 1163 km
    color: 0xd9d9d6, minPx: 3,
  },
  {
    id: 'haumea', name: 'Haumea', body: 'haumea', epoch_jd: 2461200.5, // [S] 8 Jun 2026
    a: 43.06029024, e: 0.19444301, i: 28.20847393, node: 121.786056133, w: 240.690547251,
    M: 223.210411881, T: 103208.1173,
    r: 5.16e-6,            // 1544 km mean diameter / 2
    color: 0xd2d6da, minPx: 3,
  },
  {
    id: 'makemake', name: 'Makemake', body: 'makemake', epoch_jd: 2460600.5, // [S] 16 Oct 2024
    a: 45.38390777, e: 0.16353397, i: 29.03373563, node: 79.260520400, w: 296.753831617,
    M: 168.416838182, T: 111673.7908,
    r: 4.78e-6,            // 715 km
    color: 0xc49a7a, minPx: 3,
  },
  {
    id: 'gonggong', name: 'Gonggong', body: 'gonggong', epoch_jd: 2461000.5, // [W] 21 Nov 2025
    a: 66.895, e: 0.50318, i: 30.8664, node: 336.8401, w: 206.6442,
    M: 111.384, T: 199837.0,
    r: 4.11e-6,            // 615 km
    color: 0xb0624a, minPx: 3,
  },
  {
    id: 'quaoar', name: 'Quaoar', body: 'quaoar', epoch_jd: 2459000.5, // [W] 31 May 2020
    a: 43.694, e: 0.04106, i: 7.9895, node: 188.927, w: 147.480,
    M: 301.104, T: 105495.0,
    r: 3.67e-6,            // 1097.6 km volume-equivalent diameter / 2
    color: 0xa87860, minPx: 3,
  },
  {
    id: 'orcus', name: 'Orcus', body: 'orcus', epoch_jd: 2459000.5,   // [W] 31 May 2020
    a: 39.174, e: 0.22701, i: 20.592, node: 268.799, w: 72.310,
    M: 181.735, T: 89557.0,
    r: 3.04e-6,            // 910 km / 2
    color: 0x9aa0a8, minPx: 3,
  },
  // Sedna: heliocentric osculating elements of an a≈500 AU orbit wobble with
  // the Sun's motion about the barycenter (a = 506 AU at one epoch, 532 at
  // another), so two-body propagation is only trustworthy near the epoch. This
  // set gives perihelion in ~2075 (published: ≈ July 2076).
  {
    id: 'sedna', name: 'Sedna', body: 'sedna', epoch_jd: 2460000.5,   // [S] 24 Feb 2023
    a: 532.30647040, e: 0.85650695, i: 11.93034, node: 144.258477640, w: 310.868790093,
    M: 358.469407879, T: 4485812.0,                                  // 12,281.48 yr
    r: 3.03e-6,            // 906 km / 2 (thermal; occultation chord gives ~1025 km)
    color: 0xb4553c, minPx: 3,
  },
];

// ── Comets — JPL Kepler elements, each at its OWN epoch_jd ───────────────────
// The page (radar.ejs _elemsFromEpoch) propagates M from epoch_jd to the sim
// epoch, so Halley (epoch 2061, near perihelion) correctly sits near aphelion
// in 2026. body = manifest slug prefix; tail_color tints the dust tail (the
// ion tail is a fixed blue-white). Physical radii are REAL (AU) — the prompt's
// r were the km/1e6 inflation again (Halley 5.5e-6 AU ≈ 823 km), kept fixed.
var COMETS = [
  {
    id: 'halley', name: '1P/Halley', short: '1P/Halley', body: 'halley',
    epoch_jd: 2474040.5,                     // 4 Aug 2061, perihelion 28 Jul 2061
    a: 17.737, e: 0.96658, i: 161.96, node: 59.396, w: 112.05, M: 0.07323,
    T: 27255.0, r: 3.68e-8, color: 0x8899aa, tail_color: 0xaabbff, minPx: 2.5, // ~5.5 km
  },
  {
    id: 'churyumov', name: '67P/Churyumov-Gerasimenko', short: '67P/C-G',
    body: 'churyumov-gerasimenko', epoch_jd: 2451545.0,
    a: 3.463, e: 0.6411, i: 7.04, node: 50.147, w: 12.783, M: 342.0,
    T: 2354.0, r: 1.34e-8, color: 0x777766, tail_color: 0xffeeaa, minPx: 2.5, // ~2.0 km
  },
  {
    id: 'hartley2', name: '103P/Hartley 2', short: '103P/Hartley',
    body: 'hartley_2', epoch_jd: 2451545.0,
    a: 3.475, e: 0.6943, i: 13.61, node: 219.76, w: 181.0, M: 30.0,
    T: 2365.0, r: 3.9e-9, color: 0x666655, tail_color: 0xffffcc, minPx: 2.5,  // ~0.58 km
  },
  {
    id: 'tempel1', name: '9P/Tempel 1', short: '9P/Tempel',
    body: 'tempel_1', epoch_jd: 2451545.0,
    a: 3.123, e: 0.5175, i: 10.47, node: 68.94, w: 178.9, M: 346.0,
    T: 2016.0, r: 2.0e-8, color: 0x665544, tail_color: 0xffddaa, minPx: 2.5,  // ~3.0 km
  },
  {
    id: 'wild2', name: '81P/Wild 2', short: '81P/Wild',
    body: 'wild_2', epoch_jd: 2451545.0,
    a: 3.451, e: 0.5362, i: 3.24, node: 136.07, w: 47.0, M: 87.0,
    T: 2348.0, r: 1.37e-8, color: 0x554433, tail_color: 0xffcc88, minPx: 2.5, // ~2.05 km
  },
];

// Coma/tails become visible inside this heliocentric distance (AU)
var COMET_ACTIVE_AU = 2.5;

// Local circular-orbit offset from the parent at simTime (days from the sim
// epoch JD 2461188.0 = J2000 + 9643 d — same phase convention the page's old
// moonPos() used, so the Moon keeps its position across this refactor).
function moonLocalPos(data, simTime) {
  var Tabs = Math.abs(data.T);
  var phase0 = ((9643 % Tabs) / Tabs) * 2 * Math.PI;
  var sign = data.T < 0 ? -1 : 1;
  var angle = phase0 + sign * (simTime / Tabs) * 2 * Math.PI;
  var iRad = data.i * Math.PI / 180;
  var sa = Math.sin(angle);
  return {
    x: data.a * Math.cos(angle),
    y: data.a * sa * Math.cos(iRad),
    z: data.a * sa * Math.sin(iRad),
    angle: angle,
  };
}

/* ── Seeded PRNG + string hash (deterministic asteroid shapes) ───────────── */

function _mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function _hashString(str) {
  var h = 5381;
  for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return h >>> 0;
}

/* ── Inline 3D simplex noise (Gustavson variant, seeded permutation) ─────── */

function _makeSimplex3D(rand) {
  var grad3 = [
    [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
    [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
    [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
  ];
  var p = new Uint8Array(256);
  for (var i = 0; i < 256; i++) p[i] = i;
  for (var j = 255; j > 0; j--) {
    var k = (rand() * (j + 1)) | 0;
    var tmp = p[j]; p[j] = p[k]; p[k] = tmp;
  }
  var perm = new Uint8Array(512), permMod12 = new Uint8Array(512);
  for (var m = 0; m < 512; m++) { perm[m] = p[m & 255]; permMod12[m] = perm[m] % 12; }

  var F3 = 1 / 3, G3 = 1 / 6;
  return function noise3D(xin, yin, zin) {
    var n0, n1, n2, n3;
    var s = (xin + yin + zin) * F3;
    var i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
    var t = (i + j + k) * G3;
    var x0 = xin - (i - t), y0 = yin - (j - t), z0 = zin - (k - t);
    var i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0)      { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else               { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0)       { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0)  { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else               { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }
    var x1 = x0 - i1 + G3,     y1 = y0 - j1 + G3,     z1 = z0 - k1 + G3;
    var x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    var x3 = x0 - 1 + 3 * G3,  y3 = y0 - 1 + 3 * G3,  z3 = z0 - 1 + 3 * G3;
    var ii = i & 255, jj = j & 255, kk = k & 255;
    var gi0 = permMod12[ii + perm[jj + perm[kk]]];
    var gi1 = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]];
    var gi2 = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]];
    var gi3 = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]];
    var t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0, g;
    if (t0 < 0) n0 = 0; else { t0 *= t0; g = grad3[gi0]; n0 = t0 * t0 * (g[0] * x0 + g[1] * y0 + g[2] * z0); }
    var t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 < 0) n1 = 0; else { t1 *= t1; g = grad3[gi1]; n1 = t1 * t1 * (g[0] * x1 + g[1] * y1 + g[2] * z1); }
    var t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 < 0) n2 = 0; else { t2 *= t2; g = grad3[gi2]; n2 = t2 * t2 * (g[0] * x2 + g[1] * y2 + g[2] * z2); }
    var t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 < 0) n3 = 0; else { t3 *= t3; g = grad3[gi3]; n3 = t3 * t3 * (g[0] * x3 + g[1] * y3 + g[2] * z3); }
    return 32 * (n0 + n1 + n2 + n3);
  };
}

/* ── Procedural asteroid mesh — deterministic per designation ────────────── */

// 4 shape archetypes picked by seed%4 — matches the rock-texture set choice
// (stretch = per-axis elongation applied after the noise displacement)
var NEO_SHAPE_ARCHETYPES = [
  { stretch: [1.0, 1.0, 1.0] },   // 0 near-spherical rubble pile — Bennu-like
  { stretch: [1.6, 1.0, 1.0] },   // 1 elongated along X — Eros-like
  { stretch: [1.0, 1.0, 0.7] },   // 2 flattened along Z — Apophis-like
  { stretch: [1.0, 1.0, 1.0], asym: true }, // 3 irregular: rougher +X hemisphere
];

function generateAsteroidGeometry(seed, detail) {
  var rand    = _mulberry32(seed);
  var noise3D = _makeSimplex3D(rand);
  var geo     = new THREE.IcosahedronGeometry(1, detail == null ? 3 : detail);
  var pos     = geo.attributes.position;
  var v       = new THREE.Vector3();
  var FREQ    = 1.7;
  var arche   = NEO_SHAPE_ARCHETYPES[(seed >>> 0) % NEO_SHAPE_ARCHETYPES.length];
  var st      = arche.stretch;
  // Non-indexed geometry: duplicated verts share the same position, and the
  // displacement is a pure function of position — so seams stay watertight.
  for (var i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    // 3 noise octaves — large lobes, medium lumps, fine surface detail
    var n = 0.30 * noise3D(v.x * FREQ, v.y * FREQ, v.z * FREQ)
          + 0.12 * noise3D(v.x * FREQ * 2.3, v.y * FREQ * 2.3, v.z * FREQ * 2.3)
          + 0.04 * noise3D(v.x * FREQ * 5.1, v.y * FREQ * 5.1, v.z * FREQ * 5.1);
    // Asymmetric archetype: one hemisphere gets an extra aggressive octave
    if (arche.asym && v.x > 0) {
      n += v.x * 0.18 * noise3D(v.x * FREQ * 3.1 + 7.7, v.y * FREQ * 3.1 + 7.7, v.z * FREQ * 3.1 + 7.7);
    }
    var r = 1 + n;
    pos.setXYZ(i, v.x * r * st[0], v.y * r * st[1], v.z * r * st[2]);
  }
  geo.computeVertexNormals();
  return geo;
}

/* ── NASA shape models (GLB, public domain — VTAD) ───────────────────────── */

// numeric designation → model file in /assets/models/<key>.glb
// (fetched by scripts/downloadAsteroidModels.js; missing files simply fall
// back to the procedural archetypes below)
var MODEL_MAP = {
  '99942':  'apophis',   // Apophis
  '101955': 'bennu',     // Bennu
  '433':    'eros',      // Eros
  '25143':  'itokawa',   // Itokawa
  '162173': 'ryugu',     // Ryugu
  '65803':  'didymos',   // Didymos
  '4179':   'toutatis_radar-based_hi-res',  // Toutatis (manifest import)
  // Manifest-imported shape models (scripts/convertAndImport.js — slugs ARE
  // the .glb basenames in /assets/models/)
  '1862':   'apollo_model_1',              // Apollo
  '1036':   'ganymed_model_1',             // Ganymed
  '4769':   'castalia_radar-based',        // Castalia
  '6489':   'golevka_radar-based',         // Golevka
  '1620':   'geographos_radar-based_mid-res', // Geographos
  '2100':   'ra-shalom_radar-based',       // Ra-Shalom
};

// #repr-notice text when a real NASA shape model is on screen
var MODEL_NOTICE = {
  apophis:  'NASA SHAPE MODEL · RADAR OBSERVATION DATA',
  bennu:    'NASA SHAPE MODEL · OSIRIS-REX DATA · 2019',
  eros:     'NASA SHAPE MODEL · NEAR SHOEMAKER DATA · 2000',
  itokawa:  'NASA SHAPE MODEL · HAYABUSA DATA · 2005',
  ryugu:    'NASA SHAPE MODEL · HAYABUSA2 DATA · 2018',
  didymos:  'NASA SHAPE MODEL · DART / RADAR DATA · 2022',
  toutatis: 'NASA SHAPE MODEL · RADAR OBSERVATION DATA',
};

// Fallback notice for manifest models without a curated credit line
var MODEL_NOTICE_DEFAULT = 'SHAPE MODEL · RADAR / LIGHTCURVE INVERSION DATA';

function _modelKeyFor(designation, name) {
  var d = String(designation || '').trim();
  var m = /^\(?(\d+)\)?/.exec(d);
  if (m && MODEL_MAP[m[1]]) return MODEL_MAP[m[1]];
  // Whole-word name match ("(101955) Bennu" → bennu)
  var n = ' ' + String(name || d).toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
  for (var key in MODEL_NOTICE) {
    if (n.indexOf(' ' + key + ' ') !== -1) return key;
  }
  return null;
}

/* ── 8 procedural asteroid archetypes (seed-picked, deterministic) ───────── */

var ASTEROID_ARCHETYPES = [
  { stretch: [1.00, 1.00, 1.00], amp: 0.30, freq: 1.6, craters: 3 },               // 1 rubble-pile sphere
  { stretch: [1.85, 0.85, 0.75], amp: 0.22, freq: 1.3, craters: 2 },               // 2 elongated, Eros-like
  { stretch: [1.00, 1.00, 1.00], amp: 0.48, freq: 2.3, craters: 1 },               // 3 heavily lumped
  { stretch: [1.25, 1.05, 0.70], amp: 0.28, freq: 1.8, craters: 4 },               // 4 flattened, cratered
  { stretch: [1.45, 1.15, 0.90], amp: 0.34, freq: 1.1, craters: 2 },               // 5 broad irregular
  { stretch: [1.00, 0.92, 0.88], amp: 0.16, freq: 2.9, craters: 2, equator: 0.16 },// 6 spinning-top, Bennu-like
  { stretch: [2.30, 0.75, 0.70], amp: 0.26, freq: 1.5, craters: 2, waist: 0.22 },  // 7 contact-binary
  { stretch: [1.10, 1.10, 0.80], amp: 0.40, freq: 2.0, craters: 5 },               // 8 battered oblate
];

function generateArchetypeGeometry(seed, detail) {
  var arche   = ASTEROID_ARCHETYPES[(seed >>> 0) % ASTEROID_ARCHETYPES.length];
  var rand    = _mulberry32(seed);
  var noise3D = _makeSimplex3D(rand);

  var craters = [];
  for (var c = 0; c < arche.craters; c++) {
    var u = rand() * 2 - 1, ph = rand() * Math.PI * 2, sq = Math.sqrt(1 - u * u);
    craters.push({
      x: sq * Math.cos(ph), y: sq * Math.sin(ph), z: u,
      size: 0.20 + rand() * 0.45,                  // extent in 1−cos(angle) space
      depth: 0.06 + rand() * 0.12,
    });
  }

  var geo = new THREE.IcosahedronGeometry(1, detail == null ? 3 : detail);
  var pos = geo.attributes.position;
  var v   = new THREE.Vector3();
  var f   = arche.freq;
  var maxR = 0;
  // Displacement is a pure function of position, so duplicated verts of the
  // non-indexed geometry stay watertight (same rule as generateAsteroidGeometry).
  for (var i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    var n = noise3D(v.x * f, v.y * f, v.z * f)
          + 0.50 * noise3D(v.x * f * 2.1, v.y * f * 2.1, v.z * f * 2.1)
          + 0.25 * noise3D(v.x * f * 4.3, v.y * f * 4.3, v.z * f * 4.3);
    var r = 1 + n * arche.amp * 0.7;
    for (var k = 0; k < craters.length; k++) {
      var cr = craters[k];
      var d = 1 - (v.x * cr.x + v.y * cr.y + v.z * cr.z);
      if (d < cr.size) {
        var t = 1 - d / cr.size;
        r -= cr.depth * t * t * (3 - 2 * t);       // smoothstep bowl
      }
    }
    if (arche.equator) r += arche.equator * (1 - Math.abs(v.z)) * 0.9;
    if (arche.waist)   r -= arche.waist * Math.exp(-Math.pow(v.x * 2.2, 2));
    var px = v.x * r * arche.stretch[0];
    var py = v.y * r * arche.stretch[1];
    var pz = v.z * r * arche.stretch[2];
    pos.setXYZ(i, px, py, pz);
    var rr = px * px + py * py + pz * pz;
    if (rr > maxR) maxR = rr;
  }
  // Normalize to unit max radius so callers can scale in world units directly
  maxR = Math.sqrt(maxR) || 1;
  for (var j = 0; j < pos.count; j++) {
    pos.setXYZ(j, pos.getX(j) / maxR, pos.getY(j) / maxR, pos.getZ(j) / maxR);
  }
  geo.computeVertexNormals();
  return geo;
}

/* ── Procedural PBR rock textures (canvas-generated, zero external files) ── */

function generateRockTexture(seed, resolution) {
  var res     = resolution || 512;
  var rand    = _mulberry32((seed ^ 0x5f3759df) >>> 0);
  var noise3D = _makeSimplex3D(rand);

  // Sample on a cylinder so u wraps seamlessly around the mesh
  function fbm(u, v, oct, baseFreq, zoff) {
    var a = u * Math.PI * 2;
    var cx = Math.cos(a), sx = Math.sin(a);
    var sum = 0, amp = 1, norm = 0, fr = baseFreq;
    for (var o = 0; o < oct; o++) {
      sum += amp * noise3D(cx * fr, sx * fr, v * fr * 2.2 + zoff);
      norm += amp; amp *= 0.5; fr *= 2.03;
    }
    return sum / norm;                             // ≈ [−1, 1]
  }

  // Height field first — shared by albedo shading and the normal map
  var h   = new Float32Array(res * res);
  var inv = 1 / res;
  var x, y, i;
  for (y = 0; y < res; y++) {
    for (x = 0; x < res; x++) {
      h[y * res + x] = fbm(x * inv, y * inv, 4, 1.5, 0);
    }
  }

  function makeCanvas() {
    var c = document.createElement('canvas');
    c.width = c.height = res;
    return c;
  }
  var albC = makeCanvas(), norC = makeCanvas(), rouC = makeCanvas();
  var albG = albC.getContext('2d'), norG = norC.getContext('2d'), rouG = rouC.getContext('2d');
  var albD = albG.createImageData(res, res);
  var norD = norG.createImageData(res, res);
  var rouD = rouG.createImageData(res, res);

  var STR = 1.6;                                   // normal-map strength
  for (y = 0; y < res; y++) {
    for (x = 0; x < res; x++) {
      i = y * res + x;
      var o4 = i * 4;
      var hv = h[i] * 0.5 + 0.5;                   // 0..1

      // Albedo: dark brown 0x5a4a3a → light gray-brown 0x8a7a6a by height,
      // plus fine speckle so it reads as regolith up close
      var spk = fbm(x * inv, y * inv, 2, 11.0, 37.7) * 0.5 + 0.5;
      var t = Math.min(1, Math.max(0, hv * 0.8 + spk * 0.2));
      var shade = spk > 0.82 ? 0.7 : 1;            // dark speckles
      albD.data[o4]     = ((0x5a + (0x8a - 0x5a) * t) * shade) | 0;
      albD.data[o4 + 1] = ((0x4a + (0x7a - 0x4a) * t) * shade) | 0;
      albD.data[o4 + 2] = ((0x3a + (0x6a - 0x3a) * t) * shade) | 0;
      albD.data[o4 + 3] = 255;

      // Normal from height-field central differences (wrapping)
      var xl = h[y * res + ((x - 1 + res) % res)], xr = h[y * res + ((x + 1) % res)];
      var yu = h[((y - 1 + res) % res) * res + x], yd = h[((y + 1) % res) * res + x];
      var nx = (xl - xr) * STR, ny = (yu - yd) * STR;
      var nl = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      norD.data[o4]     = ((nx * nl * 0.5 + 0.5) * 255) | 0;
      norD.data[o4 + 1] = ((ny * nl * 0.5 + 0.5) * 255) | 0;
      norD.data[o4 + 2] = ((nl * 0.5 + 0.5) * 255) | 0;
      norD.data[o4 + 3] = 255;

      // Roughness ~0.9 with mild variation (three.js reads the G channel)
      var rough = ((0.9 + h[i] * 0.05) * 255) | 0;
      rouD.data[o4] = rouD.data[o4 + 1] = rouD.data[o4 + 2] = rough;
      rouD.data[o4 + 3] = 255;
    }
  }
  albG.putImageData(albD, 0, 0);
  norG.putImageData(norD, 0, 0);
  rouG.putImageData(rouD, 0, 0);

  var albedoTexture = new THREE.CanvasTexture(albC);
  albedoTexture.encoding = THREE.sRGBEncoding;
  var normalTexture    = new THREE.CanvasTexture(norC);
  var roughnessTexture = new THREE.CanvasTexture(rouC);
  [albedoTexture, normalTexture, roughnessTexture].forEach(function (tx) {
    tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
  });
  return { albedoTexture: albedoTexture, normalTexture: normalTexture, roughnessTexture: roughnessTexture };
}

/* ── Comet tails (dust + ion), procedural on the GPU ─────────────────────── */
// One instance per comet, two THREE.Points systems in the MAIN scene (so the
// tail renders in focus mode too). Nothing is simulated on the CPU: every
// particle owns four fixed random seeds and the vertex shader derives its
// position, size and brightness from those seeds plus a handful of uniforms
// (comet position, anti-solar axis, trailing axis, tail length, activity,
// time). That gives:
//  - no gaps or clumps at any time speed (a stateful emitter spaces particles
//    by how far the comet moved per frame; this has no such dependency),
//  - tens of thousands of particles for almost no CPU cost,
//  - sprites sized in WORLD units and projected to pixels, so the tail keeps
//    its shape from the wide map to a close focus (clamped to a pixel range
//    so nothing balloons or vanishes),
//  - round soft sprites (gaussian falloff to exactly zero at the edge), which
//    is what removes the square, spaced-out look.
// The scene uses logarithmicDepthBuffer, but these sprites draw with
// depthTest off and additive blending, so no depth chunks are needed.
//
// Physical model, kept simple on purpose:
//  - Dust follows a syndyne-style fan: each particle has a beta (radiation
//    pressure over gravity). High beta leaves fast and flies nearly straight
//    anti-solar, low beta lags and bends toward the trailing side of the orbit.
//  - Ion is a set of thin straight rays along the anti-solar line with a small
//    wavy kink, because plasma follows the solar wind, not the orbit.
//  - Surface brightness falls as each particle spreads (flux conservation:
//    alpha scales with 1/size), plus a fade with age along the tail.

var COMET_N_DUST = 40000;
var COMET_N_ION  = 6000;
var COMET_N_COMA = 14000;

// Radical inverse (Halton): low-discrepancy samples, so the particles cover the
// tail evenly instead of clumping the way plain Math.random() does. This is what
// removes the blotchy, mottled look of large soft sprites.
function cometHalton(i, base) {
  var f = 1, r = 0;
  while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
  return r;
}

var COMET_TAIL_VERT = [
  'uniform vec3  uComet;',
  'uniform vec3  uAnti;',
  'uniform vec3  uTrail;',
  'uniform float uLen;',
  'uniform float uAct;',
  'uniform float uTime;',
  'uniform float uFlow;',
  'uniform float uPxScale;',
  'uniform float uMinPx;',
  'uniform float uMaxPx;',
  'uniform float uRefPx;',
  'uniform float uGain;',
  'uniform vec3  uHot;',
  'uniform vec3  uCold;',
  'attribute vec4 aSeed;',
  'varying vec4 vColor;',
  '',
  'void main() {',
  '  float a = fract(aSeed.x + uTime * uFlow);',      // age along the tail, 0..1
  '  float s = pow(a, 1.55);',                         // more particles near the head
  '  vec3 up = abs(uAnti.z) > 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0);',
  '  vec3 p1 = normalize(cross(uAnti, up));',
  '  vec3 p2 = cross(uAnti, p1);',
  '  float u1 = clamp(aSeed.y, 0.001, 1.0);',
  '  float r  = sqrt(-2.0 * log(u1));',
  '  float g1 = r * cos(6.2831853 * aSeed.w);',
  '  float g2 = r * sin(6.2831853 * aSeed.w);',
  '  vec3 pos;',
  '  float wSize;',
  '  float tint = 0.0;',
  '#ifdef ION',
  '  float ray   = floor(aSeed.z * 9.0);',
  '  float ph    = fract(sin(ray * 12.9898) * 43758.5453);',
  '  float th    = 6.2831853 * ph;',
  '  float rho   = (0.2 + 0.8 * fract(ph * 7.31)) * (0.003 + 0.014 * s) * uLen;',
  '  vec3 lat    = (p1 * cos(th) + p2 * sin(th)) * rho;',
  '  lat += (p1 * g1 + p2 * g2) * (0.0006 + 0.0022 * s) * uLen;',
  '  float kink  = sin(s * 9.0 + th + uTime * 0.7) * 0.012 * s * uLen;',
  '  pos = uComet + uAnti * (s * uLen) + lat + p1 * kink + uTrail * (s * s * 0.05 * uLen);',
  '  wSize = uLen * (0.0012 + 0.028 * s);',
  '#else',
  '#ifdef COMA',
  '  float k3  = sqrt(-2.0 * log(clamp(fract(aSeed.x * 57.31 + aSeed.y * 13.7), 0.001, 1.0)));',
  '  float g3  = k3 * cos(6.2831853 * fract(aSeed.z * 91.7 + aSeed.w * 3.3));',
  '  vec3 dir  = normalize(vec3(g1, g2, g3) + 1e-4);',
  '  float ca  = dot(dir, uAnti);',                       // > 0 on the tail side
  '  vec3 off;',
  '  if (aSeed.z < 0.2) {',
  // sunward fountain: leaves toward the Sun, then the solar wind sweeps it back
  '    vec3 jd  = normalize(-uAnti * 0.75 + (p1 * g1 + p2 * g2) * 0.35);',
  '    float jo = sin(3.14159265 * min(a * 1.15, 1.0));',
  '    off = jd * (uLen * 1.15 * jo) + uAnti * (uLen * 1.7 * a * a) + uTrail * (uLen * 0.5 * a * a);',
  '  } else {',
  // shell: compressed on the sunward side, drawn out toward the tail
  '    float sc = 0.7 + 1.7 * max(ca, 0.0) * a;',
  '    off = dir * (uLen * pow(a, 2.0) * sc) + uAnti * (uLen * 0.6 * a * a);',
  '  }',
  '  pos = uComet + off;',
  '  wSize = uLen * (0.10 + 0.30 * a);',
  '  if (aSeed.z < 0.2) wSize *= 1.8;',
  '#else',
  '  float beta  = pow(aSeed.z, 0.55);',
  '  float reach = s * mix(0.55, 1.0, beta);',
  '  float bend  = s * s * (1.0 - beta) * 0.55;',
  '  float wid   = uLen * (0.012 + 0.22 * s);',
  '  vec3 lat    = (p1 * g1 + p2 * g2 * 0.6) * wid * 0.5;',
  '  tint = clamp(length(vec2(g1, g2 * 0.6)) * 0.22, 0.0, 1.0);',
  '  pos = uComet + uAnti * (reach * uLen) + uTrail * (bend * uLen) + lat;',
  '  wSize = uLen * (0.004 + 0.075 * s);',
  '#endif',
  '#endif',
  '  vec4 mv = modelViewMatrix * vec4(pos, 1.0);',
  '  float depth = -mv.z;',
  '  if (depth <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vColor = vec4(0.0); return; }',
  '  float px = clamp(wSize * uPxScale / depth, uMinPx, uMaxPx);',
  '  float fade = smoothstep(0.0, 0.05, a) * pow(1.0 - a, 0.85);',
  '  float spread = uRefPx / max(px, uRefPx);',
  '  float alpha = min(1.0, uGain * uAct * fade * spread);',
  '  vColor = vec4(mix(uHot, uCold, clamp(pow(s, 0.6) * 0.65 + tint, 0.0, 1.0)), alpha);',
  '  gl_PointSize = px;',
  '  gl_Position = projectionMatrix * mv;',
  '}',
].join('\n');

var COMET_TAIL_FRAG = [
  'varying vec4 vColor;',
  'void main() {',
  '  vec2 c = gl_PointCoord - 0.5;',
  '  float d2 = dot(c, c) * 4.0;',                    // 0 at center, 1 at the edge
  '  if (d2 >= 1.0) discard;',
  '  float falloff = exp(-d2 * 2.3) * (1.0 - d2);',   // soft, exactly 0 at the edge
  '  gl_FragColor = vec4(vColor.rgb, vColor.a * falloff);',
  '  #include <encodings_fragment>',
  '}',
].join('\n');

class CometTail {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Texture} glowTex  unused (sprites are procedural), kept for API
   * @param {*} tailColor            unused (palette is fixed below)
   * @param {Float32Array} [orbitPts] stride-3 orbit samples in order of motion;
   *        the local tangent gives the trailing direction even when paused
   */
  constructor(scene, glowTex, tailColor, orbitPts) {
    this._scene = scene;
    this._orbitPts = orbitPts || null;
    // Same palette as before: white head fading through blue to a blue-violet
    // tip (linear space). Dust and ion get their own pair.
    this._dustHot  = new THREE.Color(0xffffff).convertSRGBToLinear();
    this._dustCold = new THREE.Color(0x88aaff).convertSRGBToLinear();
    this._ionHot   = new THREE.Color(0xa9cfff).convertSRGBToLinear();
    this._ionCold  = new THREE.Color(0x7766cc).convertSRGBToLinear();
    this._comaHot  = new THREE.Color(0xeaf2ff).convertSRGBToLinear();
    this._comaCold = new THREE.Color(0x88aaff).convertSRGBToLinear();
    this._smoothActivity = 0;
    this._time = 0;
    this._anti  = new THREE.Vector3();
    this._trail = new THREE.Vector3(0, 1, 0);
    this._sz    = new THREE.Vector2();
    this._maxPointPx = 0;
    // Live multipliers (handy for tuning from the console: comet.tail.tune.dust = 2)
    this.tune = { dust: 1.0, ion: 1.0, coma: 1.0 };
    var m = (typeof window !== 'undefined' && window.innerWidth < 768) ? 0.5 : 1;   // fill-rate on phones
    this.dust = this._makeSystem(Math.round(COMET_N_DUST * m), 'dust');
    this.ion  = this._makeSystem(Math.round(COMET_N_ION  * m), 'ion');
    this.coma = this._makeSystem(Math.round(COMET_N_COMA * m), 'coma');
    scene.add(this.dust.points);
    scene.add(this.ion.points);
    scene.add(this.coma.points);
  }

  _makeSystem(n, kind) {
    var isIon = kind === 'ion', isComa = kind === 'coma';
    var seeds = new Float32Array(n * 4);
    var bases = [2, 3, 5, 7], off = [Math.random(), Math.random(), Math.random(), Math.random()];
    for (var i = 0; i < n; i++) {
      for (var k = 0; k < 4; k++) {
        var h = cometHalton(i + 1, bases[k]) + off[k];     // random per-system shift
        seeds[i * 4 + k] = h - Math.floor(h);
      }
    }
    var geo = new THREE.BufferGeometry();
    // 'position' is never read by the shader but three.js sizes the draw call
    // from it
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    var self = this;
    var mat = new THREE.ShaderMaterial({
      defines: isIon ? { ION: 1 } : (isComa ? { COMA: 1 } : {}),
      uniforms: {
        uComet:   { value: new THREE.Vector3() },
        uAnti:    { value: new THREE.Vector3(1, 0, 0) },
        uTrail:   { value: new THREE.Vector3(0, 1, 0) },
        uLen:     { value: 0.0 },
        uAct:     { value: 0.0 },
        uTime:    { value: 0.0 },
        uFlow:    { value: isIon ? 0.16 : (isComa ? 0.12 : 0.065) },
        uPxScale: { value: 800.0 },
        uMinPx:   { value: 1.5 },
        uMaxPx:   { value: 96.0 },
        uRefPx:   { value: 6.0 },
        uGain:    { value: isIon ? 0.12 : (isComa ? 0.17 : 0.105) },
        uHot:     { value: (isIon ? this._ionHot  : (isComa ? this._comaHot  : this._dustHot)).clone() },
        uCold:    { value: (isIon ? this._ionCold : (isComa ? this._comaCold : this._dustCold)).clone() },
      },
      vertexShader: COMET_TAIL_VERT,
      fragmentShader: COMET_TAIL_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });
    var points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 2;               // after the opaque nucleus/scene
    points.visible = false;
    // Pixel scale depends on the live camera + drawing buffer, so refresh it
    // right before the draw
    points.onBeforeRender = function (renderer, scene, camera) {
      renderer.getDrawingBufferSize(self._sz);
      var pr = renderer.getPixelRatio();
      if (!self._maxPointPx) {
        var gl = renderer.getContext();
        var rng = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
        self._maxPointPx = rng ? rng[1] : 64;
      }
      var u = mat.uniforms;
      u.uPxScale.value = 0.5 * self._sz.y * camera.projectionMatrix.elements[5];
      u.uMinPx.value   = 1.5 * pr;
      u.uMaxPx.value   = Math.min(72 * pr, self._maxPointPx);
      u.uRefPx.value   = 6.0 * pr;
      mat.uniformsNeedUpdate = true;
    };
    return { geo: geo, mat: mat, points: points, n: n };
  }

  activity() { return this._smoothActivity; }

  // Trailing direction (opposite to the velocity) from the orbit polyline:
  // nearest sample, then the local tangent. Works while paused or scrubbing.
  _updateTrail(cometPos) {
    var pts = this._orbitPts;
    if (!pts) return;
    var N = pts.length / 3, best = 0, bd = Infinity;
    for (var k = 0; k < N; k++) {
      var dx = pts[k*3] - cometPos.x, dy = pts[k*3+1] - cometPos.y, dz = pts[k*3+2] - cometPos.z;
      var d = dx*dx + dy*dy + dz*dz;
      if (d < bd) { bd = d; best = k; }
    }
    var n1 = ((best + 1) % N) * 3, p1 = ((best - 1 + N) % N) * 3;
    this._trail.set(pts[p1] - pts[n1], pts[p1+1] - pts[n1+1], pts[p1+2] - pts[n1+2]);
    // Keep only the part perpendicular to the anti-solar axis
    var dot = this._trail.dot(this._anti);
    this._trail.addScaledVector(this._anti, -dot);
    if (this._trail.lengthSq() < 1e-18) this._trail.set(-this._anti.y, this._anti.x, 0);
    this._trail.normalize();
  }

  update(cometPos, sunPos, distSol, simDt, focusBoost) {
    var dt = simDt || 1.0;
    this._anti.copy(cometPos).sub(sunPos);
    var d = this._anti.length() || 1e-9;
    this._anti.multiplyScalar(1 / d);

    var activity = Math.max(0, (COMET_ACTIVE_AU - distSol) / COMET_ACTIVE_AU);
    // Exponential smoothing: the tail grows/shrinks over seconds, not instantly
    this._smoothActivity = this._smoothActivity * 0.98 + activity * 0.02;
    var act = this._smoothActivity;

    // Fully idle: hide both systems and skip all uniform work
    if (act < 0.005) { this.hide(); return; }

    this._updateTrail(cometPos);
    this._time += dt / 60;                      // dt is a ~1-at-60fps pace factor

    var boost = focusBoost ? 1.25 : 1.0;
    // Lengths in AU: dust tail, ion tail, coma radius (tied to the ion length)
    var sys = [this.dust, this.ion, this.coma];
    var lens = [act * 1.5, act * 1.5, act * 1.5 * 0.055];
    var tn = [this.tune.dust, this.tune.ion, this.tune.coma];
    for (var i = 0; i < 3; i++) {
      var u = sys[i].mat.uniforms;
      u.uComet.value.copy(cometPos);
      u.uAnti.value.copy(this._anti);
      u.uTrail.value.copy(this._trail);
      u.uLen.value  = lens[i];
      u.uAct.value  = Math.min(1, 0.35 + act) * boost * tn[i];
      u.uTime.value = this._time;
      sys[i].points.visible = true;
    }
  }

  hide() {
    this.dust.points.visible = false;
    this.ion.points.visible = false;
    this.coma.points.visible = false;
  }

  dispose() {
    [this.dust, this.ion, this.coma].forEach(function (s) {
      if (s.points.parent) s.points.parent.remove(s.points);
      s.geo.dispose();
      s.mat.dispose();
    });
  }
}

/* ── Magnetospheres ──────────────────────────────────────────────────────── */
// Focus-mode overlay for bodies with an intrinsic magnetic field. Two layers,
// both in REAL scale (units = body radii, never inflated by the min-px floor):
//
//   1. Field lines of the body's dipole, traced numerically through
//      B ∝ [3(m̂·r̂)r̂ − m̂] / r³, tilted and offset as published. They rotate
//      with the body.
//   2. The magnetopause: the empirical surface r(θ) = r0·(2/(1+cos θ))^α of
//      Shue et al. (1997, JGR 102, 9497), θ measured from the Sun direction,
//      r0 = observed subsolar standoff distance.
//
// What this is NOT: a model of the compressed dayside / stretched nightside
// field (Tsyganenko-class). The lines are pure dipole and are only drawn out
// to `shells`' last value, always inside the magnetopause.
//
// Sources (read 2026-11-10):
//   [F] NASA NSSDCA planetary fact sheets: dipole strength, tilt, offset
//   [W] Wikipedia "Magnetopause", table of observed standoff distances
//   [M] Winslow et al. 2013, JGR 118, 2213: Mercury r0 = 1.45 (1.35–1.55),
//       α = 0.5. Wicht & Heyner 2017 (arXiv:1701.05060): tilt < 0.8°,
//       dipole 480 km (0.2 radii) north of centre, axial dipole 190 nT
//   [E] Lu et al. 2011 as quoted in arXiv:1709.01407: Earth α ≈ 0.55
//   [J] Wikipedia "Magnetosphere of Jupiter": magnetopause 45–100 radii,
//       tail up to 7000 radii, dipolar inside ~10 radii, polarity opposite
//       to Earth's
//   [S] Wikipedia "Magnetosphere of Saturn": r0 ≈ 22 (16–27), dipole 0.037
//       radii north, mostly dipolar inside ~6 radii, polarity as Jupiter.
//       Kanani et al. 2010, JGR 115, A06207: α = 0.73
//   [U] Wikipedia "Uranus" / "Neptune", magnetosphere sections
//   [G] Wikipedia "Ganymede (moon)": 719 nT at the equator, moment tilted
//       176° from the rotation axis, ambient Jovian field ≈ 120 nT
//
// tilt  = angle between the rotation axis (north) and the magnetic MOMENT, in
//         degrees. Earth's moment points south: 180 − 9.35 ([F], geocentric
//         dipole at 80.65° N).
// polarityKnown = false where none of the sources state the sense of the
//         moment (Mercury, Uranus, Neptune). The lines are then drawn
//         without the direction-of-field animation instead of guessing it.
// offN  = dipole centre offset along the rotation axis, body radii (+ north).
//         Earth (0.076), Jupiter (0.119) and Neptune (0.485) have published
//         offsets too [F], but with no direction in these sources: not applied.
// alpha = magnetopause flaring. alphaAssumed = no published fit found for
//         that planet in these sources, a generic 0.6 is used.
// eqField = equatorial surface field of the dipole term, µT ([F]: 1 G = 100 µT).
var MAGNETOSPHERES = {
  mercury: {
    tilt: 0, tiltShown: '< 0.8°', polarityKnown: false, offN: 0.2,
    eqField: 0.19, r0: 1.45, r0lo: 1.35, r0hi: 1.55, alpha: 0.5, tail: 5,
    shells: [1.08, 1.16, 1.23, 1.30], lon: 12,
    tailNote: 'REAL TAIL: 10–100 RADII',
    note: 'The planet fills most of its own magnetosphere. Dipole sits 480 km north of the centre.',
  },
  earth: {
    tilt: 170.65, tiltShown: '9.4°', polarityKnown: true, offN: 0,
    eqField: 30.6, r0: 10, r0lo: 8, r0hi: 12, alpha: 0.55, tail: 3.5,
    shells: [1.5, 2, 3, 4, 5.5, 7, 8.5], lon: 10,
    tailNote: null,
    note: 'Field lines leave the southern hemisphere and enter the northern one.',
  },
  jupiter: {
    tilt: 9.4, polarityKnown: true, offN: 0,
    eqField: 430, r0: 75, r0lo: 45, r0hi: 100, alpha: 0.6, alphaAssumed: true, tail: 3,
    shells: [2, 3, 4.5, 6, 8, 11, 15], lon: 10,
    tailNote: 'REAL TAIL: UP TO 7000 RADII, PAST SATURN\'S ORBIT',
    note: 'Polarity opposite to Earth\'s. Beyond ~10 radii the real field stretches into a disc; lines shown are pure dipole.',
  },
  saturn: {
    tilt: 0, tiltShown: '< 0.5°', polarityKnown: true, offN: 0.038,
    eqField: 21.5, r0: 22, r0lo: 16, r0hi: 27, alpha: 0.73, tail: 3,
    shells: [1.5, 2.2, 3, 4, 5.5, 7, 9], lon: 10,
    tailNote: 'REAL TAIL: HUNDREDS OF RADII',
    note: 'Almost perfectly aligned with the spin axis. Polarity opposite to Earth\'s. Mostly dipolar inside ~6 radii.',
  },
  uranus: {
    tilt: 58.6, polarityKnown: false, offN: -0.33,
    eqField: 22.8, r0: 18, r0lo: null, r0hi: null, alpha: 0.6, alphaAssumed: true, tail: 3,
    shells: [2, 3, 4.5, 6.5, 9, 12, 16], lon: 10,
    tailNote: 'REAL TAIL: TWISTED INTO A CORKSCREW BY THE ROTATION',
    note: 'Dipole tilted 59° and shifted a third of a radius off-centre. Strong quadrupole: a dipole is a rough sketch here.',
  },
  neptune: {
    tilt: 46.9, polarityKnown: false, offN: 0,
    eqField: 14.2, r0: 24.5, r0lo: 23, r0hi: 26.5, alpha: 0.6, alphaAssumed: true, tail: 3,
    shells: [2, 3, 4.5, 6.5, 9, 13, 18, 22], lon: 10,
    tailNote: 'REAL TAIL: AT LEAST 72 RADII',
    note: 'Dipole tilted 47° and offset ~0.5 radii (direction not modelled). A dipole is a rough sketch here.',
  },
  // Ganymede sits INSIDE Jupiter's magnetosphere: no solar wind, no bullet-
  // shaped magnetopause. The field drawn is its dipole plus Jupiter's local
  // field treated as uniform and parallel to Ganymede's moment (ext = 120/719).
  // That superposition has a neutral ring at (719/120)^(1/3) = 1.82 radii and
  // puts the last closed field line at 29.2° latitude, matching the published
  // "closed below 30°" [G]: a check of the model, not an input to it.
  ganymede: {
    tilt: 176, polarityKnown: true, offN: 0,
    eqField: 0.719, ext: 120 / 719, noShell: true,
    r0: 1.82, tail: 0,
    closed: [1.12, 1.25, 1.38, 1.52, 1.66, 1.77], openColat: [10, 22, 34, 46, 56], rOut: 3.6, lon: 12,
    tailNote: null,
    note: 'The only moon with its own magnetosphere, a bubble inside Jupiter\'s. Polar lines are open: they connect to Jupiter.',
  },
};

// Bodies with no intrinsic global field: the toggle explains instead of drawing
var NO_MAGNETOSPHERE = {
  venus: 'NO INTRINSIC GLOBAL FIELD. The solar wind is held off by the ionosphere instead (induced magnetosphere).',
  mars:  'NO GLOBAL DIPOLE TODAY. Only patches of magnetised crust remain.',
  moon:  'NO GLOBAL FIELD. Only weak patches of magnetised crust.',
  _moon: 'NO INTRINSIC FIELD KNOWN. Ganymede is the only moon known to have its own magnetosphere.',
};

// Fastest the field cage may visibly turn (rad per real second). In live mode
// it tracks the planet's true rotation; under time acceleration a 59°-tilted
// dipole spinning 20× a second would only strobe.
var MAG_SPIN_CAP = 0.5;

// Dipole (+ optional uniform field along the moment) in the dipole frame:
// moment along +Z, lengths in body radii, field in units of the equatorial
// surface field. At the magnetic equator B = −ẑ/r³ (+ ext·ẑ).
function _magField(ext, p, out) {
  var x = p[0], y = p[1], z = p[2];
  var r2 = x * x + y * y + z * z, r5 = r2 * r2 * Math.sqrt(r2);
  out[0] = 3 * z * x / r5;
  out[1] = 3 * z * y / r5;
  out[2] = (3 * z * z - r2) / r5 + ext;
  return out;
}

// One field line through `seed`, followed along +B (sign 1) or −B (sign −1)
// with RK4 until it enters the body, leaves the rOut sphere or runs out of
// steps. `body` = body centre in the dipole frame (non-zero for offset dipoles).
function _magTrace(ext, seed, sign, body, rOut, maxSteps) {
  var pts = [seed[0], seed[1], seed[2]];
  var p = [seed[0], seed[1], seed[2]];
  var k1 = [0, 0, 0], k2 = [0, 0, 0], k3 = [0, 0, 0], k4 = [0, 0, 0], q = [0, 0, 0];
  function dir(at, out) {
    _magField(ext, at, out);
    var n = sign / (Math.hypot(out[0], out[1], out[2]) || 1e-12);
    out[0] *= n; out[1] *= n; out[2] *= n;
    return out;
  }
  var open = false;
  for (var s = 0; s < maxSteps; s++) {
    var h = Math.max(0.004, 0.03 * Math.hypot(p[0], p[1], p[2]));
    dir(p, k1);
    q[0] = p[0] + k1[0] * h / 2; q[1] = p[1] + k1[1] * h / 2; q[2] = p[2] + k1[2] * h / 2;
    dir(q, k2);
    q[0] = p[0] + k2[0] * h / 2; q[1] = p[1] + k2[1] * h / 2; q[2] = p[2] + k2[2] * h / 2;
    dir(q, k3);
    q[0] = p[0] + k3[0] * h; q[1] = p[1] + k3[1] * h; q[2] = p[2] + k3[2] * h;
    dir(q, k4);
    p[0] += h / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
    p[1] += h / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
    p[2] += h / 6 * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]);
    pts.push(p[0], p[1], p[2]);
    var bx = p[0] - body[0], by = p[1] - body[1], bz = p[2] - body[2];
    if (bx * bx + by * by + bz * bz < 1) break;          // inside the body (it occludes the stub)
    if (p[0] * p[0] + p[1] * p[1] + p[2] * p[2] > rOut * rOut) { open = true; break; }
  }
  return { pts: pts, open: open };
}

function _magReverse(pts) {
  var out = new Array(pts.length);
  for (var i = 0, n = pts.length / 3; i < n; i++) {
    out[i * 3] = pts[(n - 1 - i) * 3];
    out[i * 3 + 1] = pts[(n - 1 - i) * 3 + 1];
    out[i * 3 + 2] = pts[(n - 1 - i) * 3 + 2];
  }
  return out;
}

function _magSmooth(a, b, x) {
  var t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Append a polyline (ordered along +B) to a LineSegments accumulator.
// aT = normalised arc length (drives the flow animation), aFade = per-vertex
// alpha: fadeStart / fadeEnd soften an open end, fadeFn overrides both.
function _magAppend(acc, pts, fadeStart, fadeEnd, fadeFn) {
  var n = pts.length / 3;
  if (n < 2) return;
  var len = new Array(n), total = 0;
  len[0] = 0;
  for (var i = 1; i < n; i++) {
    total += Math.hypot(pts[i * 3] - pts[i * 3 - 3], pts[i * 3 + 1] - pts[i * 3 - 2], pts[i * 3 + 2] - pts[i * 3 - 1]);
    len[i] = total;
  }
  if (!(total > 0)) return;
  function push(j) {
    var t = len[j] / total, f = 1;
    if (fadeFn) f = fadeFn(pts[j * 3], pts[j * 3 + 1], pts[j * 3 + 2]);
    else {
      if (fadeStart) f *= _magSmooth(0, 0.4, t);
      if (fadeEnd) f *= 1 - _magSmooth(0.6, 1, t);
    }
    acc.pos.push(pts[j * 3], pts[j * 3 + 1], pts[j * 3 + 2]);
    acc.t.push(t);
    acc.fade.push(f);
  }
  for (var k = 0; k < n - 1; k++) { push(k); push(k + 1); }
}

function _magLinesGeometry(acc) {
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(acc.pos), 3));
  geo.setAttribute('aT', new THREE.BufferAttribute(new Float32Array(acc.t), 1));
  geo.setAttribute('aFade', new THREE.BufferAttribute(new Float32Array(acc.fade), 1));
  return geo;
}

// Field lines of a (possibly offset) dipole: one line per L-shell and
// longitude, seeded on the magnetic equator and traced to both footpoints.
function _magBuildDipole(def) {
  var acc = { pos: [], t: [], fade: [] };
  var tau = def.tilt * Math.PI / 180, off = def.offN || 0;
  // Body centre seen from the dipole centre, in the dipole frame (= body frame
  // rotated about X by the tilt; the offset lies along the body's Z).
  var body = [0, -off * Math.sin(tau), -off * Math.cos(tau)];
  var rOut = def.shells[def.shells.length - 1] * 1.5 + 2;
  for (var s = 0; s < def.shells.length; s++) {
    var L = def.shells[s];
    for (var k = 0; k < def.lon; k++) {
      var phi = 2 * Math.PI * (k + (s % 2) * 0.5) / def.lon;      // stagger alternate shells
      var seed = [L * Math.cos(phi), L * Math.sin(phi), 0];
      var south = _magTrace(0, seed, 1, body, rOut, 4000);         // +B: toward the −moment pole
      var north = _magTrace(0, seed, -1, body, rOut, 4000);
      _magAppend(acc, _magReverse(north.pts).concat(south.pts.slice(3)), false, false);
    }
  }
  return _magLinesGeometry(acc);
}

// Ganymede: dipole + uniform Jovian field. Closed lines are seeded on the
// magnetic equator inside the neutral ring; open ones on the surface,
// poleward of the last closed line, and traced outward until rOut.
function _magBuildEmbedded(def) {
  var acc = { pos: [], t: [], fade: [] };
  var body = [0, 0, 0], ext = def.ext;
  var k, phi;
  for (var s = 0; s < def.closed.length; s++) {
    for (k = 0; k < def.lon; k++) {
      phi = 2 * Math.PI * (k + (s % 2) * 0.5) / def.lon;
      var seed = [def.closed[s] * Math.cos(phi), def.closed[s] * Math.sin(phi), 0];
      var a = _magTrace(ext, seed, 1, body, def.rOut, 4000);
      var b = _magTrace(ext, seed, -1, body, def.rOut, 4000);
      _magAppend(acc, _magReverse(b.pts).concat(a.pts.slice(3)), b.open, a.open);
    }
  }
  var tmp = [0, 0, 0];
  for (var c = 0; c < def.openColat.length; c++) {
    for (var hemi = 0; hemi < 2; hemi++) {
      var th = def.openColat[c] * Math.PI / 180;
      if (hemi) th = Math.PI - th;
      for (k = 0; k < def.lon; k++) {
        phi = 2 * Math.PI * (k + (c % 2) * 0.5) / def.lon;
        var sd = [1.002 * Math.sin(th) * Math.cos(phi), 1.002 * Math.sin(th) * Math.sin(phi), 1.002 * Math.cos(th)];
        _magField(ext, sd, tmp);
        var outward = tmp[0] * sd[0] + tmp[1] * sd[1] + tmp[2] * sd[2] > 0 ? 1 : -1;
        var tr = _magTrace(ext, sd, outward, body, def.rOut, 4000);
        if (outward > 0) _magAppend(acc, tr.pts, false, tr.open);          // surface → far, along +B
        else _magAppend(acc, _magReverse(tr.pts), tr.open, false);         // far → surface, along +B
      }
    }
  }
  return _magLinesGeometry(acc);
}

function _magShue(r0, alpha, theta) {
  return r0 * Math.pow(2 / (1 + Math.cos(theta)), alpha);
}

// Magnetopause surface of revolution about +X (the Sun direction), cut where
// it reaches x = −tail·r0, plus cross-section rings and meridians for depth.
function _magBuildShell(def) {
  var r0 = def.r0, alpha = def.alpha, tailX = def.tail * r0;
  function xAt(th) { return _magShue(r0, alpha, th) * Math.cos(th); }
  function thetaForX(x) {                       // x(θ) falls monotonically from r0
    var lo = 0, hi = Math.PI - 1e-4;
    for (var i = 0; i < 60; i++) {
      var mid = (lo + hi) / 2;
      if (xAt(mid) > x) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }
  var thMax = thetaForX(-tailX);
  var NT = 80, NP = 56;
  var pos = new Float32Array((NT + 1) * NP * 3), idx = [];
  var i, j;
  for (i = 0; i <= NT; i++) {
    var th = thMax * i / NT, r = _magShue(r0, alpha, th);
    var x = r * Math.cos(th), rho = r * Math.sin(th);
    for (j = 0; j < NP; j++) {
      var ph = 2 * Math.PI * j / NP, o = (i * NP + j) * 3;
      pos[o] = x; pos[o + 1] = rho * Math.cos(ph); pos[o + 2] = rho * Math.sin(ph);
    }
  }
  for (i = 0; i < NT; i++) {
    for (j = 0; j < NP; j++) {
      var a = i * NP + j, b = i * NP + (j + 1) % NP, c = a + NP, d = b + NP;
      idx.push(a, c, b, b, c, d);
    }
  }
  var mesh = new THREE.BufferGeometry();
  mesh.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  mesh.setIndex(idx);
  mesh.computeVertexNormals();

  var acc = { pos: [], t: [], fade: [] };
  function fade(x) { return _magSmooth(-tailX, -0.3 * tailX, x); }
  var RINGS = 11, SEG = 96, pts, m;
  for (var q = 0; q < RINGS; q++) {
    var rx = r0 * 0.72 - (r0 * 0.72 + tailX * 0.96) * q / (RINGS - 1);
    var rth = thetaForX(rx), rr = _magShue(r0, alpha, rth) * Math.sin(rth);
    pts = [];
    for (m = 0; m <= SEG; m++) {
      var ang = 2 * Math.PI * m / SEG;
      pts.push(rx, rr * Math.cos(ang), rr * Math.sin(ang));
    }
    _magAppend(acc, pts, false, false, fade);
  }
  for (var mer = 0; mer < 12; mer++) {
    var mph = 2 * Math.PI * mer / 12;
    pts = [];
    for (m = 0; m <= 96; m++) {
      var mt = thMax * m / 96, mr = _magShue(r0, alpha, mt);
      pts.push(mr * Math.cos(mt), mr * Math.sin(mt) * Math.cos(mph), mr * Math.sin(mt) * Math.sin(mph));
    }
    _magAppend(acc, pts, false, false, fade);
  }
  return { mesh: mesh, lines: _magLinesGeometry(acc), tailX: tailX };
}

// Both shaders carry the logdepthbuf chunks: the renderer runs a logarithmic
// depth buffer, and without them these would not be occluded by the planet.
var MAG_LINE_VERT = [
  'attribute float aT;',
  'attribute float aFade;',
  'varying float vT;',
  'varying float vFade;',
  '#include <common>',
  '#include <logdepthbuf_pars_vertex>',
  'void main() {',
  '  vT = aT;',
  '  vFade = aFade;',
  '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
  '  #include <logdepthbuf_vertex>',
  '}',
].join('\n');

// uFlow = 1: bright pulses travel along +B (three per line), so the sense of
// the field is visible. uFlow = 0: steady line (polarity not sourced, or not
// a field line at all).
var MAG_LINE_FRAG = [
  'uniform vec3 uColor;',
  'uniform float uOpacity;',
  'uniform float uTime;',
  'uniform float uFlow;',
  'varying float vT;',
  'varying float vFade;',
  '#include <common>',
  '#include <logdepthbuf_pars_fragment>',
  'void main() {',
  '  #include <logdepthbuf_fragment>',
  '  float p = fract(vT * 3.0 - uTime * 0.30);',
  '  float pulse = 0.34 + 0.66 * pow(1.0 - p, 2.5);',
  '  float b = mix(0.70, pulse, uFlow);',
  '  gl_FragColor = vec4(uColor * b, vFade * uOpacity);',
  '  #include <encodings_fragment>',
  '}',
].join('\n');

var MAG_SHELL_VERT = [
  'varying vec3 vN;',
  'varying vec3 vV;',
  'varying float vX;',
  '#include <common>',
  '#include <logdepthbuf_pars_vertex>',
  'void main() {',
  '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
  '  vN = normalize(normalMatrix * normal);',
  '  vV = normalize(-mv.xyz);',
  '  vX = position.x;',
  '  gl_Position = projectionMatrix * mv;',
  '  #include <logdepthbuf_vertex>',
  '}',
].join('\n');

// Fresnel-style: nearly invisible face-on, glowing at the limb, so the shell
// reads as a surface without hiding the planet. Fades out down the tail (the
// real one keeps going).
var MAG_SHELL_FRAG = [
  'uniform vec3 uColor;',
  'uniform float uOpacity;',
  'uniform float uTail;',
  'varying vec3 vN;',
  'varying vec3 vV;',
  'varying float vX;',
  '#include <common>',
  '#include <logdepthbuf_pars_fragment>',
  'void main() {',
  '  #include <logdepthbuf_fragment>',
  '  float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);',
  '  float fade = smoothstep(-uTail, -0.3 * uTail, vX);',
  '  gl_FragColor = vec4(uColor, (0.03 + 0.40 * fres) * fade * uOpacity);',
  '  #include <encodings_fragment>',
  '}',
].join('\n');

class MagnetosphereView {
  constructor(scene, def) {
    this.def = def;
    this.opacity = 0;
    this.phase = 0;
    this._mats = [];
    this._geos = [];
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._q = new THREE.Quaternion();

    this.root = new THREE.Group();          // at the body, scaled to its real radius
    this.root.visible = false;
    scene.add(this.root);
    this.spin = new THREE.Group();          // body frame: axial tilt × rotation
    this.root.add(this.spin);
    this.dip = new THREE.Group();           // dipole frame: moment along +Z
    this.dip.rotation.x = def.tilt * Math.PI / 180;
    this.dip.position.set(0, 0, def.offN || 0);
    this.spin.add(this.dip);

    var flow = !!def.polarityKnown;
    this._addLines(this.dip, def.ext ? _magBuildEmbedded(def) : _magBuildDipole(def), 0x58d0ff, flow, 0.95);

    // Axes: magnetic (amber, through the dipole centre) vs rotation (white)
    var top = def.noShell ? 2.6 : Math.max(2.2, def.shells[0] * 1.5);
    this._addLines(this.dip, this._axisGeo(top), 0xffc857, false, 0.9);
    this._addLines(this.spin, this._axisGeo(top * 0.86), 0xe6ecff, false, 0.45);

    this.shell = null;
    if (!def.noShell) {
      var sh = _magBuildShell(def);
      this.shell = new THREE.Group();       // +X aimed at the Sun every frame
      this.root.add(this.shell);
      var mat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(0x7d8dff).convertSRGBToLinear() },
          uOpacity: { value: 0 }, uTail: { value: sh.tailX },
        },
        vertexShader: MAG_SHELL_VERT, fragmentShader: MAG_SHELL_FRAG,
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      mat.userData.gain = 1;
      var mesh = new THREE.Mesh(sh.mesh, mat);
      mesh.frustumCulled = false;
      this.shell.add(mesh);
      this._mats.push(mat);
      this._geos.push(sh.mesh);
      this._addLines(this.shell, sh.lines, 0x8c9bff, false, 0.34);
    }
  }

  _axisGeo(half) {
    var acc = { pos: [], t: [], fade: [] };
    _magAppend(acc, [0, 0, -half, 0, 0, 0, 0, 0, half], true, true);
    return _magLinesGeometry(acc);
  }

  _addLines(parent, geo, colorHex, flow, gain) {
    var mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(colorHex).convertSRGBToLinear() },
        uOpacity: { value: 0 }, uTime: { value: 0 }, uFlow: { value: flow ? 1 : 0 },
      },
      vertexShader: MAG_LINE_VERT, fragmentShader: MAG_LINE_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    mat.userData.gain = gain;
    var lines = new THREE.LineSegments(geo, mat);
    lines.frustumCulled = false;
    parent.add(lines);
    this._mats.push(mat);
    this._geos.push(geo);
    return lines;
  }

  /** @param pos       THREE.Vector3 body centre (AU)
   *  @param radiusAU  real body radius
   *  @param bodyQuat  body-frame orientation WITHOUT the rotation phase (axial tilt)
   *  @param phase     rotation angle about the body's +Z (rad)
   *  @param time      seconds, drives the flow pulses */
  update(pos, radiusAU, bodyQuat, phase, time) {
    this.root.visible = this.opacity > 0.002;
    if (!this.root.visible) return;
    this.root.position.copy(pos);
    this.root.scale.setScalar(radiusAU);
    this._q.setFromAxisAngle(this._v.set(0, 0, 1), phase);
    this.spin.quaternion.copy(bodyQuat).multiply(this._q);
    if (this.shell) {
      // The Sun sits at the origin: +X of the shell looks back down the radius
      var L = pos.length() || 1;
      this._q.setFromUnitVectors(this._v.set(1, 0, 0), this._v2.set(-pos.x / L, -pos.y / L, -pos.z / L));
      this.shell.quaternion.copy(this._q);
      // The standoff distance is measured from the dipole, not the body centre
      this.shell.position.set(0, 0, this.def.offN || 0).applyQuaternion(this.spin.quaternion);
    }
    for (var i = 0; i < this._mats.length; i++) {
      var u = this._mats[i].uniforms;
      u.uOpacity.value = this.opacity * this._mats[i].userData.gain;
      if (u.uTime) u.uTime.value = time;
    }
  }

  dispose() {
    if (this.root.parent) this.root.parent.remove(this.root);
    this._geos.forEach(function (g) { g.dispose(); });
    this._mats.forEach(function (m) { m.dispose(); });
  }
}

/* ── Renderer ────────────────────────────────────────────────────────────── */

class ThreeJSRenderer {
  /**
   * @param {HTMLElement} container  the .canvas-area element
   * @param {object} opts
   * @param {Array}  opts.planets  [{key,name,color,r,glow,ring, orbitPts:Float32Array}]
   * @param {Array}  opts.neos     [{id,name,risk, orbitPts:Float32Array}]
   * @param {string} [opts.textureBase='/assets/textures/']
   */
  constructor(container, opts) {
    if (typeof THREE === 'undefined') {
      throw new Error('ThreeJSRenderer: THREE global not found — load three.min.js first');
    }
    this.container = container;
    this.opts = opts || {};
    this._textureBase = this.opts.textureBase || '/assets/textures/';

    var rect = container.getBoundingClientRect();
    this.W = rect.width; this.H = rect.height;
    // Cap at 2: 3×+ DPR phones pay 2.25×+ the fragment cost for no visible gain
    this.DPR = Math.min(2, Math.max(1, window.devicePixelRatio || 1));

    // Adopt the existing #radar-canvas so every mouse/touch listener the page
    // attaches keeps working on the exact same DOM node.
    var canvas = container.querySelector('canvas#radar-canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'radar-canvas';
      container.insertBefore(canvas, container.firstChild);
    }

    this.renderer = new THREE.WebGLRenderer({
      canvas: canvas,
      antialias: true,
      logarithmicDepthBuffer: true,
      alpha: true,
    });
    this.renderer.setPixelRatio(this.DPR);
    this.renderer.setSize(this.W, this.H);
    // Near-black with a hint of blue — deeper than pure black next to stars
    this.renderer.setClearColor(0x000005, 1);
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.autoClear = false;
    this.domElement = canvas;

    // 2D overlay for text labels / dashed lines / pulse rings
    this.overlay = document.createElement('canvas');
    this.overlay.style.cssText =
      'position:absolute;inset:0;pointer-events:none;z-index:2;';
    canvas.parentNode.insertBefore(this.overlay, canvas.nextSibling);
    this.octx = this.overlay.getContext('2d');

    this.scene = new THREE.Scene();
    // Free-orbit perspective camera — near 1e-6 AU (≈150 km, close enough
    // for the small moons) to 500 AU; the logarithmicDepthBuffer makes that
    // range artifact-free (and only works with a perspective projection).
    this.camera = new THREE.PerspectiveCamera(FOV_DEG, this.W / Math.max(1, this.H), 1e-6, 500);
    this.camera.up.set(0, 0, 1);
    this._camPos = new THREE.Vector3();
    this._cometPos = new THREE.Vector3();   // scratch for CometTail.update
    this._sunOrigin = new THREE.Vector3(0, 0, 0);
    this._vpMat = new THREE.Matrix4();
    // Shared view-projection matrix (column-major) — the page's ws() reads it.
    // Float64 on purpose: projecting a point a few thousand km from a camera
    // that sits 30 AU from the origin cancels two ~30 AU terms, and float32
    // matrix elements leave errors as large as the distance itself (labels and
    // hit tests jitter). Nothing uploads this array to the GPU.
    this._vpArray = new Float64Array(16);
    this._wpp1 = 1;   // world units per pixel at distance 1 (set per frame)

    // Cinematic lighting: the Sun is the only real source. distance=0 keeps
    // it unattenuated across the whole system (r128 non-physical mode);
    // decay=2 is the physical falloff exponent if physicallyCorrectLights
    // ever gets switched on.
    this._sunLight = new THREE.PointLight(0xffe0a0, 2.5, 0, 2);
    this._sunLight.position.set(0, 0, 0);
    this.scene.add(this._sunLight);
    // Minimal ambient — night sides go genuinely dark
    this.scene.add(new THREE.AmbientLight(0x111122, 0.08));
    // Weak cool fill riding with the camera — stands in for bounced sunlight
    // so the near side never reads pitch black (cheaper than shadow maps)
    this._fillLight = new THREE.DirectionalLight(0x334455, 0.15);
    this.scene.add(this._fillLight);
    this.scene.add(this._fillLight.target);

    this._glowTexture = this._makeGlowTexture();
    this._texLoader = new THREE.TextureLoader();
    this._buildRockMaterials();

    this._buildStars();
    this._buildSun();
    this._buildPlanets();
    this._buildMoons();
    this._buildDwarfPlanets();
    this._buildComets();
    this._buildNEOs();
    this._buildCone();

    // MPC point cloud — created lazily via setMPC() once the catalog loads
    this._mpcPoints = null;

    // Promoted asteroid (Layer 3)
    this._promoMesh = null;
    this._promoAxis = new THREE.Vector3(0.4, 1, 0.3).normalize();
    this._promoSpeed = 0.6;
    this._promoDisposables = null;
    this._promoModelKey = null;
    this._promoOrbit = null;
    this._trajLine = null;
    this._mcPoints = null;

    // GLB shape-model loader + caches (optional — needs the GLTFLoader script)
    this._gltfLoader  = typeof THREE.GLTFLoader !== 'undefined' ? new THREE.GLTFLoader() : null;
    this._gltfCache   = {};
    this._gltfPending = {};
    this._rockMats    = {};

    this.onModelApplied = null;   // page hook: (context, modelKey, noticeText)

    // Manifest of imported GLB shape models + textures (Parte 1). Missing
    // file / offline: every body keeps its sphere or procedural fallback.
    this._manifest = null;
    var selfM = this;
    if (typeof fetch !== 'undefined') {
      fetch('/assets/models/manifest.json')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (m) {
          if (!m) return;
          selfM._manifest = m;
          selfM._onManifestLoaded();
        })
        .catch(function () { /* keep fallbacks */ });
    }

    this._lastNow = performance.now();
    this._loadTextures();
    this.resize();
  }

  /* ── Setup helpers ─────────────────────────────────────────────────────── */

  _col(hex) {
    return new THREE.Color(hex).convertSRGBToLinear();
  }

  _makeGlowTexture() {
    var c = document.createElement('canvas');
    c.width = c.height = 128;
    var g = c.getContext('2d');
    var grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.35)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    var tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding;
    return tex;
  }

  // 4 shared PBR rock materials fed by real AmbientCG scans (CC0), fetched by
  // scripts/downloadAsteroidModels.js. Each material starts as flat regolith
  // gray-brown and every map pops in as its PNG arrives; a 404 (script never
  // run / offline) just leaves the fallback color — no crash, no black rock.
  _buildRockMaterials() {
    var self = this;
    this._rockMaterials = ['rock_a', 'rock_b', 'rock_c', 'rock_d'].map(function (id) {
      var mat = new THREE.MeshStandardMaterial({
        color: self._col('#8a7a6a'),
        roughness: 0.92,
        metalness: 0.04,
        normalScale: new THREE.Vector2(2.0, 2.0),
      });
      function load(kind, assign) {
        self._texLoader.load(self._textureBase + 'rock/' + id + '_' + kind + '.jpg',
          function (tex) {
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            tex.anisotropy = Math.min(4, self.renderer.capabilities.getMaxAnisotropy());
            assign(tex);
            mat.needsUpdate = true;
          }, undefined, function () { /* keep the flat fallback color */ });
      }
      load('albedo', function (tex) {
        tex.encoding = THREE.sRGBEncoding;
        mat.map = tex;
        mat.color.set(0xffffff);
      });
      load('normal', function (tex) { mat.normalMap = tex; });
      load('roughness', function (tex) { mat.roughnessMap = tex; });
      return mat;
    });
  }

  _buildStars() {
    // Background starfield — own scene + camera; render() copies only the main
    // camera's rotation onto it, so the stars sit at infinity and never translate
    this.starScene = new THREE.Scene();
    this.starCamera = new THREE.PerspectiveCamera(60, this.W / Math.max(1, this.H), 1, 2000);
    this.starCamera.up.set(0, -1, 0);
    this.starCamera.lookAt(0, 0, 1);

    // Half the stars on small screens — invisible difference, real GPU savings
    var N = window.innerWidth < 768 ? 1500 : 3000, R = 500;
    var rand = _mulberry32(42);                       // same sky every session
    var pos = new Float32Array(N * 3);
    var col = new Float32Array(N * 3);
    for (var i = 0; i < N; i++) {
      var u = rand() * 2 - 1;                          // cos(theta) uniform on sphere
      var phi = rand() * Math.PI * 2;
      var s = Math.sqrt(1 - u * u);
      pos[i * 3]     = R * s * Math.cos(phi);
      pos[i * 3 + 1] = R * s * Math.sin(phi);
      pos[i * 3 + 2] = R * u;
      var b = 0.3 + rand() * 0.7;                      // brightness 0.3–1.0
      var blue = 1 + rand() * 0.12;                    // slight blue-white tint
      col[i * 3] = b; col[i * 3 + 1] = b; col[i * 3 + 2] = Math.min(1, b * blue);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this._starMaterial = new THREE.PointsMaterial({
      size: 1.2 * this.DPR,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    var stars = new THREE.Points(geo, this._starMaterial);
    stars.frustumCulled = false;
    this.starScene.add(stars);
  }

  _buildSun() {
    this._sunMaterial = new THREE.MeshBasicMaterial({ color: this._col('#ffd87a') });
    this.sun = new THREE.Mesh(new THREE.SphereGeometry(0.04, 32, 32), this._sunMaterial);
    this.sun.position.set(0, 0, 0);
    this.scene.add(this.sun);

    var mat = new THREE.SpriteMaterial({
      map: this._glowTexture,
      color: this._col('#ffcf8a'),
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.sunGlow = new THREE.Sprite(mat);
    this.sunGlow.position.set(0, 0, 0);
    this.scene.add(this.sunGlow);

    // Second, wider and fainter blue-white aura — fake two-layer bloom, so
    // the Sun reads as a star without an EffectComposer pass
    var mat2 = new THREE.SpriteMaterial({
      map: this._makeAuraTexture(),
      color: this._col('#aaccff'),
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0.15,
      depthWrite: false,
    });
    this.sunGlow2 = new THREE.Sprite(mat2);
    this.sunGlow2.position.set(0, 0, 0);
    this.scene.add(this.sunGlow2);
  }

  // Broader, softer radial gradient than _makeGlowTexture — the outer aura
  // needs a long gentle tail, not the tight core of the primary halo
  _makeAuraTexture() {
    var c = document.createElement('canvas');
    c.width = c.height = 256;
    var g = c.getContext('2d');
    var grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.3, 'rgba(255,255,255,0.28)');
    grad.addColorStop(0.65, 'rgba(255,255,255,0.07)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    var tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding;
    return tex;
  }

  _orbitLine(orbitPts, colorHex, opacity) {
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(orbitPts, 3));
    var mat = new THREE.LineBasicMaterial({
      color: this._col(colorHex),
      transparent: true,
      opacity: opacity,
    });
    var line = new THREE.LineLoop(geo, mat);
    line.frustumCulled = false;
    return line;
  }

  _buildPlanets() {
    var self = this;
    // Geometry poles are ±Y by default — bake them onto ±Z so the geographic
    // pole points at ecliptic north (+Z) and the sidereal spin is rotation.z.
    this._sphereGeoHi = new THREE.SphereGeometry(1, 32, 16);
    this._sphereGeoHi.rotateX(Math.PI / 2);
    this.planets = (this.opts.planets || []).map(function (def, i) {
      var group = new THREE.Group();
      group.visible = false;
      // Axial tilt: the pole is baked along +Z, so tipping it needs a
      // rotation about an IN-PLANE axis (y); rotating about z would just
      // spin the pole in place.
      group.rotation.y = (AXIAL_TILT[def.key] || 0) * Math.PI / 180;
      self.scene.add(group);

      var isEarth = def.key === 'earth';
      var mat = new THREE.MeshStandardMaterial({
        color: self._col(def.color),
        roughness: 0.85,
        metalness: 0.0,
        emissive: isEarth ? self._col('#2255cc') : new THREE.Color(0x000000),
        emissiveIntensity: isEarth ? 0.35 : 0,
      });
      var sphere = new THREE.Mesh(self._sphereGeoHi, mat);
      group.add(sphere);

      if (isEarth) {
        // Weak blue point light riding with Earth — lifts nearby asteroids.
        // Light range/intensity ignore the parent's scale; only position
        // inherits. Range 0.05 AU: with the near-zero ambient a system-wide
        // reach would tint half the map blue.
        group.add(new THREE.PointLight(0x4488ff, 0.5, 0.05));
        // Atmosphere: back-face shell slightly larger than the globe reads as
        // a bright rim from every angle.
        var halo = new THREE.Mesh(
          new THREE.SphereGeometry(1.08, 32, 16),
          new THREE.MeshBasicMaterial({
            color: 0x224488,
            transparent: true,
            opacity: 0.30,
            side: THREE.BackSide,
            depthWrite: false,
          })
        );
        group.add(halo);
      }

      // Glow sprite (Earth/Jupiter always, any planet during a conjunction).
      // Child of the scaled group, so its scale is a ratio of the body radius.
      var glowMat = new THREE.SpriteMaterial({
        map: self._glowTexture,
        color: self._col(def.color),
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
      });
      var glow = new THREE.Sprite(glowMat);
      glow.scale.setScalar(6);
      glow.visible = !!def.glow;
      group.add(glow);

      var ring = null;
      if (def.ring) {
        // RingGeometry lies in the local XY plane — with the pole baked onto
        // +Z that IS the planet's equatorial plane; the group's axial tilt
        // (rotation.y above) tips ring and globe together.
        var ringGeo = new THREE.RingGeometry(1.4, 2.4, 64);
        self._remapRingUVs(ringGeo, 1.4, 2.4);
        var ringMat = new THREE.MeshBasicMaterial({
          color: self._col('#d4c79c'),
          transparent: true,
          opacity: 0.5,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        ring = new THREE.Mesh(ringGeo, ringMat);
        group.add(ring);
      }

      var orbit = self._orbitLine(def.orbitPts, def.color, 0.25);
      orbit.visible = false;
      self.scene.add(orbit);

      return {
        def: def,
        group: group,
        sphere: sphere,
        clouds: null,                                 // Earth only, added on texture load
        ring: ring,
        glow: glow,
        orbit: orbit,
      };
    });
    this._earthIdx = this.planets.findIndex(function (p) { return p.def.key === 'earth'; });
  }

  _buildMoons() {
    var self = this;
    // Parent lookup: planet key → index into this.planets / frame.planets
    this._planetIdxByKey = {};
    this.planets.forEach(function (p, i) { self._planetIdxByKey[p.def.key] = i; });

    this._moonGeoShared = new THREE.SphereGeometry(1, 24, 16);
    this._moons = {};
    MOONS.forEach(function (data) {
      var mat = new THREE.MeshStandardMaterial({
        color: self._col(MOON_FALLBACK[data.id] != null ? MOON_FALLBACK[data.id] : 0x999999),
        roughness: 0.95,
        metalness: 0.0,
      });
      var mesh = new THREE.Mesh(self._moonGeoShared, mat);
      // Texture pole → +Z. Euler XYZ applies the tidal spin (rotation.y)
      // about the geometry pole BEFORE this pre-tilt.
      mesh.rotation.x = Math.PI / 2;
      var group = new THREE.Group();
      group.add(mesh);
      group.visible = false;
      self.scene.add(group);

      // Orbit ring baked at radius a in the moon's orbital plane (tilt i) —
      // recentred on the parent every frame
      var N = 64, pts = new Float32Array(N * 3);
      var iRad = data.i * Math.PI / 180, ci = Math.cos(iRad), si = Math.sin(iRad);
      for (var k = 0; k < N; k++) {
        var a2 = (k / N) * Math.PI * 2, s2 = Math.sin(a2);
        pts[k * 3]     = data.a * Math.cos(a2);
        pts[k * 3 + 1] = data.a * s2 * ci;
        pts[k * 3 + 2] = data.a * s2 * si;
      }
      var ogeo = new THREE.BufferGeometry();
      ogeo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      var orbit = new THREE.LineLoop(ogeo, new THREE.LineBasicMaterial({
        color: 0x888888,
        transparent: true,
        opacity: 0.15,
      }));
      orbit.frustumCulled = false;
      orbit.visible = false;
      self.scene.add(orbit);

      self._moons[data.id] = {
        data: data, group: group, mesh: mesh, orbit: orbit,
        screen: null, labelOn: false,
      };
    });
  }

  // Dwarf planets (Parte 4): sphere fallback now, GLB from the manifest when
  // it arrives. Positions come from the page (frame.dwarfPlanets — radar.ejs
  // solves the Kepler elements); orbit polylines come in via opts.
  _buildDwarfPlanets() {
    var self = this;
    this._dwarfs = (this.opts.dwarfPlanets || []).map(function (dd) {
      var def = dd.def;
      var group = new THREE.Group();
      group.visible = false;
      self.scene.add(group);
      var mesh = new THREE.Mesh(self._moonGeoShared, new THREE.MeshStandardMaterial({
        color: self._col(def.color),
        roughness: 0.95,
        metalness: 0.0,
      }));
      mesh.rotation.x = Math.PI / 2;               // texture pole → +Z
      group.add(mesh);
      // Órbita: cinza-esverdeado, sutilmente distinta das dos planetas
      var orbit = self._orbitLine(dd.orbitPts, '#8a9a84', 0.28);
      orbit.visible = false;
      self.scene.add(orbit);
      return { def: def, group: group, mesh: mesh, model: null, orbit: orbit, screen: null };
    });
  }

  // Comets (Parte 5): GLB/sphere nucleus + dashed orbit + coma sprite +
  // PointLight + a particle CometTail (dust + ion). Coma and tails are
  // scene-level (world units — a child of the min-px group would inherit its
  // scale).
  _buildComets() {
    var self = this;
    this._comets = (this.opts.comets || []).map(function (cd) {
      var def = cd.def;
      var group = new THREE.Group();
      group.visible = false;
      self.scene.add(group);
      var mesh = new THREE.Mesh(self._moonGeoShared, new THREE.MeshStandardMaterial({
        color: self._col(def.color),
        roughness: 0.98,
        metalness: 0.0,
      }));
      mesh.rotation.x = Math.PI / 2;
      group.add(mesh);

      // Coma: additive radial-gradient sprite, scene-level so its size stays
      // in world units. Bright blue-white head to match the reference photo;
      // scale/opacity/pulse are driven per frame in _drawComets.
      var comaCol = self._col(0xdfeaff);
      var coma = new THREE.Sprite(new THREE.SpriteMaterial({
        map: self._glowTexture,
        color: comaCol,
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity: 0.0,
        depthWrite: false,
      }));
      coma.visible = false;
      self.scene.add(coma);
      // Weak blue-white point light near perihelion. Intensity toggles, never
      // the light COUNT — a changing count recompiles every material's shader.
      var light = new THREE.PointLight(0xaaccee, 0.0, 0.6);
      group.add(light);

      // Dashed dark-cyan orbit (world-unit dashes; needs line distances)
      var ogeo = new THREE.BufferGeometry();
      ogeo.setAttribute('position', new THREE.BufferAttribute(cd.orbitPts, 3));
      var orbit = new THREE.LineLoop(ogeo, new THREE.LineDashedMaterial({
        color: self._col('#2a7f8a'),
        transparent: true, opacity: 0.32, dashSize: 0.18, gapSize: 0.12,
      }));
      orbit.computeLineDistances();
      orbit.frustumCulled = false;
      orbit.visible = false;
      self.scene.add(orbit);

      // Particle tails (dust + ion) — pooled Points added to the main scene
      var tail = new CometTail(self.scene, self._glowTexture, def.tail_color, cd.orbitPts);

      return {
        def: def, group: group, mesh: mesh, model: null,
        coma: coma, light: light, orbit: orbit, tail: tail, screen: null,
      };
    });
  }

  // The Solar System Scope ring texture is a radial strip: u = radius.
  // RingGeometry's default UVs are planar, so remap them.
  _remapRingUVs(geo, inner, outer) {
    var pos = geo.attributes.position, uv = geo.attributes.uv;
    var v = new THREE.Vector3();
    for (var i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      var r = v.length();
      uv.setXY(i, (r - inner) / (outer - inner), 0.5);
    }
    uv.needsUpdate = true;
  }

  _buildNEOs() {
    var self = this;
    this.neos = (this.opts.neos || []).map(function (def) {
      var style = ORBIT_STYLE[def.risk] || ORBIT_STYLE.safe;

      // Procedural rock — deterministic per designation — with a backface-
      // hull outline in the risk color so the marker keeps its risk reading.
      // Texture set follows the same seed%4 pick as the shape archetype.
      var seed = _hashString(String(def.id || def.name || 'neo'));
      var geo = generateAsteroidGeometry(seed);
      var group = new THREE.Group();
      var rock = new THREE.Mesh(geo, self._rockMaterials[(seed >>> 0) % self._rockMaterials.length]);
      group.add(rock);
      var outline = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: self._col(RISK_COLOR[def.risk] || '#f0f4ff'),
        side: THREE.BackSide,
      }));
      outline.scale.setScalar(1.08);
      group.add(outline);
      self.scene.add(group);

      var orbit = self._orbitLine(def.orbitPts, style.color, style.base);
      self.scene.add(orbit);

      return { def: def, group: group, rock: rock, outline: outline, orbit: orbit, style: style };
    });

    // Shared selection highlight: pulsing wireframe + weak point light
    this._selWire = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 1),
      new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.5 })
    );
    this._selWire.visible = false;
    this.scene.add(this._selWire);

    this._selLight = new THREE.PointLight(0xffffff, 0.5, 1.2);
    this._selLight.visible = false;
    this.scene.add(this._selLight);
  }

  _buildCone() {
    // Uncertainty ribbon: fixed vertex count, positions rewritten per frame
    var N = 101;
    this._coneN = N;
    var geo = new THREE.BufferGeometry();
    var pos = new THREE.BufferAttribute(new Float32Array(N * 2 * 3), 3);
    pos.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', pos);
    var idx = [];
    for (var k = 0; k < N - 1; k++) {
      var a = k, b = N + k, a1 = k + 1, b1 = N + k + 1;
      idx.push(a, b, a1, b, b1, a1);
    }
    geo.setIndex(idx);
    this._coneMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.09,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.cone = new THREE.Mesh(geo, this._coneMat);
    this.cone.frustumCulled = false;
    this.cone.visible = false;
    this.scene.add(this.cone);
  }

  _loadTextures() {
    var self = this;
    var base = this._textureBase;

    function load(file, onOk) {
      self._texLoader.load(base + file, function (tex) {
        tex.encoding = THREE.sRGBEncoding;
        tex.anisotropy = Math.min(4, self.renderer.capabilities.getMaxAnisotropy());
        onOk(tex);
      }, undefined, function () {
        // Fallback: keep the flat catalog color. Never block rendering.
      });
    }

    load('sun.jpg', function (tex) {
      self._sunMaterial.map = tex;
      self._sunMaterial.color.set(0xffffff);
      self._sunMaterial.needsUpdate = true;
    });

    Object.keys(this._moons).forEach(function (id) {
      var m = self._moons[id];
      load(id + '.jpg', function (tex) {
        m.mesh.material.map = tex;
        m.mesh.material.color.set(0xffffff);
        m.mesh.material.needsUpdate = true;
      });
    });

    this.planets.forEach(function (p) {
      load(p.def.key + '.jpg', function (tex) {
        p.sphere.material.map = tex;
        p.sphere.material.color.set(0xffffff);
        p.sphere.material.needsUpdate = true;
      });
      if (p.def.key === 'earth') {
        load('earth_clouds.jpg', function (tex) {
          var mat = new THREE.MeshBasicMaterial({
            map: tex,
            transparent: true,
            opacity: 0.35,
            depthWrite: false,
          });
          var cloudGeo = new THREE.SphereGeometry(1.035, 32, 16);
          cloudGeo.rotateX(Math.PI / 2);              // same pole-to-+Z bake as the globe
          p.clouds = new THREE.Mesh(cloudGeo, mat);
          p.group.add(p.clouds);
        });
      }
      if (p.def.key === 'saturn' && p.ring) {
        load('saturn_ring.png', function (tex) {
          p.ring.material.map = tex;
          p.ring.material.alphaMap = tex;
          p.ring.material.color.set(0xffffff);
          p.ring.material.opacity = 0.9;
          p.ring.material.needsUpdate = true;
        });
      }
    });
  }

  /* ── Public API ────────────────────────────────────────────────────────── */

  resize() {
    var rect = this.container.getBoundingClientRect();
    this.W = Math.max(1, rect.width);
    this.H = Math.max(1, rect.height);
    this.DPR = Math.min(2, Math.max(1, window.devicePixelRatio || 1));

    this.renderer.setPixelRatio(this.DPR);
    this.renderer.setSize(this.W, this.H);

    this.overlay.width = this.W * this.DPR;
    this.overlay.height = this.H * this.DPR;
    this.overlay.style.width = this.W + 'px';
    this.overlay.style.height = this.H + 'px';

    this.starCamera.aspect = this.W / this.H;
    this.starCamera.updateProjectionMatrix();

    this.camera.aspect = this.W / this.H;
    this.camera.updateProjectionMatrix();

    if (this._ship) {
      this._ship.cam.aspect = this.W / this.H;
      this._ship.cam.updateProjectionMatrix();
    }

    this._starMaterial.size = 1.2 * this.DPR;
    if (this._mpcPoints) this._mpcPoints.material.size = 1.0 * this.DPR;
  }

  /**
   * Register the MPC point cloud. The page OWNS `positions` and mutates it in
   * place every frame; we only re-upload. Called once after the catalog loads.
   */
  setMPC(positions, colors, count) {
    if (this._mpcPoints) {
      this.scene.remove(this._mpcPoints);
      this._mpcPoints.geometry.dispose();
      this._mpcPoints.material.dispose();
    }
    var geo = new THREE.BufferGeometry();
    var posAttr = new THREE.BufferAttribute(positions, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', posAttr);
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setDrawRange(0, count);
    var mat = new THREE.PointsMaterial({
      size: 1.0 * this.DPR,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });
    this._mpcPoints = new THREE.Points(geo, mat);
    this._mpcPoints.frustumCulled = false;
    this._mpcPoints.visible = false;
    this.scene.add(this._mpcPoints);
  }

  /** Create the 3D mesh for a promoted/focused asteroid — a real NASA shape
   *  model when the designation maps to a downloaded GLB, PBR procedural
   *  otherwise. orbitPts (optional Float32Array, stride 3) draws the object's
   *  full heliocentric orbit alongside the mesh. */
  promote(designation, name, orbitPts) {
    this.demote();
    var seed  = _hashString(String(designation || 'asteroid'));
    var geo   = generateArchetypeGeometry(seed, 3);
    var mesh  = new THREE.Mesh(geo, this._getRockMaterial(seed));
    var group = new THREE.Group();
    group.add(mesh);
    group.visible = false;
    this.scene.add(group);
    this._promoMesh = group;
    this._promoDisposables = [geo];
    this._promoModelKey = null;

    if (orbitPts && orbitPts.length >= 9) {
      this._promoOrbit = this._orbitLine(orbitPts, '#6fb4ff', 0.5);
      this._promoOrbit.visible = false;
      this.scene.add(this._promoOrbit);
    }

    var rand = _mulberry32(seed ^ 0x9e3779b9);
    this._promoAxis = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5);
    if (this._promoAxis.lengthSq() < 1e-6) this._promoAxis.set(0.4, 1, 0.3);
    this._promoAxis.normalize();
    this._promoSpeed = 0.3 + rand() * 0.9;           // rad/s

    var key = _modelKeyFor(designation, name);
    if (!key) {
      // Manifest fuzzy-name fallback (Parte 2): any of the 1552 imported
      // DAMIT/radar models can serve a focused NEO or MPC asteroid
      var fz = this._fuzzyModel(name || designation);
      if (fz) key = fz.slug;
    }
    if (key) {
      var self = this;
      this._loadModel(key, function (inst) {
        if (!inst || self._promoMesh !== group) return;   // failed or stale
        // Manifest GLBs ship obj2gltf's default material and no UVs — dress
        // them in the shared PBR rock set. Curated NASA GLBs keep their own
        // material when it carries a texture; an untextured one (Apophis) is
        // glTF's default metal (metalness 1), which has no diffuse term and
        // renders near-black without an environment map: rock set for it too.
        var textured = false;
        inst.traverse(function (child) {
          if (child.isMesh && child.material && child.material.map) textured = true;
        });
        if (!MODEL_NOTICE[key] || !textured) {
          self._ensureSphericalUVs(inst);
          var rockMat = self._getRockMaterial(seed);
          inst.traverse(function (child) {
            if (child.isMesh) child.material = rockMat;
          });
        }
        group.remove(mesh);
        group.add(inst);
        self._promoModelKey = key;
        if (self.onModelApplied) {
          self.onModelApplied('promoted', key, MODEL_NOTICE[key] || MODEL_NOTICE_DEFAULT);
        }
      });
    }
  }

  /** RK4 trajectory + Monte Carlo cloud for the promoted asteroid. */
  setPromotedTrajectory(trajectory, mcPositions) {
    this._disposeTrajectory();
    if (trajectory && trajectory.length > 1) {
      var pts = new Float32Array(trajectory.length * 3);
      for (var i = 0; i < trajectory.length; i++) {
        pts[i * 3] = trajectory[i][0];
        pts[i * 3 + 1] = trajectory[i][1];
        pts[i * 3 + 2] = 0;
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      this._trajLine = new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: this._col('#1a6cf6'),
        transparent: true,
        opacity: 0.75,
      }));
      this._trajLine.frustumCulled = false;
      this.scene.add(this._trajLine);
    }
    if (mcPositions && mcPositions.length > 4) {
      var mpts = new Float32Array(mcPositions.length * 3);
      for (var j = 0; j < mcPositions.length; j++) {
        mpts[j * 3] = mcPositions[j][0];
        mpts[j * 3 + 1] = mcPositions[j][1];
        mpts[j * 3 + 2] = 0;
      }
      var mgeo = new THREE.BufferGeometry();
      mgeo.setAttribute('position', new THREE.BufferAttribute(mpts, 3));
      this._mcPoints = new THREE.Points(mgeo, new THREE.PointsMaterial({
        color: this._col('#ff6b2b'),
        size: 5 * this.DPR,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.25,
        depthWrite: false,
      }));
      this._mcPoints.frustumCulled = false;
      this.scene.add(this._mcPoints);
    }
  }

  _disposeTrajectory() {
    if (this._trajLine) {
      this.scene.remove(this._trajLine);
      this._trajLine.geometry.dispose();
      this._trajLine.material.dispose();
      this._trajLine = null;
    }
    if (this._mcPoints) {
      this.scene.remove(this._mcPoints);
      this._mcPoints.geometry.dispose();
      this._mcPoints.material.dispose();
      this._mcPoints = null;
    }
  }

  /** Dispose the promoted asteroid mesh + trajectory (dossier closed).
   *  Cached GLB assets and rock materials survive — clones share them. */
  demote() {
    if (this._promoMesh) {
      this.scene.remove(this._promoMesh);
      var dis = this._promoDisposables || [];
      for (var i = 0; i < dis.length; i++) dis[i].dispose();
      this._promoDisposables = null;
      this._promoMesh = null;
      this._promoModelKey = null;
    }
    if (this._promoOrbit) {
      this.scene.remove(this._promoOrbit);
      this._promoOrbit.geometry.dispose();
      this._promoOrbit.material.dispose();
      this._promoOrbit = null;
    }
    this._disposeTrajectory();
  }

  /* ── Shared model helpers (promoted object + focus mode) ───────────────── */

  _getRockMaterial(seed) {
    // Real AmbientCG rock set when its albedo already arrived (map set on
    // load success only) — canvas-procedural PBR set otherwise
    var real = this._rockMaterials[(seed >>> 0) % this._rockMaterials.length];
    if (real && real.map) return real;
    var idx = (seed >>> 0) % ASTEROID_ARCHETYPES.length;
    if (!this._rockMats[idx]) {
      var tex = generateRockTexture(idx + 1, 512);   // 8 fixed texture seeds
      tex.albedoTexture.anisotropy =
        Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
      this._rockMats[idx] = new THREE.MeshStandardMaterial({
        map:          tex.albedoTexture,
        normalMap:    tex.normalTexture,
        roughnessMap: tex.roughnessTexture,
        roughness:    0.92,
        metalness:    0.04,
        normalScale:  new THREE.Vector2(0.85, 0.85),
      });
    }
    return this._rockMats[idx];
  }

  /**
   * Load + cache a NASA GLB by key; cb receives a normalized clone
   * (centered, unit bounding-sphere radius) or null on any failure.
   * cb fires synchronously when the model is already cached.
   */
  _loadModel(key, cb) {
    if (!this._gltfLoader) { cb(null); return; }
    var cached = this._gltfCache[key];
    if (cached === 'error') { cb(null); return; }
    if (cached) { cb(cached.clone(true)); return; }
    if (this._gltfPending[key]) { this._gltfPending[key].push(cb); return; }
    this._gltfPending[key] = [cb];
    var self = this;
    function settle(result) {
      self._gltfCache[key] = result;
      var cbs = self._gltfPending[key];
      delete self._gltfPending[key];
      for (var i = 0; i < cbs.length; i++) {
        cbs[i](result === 'error' ? null : result.clone(true));
      }
    }
    this._gltfLoader.load('/assets/models/' + key + '.glb', function (gltf) {
      try {
        var root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
        // Lighting needs real vertex normals. For meshes without them
        // GLTFLoader falls back to flatShading, i.e. normals from screen-space
        // derivatives of the view position, and those underflow float32 when
        // a km-sized body is seen at true scale from a few km away (pilot
        // mode): the model turns solid black. Compute them once instead.
        root.traverse(function (child) {
          if (!child.isMesh || !child.geometry) return;
          if (!child.geometry.attributes.normal) child.geometry.computeVertexNormals();
          var mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach(function (m) {
            if (m && m.flatShading) { m.flatShading = false; m.needsUpdate = true; }
          });
        });
        var sph = new THREE.Box3().setFromObject(root)
          .getBoundingSphere(new THREE.Sphere());
        root.position.sub(sph.center);
        var wrap = new THREE.Group();
        wrap.add(root);
        wrap.scale.setScalar(sph.radius > 1e-9 ? 1 / sph.radius : 1);
        settle(wrap);
      } catch (e) {
        settle('error');
      }
    }, undefined, function () {
      settle('error');
    });
  }

  /* ── Manifest (imported GLB shape models — Parte 1) ────────────────────── */

  /** Exact-slug lookup across every manifest category.
   *  Returns { slug, modelPath, texturePath } or null. */
  _findModel(slug) {
    if (!this._manifest || !slug) return null;
    var cats = ['asteroids', 'comets', 'dwarf_planets', 'moons'];
    for (var c = 0; c < cats.length; c++) {
      var arr = this._manifest[cats[c]] || [];
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].slug === slug) return arr[i];
      }
    }
    return null;
  }

  // Body-prefix lookup inside ONE category list — slugs are
  // <body>_<source> ("dione_gaskell_200k_poly"), so "dione" matches exactly
  // or as "dione_…". Same rule the manifest generator used for textures.
  _findModelByBody(list, body) {
    if (!list || !body) return null;
    for (var i = 0; i < list.length; i++) {
      var s = list[i].slug;
      if (s === body || s.indexOf(body + '_') === 0) return list[i];
    }
    return null;
  }

  /** Fuzzy name → manifest entry. Normalizes to a slug ("Ra-Shalom" →
   *  "ra_shalom" → prefix test), searching asteroids first so asteroid 85 Io
   *  never collides with the moon Io. Prefix must land on a "_" boundary —
   *  the substring false positives of the first manifest are what this
   *  whole scheme replaced. */
  _fuzzyModel(name) {
    if (!this._manifest) return null;
    var norm = String(name || '').toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!norm) return null;
    var cats = ['asteroids', 'comets', 'dwarf_planets', 'moons'];
    for (var c = 0; c < cats.length; c++) {
      var hit = this._findModelByBody(this._manifest[cats[c]], norm);
      if (hit) return hit;
    }
    return null;
  }

  /** Model resolution for a catalog NEO (Parte 2): curated MODEL_MAP first
   *  (numeric designation), manifest fuzzy-name second, null = procedural. */
  _getNEOModel(neo) {
    var key = _modelKeyFor(neo.id, neo.name);
    if (key) return { key: key, modelPath: '/assets/models/' + key + '.glb' };
    var entry = this._fuzzyModel(neo.name);
    if (entry) return { key: entry.slug, modelPath: entry.modelPath };
    return null;
  }

  _onManifestLoaded() {
    this._applyMoonModels();
    this._applySmallBodyModels(this._dwarfs, this._manifest.dwarf_planets);
    this._applySmallBodyModels(this._comets, this._manifest.comets);
    this._logNEOModels();
  }

  // The imported OBJs ship POSITION only — no normals (black under any lit
  // material) and no UVs. Generate both: computed vertex normals, plus
  // spherical UVs for the equirectangular NASA maps. Non-indexed pass fixes
  // the u wrap seam per triangle; RepeatWrapping absorbs u > 1.
  _ensureSphericalUVs(root) {
    root.traverse(function (child) {
      if (!child.isMesh || !child.geometry) return;
      var geo = child.geometry;
      if (geo.attributes.uv && geo.attributes.normal) return;
      if (geo.index) { geo = geo.toNonIndexed(); child.geometry = geo; }
      if (!geo.attributes.normal) geo.computeVertexNormals();
      if (geo.attributes.uv) return;
      var pos = geo.attributes.position;
      var uv = new Float32Array(pos.count * 2);
      for (var i = 0; i < pos.count; i++) {
        var x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        var r = Math.sqrt(x * x + y * y + z * z) || 1;
        uv[i * 2]     = 0.5 + Math.atan2(y, x) / (2 * Math.PI);
        uv[i * 2 + 1] = 0.5 + Math.asin(Math.max(-1, Math.min(1, z / r))) / Math.PI;
      }
      for (var t3 = 0; t3 < pos.count; t3 += 3) {
        var u0 = uv[t3 * 2], u1 = uv[(t3 + 1) * 2], u2 = uv[(t3 + 2) * 2];
        var uMax = Math.max(u0, u1, u2);
        if (uMax - Math.min(u0, u1, u2) > 0.5) {
          if (uMax - u0 > 0.5) uv[t3 * 2] += 1;
          if (uMax - u1 > 0.5) uv[(t3 + 1) * 2] += 1;
          if (uMax - u2 > 0.5) uv[(t3 + 2) * 2] += 1;
        }
      }
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    });
  }

  // Replace the GLB's exported materials with our standard rock material and
  // pop the texture in when it arrives (never blocks the mesh showing up).
  _applyManifestMaterial(inst, texturePath, fallbackColor) {
    var self = this;
    var mat = new THREE.MeshStandardMaterial({
      color: this._col(fallbackColor != null ? fallbackColor : 0x999999),
      roughness: 0.95,
      metalness: 0.0,
    });
    inst.traverse(function (child) {
      if (child.isMesh) child.material = mat;
    });
    if (texturePath) {
      this._texLoader.load(texturePath, function (tex) {
        tex.encoding = THREE.sRGBEncoding;
        tex.wrapS = THREE.RepeatWrapping;            // seam-fix u may exceed 1
        tex.anisotropy = Math.min(4, self.renderer.capabilities.getMaxAnisotropy());
        mat.map = tex;
        mat.color.set(0xffffff);
        mat.needsUpdate = true;
      }, undefined, function () { /* keep flat color */ });
    }
    return mat;
  }

  // Parte 3: moons whose id has a manifest shape model swap their textured
  // sphere for the real GLB. Texture-only moons (Europa, Titan, …) simply
  // keep the sphere + id.jpg path from _loadTextures().
  _applyMoonModels() {
    var self = this;
    if (!this._gltfLoader) return;
    Object.keys(this._moons).forEach(function (id) {
      var m = self._moons[id];
      var entry = self._findModelByBody(self._manifest.moons, id);
      if (!entry) return;
      self._loadModel(entry.slug, function (inst) {
        if (!inst || m.model) return;
        self._ensureSphericalUVs(inst);
        // id.jpg is already requested for the sphere — same URL, so the
        // browser serves it from cache (the manifest textures are the multi-
        // MB enhanced-color scans; the equirect id.jpg reads the same here).
        self._applyManifestMaterial(inst, self._textureBase + id + '.jpg',
          MOON_FALLBACK[id] != null ? MOON_FALLBACK[id] : 0x999999);
        m.model = inst;
        m.group.add(inst);
        m.mesh.visible = false;                      // hide the sphere
      });
    });
  }

  // Partes 4/5: dwarf planets + comets — same swap, driven by def.body
  _applySmallBodyModels(list, manifestList) {
    var self = this;
    if (!this._gltfLoader || !list) return;
    list.forEach(function (d) {
      var entry = self._findModelByBody(manifestList, d.def.body);
      if (!entry) return;
      // Skip scientific "regions" maps (false-colour geologic units — 67P ships
      // only churyumov-gerasimenko_regions.jpg). A flat dark grey-brown surface
      // reads far better than region colours splashed on the nucleus.
      var texPath = entry.texturePath;
      var fallbackColor = d.def.color;
      if (texPath && /region/i.test(texPath)) {
        texPath = null;
        fallbackColor = 0x554433;
      }
      self._loadModel(entry.slug, function (inst) {
        if (!inst || d.model) return;
        self._ensureSphericalUVs(inst);
        self._applyManifestMaterial(inst, texPath, fallbackColor);
        d.model = inst;
        d.group.add(inst);
        d.mesh.visible = false;
      });
    });
  }

  // Parte 6: log which of the 47 catalog NEOs resolve to a real shape model.
  // Diagnostic only — rendering behavior is unchanged by this.
  _logNEOModels() {
    var neos = this.opts.neos || [];
    console.log('[NEO Models]');
    for (var i = 0; i < neos.length; i++) {
      var got = this._getNEOModel(neos[i]);
      console.log('  ' + neos[i].name + ': ' + (got ? got.modelPath : 'procedural'));
    }
  }

  /* ── Per-frame update ──────────────────────────────────────────────────── */

  /** Position the camera from the page-owned spherical state (frame.cam) and
   *  refresh the shared view-projection matrix the page's ws() reads. */
  _updateCamera(cam, ship) {
    var piloting = !!(ship && ship.active);
    // Pilot mode flies within metres of km-sized bodies, so it brings its own
    // near plane; the map/focus camera keeps the 1e-6 AU default.
    var near = piloting ? ship.near : 1e-6;
    if (this.camera.near !== near) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
    if (piloting) {
      // The page owns the ship: position + (lagged) camera orientation arrive
      // solved, the renderer only applies them.
      this.camera.position.set(ship.x, ship.y, ship.z);
      this.camera.quaternion.set(ship.cqx, ship.cqy, ship.cqz, ship.cqw);
      this.camera.updateMatrixWorld(true);
      this._camPos.copy(this.camera.position);
      this._fillLight.position.copy(this.camera.position);
      var fe = this.camera.matrixWorld.elements;        // column 2 = local +Z (backward)
      this._fillLight.target.position.set(ship.x - fe[8], ship.y - fe[9], ship.z - fe[10]);
    } else {
      var cp = Math.cos(cam.phi), sp = Math.sin(cam.phi);
      this.camera.position.set(
        cam.tx + cam.dist * cp * Math.sin(cam.theta),
        cam.ty + cam.dist * cp * Math.cos(cam.theta),
        cam.tz + cam.dist * sp
      );
      this.camera.up.set(0, 0, 1);
      this.camera.lookAt(cam.tx, cam.ty, cam.tz);
      this.camera.updateMatrixWorld(true);
      this._camPos.copy(this.camera.position);
      // Camera-riding fill: lights whatever face the user is looking at
      this._fillLight.position.copy(this.camera.position);
      this._fillLight.target.position.set(cam.tx, cam.ty, cam.tz);
    }
    this._vpMat.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this._vpArray.set(this._vpMat.elements);
    // AU per pixel at distance 1 — multiply by a body's camera distance
    this._wpp1 = 2 * Math.tan(FOV_DEG * Math.PI / 360) / this.H;
  }

  /** The shared VP matrix (Float32Array 16, column-major). Same array object
   *  every call — the page keeps one reference and reads fresh values. */
  getVPMatrix() {
    return this._vpArray;
  }

  // World → CSS-px screen coords through the current VP matrix.
  // Returns null when the point is behind the camera.
  _ws(x, y, z) {
    var e = this._vpArray;
    var cw = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (cw <= 0) return null;
    var cx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / cw;
    var cy = (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw;
    return { x: (cx + 1) * 0.5 * this.W, y: (1 - cy) * 0.5 * this.H };
  }

  // Camera distance to a world point (AU) — for the min-px scale rule
  _camDist(x, y, z) {
    var dx = x - this._camPos.x, dy = y - this._camPos.y, dz = z - this._camPos.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  _drawSun() {
    // Physically true angular size at every distance, with a small visibility
    // floor: a 6px point from the outer system, a real disc as the camera
    // dives in (≈0.5° from Earth's distance).
    var wpp = this._wpp1 * this._camPos.length();      // sun sits at the origin
    var r = Math.max(REAL_RADIUS_AU.sun, MIN_PX.sun * wpp);
    this.sun.scale.setScalar(r / 0.04);                // base geometry radius 0.04
    // Glow: 6× the disc, never under 80px. Sprite scale is raw world units —
    // the 0.04 base radius belongs to the sphere geometry only.
    var glowR = Math.max(r * 6, 80 * wpp);
    this.sunGlow.scale.set(glowR, glowR, 1);
    // Outer aura: twice the primary halo, much fainter (fake bloom layer 2)
    var glow2R = Math.max(r * 12, 170 * wpp);
    this.sunGlow2.scale.set(glow2R, glow2R, 1);
  }

  _drawPlanets(state, frame, dt) {
    var showOrbits = state.showPlanets && state.showOrbits;
    for (var i = 0; i < this.planets.length; i++) {
      var p = this.planets[i];
      var f = frame.planets[i];
      p.group.visible = f.visible;
      p.orbit.visible = showOrbits && !!(state.planetToggles && state.planetToggles[p.def.key]);
      if (!f.visible) continue;
      p.group.position.set(f.x, f.y, 0);
      // Real radius with a min-px floor: a fixed dot from afar, true
      // perspective size up close (ring + halo are children — they inherit)
      var wpp = this._wpp1 * this._camDist(f.x, f.y, 0);
      var realR = REAL_RADIUS_AU[p.def.key] || 2e-5;
      var minPx = MIN_PX[p.def.key] || 3;
      var r = Math.max(realR, minPx * wpp);
      p.group.scale.setScalar(r);
      // Sidereal rotation — set absolutely from simTime (days) so variable
      // simulation speed never accumulates drift
      var angleRad = (Math.PI * 2 / SIDEREAL_DAY[p.def.key]) * state.simTime;
      p.sphere.rotation.z = angleRad;
      if (p.clouds) p.clouds.rotation.z = angleRad * 1.006;
      var conj = !!f.conj;
      // The additive glow sprite would wash out the textured close-up, so it
      // fades out once the true size beats the min-px floor
      var closeUp = realR > minPx * wpp;
      p.glow.visible = (!!p.def.glow || conj) && !closeUp;
      p.glow.scale.setScalar(conj ? 10 : 6);
      p.glow.material.opacity = conj ? 0.5 : 0.4;
    }
  }

  _drawMoons(state, frame) {
    for (var id in this._moons) {
      var m = this._moons[id];
      var pIdx = this._planetIdxByKey[m.data.parent];
      var pf = pIdx != null ? frame.planets[pIdx] : null;
      var visible = !!(pf && pf.visible);
      m.group.visible = visible;
      m.orbit.visible = false;
      m.labelOn = false;
      if (!visible) { m.screen = null; continue; }

      var lp = moonLocalPos(m.data, state.simTime);
      var mx = pf.x + lp.x, my = pf.y + lp.y, mz = lp.z;
      m.group.position.set(mx, my, mz);

      // NEO-sized min-px dot from afar, true physical radius up close
      var dist = this._camDist(mx, my, mz);
      var wpp = this._wpp1 * dist;
      var r = Math.max(m.data.r, 1.5 * wpp);
      // Focused moon: promo-style floor frozen at the luna framing distance —
      // Phobos/Deimos read as real rocks instead of 2 px dots, and dollying
      // in past the frame distance grows them instead of re-shrinking
      if (state.focusTarget && state.focusTarget.type === 'moon' &&
          state.focusTarget.id === id) {
        r = Math.max(r, FOCUS_BODY_MIN_PX * this._wpp1 * Math.max(dist, FOCUS_BODY_FRAME_DIST));
      }
      m.group.scale.setScalar(r);

      // Tidally locked: the same face keeps pointing at the parent.
      // Math.PI − angle turns the texture near side toward the planet.
      // GLB shape models spin about +Z (their native spin axis — no sphere
      // pole bake), so the same lock angle goes on rotation.z there.
      if (m.data.tidal) {
        m.mesh.rotation.y = Math.PI - lp.angle;
        if (m.model) m.model.rotation.z = Math.PI - lp.angle;
      }

      // Screen cache for page hit tests + labels. sep = on-screen distance to
      // the parent's centre (page skips moons buried inside the parent disc).
      var s = this._ws(mx, my, mz);
      var ps = this._ws(pf.x, pf.y, 0);
      var sep = (s && ps) ? Math.hypot(s.x - ps.x, s.y - ps.y) : 1e9;
      m.screen = s ? { x: s.x, y: s.y, r: Math.max(3, r / wpp), sep: sep } : null;

      // Orbit ring + label only while the camera is inside the parent system
      var nearParent = this._camDist(pf.x, pf.y, 0) < 1;
      m.orbit.visible = !!state.showOrbits && nearParent;
      if (m.orbit.visible) m.orbit.position.set(pf.x, pf.y, 0);
      m.labelOn = nearParent && !!s && sep > 14;
    }
  }

  /** Screen position (CSS px) + apparent radius of a moon — used by the page
   *  for hover/click hit testing. sep = on-screen distance to the parent's
   *  centre. Null when hidden or behind the camera. */
  getMoonScreenPos(id) {
    var m = this._moons[id];
    return m && m.group.visible ? m.screen : null;
  }

  /** Same contract for dwarf planets / comets, by index into the shared
   *  DWARF_PLANETS / COMETS tables (page hit tests + focus). */
  getDwarfScreenPos(i) {
    var d = this._dwarfs && this._dwarfs[i];
    return d && d.group.visible ? d.screen : null;
  }

  getCometScreenPos(i) {
    var c = this._comets && this._comets[i];
    return c && c.group.visible ? c.screen : null;
  }

  // Parte 4 — positions arrive solved from the page (frame.dwarfPlanets)
  _drawDwarfPlanets(state, frame, dt) {
    if (!this._dwarfs || !frame.dwarfPlanets) return;
    for (var i = 0; i < this._dwarfs.length; i++) {
      var d = this._dwarfs[i];
      var f = frame.dwarfPlanets[i];
      var visible = !!(f && f.visible);
      d.group.visible = visible;
      d.orbit.visible = visible && !!state.showOrbits;
      if (!visible) { d.screen = null; continue; }
      d.group.position.set(f.x, f.y, f.z);
      // Min-px 3: smaller than planets, bigger than the asteroid cloud
      var dist = this._camDist(f.x, f.y, f.z);
      var wpp = this._wpp1 * dist;
      var r = Math.max(d.def.r, (d.def.minPx || 3) * wpp);
      if (state.focusTarget && state.focusTarget.type === 'dwarf' &&
          state.focusTarget.idx === i) {
        r = Math.max(r, FOCUS_BODY_MIN_PX * this._wpp1 * Math.max(dist, FOCUS_BODY_FRAME_DIST));
      }
      d.group.scale.setScalar(r);
      // Slow spin — sphere about its baked pole, GLB about native +Z
      var spin = state.simTime * 0.7;
      d.mesh.rotation.y = spin;
      if (d.model) d.model.rotation.z = spin;
      var s = this._ws(f.x, f.y, f.z);
      d.screen = s ? { x: s.x, y: s.y, r: Math.max(4, r / wpp) } : null;
    }
  }

  // Parte 5 — comets: nucleus + coma + particle CometTail (dust + ion)
  _drawComets(state, frame, dt) {
    if (!this._comets || !frame.comets) return;
    var simDt = frame.simDt || 1.0;
    for (var i = 0; i < this._comets.length; i++) {
      var c = this._comets[i];
      var f = frame.comets[i];
      var visible = !!(f && f.visible);
      c.group.visible = visible;
      c.orbit.visible = visible && !!state.showOrbits;
      if (!visible) {
        c.screen = null; c.coma.visible = false; c.light.intensity = 0;
        if (c.tail) c.tail.hide();
        continue;
      }
      c.group.position.set(f.x, f.y, f.z);
      var dist = this._camDist(f.x, f.y, f.z);
      var wpp = this._wpp1 * dist;
      var r = Math.max(c.def.r, (c.def.minPx || 2.5) * wpp);
      if (state.focusTarget && state.focusTarget.type === 'comet' &&
          state.focusTarget.idx === i) {
        r = Math.max(r, FOCUS_BODY_MIN_PX * this._wpp1 * Math.max(dist, FOCUS_BODY_FRAME_DIST));
      }
      c.group.scale.setScalar(r);
      var spin = state.simTime * 1.3;
      c.mesh.rotation.y = spin;
      if (c.model) c.model.rotation.z = spin;

      // Particle tails — CometTail owns the smoothed activation (crossing
      // 2.5 AU ramps up/down over seconds). Emission boosts while focused.
      var sunDist = f.sunDist || Math.hypot(f.x, f.y, f.z) || 1e-6;
      var focusBoost = !!(state.focusTarget && state.focusTarget.type === 'comet' &&
                          state.focusTarget.idx === i);
      if (c.tail) {
        this._cometPos.set(f.x, f.y, f.z);
        c.tail.update(this._cometPos, this._sunOrigin, sunDist, simDt, focusBoost);
      }
      var act = c.tail ? c.tail.activity()
        : Math.max(0, (COMET_ACTIVE_AU - sunDist) / COMET_ACTIVE_AU);
      c.light.intensity = act > 0.02 ? 0.4 * Math.min(1, act * 2) : 0;

      // Coma sprite (scene-level, world units with a px floor so it also reads
      // on the wide map). Focused comet gets a big bright blue-white bloom head
      // (50–140 px), like the reference photo; on the map it's a small halo.
      var comaWorld = c.def.r * 300 * act * (focusBoost ? 3 : 1) + c.def.r * 2;
      var comaPx = (focusBoost ? (50 + act * 90) : (14 * act + 3)) * wpp;
      var pulse = 1 + 0.05 * Math.sin(performance.now() * 0.002);
      c.coma.position.set(f.x, f.y, f.z);
      c.coma.scale.setScalar(Math.max(comaWorld, comaPx) * pulse);
      c.coma.material.opacity = focusBoost ? Math.min(0.9, act * 0.6 + 0.3) : act * 0.55;
      c.coma.visible = act > 0.01;

      var s = this._ws(f.x, f.y, f.z);
      c.screen = s ? { x: s.x, y: s.y, r: Math.max(4, r / wpp) } : null;
    }
  }

  _drawNEOs(state, frame) {
    // The focused NEO is rendered as its promoted 3D mesh (procedural rock or
    // NASA GLB, _drawPromotedObject) — the whole map group hides while that
    // NEO is the focus target. The index arrives as flat frame data
    // (frame.focusNeoIdx): the renderer stays out of the page's focus state.
    var focusNeo = (frame.focusNeoIdx != null) ? frame.focusNeoIdx : -1;
    var MAP_NEO_PX = 1.5;    // fixed small marker size in the general map
    for (var i = 0; i < this.neos.length; i++) {
      var n = this.neos[i];
      var f = frame.neos[i];
      var isSel = i === frame.selIdx;
      n.group.visible = i !== focusNeo;
      n.orbit.visible = true;
      if (n.group.visible) {
        n.group.position.set(f.x, f.y, f.z);
        // Catalog NEOs carry no reliable physical radius (1e-9 AU stand-in):
        // the min-px floor decides the on-screen size. The focused NEO never
        // scales up here — it hides (visible=false above) and _promoMesh
        // renders in its place at PROMO_MIN_PX.
        var wpp = this._wpp1 * this._camDist(f.x, f.y, f.z);
        n.group.scale.setScalar(Math.max(1e-9, MAP_NEO_PX * wpp));
        n.group.rotation.y += 0.003;             // slow tumble — life on the map
      }
      n.orbit.material.opacity = isSel ? n.style.sel : n.style.base;
    }
    var sel = frame.selIdx >= 0 ? this.neos[frame.selIdx] : null;
    this._selWire.visible = !!sel;
    this._selLight.visible = !!sel;
    if (sel) {
      var f2 = frame.neos[frame.selIdx];
      var riskCol = this._col(RISK_COLOR[sel.def.risk] || '#f0f4ff');
      var pulse = 1.8 + 0.4 * Math.sin(state.simTime * 3);
      var wpp2 = this._wpp1 * this._camDist(f2.x, f2.y, f2.z);
      this._selWire.position.set(f2.x, f2.y, f2.z);
      this._selWire.scale.setScalar(4 * wpp2 * pulse);
      this._selWire.material.color.copy(riskCol);
      this._selLight.position.set(f2.x, f2.y, f2.z);
      this._selLight.color.copy(riskCol);
    }
  }

  _drawConeMesh(state, frame) {
    var c = frame.cone;
    // Hidden while focused: at focus dolly distances the wide translucent
    // ribbon (orange when the selection is risky) slices through the frustum
    // and washes the whole close-up in its color.
    // Same reason in pilot mode: the ship flies right through it.
    this.cone.visible = !!(c && c.active && !state.focusTarget && !(frame.ship && frame.ship.active));
    if (!this.cone.visible) return;
    var N = Math.min(this._coneN, c.count);
    var pos = this.cone.geometry.attributes.position;
    var arr = pos.array;
    for (var k = 0; k < N; k++) {
      arr[k * 3] = c.upper[k * 3];
      arr[k * 3 + 1] = c.upper[k * 3 + 1];
      arr[k * 3 + 2] = c.upper[k * 3 + 2];
      var o = (this._coneN + k) * 3;
      arr[o] = c.lower[k * 3];
      arr[o + 1] = c.lower[k * 3 + 1];
      arr[o + 2] = c.lower[k * 3 + 2];
    }
    pos.needsUpdate = true;
    this._coneMat.color = this._col(c.risky ? '#ff6b2b' : '#1a6cf6');
    this._coneMat.opacity = c.risky ? 0.10 : 0.08;
  }

  _drawMPCAsteroids(state, frame) {
    if (!this._mpcPoints) return;
    var show = !!(state.showMPC && frame.mpcDirty);
    this._mpcPoints.visible = show;
    if (show) this._mpcPoints.geometry.attributes.position.needsUpdate = true;
  }

  _drawPromotedObject(state, frame, dt) {
    var active = !!(frame.promoted && frame.promoted.active);
    if (this._promoMesh) {
      this._promoMesh.visible = active;
      if (active) {
        var pr = frame.promoted;
        // Real radius estimated from H (page-computed) with a min-px floor.
        // Geometry base radius is 1.0 (procedural meshes normalized to unit
        // max radius, GLB wrapped to a unit bounding sphere), so the AU
        // radius IS the scale. The big PROMO_MIN_PX floor applies ONLY
        // while this asteroid is the focus target — a dossier promotion seen
        // from the map keeps the small 8px marker floor, otherwise the rock
        // dwarfs the whole inner system.
        // While focused, the min-px floor is evaluated at FOCUS_FRAME_DIST
        // (not the live camera distance): the world size stays constant, so
        // the wheel dolly reads as a real approach — 60 px at the entry
        // framing, growing to fill the screen near _focusMinDist.
        var dist = this._camDist(pr.x, pr.y, pr.z);
        var wpp = this._wpp1 * (pr.focused ? Math.max(dist, FOCUS_FRAME_DIST) : dist);
        var minPx = pr.focused ? PROMO_MIN_PX : 8;
        var scale = Math.max(pr.radius || 0, minPx * wpp);
        this._promoMesh.position.set(pr.x, pr.y, pr.z);
        this._promoMesh.scale.setScalar(scale);
        this._promoMesh.rotateOnAxis(this._promoAxis, this._promoSpeed * dt);
      }
    }
    // Warm sun-position point light for the asteroid close-up — lifts the
    // rock's lit side above the minimal ambient while the camera hugs it.
    // Also on for focused moons/dwarfs/comets: same close-up, same need.
    var tgF = state.focusTarget;
    var smallBodyFocus = !!(tgF && (tgF.type === 'moon' || tgF.type === 'dwarf' || tgF.type === 'comet'));
    if ((active && frame.promoted.focused) || smallBodyFocus) {
      if (!this._focusAstLight) {
        this._focusAstLight = new THREE.PointLight(0xfff5e0, 1.5, 0, 2);
        this._focusAstLight.position.set(0, 0, 0);   // the Sun
        this.scene.add(this._focusAstLight);
      }
      this._focusAstLight.visible = true;
    } else if (this._focusAstLight) {
      this._focusAstLight.visible = false;
    }
    if (this._promoOrbit) this._promoOrbit.visible = active;
    if (this._trajLine) this._trajLine.visible = active;
    if (this._mcPoints) this._mcPoints.visible = active;
  }

  /* ── Magnetosphere (focus mode toggle) ─────────────────────────────────── */

  // frame.mag = { key, kind } names the body whose field is on (key into
  // MAGNETOSPHERES; kind 'planet' | 'moon'), or key = null. Views are built on
  // first use and cached; they cross-fade when the focus hops between bodies.
  _drawMagnetosphere(state, frame, dt) {
    var mag = frame.mag;
    var want = mag && mag.key && MAGNETOSPHERES[mag.key] ? mag.key : null;
    if (!this._magViews) {
      if (!want) return;
      this._magViews = {};
      this._magTime = 0;
      this._magIdentity = new THREE.Quaternion();
    }
    this._magTime += dt;
    if (want && !this._magViews[want]) {
      this._magViews[want] = new MagnetosphereView(this.scene, MAGNETOSPHERES[want]);
      this._magViews[want].kind = mag.kind;
    }
    this._magLabel = null;
    for (var key in this._magViews) {
      var v = this._magViews[key];
      var target = key === want ? 1 : 0;
      v.opacity += (target - v.opacity) * Math.min(1, dt * 4);
      if (target === 0 && v.opacity < 0.004) v.opacity = 0;

      var pos = null, radius = 0, quat = this._magIdentity, trueAngle = 0, period = 0;
      if (v.kind === 'planet') {
        var p = this.planets[this._planetIdxByKey[key]];
        if (p && p.group.visible) {
          pos = p.group.position; radius = REAL_RADIUS_AU[key];
          quat = p.group.quaternion; trueAngle = p.sphere.rotation.z; period = SIDEREAL_DAY[key];
        }
      } else {
        var m = this._moons[key];
        if (m && m.group.visible) { pos = m.group.position; radius = m.data.r; }
      }
      if (!pos) { v.opacity = 0; v.root.visible = false; continue; }

      // Rotation: locked to the real spin while it is slow enough to follow
      // (always in live mode), otherwise turning at the cap in the true sense
      var w = period ? (2 * Math.PI / period) * (frame.simRate || 0) : 0;
      if (Math.abs(w) <= MAG_SPIN_CAP) v.phase = trueAngle;
      else v.phase += (w > 0 ? 1 : -1) * MAG_SPIN_CAP * dt;

      v.update(pos, radius, quat, v.phase, this._magTime);
      if (key === want && v.shell) {
        this._magLabel = { view: v, pos: pos, radius: radius };
      }
    }
  }

  // Two words on the 2D overlay so the shape reads at a glance
  _drawMagLabels(g) {
    var ml = this._magLabel;
    if (!ml || ml.view.opacity < 0.05) return;
    var def = ml.view.def, p = ml.pos;
    var L = Math.hypot(p.x, p.y, p.z) || 1;
    var sx = -p.x / L, sy = -p.y / L, sz = -p.z / L;          // unit vector to the Sun
    var nose = def.r0 * ml.radius, tail = def.tail * def.r0 * ml.radius * 0.62;
    var a = this._ws(p.x + sx * nose, p.y + sy * nose, p.z + sz * nose);
    var b = this._ws(p.x - sx * tail, p.y - sy * tail, p.z - sz * tail);
    g.save();
    g.font = '9px "JetBrains Mono", monospace';
    g.globalAlpha = Math.min(1, ml.view.opacity) * 0.85;
    g.fillStyle = 'rgba(170, 182, 255, 1)';
    if (a && a.x > 0 && a.x < this.W && a.y > 0 && a.y < this.H) {
      g.fillText('MAGNETOPAUSE', a.x + 8, a.y - 6);
      g.beginPath(); g.arc(a.x, a.y, 2, 0, Math.PI * 2); g.fill();
    }
    if (b && b.x > 0 && b.x < this.W && b.y > 0 && b.y < this.H) {
      g.fillText('MAGNETOTAIL', b.x + 8, b.y - 6);
    }
    g.restore();
  }

  /* ── Pilot mode: the player's ship ─────────────────────────────────────── */

  // The ship lives in its OWN scene with its own camera, drawn after the main
  // pass with the depth buffer cleared in between. A ~30 m craft cannot share
  // a world scale or a depth range with planets, and this keeps it the same
  // size on screen whether it is skimming a 300 m asteroid or leaving Jupiter.
  // The overlay scene's axes ARE the main camera's local axes, so the key
  // light is aimed along the true Sun direction: the hull is lit from where
  // the Sun really is. Ship axes: forward = −Z, up = +Y, right = +X (same as a
  // camera). Built lazily on the first pilot frame.
  _buildShip() {
    var self = this;
    var scene = new THREE.Scene();
    var cam = new THREE.PerspectiveCamera(36, this.W / Math.max(1, this.H), 0.05, 80);
    // Behind and ~18° above the hull, so the payload bay and wing tops show
    // (dead astern an orbiter is mostly engine bells), and far enough back
    // that it sits in the lower quarter of the view: the scene is the subject.
    cam.position.set(0, 3.6, 11.0);
    cam.lookAt(0, 2.05, 0);

    var sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
    scene.add(sun);
    scene.add(sun.target);
    scene.add(new THREE.HemisphereLight(0x9db4dc, 0x10131c, 0.42));

    var root = new THREE.Group();     // attitude relative to the camera (page-solved)
    var bank = new THREE.Group();     // cosmetic bank/pitch from the turn rates
    root.add(bank);
    scene.add(root);
    // The ship is NASA's Space Shuttle orbiter (loaded below). Everything
    // built into `proc` is a stand-in that only shows if that file fails.
    var proc = new THREE.Group();
    proc.visible = false;
    bank.add(proc);

    function mat(hex, rough, extra) {
      var o = { color: self._col(hex), roughness: rough, metalness: 0.18, flatShading: true };
      if (extra) for (var k in extra) o[k] = extra[k];
      return new THREE.MeshStandardMaterial(o);
    }
    var hullMat   = mat(0xaeb7c9, 0.55);
    var darkMat   = mat(0x2b3242, 0.65);
    var accentMat = mat(0x1a6cf6, 0.45, { emissive: this._col(0x1a6cf6), emissiveIntensity: 0.30 });
    var glassMat  = mat(0x0c1a33, 0.12, { metalness: 0.6, flatShading: false,
                                          emissive: this._col(0x1c4a8c), emissiveIntensity: 0.55 });
    function add(geo, m, x, y, z) {
      var mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x || 0, y || 0, z || 0);
      proc.add(mesh);
      return mesh;
    }
    // Flat plate from a 2D outline: outline +y → ship forward, thickness → up
    function plate(points, depth) {
      var sh = new THREE.Shape();
      sh.moveTo(points[0][0], points[0][1]);
      for (var k = 1; k < points.length; k++) sh.lineTo(points[k][0], points[k][1]);
      sh.closePath();
      var g = new THREE.ExtrudeGeometry(sh, { depth: depth, bevelEnabled: false });
      g.translate(0, 0, -depth / 2);
      g.rotateX(-Math.PI / 2);
      return g;
    }

    // Hull: lathe profile (radius, station) listed tail → nose so faces point out
    var prof = [[0, -1.60], [0.25, -1.60], [0.31, -1.20], [0.34, -0.60], [0.31, 0.15],
                [0.24, 0.85], [0.15, 1.40], [0.06, 1.80], [0, 1.95]];
    var hullGeo = new THREE.LatheGeometry(prof.map(function (p) { return new THREE.Vector2(p[0], p[1]); }), 12);
    hullGeo.rotateX(-Math.PI / 2);
    hullGeo.scale(1, 0.70, 1);
    add(hullGeo, hullMat);
    // Dark tail cap: the chase camera looks straight at the hull's flat rear
    // end, which otherwise reads as a third, white-hot engine
    var capGeo = new THREE.CircleGeometry(0.262, 14);
    capGeo.scale(1, 0.70, 1);
    add(capGeo, darkMat, 0, 0, 1.603);

    // Canopy + dorsal accent stripe
    var canopyGeo = new THREE.SphereGeometry(0.2, 14, 10);
    canopyGeo.scale(0.85, 0.62, 2.1);
    add(canopyGeo, glassMat, 0, 0.155, -0.78);
    add(new THREE.BoxGeometry(0.09, 0.03, 1.55), accentMat, 0, 0.232, 0.40);

    // Swept wings (slight anhedral) with accent tips
    var wingR = [[0.24, 0.45], [1.85, -1.05], [1.85, -1.38], [1.25, -1.30], [0.24, -1.30]];
    var wingL = wingR.map(function (p) { return [-p[0], p[1]]; });
    add(plate(wingR, 0.06), hullMat, 0, -0.03, 0).rotation.z = -0.06;
    add(plate(wingL, 0.06), hullMat, 0, -0.03, 0).rotation.z = 0.06;
    add(new THREE.BoxGeometry(0.07, 0.08, 0.40), accentMat, 1.86, -0.14, 1.21);
    add(new THREE.BoxGeometry(0.07, 0.08, 0.40), accentMat, -1.86, -0.14, 1.21);

    // Twin canted tail fins
    function fin(sign) {
      var g = plate([[0, -0.70], [0.62, -1.50], [0.62, -1.70], [0, -1.58]], 0.05);
      g.rotateZ(Math.PI / 2);                  // outline +x → up, thickness → sideways
      var m = add(g, darkMat, sign * 0.27, 0.10, 0);
      m.rotation.z = -sign * 0.32;
    }
    fin(1); fin(-1);

    // Engines: nacelle + intake cone + glowing nozzle, flame and halo
    var flames = [], halos = [];
    var nacelleGeo = new THREE.CylinderGeometry(0.16, 0.19, 1.0, 10);
    nacelleGeo.rotateX(Math.PI / 2);
    var intakeGeo = new THREE.ConeGeometry(0.16, 0.36, 10);
    intakeGeo.rotateX(-Math.PI / 2);
    var nozzleGeo = new THREE.CircleGeometry(0.135, 14);
    var flameGeo = new THREE.ConeGeometry(0.125, 1, 10, 1, true);
    flameGeo.rotateX(Math.PI / 2);
    flameGeo.translate(0, 0, 0.5);             // base at the nozzle, tip trailing (+Z)
    var nozzleMat = new THREE.MeshBasicMaterial({ color: this._col(0x9fdcff) });
    [1, -1].forEach(function (sign) {
      var x = sign * 0.56;
      add(nacelleGeo, darkMat, x, -0.05, 1.08);
      add(intakeGeo, darkMat, x, -0.05, 0.40);
      add(nozzleGeo, nozzleMat, x, -0.05, 1.585);
      var flame = add(flameGeo, new THREE.MeshBasicMaterial({
        color: self._col(0x62b4ff), transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }), x, -0.05, 1.59);
      flames.push(flame);
      var halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: self._glowTexture, color: self._col(0x7fc8ff),
        blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
      }));
      halo.position.set(x, -0.05, 1.66);
      proc.add(halo);
      halos.push(halo);
    });

    // Navigation lights, aviation convention: red to port, green to starboard
    var navs = [];
    [[-1.9, 0xff3b30], [1.9, 0x30ff6a]].forEach(function (n) {
      var sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: self._glowTexture, color: self._col(n[1]),
        blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
      }));
      sp.position.set(n[0], -0.14, 1.2);
      sp.scale.setScalar(0.34);
      proc.add(sp);
      navs.push(sp);
    });

    var sh = this._ship = {
      scene: scene, cam: cam, sun: sun, root: root, bank: bank,
      flames: flames, halos: halos, navs: navs,
      idleFlame: 0.12, idleHalo: 0.45,       // the stand-in's engines idle with a glow
      bankZ: 0, pitchX: 0, burn: 0, t: 0,
    };
    this._shipQ = new THREE.Quaternion();     // inverse camera orientation (scratch)
    this._shipV = new THREE.Vector3();

    // ── The real hull: NASA Space Shuttle orbiter ──
    // /assets/models/ship_shuttle.glb is NASA 3D Resources' "Space Shuttle (D)"
    // set (body, payload bay doors, engine bells) assembled into one file, in
    // the on-orbit configuration: doors open, radiators out. Nose −Z, up +Y.
    // The exhaust hangs off the two OMS engines, the ones an orbiter actually
    // manoeuvres with in space: the three main engines only ran during ascent,
    // fed by the external tank, so their bells stay dark.
    var SHIP_SCALE = 2.9;                    // hull length ≈ 4.7 overlay units
    this._loadModel('ship_shuttle', function (inst) {
      if (!inst) { proc.visible = true; return; }          // file missing: fly the stand-in
      var maxAniso = Math.min(4, self.renderer.capabilities.getMaxAnisotropy());
      var exits = [];
      inst.traverse(function (o) {
        if (o.isMesh && o.material && o.material.map) o.material.map.anisotropy = maxAniso;
        if (o.name === 'oms_exit_port' || o.name === 'oms_exit_stbd') exits.push(o);
      });
      var model = new THREE.Group();
      model.add(inst);
      model.scale.setScalar(SHIP_SCALE);
      model.position.y = 0.53;               // fuselage axis on the bank pivot (the fin makes the bounds top-heavy)
      bank.add(model);

      // Exhaust at each OMS exit plane. The marker's frame is the engine's
      // (inches, +X toward the nose): turn the plume's +Z to −X and undo the
      // model's scale so the geometry below keeps its overlay-unit size.
      var k = 0.36 / (SHIP_SCALE * inst.scale.x);
      var newFlames = [], newHalos = [];
      exits.forEach(function (marker) {
        var holder = new THREE.Group();
        holder.rotation.y = -Math.PI / 2;
        holder.scale.setScalar(k);
        marker.add(holder);
        var flame = new THREE.Mesh(flameGeo, new THREE.MeshBasicMaterial({
          color: self._col(0xbfe0ff), transparent: true, opacity: 0.4,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        }));
        holder.add(flame);
        newFlames.push(flame);
        var halo = new THREE.Sprite(new THREE.SpriteMaterial({
          map: self._glowTexture, color: self._col(0xcfe6ff),
          blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
        }));
        halo.position.set(0, 0, 0.1);
        holder.add(halo);
        newHalos.push(halo);
      });
      bank.remove(proc);
      sh.flames = newFlames; sh.halos = newHalos; sh.navs = [];
      sh.idleFlame = 0; sh.idleHalo = 0;     // a real engine is dark when it is not burning
    });
  }

  _drawShip(frame, dt) {
    if (!this._ship) this._buildShip();
    var sh = this._ship, s = frame.ship;
    sh.t += dt;

    sh.root.quaternion.set(s.rqx, s.rqy, s.rqz, s.rqw);
    // Bank into turns and lift the nose with pitch: pure cosmetics, eased
    var k = Math.min(1, dt * 6);
    var wantBank = Math.max(-0.6, Math.min(0.6, s.yaw * 0.38));
    var wantPitch = Math.max(-0.22, Math.min(0.22, s.pitch * 0.12));
    sh.bankZ += (wantBank - sh.bankZ) * k;
    sh.pitchX += (wantPitch - sh.pitchX) * k;
    sh.bank.rotation.set(sh.pitchX, 0, sh.bankZ);

    // Key light from the real Sun direction, expressed in camera space. It
    // dims with heliocentric distance but never to black (the hull would
    // vanish beyond Jupiter under a true inverse-square falloff).
    this._shipQ.copy(this.camera.quaternion).invert();
    var v = this._shipV.set(-s.x, -s.y, -s.z);
    var d = v.length() || 1;
    v.multiplyScalar(1 / d).applyQuaternion(this._shipQ);
    sh.sun.position.copy(v).multiplyScalar(10);
    sh.sun.intensity = 0.55 + 1.0 / (1 + 0.35 * Math.sqrt(d));

    // Engines follow the throttle (boost burns longer and brighter)
    var want = Math.min(1, Math.abs(s.throttle)) * (s.boost > 1 ? 1.6 : 1);
    sh.burn += (want - sh.burn) * Math.min(1, dt * 5);
    var flick = 0.92 + 0.08 * Math.sin(sh.t * 41) * Math.sin(sh.t * 17);
    for (var i = 0; i < sh.flames.length; i++) {
      sh.flames[i].scale.set(1, 1, Math.max(1e-4, sh.idleFlame + 1.7 * sh.burn * flick));
      sh.flames[i].material.opacity = 0.18 + 0.42 * Math.min(1, sh.burn);
      sh.halos[i].scale.setScalar(Math.max(1e-4, sh.idleHalo + 1.15 * sh.burn * flick));
      sh.halos[i].material.opacity = 0.35 + 0.5 * Math.min(1, sh.burn);
    }
    var blink = 0.55 + 0.45 * Math.max(0, Math.sin(sh.t * 2.4));
    for (var n = 0; n < sh.navs.length; n++) sh.navs[n].material.opacity = blink;
  }

  // Camera-relative projection in double precision (CSS px). Pilot-mode HUD
  // marks use this instead of _ws(): the target can be a few km away.
  _projectRel(x, y, z, out) {
    var v = this._shipV.set(x - this._camPos.x, y - this._camPos.y, z - this._camPos.z)
      .applyQuaternion(this._shipQ);
    var f = (this.H / 2) / Math.tan(FOV_DEG * Math.PI / 360);
    out.front = v.z < 0;
    out.cx = v.x; out.cy = v.y; out.depth = -v.z;
    if (out.front) {
      out.x = this.W / 2 + (v.x / -v.z) * f;
      out.y = this.H / 2 - (v.y / -v.z) * f;
    }
    out.f = f;
    return out;
  }

  _drawShipOverlay(frame, g) {
    var s = frame.ship, W = this.W, H = this.H, cx = W / 2, cy = H / 2;
    g.save();
    // Crosshair: where the nose points
    g.strokeStyle = 'rgba(200,215,255,0.55)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(cx - 14, cy); g.lineTo(cx - 5, cy);
    g.moveTo(cx + 5, cy);  g.lineTo(cx + 14, cy);
    g.moveTo(cx, cy - 14); g.lineTo(cx, cy - 5);
    g.moveTo(cx, cy + 5);  g.lineTo(cx, cy + 14);
    g.stroke();

    if (s.hasTarget) {
      var p = this._projectRel(s.tx, s.ty, s.tz, this._shipProj || (this._shipProj = {}));
      var col = s.auto ? 'rgba(111,180,255,' : 'rgba(79,143,255,';
      var pulse = s.auto ? 0.7 + 0.3 * Math.sin(this._ship.t * 5) : 0.9;
      g.strokeStyle = col + pulse + ')';
      g.fillStyle = col + '0.95)';
      g.lineWidth = 1.4;
      g.font = '10px "JetBrains Mono", monospace';
      var onScreen = p.front && p.x > 24 && p.x < W - 24 && p.y > 24 && p.y < H - 24;
      var rpx = p.front && p.depth > 0 ? p.f * s.tr / p.depth : 0;
      if (onScreen && rpx + 8 > Math.min(W, H) * 0.40) {
        // The body fills the view: brackets would only clutter it
      } else if (onScreen) {
        // Corner brackets hugging the body's apparent disc
        var b = Math.max(12, Math.min(Math.min(W, H) * 0.42, rpx + 8)), c = Math.max(5, b * 0.3);
        g.beginPath();
        for (var qx = -1; qx <= 1; qx += 2) for (var qy = -1; qy <= 1; qy += 2) {
          g.moveTo(p.x + qx * b, p.y + qy * (b - c));
          g.lineTo(p.x + qx * b, p.y + qy * b);
          g.lineTo(p.x + qx * (b - c), p.y + qy * b);
        }
        g.stroke();
        // Centred under the brackets: the map's own label already sits to the
        // right of the body, and the Sun / catalog asteroids have none
        // …unless that lands on the hull (lower middle of the view): then above
        g.textAlign = 'center';
        var below = p.y + b + 15;
        var onHull = below > H * 0.60 && Math.abs(p.x - W / 2) < W * 0.24;
        g.fillText(s.tName + ' · ' + s.tDist, p.x, onHull ? p.y - b - 9 : below);
      } else {
        // Off screen (or behind): arrow on a ring pointing the shortest turn
        var ax = p.cx, ay = p.cy, al = Math.hypot(ax, ay);
        if (al < 1e-12) { ax = 0; ay = -1; al = 1; }
        ax /= al; ay /= al;
        var R = Math.min(W, H) * 0.40;
        var px = cx + ax * R, py = cy - ay * R, ang = Math.atan2(-ay, ax);
        g.beginPath();
        g.moveTo(px + 9 * Math.cos(ang), py + 9 * Math.sin(ang));
        g.lineTo(px - 7 * Math.cos(ang - 0.6), py - 7 * Math.sin(ang - 0.6));
        g.lineTo(px - 7 * Math.cos(ang + 0.6), py - 7 * Math.sin(ang + 0.6));
        g.closePath();
        g.fill();
        g.textAlign = ax > 0.3 ? 'right' : ax < -0.3 ? 'left' : 'center';
        g.fillText(s.tName + ' · ' + s.tDist, px - ax * 16, py + ay * 16 + 3);
      }
    }
    g.restore();
  }

  /* ── Overlay (text, dashed lines, pulse rings) ─────────────────────────── */

  _drawOverlay(state, frame) {
    var g = this.octx;
    g.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    g.clearRect(0, 0, this.W, this.H);

    // Planet labels — _ws() returns null behind the camera: skip those
    if (state.showPlanets) {
      g.font = '10px "JetBrains Mono", monospace';
      for (var i = 0; i < this.planets.length; i++) {
        var f = frame.planets[i];
        if (!f.visible) continue;
        var p = this.planets[i];
        var sp = this._ws(f.x, f.y, 0);
        if (!sp) continue;
        g.fillStyle = PLANET_LABEL_COLOR[p.def.key] || 'rgba(200,215,255,0.9)';
        g.fillText(p.def.name, sp.x + p.def.r + 6, sp.y + 3);
      }
      // Moon labels — while the camera is inside a parent system and each
      // moon is clear of the parent's disc (labelOn from _drawMoons)
      g.save();
      g.font = '9px "JetBrains Mono", monospace';
      g.fillStyle = 'rgba(200,210,230,0.6)';
      for (var mid in this._moons) {
        var mm = this._moons[mid];
        if (!mm.group.visible || !mm.labelOn || !mm.screen) continue;
        g.fillText(mm.data.name, mm.screen.x + mm.screen.r + 5, mm.screen.y + 3);
      }
      g.restore();
    }

    // Dwarf planet + comet labels (screen positions cached by their draws)
    if (this._dwarfs || this._comets) {
      g.save();
      g.font = '10px "JetBrains Mono", monospace';
      var dl = this._dwarfs || [];
      g.fillStyle = 'rgba(196, 206, 182, 0.85)';     // cinza-esverdeado
      for (var di = 0; di < dl.length; di++) {
        var dd = dl[di];
        if (!dd.group.visible || !dd.screen) continue;
        g.fillText(dd.def.name, dd.screen.x + dd.screen.r + 5, dd.screen.y + 3);
      }
      var cl = this._comets || [];
      g.fillStyle = 'rgba(140, 214, 224, 0.85)';     // ciano
      for (var ci = 0; ci < cl.length; ci++) {
        var cc = cl[ci];
        if (!cc.group.visible || !cc.screen) continue;
        g.fillText(cc.def.short || cc.def.name, cc.screen.x + cc.screen.r + 5, cc.screen.y + 3);
      }
      g.restore();
    }

    this._drawConjunctions(state, frame, g);
    this._drawMagLabels(g);

    // Jupiter Δv vector
    var jv = frame.jup;
    if (jv && jv.active) {
      var a = this._ws(jv.ax, jv.ay, jv.az || 0), b = this._ws(jv.bx, jv.by, jv.bz || 0);
      if (a && b) {
        g.strokeStyle = 'rgba(255,107,43,0.75)';
        g.lineWidth = 1.2;
        g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
        var ang = Math.atan2(b.y - a.y, b.x - a.x);
        g.beginPath();
        g.moveTo(b.x, b.y); g.lineTo(b.x - 6 * Math.cos(ang - 0.4), b.y - 6 * Math.sin(ang - 0.4));
        g.moveTo(b.x, b.y); g.lineTo(b.x - 6 * Math.cos(ang + 0.4), b.y - 6 * Math.sin(ang + 0.4));
        g.stroke();
        g.fillStyle = 'rgba(255,107,43,0.9)';
        g.font = '10px "JetBrains Mono", monospace';
        g.fillText('+Δv', b.x + 4, b.y - 4);
      }
    }

    // Labels dos 47 NEOs — só no modo radar, não no focus. É um guard INLINE
    // (não um `return`): sair do método aqui também mataria os labels de
    // planeta/lua e os demais elementos do overlay no modo radar.
    // Pilot mode has no camera-target distance: label only the NEOs within
    // 2 AU of the ship instead (47 names at once would bury the view).
    var pilotLabels = !!(frame.ship && frame.ship.active);
    if (!frame.focusMode && frame.neos && (pilotLabels || frame.cam.dist < 15)) {
      g.save();
      for (var ni = 0; ni < this.neos.length; ni++) {
        // O selecionado/hover ganham label maior logo abaixo; o focado é
        // nomeado pelo HUD de foco — pular para não duplicar.
        if (ni === frame.selIdx || ni === frame.hovIdx || ni === frame.focusNeoIdx) continue;
        var nn = frame.neos[ni];
        if (pilotLabels && this._camDist(nn.x, nn.y, nn.z || 0) > 2) continue;
        var nsp = this._ws(nn.x, nn.y, nn.z || 0);
        if (!nsp) continue;
        if (nsp.x < 0 || nsp.x > this.W || nsp.y < 0 || nsp.y > this.H) continue;
        // Closer = bigger: 12px on top of the NEO, easing to 9px across the map
        var ndist = this._camDist(nn.x, nn.y, nn.z || 0);
        var fontSize = Math.max(9, Math.min(12, 12 - ndist * 1.2));
        g.font = fontSize + 'px "JetBrains Mono", monospace';
        g.fillStyle = 'rgba(200, 215, 255, 0.75)';
        g.globalAlpha = 0.75;
        g.fillText(this.neos[ni].def.name, nsp.x + 8, nsp.y - 6);
        g.globalAlpha = 1.0;
      }
      g.restore();
    }

    // Selected / hovered NEO labels
    g.fillStyle = 'rgba(240,244,255,0.85)';
    g.font = '11px "Space Grotesk", sans-serif';
    var labelIdx = [frame.selIdx, frame.hovIdx];
    for (var li = 0; li < labelIdx.length; li++) {
      var idx = labelIdx[li];
      if (idx < 0 || (li === 1 && idx === frame.selIdx)) continue;
      var nf = frame.neos[idx];
      var np = this._ws(nf.x, nf.y, nf.z);
      if (!np) continue;
      g.fillText(this.neos[idx].def.name, np.x + 8, np.y - 6);
    }

    // Promoted asteroid: dashed Earth line + LD label + pulsing ring
    var pr = frame.promoted;
    if (pr && pr.active) {
      var sa = this._ws(pr.x, pr.y, pr.z), se = this._ws(pr.ex, pr.ey, 0);
      if (sa && se) {
        g.save();
        g.setLineDash([3, 5]);
        g.strokeStyle = 'rgba(26,108,246,0.45)';
        g.lineWidth = 0.9;
        g.beginPath(); g.moveTo(sa.x, sa.y); g.lineTo(se.x, se.y); g.stroke();
        g.setLineDash([]);
        g.fillStyle = 'rgba(26,108,246,0.9)';
        g.font = '9px "JetBrains Mono", monospace';
        g.fillText(pr.distLD + ' LD', (sa.x + se.x) / 2 + 4, (sa.y + se.y) / 2 - 3);

        var pulse = 5 + Math.sin(state.simTime * 3) * 2;
        g.beginPath();
        g.arc(sa.x, sa.y, pulse + 7, 0, Math.PI * 2);
        g.strokeStyle = '#1a6cf6';
        g.lineWidth = 1.5;
        g.globalAlpha = 0.4 + 0.2 * Math.sin(state.simTime * 3);
        g.stroke();
        g.restore();
      }
    }

    // Hovered MPC asteroid highlight dot
    if (frame.hoverMPC) {
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.beginPath();
      g.arc(frame.hoverMPC.sx, frame.hoverMPC.sy, 3.5, 0, Math.PI * 2);
      g.fill();
    }
  }

  _drawConjunctions(state, frame, g) {
    var conjs = frame.conjs;
    if (!conjs || !conjs.length) return;
    g.save();
    for (var c = 0; c < conjs.length; c++) {
      var pts = conjs[c].pts;
      if (!pts || pts.length < 2) continue;
      var sp = [];
      for (var i = 0; i < pts.length; i++) {
        var s = this._ws(pts[i].x, pts[i].y, 0);
        if (s) sp.push(s);
      }
      if (sp.length < 2) continue;
      g.setLineDash([4, 6]);
      g.strokeStyle = 'rgba(255,255,255,0.3)';
      g.lineWidth = 0.8;
      for (var a = 0; a < sp.length; a++) {
        for (var b = a + 1; b < sp.length; b++) {
          g.beginPath(); g.moveTo(sp[a].x, sp[a].y); g.lineTo(sp[b].x, sp[b].y); g.stroke();
        }
      }
      g.setLineDash([]);
      var mx = 0, my = 0;
      for (var m = 0; m < sp.length; m++) { mx += sp[m].x; my += sp[m].y; }
      mx /= sp.length; my /= sp.length;
      g.fillStyle = 'rgba(255,255,255,0.55)';
      g.font = '9px "JetBrains Mono", monospace';
      g.textAlign = 'center';
      g.fillText('CONJUNCTION', mx, my - 8);
      g.textAlign = 'left';
    }
    g.restore();
  }

  /* ── Main render ───────────────────────────────────────────────────────── */

  /**
   * @param {object} state  the page's global state{} (toggles, simTime…)
   * @param {object} frame  flat per-frame data computed by the page:
   *   cam      {tx,ty,tz, dist, theta, phi}   — camera spherical state (page-owned)
   *   planets  [{x,y,visible,conj}]           aligned with opts.planets
   *   neos     [{x,y,z}], selIdx, hovIdx      aligned with opts.neos
   *   focusNeoIdx  index of the focused NEO (its risk sphere hides) | null
   *   focusMode    true while an object is focused
   *   focusPos     {x,y,z} of the focused object | null (currently unused here)
   *   (moons are computed renderer-side from the MOONS table + state.simTime)
   *   cone     {active, risky, count, upper:Float32Array(N·3), lower:Float32Array(N·3)}
   *   jup      {active, ax,ay,az, bx,by,bz}
   *   conjs    [{pts:[{x,y},…]}]
   *   mpcDirty boolean — MPC positions array was refreshed this frame
   *   hoverMPC {sx,sy} | null
   *   promoted {active, focused, x,y,z, ex,ey, distLD, radius} — focused:
   *            the mesh is the current focus target (full min-px floor)
   *
   * Focus mode is pure camera state on the page side — this file renders the
   * one and only scene every frame, whatever the camera is doing.
   */
  render(state, frame) {
    var now = performance.now();
    var dt = Math.min(0.1, (now - this._lastNow) / 1000);
    this._lastNow = now;

    var piloting = !!(frame.ship && frame.ship.active);
    this._updateCamera(frame.cam, frame.ship);
    this._drawSun();
    this._drawPlanets(state, frame, dt);
    this._drawMoons(state, frame);
    this._drawDwarfPlanets(state, frame, dt);
    this._drawComets(state, frame, dt);
    this._drawNEOs(state, frame);
    this._drawConeMesh(state, frame);
    this._drawMPCAsteroids(state, frame);
    this._drawPromotedObject(state, frame, dt);
    this._drawMagnetosphere(state, frame, dt);

    // Stars live at infinity: copy ONLY the rotation, never the translation
    this.starCamera.quaternion.copy(this.camera.quaternion);

    this.renderer.clear();
    this.renderer.render(this.starScene, this.starCamera);
    this.renderer.clearDepth();
    this.renderer.render(this.scene, this.camera);

    // Pilot mode: the ship is a third pass on a cleared depth buffer
    if (piloting) {
      this._drawShip(frame, dt);
      this.renderer.clearDepth();
      this.renderer.render(this._ship.scene, this._ship.cam);
    }

    this._drawOverlay(state, frame);
    if (piloting) this._drawShipOverlay(frame, this.octx);
  }
}

// Classic-script global (same convention as canvas2d.js)
if (typeof window !== 'undefined') {
  window.ThreeJSRenderer = ThreeJSRenderer;
  window.generateAsteroidGeometry = generateAsteroidGeometry;
  window.generateArchetypeGeometry = generateArchetypeGeometry;
  window.generateRockTexture = generateRockTexture;
}
