'use strict';

/**
 * downloadTextures.js — Fetch body textures into public/assets/textures/.
 *   • Planets + Sun + Earth's Moon: Solar System Scope, CC BY 4.0
 *     (BASE-relative filenames).
 *   • Other moons: planetpixelemporium.com maps (free for educational use),
 *     given as absolute URLs.
 *
 * Usage: node scripts/downloadTextures.js
 * Re-run safe: files already present with a non-zero size are skipped.
 *
 * Every download is validated by its magic bytes — a 404 page or ANY HTML
 * served with HTTP 200 (or a redirect that lands on a non-image) is rejected
 * and skipped, so a fake page never lands on disk as a .jpg. Missing moon
 * textures are non-fatal: _buildMoons() in threejs.js falls back to a flat
 * per-moon color, so the map still renders.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const BASE = 'https://www.solarsystemscope.com/textures/download/';
const OUT  = path.join(__dirname, '..', 'public', 'assets', 'textures');

// Planets + Sun + Earth's Moon — Solar System Scope (BASE + remote name)
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
};

// Moons — single-body images from Wikimedia Commons. Every URL below is the
// canonical file/thumb URL returned by the Commons API (imageinfo) for a real,
// existing file — verified 2026-07-21, not guessed. Mostly NASA/JPL public
// domain; two exceptions are flagged inline (credit them if displayed).
// Disc photos, not equirectangular maps, so they tile as a front-face texture
// (fine at map scale; _buildMoons() keeps its flat-color fallback for any miss).
//
// Note: upload.wikimedia.org rate-limits datacenter IPs (HTTP 429/400), so this
// may fail from CI/sandboxes but works from a normal machine. `url` is tried
// first, then `fallback` if present.
const MOON_TEXTURES = [
  // Mars
  { file: 'phobos.jpg',    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5c/Phobos_colour_2008.jpg/1280px-Phobos_colour_2008.jpg' },
  { file: 'deimos.jpg',    url: 'https://upload.wikimedia.org/wikipedia/commons/8/8d/Deimos-MRO.jpg' },
  // Jupiter (Galilean)
  { file: 'io.jpg',        url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7b/Io_highest_resolution_true_color.jpg/1280px-Io_highest_resolution_true_color.jpg' },
  { file: 'europa.jpg',    url: 'https://upload.wikimedia.org/wikipedia/commons/e/e4/Europa-moon-with-margins.jpg' },
  { file: 'ganymede.jpg',  url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/21/Ganymede_-_Perijove_34_Composite.png/1280px-Ganymede_-_Perijove_34_Composite.png' }, // CC BY 2.0 (credit)
  { file: 'callisto.jpg',  url: 'https://upload.wikimedia.org/wikipedia/commons/e/e9/Callisto.jpg' },
  // Saturn
  { file: 'mimas.jpg',     url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/bc/Mimas_Cassini.jpg/1280px-Mimas_Cassini.jpg' },
  { file: 'enceladus.jpg', url: 'https://upload.wikimedia.org/wikipedia/commons/9/95/Enceladus_from_Voyager.jpg' },
  { file: 'tethys.jpg',    url: 'https://upload.wikimedia.org/wikipedia/commons/b/bc/PIA18317-SaturnMoon-Tethys-Cassini-20150411.jpg' }, // CC BY (attribution)
  { file: 'dione.jpg',     url: 'https://upload.wikimedia.org/wikipedia/commons/4/42/Dione_in_natural_light.jpg' },
  { file: 'rhea.jpg',      url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/PIA07763_Rhea_full_globe5.jpg/1280px-PIA07763_Rhea_full_globe5.jpg' },
  { file: 'titan.jpg',     url: 'https://upload.wikimedia.org/wikipedia/commons/4/45/Titan_in_true_color.jpg' },
  { file: 'iapetus.jpg',   url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c9/Iapetus_as_seen_by_the_Cassini_probe_-_20071008.jpg/1280px-Iapetus_as_seen_by_the_Cassini_probe_-_20071008.jpg' },
  // Uranus
  { file: 'miranda.jpg',   url: 'https://upload.wikimedia.org/wikipedia/commons/e/e1/PIA18185_Miranda%27s_Icy_Face.jpg' },
  { file: 'ariel.jpg',     url: 'https://upload.wikimedia.org/wikipedia/commons/5/59/Ariel_%28moon%29.jpg' },
  { file: 'umbriel.jpg',   url: 'https://upload.wikimedia.org/wikipedia/commons/5/50/Umbriel_%28moon%29.jpg' },
  { file: 'titania.jpg',   url: 'https://upload.wikimedia.org/wikipedia/commons/5/50/Titania_%28moon%29_color.jpg' },
  { file: 'oberon.jpg',    url: 'https://upload.wikimedia.org/wikipedia/commons/0/09/Voyager_2_picture_of_Oberon.jpg' },
  // Neptune
  { file: 'triton.jpg',    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a6/Triton_moon_mosaic_Voyager_2_%28large%29.jpg/1280px-Triton_moon_mosaic_Voyager_2_%28large%29.jpg' },
];

function fetchBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, {
      // Some hosts reject requests with no/blank User-Agent
      headers: { 'User-Agent': 'NEO-Radar/1.0' },
    }, (res) => {
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
    });
    req.on('error', reject);
    // Fail fast on dead/unresponsive hosts instead of hanging the whole run
    req.setTimeout(12000, () => req.destroy(new Error('connection timeout (12s)')));
  });
}

// Magic-byte check — a 404/HTML page or non-image redirect target never
// passes, so it is skipped instead of being written out as a .jpg
function isImage(buf) {
  if (!buf || buf.length < 4) return false;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;           // JPEG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true; // PNG
  return false;
}

async function download(url, dest) {
  const buf = await fetchBuffer(url);
  if (!isImage(buf)) throw new Error('not an image (HTML/redirect or unknown content)');
  fs.writeFileSync(dest, buf);
  return buf.length;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const saved = [], failed = [];

  // file -> ordered candidate URLs. Planets: BASE-relative, one URL each.
  // Moons: primary `url` then optional `fallback`, both tried in order.
  const jobs = [
    ...Object.entries(TEXTURES).map(([file, remote]) => ({ file, urls: [BASE + remote] })),
    ...MOON_TEXTURES.map((m) => ({ file: m.file, urls: [m.url, m.fallback].filter(Boolean) })),
  ];

  const MIN_VALID_BYTES = 10 * 1024;   // < 10 KB = probably a saved HTML error page
  for (const job of jobs) {
    const dest = path.join(OUT, job.file);
    if (fs.existsSync(dest)) {
      const bytes = fs.statSync(dest).size;
      if (bytes >= MIN_VALID_BYTES) {
        console.log(`↷ skip ${job.file} (exists, ${(bytes / 1024).toFixed(0)} KB)`);
        saved.push(job.file);
        continue;
      }
      // Too small to be a real texture — a stale failure from an earlier run.
      // Fall through and re-download (overwrites it).
      console.log(`↻ retry ${job.file} (existing ${bytes} B < 10 KB, re-downloading)`);
    }
    let done = false;
    for (const url of job.urls) {
      try {
        const size = await download(url, dest);
        console.log(`✓ ${job.file} (${(size / 1024).toFixed(0)} KB) ← ${new URL(url).host}`);
        saved.push(job.file);
        done = true;
        break;
      } catch (e) {
        console.error(`  ✗ ${job.file} ← ${new URL(url).host}: ${e.message}`);
      }
    }
    if (!done) failed.push(job.file);
  }

  console.log(`\n── Summary ──`);
  console.log(`saved (${saved.length}/${jobs.length}): ${saved.join(', ') || '(none)'}`);
  console.log(`failed: ${failed.join(', ') || '(none)'} → flat-color fallback in _buildMoons()`);
  // Missing textures are non-fatal: the renderer falls back to flat colors.
  process.exit(failed.length > 0 ? 1 : 0);
}

main();
