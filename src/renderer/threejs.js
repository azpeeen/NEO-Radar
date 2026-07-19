/* NEO Radar — ThreeJSRenderer (WebGL heliocentric view)
   Loaded as a classic <script> (served at /js/renderer3d.js) AFTER three.min.js.
   ZERO physics: no integrators, no Kepler solvers. The page (radar.ejs) solves
   all orbits and hands this class flat arrays of positions — this file only
   turns those arrays into pixels.

   Coordinate convention — must match the page's 2D projection ws() exactly:
       screen_x = W/2 + panX + x · pxPerAU · zoom
       screen_y = H/2 + panY + y · pxPerAU · zoom      (+y is DOWN on screen)
   Achieved with an OrthographicCamera placed BELOW the ecliptic plane:
       position (cx, cy, −CAM_DIST), up (0,−1,0), looking at (cx, cy, 0)
   That is a rigid rotation (not a reflection), so triangle winding and face
   culling stay correct while the on-screen orientation is identical to the
   old Canvas 2D view. Objects with MORE NEGATIVE z render ON TOP.

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

// z-layers: camera sits at −CAM_DIST, so more-negative z draws on top
var LAYER = {
  glow:      0.5,
  orbit:     0.35,
  cone:      0.3,
  mpc:       0.2,
  mc:        0.15,
  traj:      0.1,
  neo:      -0.1,
  planet:   -0.2,
  promoted: -0.25,
  sun:      -0.3,
};

var CAM_DIST = 100;

// Physical planet radii normalized to Earth = 1 (focus-mode relative scale)
var PLANET_REAL_RADIUS = {
  mercury: 0.383, venus:  0.949, earth:   1.000, mars:    0.532,
  jupiter: 11.21, saturn: 9.449, uranus:  4.007, neptune: 3.883,
};
var FOCUS_EARTH_RADIUS = 0.14;   // Earth = 0.14 scene units in focus mode

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

// Moon — visual-only circular orbit. MOON_PERIOD, MOON_A and MOON_PHASE0 are
// NOT declared here: the page (radar.ejs) declares them as top-level const —
// a classic script sharing the global scope — and every use below runs after
// the page script has evaluated. Redeclaring them here would throw
// "Identifier has already been declared" and kill the page script.
var MOON_RADIUS_RATIO = 0.273;                                 // Moon/Earth radii
var MOON_INCL   = 5.145 * Math.PI / 180;                       // vs ecliptic
// Presentation distance Earth↔Moon in focus mode, in Earth visual radii —
// real scale (60 R⊕) would push the Moon off-screen, glued (1 R⊕) reads wrong
var MOON_FOCUS_DIST_ER = 3.2;

function moonOrbitAngle(simTime) {
  return MOON_PHASE0 + (simTime / MOON_PERIOD) * Math.PI * 2;
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
    this.DPR = Math.max(1, window.devicePixelRatio || 1);

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
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 500);
    this.camera.up.set(0, -1, 0);

    // Lights: sun point light + ambient so night sides stay readable
    this._sunLight = new THREE.PointLight(0xffe0a0, 2.5, 50);
    this._sunLight.position.set(0, 0, LAYER.planet);
    this.scene.add(this._sunLight);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.45));

    this._glowTexture = this._makeGlowTexture();
    this._texLoader = new THREE.TextureLoader();

    this._buildStars();
    this._buildSun();
    this._buildPlanets();
    this._buildMoon();
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
    this._trajLine = null;
    this._mcPoints = null;

    // GLB shape-model loader + caches (optional — needs the GLTFLoader script)
    this._gltfLoader  = typeof THREE.GLTFLoader !== 'undefined' ? new THREE.GLTFLoader() : null;
    this._gltfCache   = {};
    this._gltfPending = {};
    this._rockMats    = {};

    // Focus mode (scene built lazily on first setFocusTarget)
    this._focus       = null;
    this._focusScene  = null;
    this._focusCamera = new THREE.PerspectiveCamera(50, this.W / Math.max(1, this.H), 0.002, 400);
    this._starDefaultQuat = this.starCamera.quaternion.clone();
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
    // Fixed background starfield — own scene + camera so pan/zoom never move it
    this.starScene = new THREE.Scene();
    this.starCamera = new THREE.PerspectiveCamera(60, this.W / Math.max(1, this.H), 1, 2000);
    this.starCamera.up.set(0, -1, 0);
    this.starCamera.lookAt(0, 0, 1);

    var N = 3000, R = 500;
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
    this.sun.position.set(0, 0, LAYER.sun);
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
    this.sunGlow.position.set(0, 0, LAYER.glow);
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
    line.position.z = LAYER.orbit;
    line.frustumCulled = false;
    return line;
  }

  _buildPlanets() {
    var self = this;
    this._sphereGeoHi = new THREE.SphereGeometry(1, 32, 16);
    this.planets = (this.opts.planets || []).map(function (def, i) {
      var group = new THREE.Group();
      group.visible = false;
      // Axial tilt: after the sphere pre-tilt below, the pole lies along the
      // ecliptic normal (z) — tipping it needs a rotation about an IN-PLANE
      // axis (x); rotating about z would just spin the pole in place.
      group.rotation.x = (AXIAL_TILT[def.key] || 0) * Math.PI / 180;
      self.scene.add(group);

      var isEarth = def.key === 'earth';
      var mat = new THREE.MeshStandardMaterial({
        color: self._col(def.color),
        roughness: 0.85,
        metalness: 0.0,
        emissive: isEarth ? self._col('#2255cc') : new THREE.Color(0x000000),
        emissiveIntensity: isEarth ? 0.15 : 0,
      });
      var sphere = new THREE.Mesh(self._sphereGeoHi, mat);
      // Align the equirectangular texture's poles with the ecliptic normal
      // (Euler XYZ: the sidereal spin set on rotation.y still turns the
      // texture about its own pole before this pre-tilt is applied)
      sphere.rotation.x = -Math.PI / 2;
      group.add(sphere);

      if (isEarth) {
        // Weak blue point light riding with Earth — lifts nearby asteroids.
        // Light range/intensity ignore the parent's scale; only position inherits.
        group.add(new THREE.PointLight(0x4488ff, 0.4, 8));
        // Atmosphere: back-face shell slightly larger than the globe reads as
        // a bright rim from every angle.
        var halo = new THREE.Mesh(
          new THREE.SphereGeometry(1.08, 32, 16),
          new THREE.MeshBasicMaterial({
            color: 0x224488,
            transparent: true,
            opacity: 0.18,
            side: THREE.BackSide,
            depthWrite: false,
          })
        );
        group.add(halo);
      }

      // Glow sprite (Earth/Jupiter always, any planet during a conjunction).
      // Group scale = r px in world units, so sprite scale is a constant ratio.
      var glowMat = new THREE.SpriteMaterial({
        map: self._glowTexture,
        color: self._col(def.color),
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
      });
      var glow = new THREE.Sprite(glowMat);
      glow.scale.setScalar(60 / def.r);
      glow.visible = !!def.glow;
      group.add(glow);

      var ring = null;
      if (def.ring) {
        // Tilted so the top-down view shows the same ellipse the 2D canvas drew
        var ringHolder = new THREE.Group();
        ringHolder.rotation.z = 0.3;
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
        ring.rotation.x = 1.318;                     // cos ≈ 0.25 → flattened ellipse
        ringHolder.add(ring);
        group.add(ringHolder);
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

  _buildMoon() {
    this._moonGeo = new THREE.SphereGeometry(1, 24, 16);
    this._moonMaterial = new THREE.MeshStandardMaterial({
      color: this._col('#a0a0a0'),                    // fallback until moon.jpg loads
      roughness: 0.95,
      metalness: 0.0,
    });
    this._moonMesh = new THREE.Mesh(this._moonGeo, this._moonMaterial);
    this._moonMesh.rotation.x = -Math.PI / 2;         // same pole alignment as planets
    this._moonMesh.visible = false;
    this.scene.add(this._moonMesh);

    // Geocentric orbit: unit circle scaled to MOON_A, re-centered on Earth per frame
    var N = 64, pts = new Float32Array(N * 3);
    for (var i = 0; i < N; i++) {
      var a = (i / N) * Math.PI * 2;
      pts[i * 3] = Math.cos(a);
      pts[i * 3 + 1] = Math.sin(a);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    this._moonOrbit = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({
      color: 0x888888,
      transparent: true,
      opacity: 0.15,
    }));
    this._moonOrbit.scale.setScalar(MOON_A);
    this._moonOrbit.frustumCulled = false;
    this._moonOrbit.visible = false;
    this.scene.add(this._moonOrbit);

    this._lunaState = null;                           // last frame.luna, for hit testing
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
    this._sphereGeoLo = new THREE.SphereGeometry(1, 16, 12);
    this.neos = (this.opts.neos || []).map(function (def) {
      var style = ORBIT_STYLE[def.risk] || ORBIT_STYLE.safe;
      var mesh = new THREE.Mesh(
        self._sphereGeoLo,
        new THREE.MeshBasicMaterial({ color: self._col(RISK_COLOR[def.risk] || '#f0f4ff') })
      );
      mesh.position.z = LAYER.neo;
      self.scene.add(mesh);

      var orbit = self._orbitLine(def.orbitPts, style.color, style.base);
      self.scene.add(orbit);

      return { def: def, mesh: mesh, orbit: orbit, style: style };
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
    this.cone.position.z = LAYER.cone;
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

    load('moon.jpg', function (tex) {
      self._moonMaterial.map = tex;
      self._moonMaterial.color.set(0xffffff);
      self._moonMaterial.needsUpdate = true;
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
          p.clouds = new THREE.Mesh(new THREE.SphereGeometry(1.035, 32, 16), mat);
          p.clouds.rotation.x = -Math.PI / 2;         // same pole alignment as the globe
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
    this.DPR = Math.max(1, window.devicePixelRatio || 1);

    this.renderer.setPixelRatio(this.DPR);
    this.renderer.setSize(this.W, this.H);

    this.overlay.width = this.W * this.DPR;
    this.overlay.height = this.H * this.DPR;
    this.overlay.style.width = this.W + 'px';
    this.overlay.style.height = this.H + 'px';

    this.starCamera.aspect = this.W / this.H;
    this.starCamera.updateProjectionMatrix();

    this._focusCamera.aspect = this.W / this.H;
    this._focusCamera.updateProjectionMatrix();

    this._starMaterial.size = 1.2 * this.DPR;
    if (this._mpcPoints) this._mpcPoints.material.size = 2 * this.DPR;
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
      size: 2 * this.DPR,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this._mpcPoints = new THREE.Points(geo, mat);
    this._mpcPoints.position.z = LAYER.mpc;
    this._mpcPoints.frustumCulled = false;
    this._mpcPoints.visible = false;
    this.scene.add(this._mpcPoints);
  }

  /** Create the 3D mesh for a clicked MPC asteroid — a real NASA shape model
   *  when the designation maps to a downloaded GLB, PBR procedural otherwise. */
  promote(designation, name) {
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
      this._trajLine.position.z = LAYER.traj;
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
      this._mcPoints.position.z = LAYER.mc;
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

  /* ── Focus mode ────────────────────────────────────────────────────────── */

  _ensureFocusScene() {
    if (this._focusScene) return;
    var sc = new THREE.Scene();

    this._focusSunLight = new THREE.DirectionalLight(0xfff1d6, 1.35);
    sc.add(this._focusSunLight);
    sc.add(this._focusSunLight.target);
    sc.add(new THREE.AmbientLight(0xffffff, 0.22));

    // Distant sun for scale reference — subdued so it never outshines the target
    this._focusSun = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), this._sunMaterial);
    sc.add(this._focusSun);
    this._focusSunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this._glowTexture,
      color: this._col('#ffcf8a'),
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    }));
    sc.add(this._focusSunGlow);

    // Orbit split into traversed (solid cobalt) + ahead (faint dashed)
    var CAP = 520;
    this._focusOrbitCap = CAP;
    function makeLine(mat) {
      var g = new THREE.BufferGeometry();
      var attr = new THREE.BufferAttribute(new Float32Array(CAP * 3), 3);
      attr.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('position', attr);
      var ln = new THREE.Line(g, mat);
      ln.frustumCulled = false;
      sc.add(ln);
      return ln;
    }
    this._focusOrbitSolid = makeLine(new THREE.LineBasicMaterial({
      color: this._col('#1a6cf6'), transparent: true, opacity: 0.9,
    }));
    this._focusOrbitDash = makeLine(new THREE.LineDashedMaterial({
      color: this._col('#6fb4ff'), transparent: true, opacity: 0.38,
      dashSize: 0.05, gapSize: 0.04,
    }));
    this._focusOrbitDashDirty = -1;

    // Soft glow marking the current position on the orbit (behind the target)
    this._focusMarker = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this._glowTexture,
      color: this._col('#6fb4ff'),
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    }));
    sc.add(this._focusMarker);

    this._focusScene = sc;
  }

  _buildFocusPlanet(index) {
    var p = this.planets[index];
    // wrapper (scaled, added to scene) → body (axial tilt) → spin (sphere+clouds)
    // The Moon hangs off the wrapper, NOT the tilted body: its orbit follows
    // the ecliptic (±5.1°), not Earth's 23.44° equatorial plane.
    var wrapper = new THREE.Group();
    var body = new THREE.Group();
    body.rotation.x = (AXIAL_TILT[p.def.key] || 0) * Math.PI / 180;
    wrapper.add(body);
    var spin = new THREE.Group();
    // Pre-tilt so the texture's poles align with ecliptic ±z, then spin about
    // the texture's own pole via rotation.y (Euler XYZ applies Y before X)
    var sphere = new THREE.Mesh(this._sphereGeoHi, p.sphere.material);
    sphere.rotation.x = -Math.PI / 2;
    spin.add(sphere);
    var clouds = null;
    if (p.clouds) {
      clouds = new THREE.Mesh(p.clouds.geometry, p.clouds.material);
      clouds.rotation.x = -Math.PI / 2;
      spin.add(clouds);
    }
    body.add(spin);
    var disposables = [];
    var moon = null;
    if (p.def.key === 'earth') {
      var haloGeo = new THREE.SphereGeometry(1.08, 32, 16);
      var haloMat = new THREE.MeshBasicMaterial({
        color: 0x224488, transparent: true, opacity: 0.18,
        side: THREE.BackSide, depthWrite: false,
      });
      body.add(new THREE.Mesh(haloGeo, haloMat));
      disposables.push(haloGeo, haloMat);

      // Moon at true relative size (0.273 R⊕), presentation orbit distance
      var moonHolder = new THREE.Group();
      moonHolder.rotation.x = MOON_INCL;             // slight z-depth on the orbit
      moon = new THREE.Mesh(this._moonGeo, this._moonMaterial);
      moon.rotation.x = -Math.PI / 2;
      moon.scale.setScalar(MOON_RADIUS_RATIO);
      moonHolder.add(moon);
      wrapper.add(moonHolder);
    }
    if (p.ring) {
      var ring = new THREE.Mesh(p.ring.geometry, p.ring.material);
      ring.rotation.x = 0.35;                        // slight tilt for depth
      body.add(ring);
    }
    return {
      obj: wrapper, spin: spin,
      sphereMesh: sphere, cloudsMesh: clouds, key: p.def.key, moon: moon,
      spinAxis: new THREE.Vector3(0, 0, 1), spinSpeed: 0,
      // Real relative scale, capped at 2× Earth (Earth=0.14, Jupiter=0.28)
      // so gas giants stay framable
      radius: Math.min((PLANET_REAL_RADIUS[p.def.key] || 1) * FOCUS_EARTH_RADIUS, 0.28),
      disposables: disposables, modelKey: null,
    };
  }

  /** Focus bundle for the Moon itself: real texture, tidally-locked spin, Earth
   *  companion at the same presentation distance used in Earth's focus view. */
  _buildFocusLuna() {
    var group = new THREE.Group();
    var spin = new THREE.Group();
    var sphere = new THREE.Mesh(this._moonGeo, this._moonMaterial);
    sphere.rotation.x = -Math.PI / 2;
    spin.add(sphere);
    group.add(spin);
    var earthP = this._earthIdx >= 0 ? this.planets[this._earthIdx] : null;
    var earth = null;
    if (earthP) {
      earth = new THREE.Mesh(this._sphereGeoHi, earthP.sphere.material);
      earth.rotation.x = -Math.PI / 2;
      earth.scale.setScalar(1 / MOON_RADIUS_RATIO);  // child units = Moon radii
      group.add(earth);
    }
    return {
      obj: group, spin: spin,
      sphereMesh: sphere, cloudsMesh: null, key: null, moon: null,
      earthCompanion: earth,
      spinAxis: new THREE.Vector3(0, 0, 1), spinSpeed: 0,
      radius: MOON_RADIUS_RATIO * FOCUS_EARTH_RADIUS,
      disposables: [], modelKey: null,
    };
  }

  /**
   * Enter focus on a target. desc arrives fully solved from the page:
   *   { kind:'planet'|'neo'|'mpc', index?, designation?, name?,
   *     orbitPts: Float32Array — closed heliocentric loop, ordered along motion }
   */
  setFocusTarget(desc) {
    this.clearFocusTarget();
    this._ensureFocusScene();

    var bundle, procMesh = null, spinRef = null;
    if (desc.kind === 'planet') {
      bundle = this._buildFocusPlanet(desc.index);
    } else if (desc.kind === 'luna') {
      bundle = this._buildFocusLuna();
      // Orbit shown is around EARTH, at the presentation distance: a circle
      // through the Moon (origin), centred on the Earth companion. Ordered
      // along motion (angle grows with time).
      var LP = MOON_FOCUS_DIST_ER * FOCUS_EARTH_RADIUS, SEG = 256;
      var lpts = new Float32Array(SEG * 3);
      for (var li = 0; li < SEG; li++) {
        var la = (li / SEG) * Math.PI * 2;
        lpts[li * 3] = LP * Math.cos(la);
        lpts[li * 3 + 1] = LP * Math.sin(la);
      }
      desc.orbitPts = lpts;
    } else {
      var seed = _hashString(String(desc.designation || desc.name || 'asteroid'));
      var geo  = generateArchetypeGeometry(seed, 3);
      procMesh = new THREE.Mesh(geo, this._getRockMaterial(seed));
      spinRef  = new THREE.Group();
      spinRef.add(procMesh);
      var group = new THREE.Group();
      group.add(spinRef);
      var rand = _mulberry32(seed ^ 0x51ed270b);
      var axis = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5);
      if (axis.lengthSq() < 1e-6) axis.set(0.4, 1, 0.3);
      bundle = {
        obj: group, spin: spinRef,
        spinAxis: axis.normalize(), spinSpeed: 0.15 + rand() * 0.25,
        radius: 0.11, disposables: [geo], modelKey: null,
      };
    }

    bundle.desc = desc;
    bundle.obj.scale.setScalar(bundle.radius);
    this._focusScene.add(bundle.obj);

    // Dash pattern proportional to orbit size so big orbits still read dashed
    var mR = 0;
    for (var q = 0; q < desc.orbitPts.length; q += 3) {
      var ax = Math.abs(desc.orbitPts[q]), ay = Math.abs(desc.orbitPts[q + 1]);
      if (ax > mR) mR = ax;
      if (ay > mR) mR = ay;
    }
    this._focusOrbitDash.material.dashSize = Math.max(0.03, mR * 0.02);
    this._focusOrbitDash.material.gapSize  = Math.max(0.022, mR * 0.015);
    this._focusOrbitDashDirty = -1;

    this._focus = bundle;

    // Swap in the NASA GLB when one exists for this designation. _focus is
    // already assigned, so a cache hit (synchronous cb) also lands correctly.
    if (desc.kind !== 'planet') {
      var key = _modelKeyFor(desc.designation, desc.name);
      if (key) {
        var self = this;
        this._loadModel(key, function (inst) {
          if (!inst || self._focus !== bundle) return;
          spinRef.remove(procMesh);
          spinRef.add(inst);
          bundle.modelKey = key;
          if (self.onModelApplied) self.onModelApplied('focus', key, MODEL_NOTICE[key]);
        });
      }
    }
  }

  clearFocusTarget() {
    if (!this._focus) return;
    this._focusScene.remove(this._focus.obj);
    var dis = this._focus.disposables || [];
    for (var i = 0; i < dis.length; i++) dis[i].dispose();
    this._focus = null;
    this.starCamera.quaternion.copy(this._starDefaultQuat);
  }

  /** Visual radius (scene units) of the current focus object — the page uses
   *  it to size the "did the double-click land on the body?" test. */
  getFocusObjectRadius() {
    return this._focus ? this._focus.radius : FOCUS_EARTH_RADIUS;
  }

  /** Screen position (CSS px) + apparent radius of the Moon while Earth is in
   *  focus, or null. Lets the page turn a click on the Moon into a re-focus. */
  getFocusMoonScreenPos() {
    var fb = this._focus;
    if (!fb || !fb.moon) return null;
    var v = new THREE.Vector3();
    fb.moon.getWorldPosition(v);
    var dist = v.distanceTo(this._focusCamera.position);
    v.project(this._focusCamera);
    if (v.z > 1) return null;                        // behind the camera
    var worldR = MOON_RADIUS_RATIO * fb.radius;
    var halfFov = this._focusCamera.fov * 0.5 * Math.PI / 180;
    return {
      x: (v.x * 0.5 + 0.5) * this.W,
      y: (-v.y * 0.5 + 0.5) * this.H,
      r: (worldR / (Math.max(1e-6, dist) * Math.tan(halfFov))) * (this.H / 2),
    };
  }

  _renderFocusMode(state, frame, dt) {
    var fb = this._focus;
    var f  = frame.focus;
    var x = f.x, y = f.y;
    var mA = moonOrbitAngle(state.simTime);

    // Rotation of the focused body: sidereal for planets, tidally locked for
    // the Moon (set absolutely — no drift), procedural tumble for asteroids
    if (fb.key && SIDEREAL_DAY[fb.key]) {
      var pAng = (Math.PI * 2 / SIDEREAL_DAY[fb.key]) * state.simTime;
      fb.sphereMesh.rotation.y = pAng;
      if (fb.cloudsMesh) fb.cloudsMesh.rotation.y = pAng * 1.006;
    } else if (fb.desc.kind === 'luna') {
      fb.sphereMesh.rotation.y = -mA;
    } else if (fb.spin) {
      fb.spin.rotateOnAxis(fb.spinAxis, fb.spinSpeed * dt);
    }

    // Earth focus: Moon orbits live at the presentation distance
    if (fb.moon) {
      fb.moon.position.set(
        MOON_FOCUS_DIST_ER * Math.cos(mA),
        MOON_FOCUS_DIST_ER * Math.sin(mA), 0);
      fb.moon.rotation.y = -mA;                      // tidally locked
    }
    // Moon focus: Earth companion sits opposite the Moon's orbital phase
    if (fb.earthCompanion) {
      var eD = MOON_FOCUS_DIST_ER / MOON_RADIUS_RATIO;   // child units = Moon radii
      fb.earthCompanion.position.set(-eD * Math.cos(mA), -eD * Math.sin(mA), 0);
      fb.earthCompanion.rotation.y = (Math.PI * 2 / SIDEREAL_DAY.earth) * state.simTime;
    }

    // Scene is target-centered. The sun sits along the real solar direction,
    // pulled in to ≤ 8 camera-radii so it never leaves the frustum (far=400),
    // with its disc rescaled to keep the subtended angle; brightness of the
    // corona rises as the target gets closer to the sun.
    var sd = Math.max(1e-6, Math.hypot(x, y));
    var R_SUN_AU = 0.00465;
    var sunSceneR = R_SUN_AU * f.camRadius / Math.max(0.01, sd);
    var sunDirX = -x / sd, sunDirY = -y / sd;
    var sunDist = Math.min(sd, f.camRadius * 8);
    var distScale = sunDist / Math.max(0.001, sd);
    this._focusSun.position.set(sunDirX * sunDist, sunDirY * sunDist, 0);
    this._focusSun.scale.setScalar(sunSceneR * distScale / 0.04);
    var glowR = sunSceneR * 4.5;
    this._focusSunGlow.position.set(sunDirX * sunDist, sunDirY * sunDist, 0);
    this._focusSunGlow.scale.set(glowR / 0.04, glowR / 0.04, 1);
    this._focusSunGlow.material.opacity = Math.min(0.8, 0.3 + 0.5 / Math.max(1, sd));
    // Key light from the sun's direction, lifted off the plane for modeling
    this._focusSunLight.position.set(-x / sd * 5, -y / sd * 5, -1.8);
    this._focusSunLight.target.position.set(0, 0, 0);

    // Split the orbit at the vertex nearest the current position:
    // trailing half solid (just traversed), leading half dashed (to come).
    // ox/oy = target position in the orbit's own frame — heliocentric for
    // sun-orbiting targets, presentation-geocentric for the Moon.
    var ox = x, oy = y;
    if (fb.desc.kind === 'luna') {
      var LP2 = MOON_FOCUS_DIST_ER * FOCUS_EARTH_RADIUS;
      ox = LP2 * Math.cos(mA); oy = LP2 * Math.sin(mA);
    }
    var pts = fb.desc.orbitPts;
    var N = Math.min((pts.length / 3) | 0, this._focusOrbitCap - 2);
    var best = 0, bd = Infinity, i, dx, dy;
    for (i = 0; i < N; i++) {
      dx = pts[i * 3] - ox; dy = pts[i * 3 + 1] - oy;
      var dd = dx * dx + dy * dy;
      if (dd < bd) { bd = dd; best = i; }
    }
    var half = N >> 1;
    var solidAttr = this._focusOrbitSolid.geometry.attributes.position;
    var dashAttr  = this._focusOrbitDash.geometry.attributes.position;
    var k, idx;
    for (k = 0; k <= half; k++) {
      idx = ((best - half + k) % N + N) % N;
      solidAttr.setXYZ(k, pts[idx * 3] - ox, pts[idx * 3 + 1] - oy, 0);
    }
    solidAttr.setXYZ(half + 1, 0, 0, 0);           // land exactly on the object
    this._focusOrbitSolid.geometry.setDrawRange(0, half + 2);
    solidAttr.needsUpdate = true;

    dashAttr.setXYZ(0, 0, 0, 0);
    for (k = 1; k <= half; k++) {
      idx = (best + k) % N;
      dashAttr.setXYZ(k, pts[idx * 3] - ox, pts[idx * 3 + 1] - oy, 0);
    }
    this._focusOrbitDash.geometry.setDrawRange(0, half + 1);
    dashAttr.needsUpdate = true;
    // Dash lengths are translation-invariant — recompute only when the split moves
    if (this._focusOrbitDashDirty !== best) {
      this._focusOrbitDash.computeLineDistances();
      this._focusOrbitDashDirty = best;
    }

    // Camera: spherical orbit around the target (z is the pole axis)
    var th = f.camTheta, ph = f.camPhi, r = f.camRadius;
    var sp = Math.sin(ph);
    this._focusCamera.position.set(
      r * sp * Math.cos(th),
      r * sp * Math.sin(th),
      -r * Math.cos(ph)
    );
    this._focusCamera.up.set(0, 0, -1);
    this._focusCamera.lookAt(0, 0, 0);

    this._focusMarker.scale.setScalar(Math.max(0.06, r * 0.28));

    // Stars: slightly brighter, and they follow the camera orientation
    this._starMaterial.opacity = 1.0;
    this._starMaterial.size = 1.6 * this.DPR;
    this.starCamera.quaternion.copy(this._focusCamera.quaternion);

    this.renderer.clear();
    this.renderer.render(this.starScene, this.starCamera);
    this.renderer.clearDepth();
    this.renderer.render(this._focusScene, this._focusCamera);

    // Overlay: nothing but the transition fade (HUD is HTML on the page)
    var g = this.octx;
    g.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    g.clearRect(0, 0, this.W, this.H);
    if (frame.focusFade > 0) {
      g.fillStyle = 'rgba(0,0,0,' + Math.min(1, frame.focusFade).toFixed(3) + ')';
      g.fillRect(0, 0, this.W, this.H);
    }
  }

  /* ── Per-frame update ──────────────────────────────────────────────────── */

  _updateCamera(state) {
    var s = state.pxPerAU * state.zoom;               // CSS px per AU
    this._s = s;
    var halfW = this.W / (2 * s), halfH = this.H / (2 * s);
    var cx = -state.panX / s, cy = -state.panY / s;
    this.camera.left = -halfW; this.camera.right = halfW;
    this.camera.top = halfH;   this.camera.bottom = -halfH;
    this.camera.position.set(cx, cy, -CAM_DIST);
    this.camera.lookAt(cx, cy, 0);
    this.camera.updateProjectionMatrix();
  }

  // Same projection as the page's ws() — screen coords in CSS px
  _ws(state, x, y) {
    return {
      x: this.W / 2 + state.panX + x * this._s,
      y: this.H / 2 + state.panY + y * this._s,
    };
  }

  _drawSun() {
    var R_SUN_AU = 0.00465;                           // real solar radius in AU
    var s = this._s;                                  // px per AU
    var sunPx = R_SUN_AU * s;                         // true on-screen radius
    var finalPx = Math.max(4, sunPx);                 // ≥ 4px so it stays visible
    // px → world units → scale of the r=0.04 base geometry
    this.sun.scale.setScalar(finalPx / s / 0.04);
    // Glow: 8× the real disc, but never under 80px on screen (sprite scale
    // is world size directly — no base-geometry divisor)
    var glowWorld = Math.max(80 / s, R_SUN_AU * 8);
    this.sunGlow.scale.set(glowWorld, glowWorld, 1);
  }

  _drawPlanets(state, frame, dt) {
    var s = this._s;
    var showOrbits = state.showPlanets && state.showOrbits;
    for (var i = 0; i < this.planets.length; i++) {
      var p = this.planets[i];
      var f = frame.planets[i];
      p.group.visible = f.visible;
      p.orbit.visible = showOrbits && !!(state.planetToggles && state.planetToggles[p.def.key]);
      if (!f.visible) continue;
      p.group.position.set(f.x, f.y, LAYER.planet);
      p.group.scale.setScalar(p.def.r / s);
      // Sidereal rotation — set absolutely from simTime (days) so variable
      // simulation speed never accumulates drift
      var angleRad = (Math.PI * 2 / SIDEREAL_DAY[p.def.key]) * state.simTime;
      p.sphere.rotation.y = angleRad;
      if (p.clouds) p.clouds.rotation.y = angleRad * 1.006;
      var conj = !!f.conj;
      p.glow.visible = !!p.def.glow || conj;
      p.glow.scale.setScalar(conj ? 10 : 60 / p.def.r);
      p.glow.material.opacity = conj ? 0.5 : 0.4;
    }
  }

  _drawMoon(state, frame) {
    var lf = frame.luna;
    var earth = this._earthIdx >= 0 ? frame.planets[this._earthIdx] : null;
    var visible = !!(lf && lf.visible && earth && earth.visible);
    this._lunaState = visible
      ? { x: lf.x, y: lf.y, ex: earth.x, ey: earth.y }
      : null;
    this._moonMesh.visible = visible;
    this._moonOrbit.visible = visible && !!state.showOrbits;
    if (!visible) return;
    var s = this._s;
    this._moonMesh.position.set(lf.x, lf.y, LAYER.planet);
    // ≥2px on screen, proportional to Earth's 4px disc (Moon ≈ 0.273 R⊕)
    this._moonMesh.scale.setScalar(Math.max(2, 4 * MOON_RADIUS_RATIO) / s);
    // Tidally locked: same face always toward Earth
    this._moonMesh.rotation.y = -moonOrbitAngle(state.simTime);
    this._moonOrbit.position.set(earth.x, earth.y, LAYER.orbit);
  }

  /** Screen position of the Moon in the main map, CSS px — used by the page
   *  for hover/click hit testing. sep = on-screen distance to Earth's centre
   *  so the page can skip the check while the Moon is buried in Earth's disc. */
  getLunaScreenPos(state) {
    var l = this._lunaState;
    if (!l || state.focusTarget) return null;
    var s = state.pxPerAU * state.zoom;
    var x = this.W / 2 + state.panX + l.x * s;
    var y = this.H / 2 + state.panY + l.y * s;
    var ex = this.W / 2 + state.panX + l.ex * s;
    var ey = this.H / 2 + state.panY + l.ey * s;
    return { x: x, y: y, r: 2, sep: Math.hypot(x - ex, y - ey) };
  }

  _drawNEOs(state, frame) {
    var s = this._s;
    for (var i = 0; i < this.neos.length; i++) {
      var n = this.neos[i];
      var f = frame.neos[i];
      var isSel = i === frame.selIdx, isHov = i === frame.hovIdx;
      n.mesh.position.set(f.x, f.y, LAYER.neo);
      n.mesh.scale.setScalar((isSel ? 4 : isHov ? 3.5 : 2.4) / s);
      n.orbit.material.opacity = isSel ? n.style.sel : n.style.base;
    }
    var sel = frame.selIdx >= 0 ? this.neos[frame.selIdx] : null;
    this._selWire.visible = !!sel;
    this._selLight.visible = !!sel;
    if (sel) {
      var f2 = frame.neos[frame.selIdx];
      var riskCol = this._col(RISK_COLOR[sel.def.risk] || '#f0f4ff');
      var pulse = 1.8 + 0.4 * Math.sin(state.simTime * 3);
      this._selWire.position.set(f2.x, f2.y, LAYER.neo);
      this._selWire.scale.setScalar((4 / s) * pulse);
      this._selWire.material.color.copy(riskCol);
      this._selLight.position.set(f2.x, f2.y, LAYER.neo);
      this._selLight.color.copy(riskCol);
    }
  }

  _drawConeMesh(frame) {
    var c = frame.cone;
    this.cone.visible = !!(c && c.active);
    if (!this.cone.visible) return;
    var N = Math.min(this._coneN, c.count);
    var pos = this.cone.geometry.attributes.position;
    var arr = pos.array;
    for (var k = 0; k < N; k++) {
      arr[k * 3] = c.upper[k * 2];
      arr[k * 3 + 1] = c.upper[k * 2 + 1];
      arr[k * 3 + 2] = 0;
      var o = (this._coneN + k) * 3;
      arr[o] = c.lower[k * 2];
      arr[o + 1] = c.lower[k * 2 + 1];
      arr[o + 2] = 0;
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
        // Artistic size: 0.03 AU, clamped to stay ≥ 8px on screen when zoomed out
        var scale = Math.max(0.03, 8 / this._s);
        this._promoMesh.position.set(pr.x, pr.y, LAYER.promoted);
        this._promoMesh.scale.setScalar(scale);
        this._promoMesh.rotateOnAxis(this._promoAxis, this._promoSpeed * dt);
      }
    }
    if (this._trajLine) this._trajLine.visible = active;
    if (this._mcPoints) this._mcPoints.visible = active;
  }

  /* ── Overlay (text, dashed lines, pulse rings) ─────────────────────────── */

  _drawOverlay(state, frame) {
    var g = this.octx;
    g.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    g.clearRect(0, 0, this.W, this.H);

    // Planet labels
    if (state.showPlanets) {
      g.fillStyle = 'rgba(200,210,230,0.65)';
      g.font = '10px "JetBrains Mono", monospace';
      for (var i = 0; i < this.planets.length; i++) {
        var f = frame.planets[i];
        if (!f.visible) continue;
        var p = this.planets[i];
        var sp = this._ws(state, f.x, f.y);
        g.fillText(p.def.name, sp.x + p.def.r + 6, sp.y + 3);
      }
    }

    this._drawConjunctions(state, frame, g);

    // Jupiter Δv vector
    var jv = frame.jup;
    if (jv && jv.active) {
      var a = this._ws(state, jv.ax, jv.ay), b = this._ws(state, jv.bx, jv.by);
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

    // Selected / hovered NEO labels
    g.fillStyle = 'rgba(240,244,255,0.85)';
    g.font = '11px "Space Grotesk", sans-serif';
    var labelIdx = [frame.selIdx, frame.hovIdx];
    for (var li = 0; li < labelIdx.length; li++) {
      var idx = labelIdx[li];
      if (idx < 0 || (li === 1 && idx === frame.selIdx)) continue;
      var nf = frame.neos[idx];
      var np = this._ws(state, nf.x, nf.y);
      g.fillText(this.neos[idx].def.name, np.x + 8, np.y - 6);
    }

    // Promoted asteroid: dashed Earth line + LD label + pulsing ring
    var pr = frame.promoted;
    if (pr && pr.active) {
      var sa = this._ws(state, pr.x, pr.y), se = this._ws(state, pr.ex, pr.ey);
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

    // Hovered MPC asteroid highlight dot
    if (frame.hoverMPC) {
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.beginPath();
      g.arc(frame.hoverMPC.sx, frame.hoverMPC.sy, 3.5, 0, Math.PI * 2);
      g.fill();
    }

    // Focus-mode transition: fade through black
    if (frame.focusFade > 0) {
      g.fillStyle = 'rgba(0,0,0,' + Math.min(1, frame.focusFade).toFixed(3) + ')';
      g.fillRect(0, 0, this.W, this.H);
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
      for (var i = 0; i < pts.length; i++) sp.push(this._ws(state, pts[i].x, pts[i].y));
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
   * @param {object} state  the page's global state{} (zoom, pan, toggles, simTime…)
   * @param {object} frame  flat per-frame data computed by the page:
   *   planets  [{x,y,visible,conj}]           aligned with opts.planets
   *   neos     [{x,y}], selIdx, hovIdx        aligned with opts.neos
   *   cone     {active, risky, count, upper:Float32Array, lower:Float32Array}
   *   jup      {active, ax,ay,bx,by}
   *   conjs    [{pts:[{x,y},…]}]
   *   mpcDirty boolean — MPC positions array was refreshed this frame
   *   hoverMPC {sx,sy} | null
   *   promoted {active, x,y, ex,ey, distLD}
   *   focus    {active, shown, x,y, camTheta, camPhi, camRadius} — focus mode
   *   focusFade number 0..1 — fade-to-black overlay while entering/leaving focus
   */
  render(state, frame) {
    var now = performance.now();
    var dt = Math.min(0.1, (now - this._lastNow) / 1000);
    this._lastNow = now;

    if (frame.focus && frame.focus.shown && this._focus) {
      this._renderFocusMode(state, frame, dt);
      return;
    }

    // Restore star defaults (focus mode brightens/reorients the field)
    this._starMaterial.opacity = 0.9;
    this._starMaterial.size = 1.2 * this.DPR;
    this.starCamera.quaternion.copy(this._starDefaultQuat);

    this._updateCamera(state);
    this._drawSun();
    this._drawPlanets(state, frame, dt);
    this._drawMoon(state, frame);
    this._drawNEOs(state, frame);
    this._drawConeMesh(frame);
    this._drawMPCAsteroids(state, frame);
    this._drawPromotedObject(state, frame, dt);

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
