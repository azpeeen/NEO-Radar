'use strict';

/**
 * downloadAsteroidModels.js — Fetch asteroid shape models (GLB) + PBR rock
 * textures for the renderer.
 *
 * Usage: node scripts/downloadAsteroidModels.js
 * Re-run safe: anything already on disk with a non-zero size is skipped.
 *
 * A) SHAPE MODELS → public/assets/models/<id>.glb
 *    Per asteroid the candidate URLs are tried in order:
 *      1. NASA VTAD GLBs (assets.science.nasa.gov — public domain)
 *      2. 3d-asteroids.space OBJs (public domain), converted OBJ → GLB.
 *         Conversion uses the obj2gltf library when installed; otherwise a
 *         built-in minimal converter (positions + smooth normals + indices)
 *         writes a spec-valid glTF 2.0 binary.
 *    Every download is validated (GLB magic bytes / OBJ "v " lines) so an
 *    HTML error page served with HTTP 200 never lands on disk. A model that
 *    fails ALL candidates is logged and skipped — the renderer falls back to
 *    the procedural archetype meshes automatically, nothing breaks.
 *
 * B) ROCK TEXTURES (CC0, AmbientCG) → public/assets/textures/rock/
 *    Four 2K PBR rock sets for visual variety; from each ZIP the *_Color.png,
 *    *_NormalGL.png and *_Roughness.png maps are extracted (built-in minimal
 *    ZIP reader — stored + deflate entries, no dependencies) and saved as
 *    <id>_albedo.png / <id>_normal.png / <id>_roughness.png. A set that fails
 *    is skipped — the renderer keeps its procedural rock material.
 *
 * Also fetches the three.js r128 GLTFLoader (examples/js) into public/js/
 * because the page CSP only allows scripts from 'self' + cdnjs, and cdnjs
 * does not host the examples/ tree.
 */

const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');

const OUT_MODELS = path.join(__dirname, '..', 'public', 'assets', 'models');
const OUT_ROCK   = path.join(__dirname, '..', 'public', 'assets', 'textures', 'rock');
const OUT_JS     = path.join(__dirname, '..', 'public', 'js');

// glb: tried first, saved as-is on success. obj: converted OBJ → GLB.
// NOTE (2026-07): 3d-asteroids.space / space.frieger.com sit behind a
// Cloudflare browser challenge — scripted fetches get an HTML page, which the
// OBJ validator rejects. The URLs stay listed in case the block is lifted.
const SHAPE_MODELS = [
  { id: 'apophis',
    glb: ['https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/a/Apophis_1_1.glb',
          'https://solarsystem.nasa.gov/system/resources/gltf_files/2367_Apophis.glb'],
    obj: ['https://3d-asteroids.space/data/asteroids/obj/99942.obj'] },
  { id: 'bennu',
    glb: ['https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/b/Bennu_1_1.glb',
          'https://science.nasa.gov/wp-content/uploads/2023/09/Bennu.glb'],
    obj: ['https://3d-asteroids.space/data/asteroids/obj/101955.obj'] },
  { id: 'eros',
    glb: ['https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/e/Eros_1_10.glb',
          'https://science.nasa.gov/wp-content/uploads/2023/09/Eros.glb'],
    obj: ['https://3d-asteroids.space/data/asteroids/obj/433.obj'] },
  { id: 'itokawa',
    glb: ['https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/i/Itokawa_1_1.glb',
          'https://science.nasa.gov/wp-content/uploads/2023/09/Itokawa.glb'],
    obj: ['https://3d-asteroids.space/data/asteroids/obj/25143.obj'] },
  { id: 'ryugu',
    glb: ['https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/r/Ryugu_1_1.glb',
          'https://science.nasa.gov/wp-content/uploads/2023/09/Ryugu.glb'],
    obj: ['https://3d-asteroids.space/data/asteroids/obj/162173.obj'] },
  { id: 'didymos',
    glb: ['https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/d/Didymos_1_1.glb'],
    obj: ['https://3d-asteroids.space/data/asteroids/obj/65803.obj'] },
  { id: 'toutatis',
    glb: ['https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/t/Toutatis_1_1.glb'],
    obj: ['https://3d-asteroids.space/data/asteroids/obj/4179.obj'] },
];

