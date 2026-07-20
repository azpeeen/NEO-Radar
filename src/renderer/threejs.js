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

function generateAsteroidGeometry(seed, detail) {
  var rand    = _mulberry32(seed);
  var noise3D = _makeSimplex3D(rand);
  var geo     = new THREE.IcosahedronGeometry(1, detail == null ? 2 : detail);
  var pos     = geo.attributes.position;
  var v       = new THREE.Vector3();
  var FREQ    = 1.7;
  // Non-indexed geometry: duplicated verts share the same position, and the
  // displacement is a pure function of position — so seams stay watertight.
  for (var i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    var n = noise3D(v.x * FREQ, v.y * FREQ, v.z * FREQ);
    var r = 1 + (n * 0.35 + 0.1);
    pos.setXYZ(i, v.x * r, v.y * r, v.z * r);
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
  '4179':   'toutatis',  // Toutatis
};

// #repr-notice text when a real NASA shape model is on screen
var MODEL_NOTICE = {
  apophis:  'NASA SHAPE MODEL · RADAR OBSERVATION DATA',
  bennu:    'NASA SHAPE MODEL · OSIRIS-REX DATA · 2019',
  eros:     'NASA SHAPE MODEL · NEAR SHOEMAKER DATA · 2000',
  itokawa:  'NASA SHAPE MODEL · HAYABUSA DATA · 2005',
  ryugu:    'NASA SHAPE MODEL · HAYABUSA2 DATA · 2018',
  toutatis: 'NASA SHAPE MODEL · RADAR OBSERVATION DATA',
};

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
    this.renderer.setClearColor(0x000000, 0);
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
    this._vpMat = new THREE.Matrix4();
    // Shared view-projection matrix (column-major) — the page's ws() reads it
    this._vpArray = new Float32Array(16);
    this._wpp1 = 1;   // world units per pixel at distance 1 (set per frame)

    // Lights: sun point light + ambient so night sides stay readable
    this._sunLight = new THREE.PointLight(0xffe0a0, 2.5, 50);
    this._sunLight.position.set(0, 0, 0);
    this.scene.add(this._sunLight);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.45));

    this._glowTexture = this._makeGlowTexture();
    this._texLoader = new THREE.TextureLoader();

    this._buildStars();
    this._buildSun();
    this._buildPlanets();
    this._buildMoons();
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
        // Light range/intensity ignore the parent's scale; only position inherits.
        group.add(new THREE.PointLight(0x4488ff, 0.8, 15));
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
      var seed = _hashString(String(def.id || def.name || 'neo'));
      var geo = generateAsteroidGeometry(seed);
      var group = new THREE.Group();
      var rock = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: self._col('#8f8578'),
        roughness: 0.9,
        metalness: 0.0,
        flatShading: true,
      }));
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
    if (key) {
      var self = this;
      this._loadModel(key, function (inst) {
        if (!inst || self._promoMesh !== group) return;   // failed or stale
        group.remove(mesh);
        group.add(inst);
        self._promoModelKey = key;
        if (self.onModelApplied) self.onModelApplied('promoted', key, MODEL_NOTICE[key]);
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

  /* ── Per-frame update ──────────────────────────────────────────────────── */

  /** Position the camera from the page-owned spherical state (frame.cam) and
   *  refresh the shared view-projection matrix the page's ws() reads. */
  _updateCamera(cam) {
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
      var wpp = this._wpp1 * this._camDist(mx, my, mz);
      var r = Math.max(m.data.r, 1.5 * wpp);
      m.group.scale.setScalar(r);

      // Tidally locked: the same face keeps pointing at the parent.
      // Math.PI − angle turns the texture near side toward the planet.
      if (m.data.tidal) m.mesh.rotation.y = Math.PI - lp.angle;

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
    this.cone.visible = !!(c && c.active && !state.focusTarget);
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
        var wpp = this._wpp1 * this._camDist(pr.x, pr.y, pr.z);
        var minPx = pr.focused ? PROMO_MIN_PX : 8;
        var scale = Math.max(pr.radius || 0, minPx * wpp);
        this._promoMesh.position.set(pr.x, pr.y, pr.z);
        this._promoMesh.scale.setScalar(scale);
        this._promoMesh.rotateOnAxis(this._promoAxis, this._promoSpeed * dt);
      }
    }
    if (this._promoOrbit) this._promoOrbit.visible = active;
    if (this._trajLine) this._trajLine.visible = active;
    if (this._mcPoints) this._mcPoints.visible = active;
  }

  /* ── Overlay (text, dashed lines, pulse rings) ─────────────────────────── */

  _drawOverlay(state, frame) {
    var g = this.octx;
    g.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    g.clearRect(0, 0, this.W, this.H);

    // Planet labels — _ws() returns null behind the camera: skip those
    if (state.showPlanets) {
      g.fillStyle = 'rgba(200,210,230,0.65)';
      g.font = '10px "JetBrains Mono", monospace';
      for (var i = 0; i < this.planets.length; i++) {
        var f = frame.planets[i];
        if (!f.visible) continue;
        var p = this.planets[i];
        var sp = this._ws(f.x, f.y, 0);
        if (!sp) continue;
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

    this._drawConjunctions(state, frame, g);

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

    this._updateCamera(frame.cam);
    this._drawSun();
    this._drawPlanets(state, frame, dt);
    this._drawMoons(state, frame);
    this._drawNEOs(state, frame);
    this._drawConeMesh(state, frame);
    this._drawMPCAsteroids(state, frame);
    this._drawPromotedObject(state, frame, dt);

    // Stars live at infinity: copy ONLY the rotation, never the translation
    this.starCamera.quaternion.copy(this.camera.quaternion);

    this.renderer.clear();
    this.renderer.render(this.starScene, this.starCamera);
    this.renderer.clearDepth();
    this.renderer.render(this.scene, this.camera);

    this._drawOverlay(state, frame);
  }
}

// Classic-script global (same convention as canvas2d.js)
if (typeof window !== 'undefined') {
  window.ThreeJSRenderer = ThreeJSRenderer;
  window.generateAsteroidGeometry = generateAsteroidGeometry;
  window.generateArchetypeGeometry = generateArchetypeGeometry;
  window.generateRockTexture = generateRockTexture;
}
