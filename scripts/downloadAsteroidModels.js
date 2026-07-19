'use strict';

/**
 * downloadAsteroidModels.js — Fetch NASA asteroid shape models (glTF/GLB).
 * Sources: NASA Visualization Technology Applications and Development (VTAD),
 * science.nasa.gov 3D resources — public domain.
 *
 * Usage: node scripts/downloadAsteroidModels.js
 * Saves to public/assets/models/. Skips files that already exist with a
 * non-zero size, so it is safe to re-run.
 *
 * Every download is validated against the GLB magic bytes ("glTF") so an
 * HTML 404 page served with HTTP 200 never lands on disk as a fake model.
 * A model that fails ALL its candidate URLs is simply logged — the renderer
 * falls back to the procedural mesh automatically, nothing breaks.
 *
 * Also fetches the three.js r128 GLTFLoader (examples/js) into public/js/
 * because the page CSP only allows scripts from 'self' + cdnjs, and cdnjs
 * does not host the examples/ tree.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const OUT_MODELS = path.join(__dirname, '..', 'public', 'assets', 'models');
const OUT_JS     = path.join(__dirname, '..', 'public', 'js');

// Primary URL first, then variations tried in order on failure.
// Confirmed URLs live on assets.science.nasa.gov (VTAD models, Sep 2023 DAM
// migration); the wp-content/ and solarsystem.nasa.gov variants are legacy
// guesses kept as fallbacks in case the DAM paths move again.
const ASTEROID_MODELS = [
  {
    name: 'bennu',
    dest: 'bennu.glb',
    urls: [
      'https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/b/Bennu_1_1.glb',
      'https://science.nasa.gov/wp-content/uploads/2023/09/Bennu.glb',
      'https://solarsystem.nasa.gov/system/resources/gltf_files/2364_Bennu_v20_200k.glb',
    ],
  },
  {
    name: 'eros',
    dest: 'eros.glb',
    urls: [
      'https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/e/Eros_1_10.glb',
      'https://science.nasa.gov/wp-content/uploads/2023/09/Eros.glb',
      'https://solarsystem.nasa.gov/system/resources/gltf_files/2363_Eros.glb',
    ],
  },
  {
    name: 'itokawa',
    dest: 'itokawa.glb',
    urls: [
      'https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/i/Itokawa_1_1.glb',
      'https://science.nasa.gov/wp-content/uploads/2023/09/Itokawa.glb',
      'https://solarsystem.nasa.gov/system/resources/gltf_files/2365_Itokawa.glb',
    ],
  },
  {
    name: 'apophis',
    dest: 'apophis.glb',
    urls: [
      'https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/a/Apophis_1_1.glb',
      'https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/a/Apophis_1_10.glb',
      'https://science.nasa.gov/wp-content/uploads/2023/09/Apophis.glb',
      'https://solarsystem.nasa.gov/system/resources/gltf_files/2367_Apophis.glb',
    ],
  },
  // Extras present in src/data/catalog.js — best-effort, procedural fallback
  {
    name: 'ryugu',
    dest: 'ryugu.glb',
    urls: [
      'https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/r/Ryugu_1_1.glb',
      'https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/r/Ryugu_1_10.glb',
      'https://science.nasa.gov/wp-content/uploads/2023/09/Ryugu.glb',
    ],
  },
  {
    name: 'toutatis',
    dest: 'toutatis.glb',
    urls: [
      'https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/t/Toutatis_1_1.glb',
      'https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/t/Toutatis_1_10.glb',
      'https://science.nasa.gov/wp-content/uploads/2023/09/Toutatis.glb',
    ],
  },
];

// Classic-script GLTFLoader for three r128 (must match the three.min.js rev)
const GLTF_LOADER = {
  dest: 'GLTFLoader.js',
  urls: [
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js',
    'https://unpkg.com/three@0.128.0/examples/js/loaders/GLTFLoader.js',
    'https://raw.githubusercontent.com/mrdoob/three.js/r128/examples/js/loaders/GLTFLoader.js',
  ],
};

function fetchBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'NEO-Radar model fetch (node)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return resolve(fetchBuffer(next, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function isGLB(buf) {
  // GLB magic: ASCII "glTF" — also accept JSON .gltf ({"asset"...)
  if (buf.length < 12) return false;
  if (buf.toString('ascii', 0, 4) === 'glTF') return true;
  const head = buf.toString('utf8', 0, 64).trimStart();
  return head.startsWith('{');
}

async function fetchFirstValid(spec, destPath, validate) {
  for (const url of spec.urls) {
    try {
      const buf = await fetchBuffer(url);
      if (!validate(buf)) throw new Error('invalid content (not a model/script)');
      fs.writeFileSync(destPath, buf);
      console.log(`✓ ${path.basename(destPath)} ← ${url} (${(buf.length / 1024).toFixed(0)} KB)`);
      return true;
    } catch (e) {
      console.warn(`  ✗ ${url}: ${e.message}`);
    }
  }
  return false;
}

async function main() {
  fs.mkdirSync(OUT_MODELS, { recursive: true });
  fs.mkdirSync(OUT_JS, { recursive: true });

  const okModels = [], failedModels = [];

  console.log('── NASA asteroid shape models ──');
  for (const m of ASTEROID_MODELS) {
    const dest = path.join(OUT_MODELS, m.dest);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      console.log(`↷ skip ${m.dest} (exists)`);
      okModels.push(m.name);
      continue;
    }
    const ok = await fetchFirstValid(m, dest, isGLB);
    (ok ? okModels : failedModels).push(m.name);
  }

  console.log('\n── GLTFLoader (three r128, classic script) ──');
  const loaderDest = path.join(OUT_JS, GLTF_LOADER.dest);
  let loaderOk = fs.existsSync(loaderDest) && fs.statSync(loaderDest).size > 0;
  if (loaderOk) {
    console.log(`↷ skip ${GLTF_LOADER.dest} (exists)`);
  } else {
    loaderOk = await fetchFirstValid(GLTF_LOADER, loaderDest, (buf) =>
      buf.toString('utf8', 0, Math.min(buf.length, 4096)).includes('GLTFLoader'));
  }

  console.log('\n── Summary ──');
  console.log(`models ok:     ${okModels.join(', ') || '(none)'}`);
  console.log(`models failed: ${failedModels.join(', ') || '(none)'} → procedural fallback`);
  console.log(`GLTFLoader:    ${loaderOk ? 'ok' : 'FAILED → all asteroids use procedural meshes'}`);

  // Missing external assets are never fatal — renderer falls back automatically.
  process.exit(0);
}

main();