const ROCK_TEXTURES = [
  { id: 'rock_a', base: 'Rock020', file: 'Rock020_2K-PNG.zip' },
  { id: 'rock_b', base: 'Rock026', file: 'Rock026_2K-PNG.zip' },
  { id: 'rock_c', base: 'Rock029', file: 'Rock029_2K-PNG.zip' },
  { id: 'rock_d', base: 'Rock035', file: 'Rock035_2K-PNG.zip' },
];
const AMBIENTCG_BASE = 'https://ambientcg.com/get?file=';

// map inside the ZIP → output suffix on disk
const ROCK_MAPS = [
  { zipSuffix: '_Color.png',    out: '_albedo.png'    },
  { zipSuffix: '_NormalGL.png', out: '_normal.png'    },
  { zipSuffix: '_Roughness.png', out: '_roughness.png' },
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

/* ── HTTP ────────────────────────────────────────────────────────────────── */

function fetchBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (NEO-Radar asset fetch; node)' },
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
    }).on('error', reject);
  });
}

/* ── Content validators ──────────────────────────────────────────────────── */

function isGLB(buf) {
  // GLB magic: ASCII "glTF" — also accept JSON .gltf ({"asset"...)
  if (buf.length < 12) return false;
  if (buf.toString('ascii', 0, 4) === 'glTF') return true;
  const head = buf.toString('utf8', 0, 64).trimStart();
  return head.startsWith('{');
}

function isOBJ(buf) {
  // Real OBJs start listing vertices quickly; HTML challenge pages don't
  const head = buf.toString('utf8', 0, Math.min(buf.length, 4096));
  if (/<!doctype|<html/i.test(head)) return false;
  return /^v\s+-?\d/m.test(head);
}

/* ── OBJ → GLB ───────────────────────────────────────────────────────────── */

function parseOBJ(text) {
  const verts = [];
  const faces = [];
  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const c0 = line.charCodeAt(0);
    if (c0 === 118 /* v */ && line.charCodeAt(1) === 32) {
      const p = line.slice(2).trim().split(/\s+/);
      verts.push(+p[0], +p[1], +p[2]);
    } else if (c0 === 102 /* f */ && line.charCodeAt(1) === 32) {
      const toks = line.slice(2).trim().split(/\s+/);
      const idx = [];
      for (const tok of toks) {
        let v = parseInt(tok, 10);            // "12/34/56" → 12
        if (!Number.isFinite(v)) continue;
        idx.push(v < 0 ? verts.length / 3 + v : v - 1);
      }
      for (let k = 2; k < idx.length; k++) faces.push(idx[0], idx[k - 1], idx[k]);
    }
  }
  if (verts.length < 9 || faces.length < 3) throw new Error('OBJ has no mesh');
  return { positions: new Float32Array(verts), indices: new Uint32Array(faces) };
}

function computeSmoothNormals(pos, idx) {
  const nor = new Float32Array(pos.length);
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const abx = pos[b] - pos[a], aby = pos[b + 1] - pos[a + 1], abz = pos[b + 2] - pos[a + 2];
    const acx = pos[c] - pos[a], acy = pos[c + 1] - pos[a + 1], acz = pos[c + 2] - pos[a + 2];
    const nx = aby * acz - abz * acy;          // area-weighted face normal
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    nor[a] += nx; nor[a + 1] += ny; nor[a + 2] += nz;
    nor[b] += nx; nor[b + 1] += ny; nor[b + 2] += nz;
    nor[c] += nx; nor[c + 1] += ny; nor[c + 2] += nz;
  }
  for (let v = 0; v < nor.length; v += 3) {
    const l = Math.hypot(nor[v], nor[v + 1], nor[v + 2]) || 1;
    nor[v] /= l; nor[v + 1] /= l; nor[v + 2] /= l;
  }
  return nor;
}

