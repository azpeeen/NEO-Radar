'use strict';

/**
 * downloadTextures.js — Fetch planet textures from Solar System Scope.
 * License: CC BY 4.0 — https://www.solarsystemscope.com/textures/
 *
 * Usage: node scripts/downloadTextures.js
 * Saves everything to public/assets/textures/. Skips files that already
 * exist with a non-zero size, so it is safe to re-run.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const BASE = 'https://www.solarsystemscope.com/textures/download/';
const OUT  = path.join(__dirname, '..', 'public', 'assets', 'textures');

const TEXTURES = {
  'sun.jpg':          '2k_sun.jpg',
  'mercury.jpg':      '2k_mercury.jpg',
  'venus.jpg':        '2k_venus_surface.jpg',
  'earth.jpg':        '2k_earth_daymap.jpg',
  'earth_clouds.jpg': '2k_earth_clouds.jpg',
  'mars.jpg':         '2k_mars.jpg',
  'jupiter.jpg':      '2k_jupiter.jpg',
  'saturn.jpg':       '2k_saturn.jpg',
  'saturn_ring.png':  '2k_saturn_ring_alpha.png',
  'uranus.jpg':       '2k_uranus.jpg',
  'neptune.jpg':      '2k_neptune.jpg',
  'moon.jpg':         '2k_moon.jpg',
  // Moons — most have no Solar System Scope map: a 404 is fine, the renderer
  // falls back to a flat color per moon.
  'phobos.jpg':       '2k_phobos.jpg',
  'deimos.jpg':       '2k_deimos.jpg',
  'io.jpg':           '2k_io.jpg',
  'europa.jpg':       '2k_europa.jpg',
  'ganymede.jpg':     '2k_ganymede.jpg',
  'callisto.jpg':     '2k_callisto.jpg',
  'mimas.jpg':        '2k_mimas.jpg',
  'enceladus.jpg':    '2k_enceladus.jpg',
  'tethys.jpg':       '2k_tethys.jpg',
  'dione.jpg':        '2k_dione.jpg',
  'rhea.jpg':         '2k_rhea.jpg',
  'titan.jpg':        '2k_titan.jpg',
  'iapetus.jpg':      '2k_iapetus.jpg',
  'miranda.jpg':      '2k_miranda.jpg',
  'ariel.jpg':        '2k_ariel.jpg',
  'umbriel.jpg':      '2k_umbriel.jpg',
  'titania.jpg':      '2k_titania.jpg',
  'oberon.jpg':       '2k_oberon.jpg',
  'triton.jpg':       '2k_triton.jpg',
};

function fetchFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'NEO-Radar texture fetch (node)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return resolve(fetchFile(next, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => out.close(() => {
        fs.renameSync(tmp, dest);
        resolve(fs.statSync(dest).size);
      }));
      out.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  let ok = 0, failed = 0;

  for (const [local, remote] of Object.entries(TEXTURES)) {
    const dest = path.join(OUT, local);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      console.log(`↷ skip ${local} (exists)`);
      ok++;
      continue;
    }
    try {
      const size = await fetchFile(BASE + remote, dest);
      console.log(`✓ ${local} (${(size / 1024).toFixed(0)} KB)`);
      ok++;
    } catch (e) {
      console.error(`✗ ${local}: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n${ok}/${Object.keys(TEXTURES).length} textures in ${OUT}`);
  // Missing textures are non-fatal: the renderer falls back to flat colors.
  process.exit(failed > 0 ? 1 : 0);
}

main();