// Minimal spec-valid glTF 2.0 binary: one mesh, POSITION + NORMAL + indices,
// flat gray-brown PBR material (radar OBJs carry no UVs, so no texture slot).
function buildGLB(positions, normals, indices) {
  const posBuf = Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength);
  const norBuf = Buffer.from(normals.buffer, normals.byteOffset, normals.byteLength);
  const idxBuf = Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength);
  const bin = Buffer.concat([posBuf, norBuf, idxBuf]);   // all 4-byte aligned

  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }

  const json = {
    asset: { version: '2.0', generator: 'NEO-Radar obj→glb' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0, mode: 4 }] }],
    materials: [{
      pbrMetallicRoughness: {
        baseColorFactor: [0.42, 0.38, 0.33, 1.0],
        metallicFactor: 0.04,
        roughnessFactor: 0.95,
      },
    }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5125, count: indices.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBuf.length, target: 34962 },
      { buffer: 0, byteOffset: posBuf.length, byteLength: norBuf.length, target: 34962 },
      { buffer: 0, byteOffset: posBuf.length + norBuf.length, byteLength: idxBuf.length, target: 34963 },
    ],
    buffers: [{ byteLength: bin.length }],
  };

  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  if (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(4 - (jsonBuf.length % 4), 0x20)]);
  let binBuf = bin;
  if (binBuf.length % 4) binBuf = Buffer.concat([binBuf, Buffer.alloc(4 - (binBuf.length % 4))]);

  const total = 12 + 8 + jsonBuf.length + 8 + binBuf.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0);              // "glTF"
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonBuf.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);             // "JSON"
  jsonBuf.copy(out, 20);
  out.writeUInt32LE(binBuf.length, 20 + jsonBuf.length);
  out.writeUInt32LE(0x004e4942, 24 + jsonBuf.length); // "BIN"
  binBuf.copy(out, 28 + jsonBuf.length);
  return out;
}

async function objToGLB(objBuffer) {
  // Prefer the real obj2gltf library when it is installed locally
  try {
    const obj2gltf = require('obj2gltf');
    const tmp = path.join(require('os').tmpdir(), `neo-radar-${Date.now()}.obj`);
    fs.writeFileSync(tmp, objBuffer);
    try {
      const glb = await obj2gltf(tmp, { binary: true });
      return Buffer.from(glb);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') throw e;
  }
  const { positions, indices } = parseOBJ(objBuffer.toString('utf8'));
  return buildGLB(positions, computeSmoothNormals(positions, indices), indices);
}

/* ── Minimal ZIP reader (stored + deflate) ───────────────────────────────── */

function zipEntries(buf) {
  // End Of Central Directory: scan the last 64 KB for the signature
  let eocd = -1;
  const start = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a ZIP (no EOCD)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central dir');
    const method   = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen  = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen   = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name     = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

function zipExtract(buf, entry) {
  if (buf.readUInt32LE(entry.localOff) !== 0x04034b50) throw new Error('bad local header');
  const nameLen  = buf.readUInt16LE(entry.localOff + 26);
  const extraLen = buf.readUInt16LE(entry.localOff + 28);
  const dataOff  = entry.localOff + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataOff, dataOff + entry.compSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`unsupported compression method ${entry.method}`);
}

/* ── Tasks ───────────────────────────────────────────────────────────────── */

async function fetchModel(m) {
  const dest = path.join(OUT_MODELS, `${m.id}.glb`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log(`↷ skip ${m.id}.glb (exists)`);
    return true;
  }
  for (const url of m.glb || []) {
    try {
      const buf = await fetchBuffer(url);
      if (!isGLB(buf)) throw new Error('invalid content (not a GLB)');
      fs.writeFileSync(dest, buf);
      console.log(`✓ ${m.id}.glb ← ${url} (${(buf.length / 1024).toFixed(0)} KB)`);
      return true;
    } catch (e) {
      console.warn(`  ✗ ${url}: ${e.message}`);
    }
  }
  for (const url of m.obj || []) {
    try {
      const buf = await fetchBuffer(url);
      if (!isOBJ(buf)) throw new Error('invalid content (not an OBJ)');
      const glb = await objToGLB(buf);
      if (!isGLB(glb)) throw new Error('conversion produced invalid GLB');
      fs.writeFileSync(dest, glb);
      console.log(`✓ ${m.id}.glb ← ${url} (OBJ→GLB, ${(glb.length / 1024).toFixed(0)} KB)`);
      return true;
    } catch (e) {
      console.warn(`  ✗ ${url}: ${e.message}`);
    }
  }
  return false;
}

async function fetchRockSet(spec) {
  const outs = ROCK_MAPS.map((mp) => path.join(OUT_ROCK, spec.id + mp.out));
  if (outs.every((p) => fs.existsSync(p) && fs.statSync(p).size > 0)) {
    console.log(`↷ skip ${spec.id} (exists)`);
    return true;
  }
  try {
    const zip = await fetchBuffer(AMBIENTCG_BASE + encodeURIComponent(spec.file));
    const entries = zipEntries(zip);
    for (let i = 0; i < ROCK_MAPS.length; i++) {
      const mp = ROCK_MAPS[i];
      const entry = entries.find((e) => e.name.endsWith(mp.zipSuffix));
      if (!entry) throw new Error(`no *${mp.zipSuffix} in ${spec.file}`);
      fs.writeFileSync(outs[i], zipExtract(zip, entry));
    }
    console.log(`✓ ${spec.id} ← ${spec.base} (${(zip.length / 1048576).toFixed(1)} MB zip → albedo/normal/roughness)`);
    return true;
  } catch (e) {
    console.warn(`  ✗ ${spec.id} (${spec.file}): ${e.message}`);
    // Half-written sets confuse the loader fallback — remove leftovers
    for (const p of outs) fs.rmSync(p, { force: true });
    return false;
  }
}

async function main() {
  fs.mkdirSync(OUT_MODELS, { recursive: true });
  fs.mkdirSync(OUT_ROCK, { recursive: true });
  fs.mkdirSync(OUT_JS, { recursive: true });

  const okModels = [], failedModels = [];
  console.log('── Asteroid shape models ──');
  for (const m of SHAPE_MODELS) {
    (await fetchModel(m) ? okModels : failedModels).push(m.id);
  }

  const okRocks = [], failedRocks = [];
  console.log('\n── PBR rock textures (AmbientCG, CC0) ──');
  for (const spec of ROCK_TEXTURES) {
    (await fetchRockSet(spec) ? okRocks : failedRocks).push(spec.id);
  }

  console.log('\n── GLTFLoader (three r128, classic script) ──');
  const loaderDest = path.join(OUT_JS, GLTF_LOADER.dest);
  let loaderOk = fs.existsSync(loaderDest) && fs.statSync(loaderDest).size > 0;
  if (loaderOk) {
    console.log(`↷ skip ${GLTF_LOADER.dest} (exists)`);
  } else {
    for (const url of GLTF_LOADER.urls) {
      try {
        const buf = await fetchBuffer(url);
        if (!buf.toString('utf8', 0, Math.min(buf.length, 4096)).includes('GLTFLoader')) {
          throw new Error('invalid content');
        }
        fs.writeFileSync(loaderDest, buf);
        console.log(`✓ ${GLTF_LOADER.dest} ← ${url}`);
        loaderOk = true;
        break;
      } catch (e) {
        console.warn(`  ✗ ${url}: ${e.message}`);
      }
    }
  }

  console.log('\n── Summary ──');
  console.log(`models ok:       ${okModels.join(', ') || '(none)'}`);
  console.log(`models failed:   ${failedModels.join(', ') || '(none)'} → procedural fallback`);
  console.log(`rock textures:   ${okRocks.join(', ') || '(none)'}`);
  console.log(`textures failed: ${failedRocks.join(', ') || '(none)'} → procedural rock material`);
  console.log(`GLTFLoader:      ${loaderOk ? 'ok' : 'FAILED → all asteroids use procedural meshes'}`);

  // Missing external assets are never fatal — renderer falls back automatically.
  process.exit(0);
}

main();
