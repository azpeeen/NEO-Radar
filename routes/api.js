'use strict';

const { Router } = require('express');
const path = require('path');
const fs   = require('fs');
const https = require('https');

const CACHE_DIR = path.join(__dirname, '..', '.cache');
const JSON_PATH = path.join(CACHE_DIR, 'asteroids_mpc.json');
const DB_PATH   = path.join(CACHE_DIR, 'asteroids_mpc.db');

// Lazy-loaded physics modules (loaded once on first use)
let _deriveAll    = null;
let _promoteAst   = null;

function getDeriveAll() {
  if (!_deriveAll) _deriveAll = require('../src/physics/derive').deriveAll;
  return _deriveAll;
}
function getPromote() {
  if (!_promoteAst) _promoteAst = require('../src/physics/promote').promoteAsteroid;
  return _promoteAst;
}

// ── Backend selection (lazy, cached) ─────────────────────────────────────────

let _sqliteDB  = null;
let _jsonData  = null;

function tryGetSQLite() {
  if (_sqliteDB) return _sqliteDB;
  try {
    if (!fs.existsSync(DB_PATH)) return null;
    const Database = require('better-sqlite3');
    _sqliteDB = new Database(DB_PATH, { readonly: true });
    return _sqliteDB;
  } catch {
    return null;
  }
}

function tryGetJSON() {
  if (_jsonData) return _jsonData;
  try {
    if (!fs.existsSync(JSON_PATH)) return null;
    _jsonData = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
    return _jsonData;
  } catch {
    return null;
  }
}

/**
 * Find a single asteroid by designation (case-insensitive).
 * Checks both the `designation` and `name` fields.
 */
function findByDesignation(desig) {
  const db = tryGetSQLite();
  if (db) {
    const row = db.prepare(
      `SELECT designation, name, H, a, e, i, M, w, node, epoch_jd
       FROM asteroids_mpc
       WHERE designation = ? OR name = ?
       LIMIT 1`
    ).get(desig, desig);
    return row || null;
  }
  const all = tryGetJSON();
  if (!all) return null;
  const d = desig.toLowerCase();
  return all.find(a => a.designation.toLowerCase() === d || (a.name || '').toLowerCase() === d) || null;
}

/**
 * Convert an MPC designation or name to the best JPL SBDB query string.
 * Numbered asteroids: "(433) Eros" or "00433" → "433"
 * Provisional: "1998 FL5" → "1998 FL5"
 */
function toJPLQuery(ast) {
  if (!ast) return '';
  // Name field: "(433) Eros" → "433"
  if (ast.name) {
    const m = ast.name.match(/^\((\d+)\)/);
    if (m) return m[1];
    // Plain provisional: "1998 FL5"
    if (/^\d{4}/.test(ast.name)) return ast.name;
  }
  // Designation: "00433" → "433"
  if (/^\d+$/.test(ast.designation)) {
    return String(parseInt(ast.designation, 10));
  }
  return ast.designation;
}

// ── JPL Small-Body Database enrichment (server-side, cached) ─────────────────

const _jplCache = new Map(); // designation → { data, ts }
const JPL_TTL   = 7 * 24 * 3600 * 1000; // 7 days in ms

/**
 * Fetch physical parameters from JPL SBDB API.
 * Returns null on any error (graceful degradation).
 */
function fetchJPL(designation) {
  return new Promise((resolve) => {
    const cached = _jplCache.get(designation);
    if (cached && (Date.now() - cached.ts < JPL_TTL)) {
      return resolve(cached.data);
    }

    const query  = encodeURIComponent(designation);
    const url    = `https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=${query}&phys-par=true&discovery=true`;

    const req = https.get(url, { timeout: 6000 }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.code || json.message) { resolve(null); return; }

          // Extract discovery data
          const disc = json.discovery || {};
          // Extract physical parameters
          const phys = {};
          if (Array.isArray(json['phys-par'])) {
            for (const p of json['phys-par']) {
              phys[p.name] = { value: p.value, sigma: p.sigma, units: p.units };
            }
          }

          const data = {
            // Discovery
            discovery_date:  disc.date || null,
            discoverer:      disc.who  || null,
            observatory:     disc.location || null,
            // Physical
            albedo:          phys['pv']  ? parseFloat(phys['pv'].value)  : null,
            rotation_h:      phys['rot'] ? parseFloat(phys['rot'].value) : null,
            spectral_class:  phys['spec_T'] ? phys['spec_T'].value : (phys['spec_B'] ? phys['spec_B'].value : null),
            // Observational arc
            n_obs:           json.orbit ? (json.orbit.n_obs || null) : null,
            arc_years:       json.orbit ? (json.orbit.data_arc || null) : null,
            // Direct link
            jpl_url: `https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html#/?sstr=${query}`,
          };

          _jplCache.set(designation, { data, ts: Date.now() });
          resolve(data);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error',   () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ── Router ────────────────────────────────────────────────────────────────────

const router = Router();

// ── GET /api/asteroids/bulk ───────────────────────────────────────────────────
// Query params: limit (default 2000, max 50000), offset, min_a, max_a, max_H
router.get('/asteroids/bulk', (req, res) => {
  const limit  = Math.min(50000, Math.max(1, parseInt(req.query.limit,  10) || 2000));
  const offset = Math.max(0,               parseInt(req.query.offset, 10) || 0);

  const min_a = req.query.min_a != null ? parseFloat(req.query.min_a) : null;
  const max_a = req.query.max_a != null ? parseFloat(req.query.max_a) : null;
  const max_H = req.query.max_H != null ? parseFloat(req.query.max_H) : null;

  // ── SQLite path ────────────────────────────────────────────────────────────
  const db = tryGetSQLite();
  if (db) {
    const conditions   = [];
    const filterParams = [];
    if (min_a !== null && !isNaN(min_a)) { conditions.push('a >= ?');  filterParams.push(min_a); }
    if (max_a !== null && !isNaN(max_a)) { conditions.push('a <= ?');  filterParams.push(max_a); }
    if (max_H !== null && !isNaN(max_H)) { conditions.push('H <= ?'); filterParams.push(max_H); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    try {
      const total     = db.prepare(`SELECT COUNT(*) AS c FROM asteroids_mpc ${where}`).get(...filterParams).c;
      const asteroids = db.prepare(
        `SELECT designation, name, H, a, e, i, M, w, node, epoch_jd
         FROM asteroids_mpc ${where} LIMIT ? OFFSET ?`
      ).all(...filterParams, limit, offset);
      return res.json({ total, returned: asteroids.length, asteroids });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── JSON path ──────────────────────────────────────────────────────────────
  const all = tryGetJSON();
  if (!all) {
    return res.json({ total: 0, returned: 0, asteroids: [] });
  }

  let filtered = all;
  if (min_a !== null && !isNaN(min_a)) filtered = filtered.filter(a => a.a >= min_a);
  if (max_a !== null && !isNaN(max_a)) filtered = filtered.filter(a => a.a <= max_a);
  if (max_H !== null && !isNaN(max_H)) filtered = filtered.filter(a => a.H <= max_H);

  const total     = filtered.length;
  const asteroids = filtered.slice(offset, offset + limit);
  return res.json({ total, returned: asteroids.length, asteroids });
});

// ── GET /api/asteroid/:designation ───────────────────────────────────────────
// Returns derived physical data + optional JPL enrichment.
// The heavy MOID computation runs server-side so the browser gets instant data.
router.get('/asteroid/:designation', async (req, res) => {
  const desig = req.params.designation;
  const ast   = findByDesignation(desig);
  if (!ast) {
    return res.status(404).json({ error: `Asteroid "${desig}" not found in catalog` });
  }

  let derived;
  try {
    derived = getDeriveAll()(ast);
  } catch (err) {
    return res.status(500).json({ error: `derive: ${err.message}` });
  }

  // JPL enrichment (non-blocking; returns null on failure)
  let jpl = null;
  try {
    jpl = await fetchJPL(toJPLQuery(ast));
  } catch { /* ignore */ }

  const jplQuery = encodeURIComponent(toJPLQuery(ast));
  if (!jpl) {
    jpl = { jpl_url: `https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html#/?sstr=${jplQuery}` };
  }

  return res.json({ designation: ast.designation, name: ast.name, elements: ast, derived, jpl });
});

// ── GET /api/asteroid/:designation/trajectory ─────────────────────────────────
// Runs full RK4 N-body promotion with Monte Carlo uncertainty.
// Query param: jd (current Julian Date, required)
router.get('/asteroid/:designation/trajectory', (req, res) => {
  const desig = req.params.designation;
  const jd    = parseFloat(req.query.jd);

  if (!isFinite(jd)) {
    return res.status(400).json({ error: 'Missing or invalid ?jd= parameter' });
  }

  const ast = findByDesignation(desig);
  if (!ast) {
    return res.status(404).json({ error: `Asteroid "${desig}" not found` });
  }

  let result;
  try {
    result = getPromote()(ast, jd, {
      backYears: 2,
      fwdYears:  5,
      outputDt:  1,    // 1-day output cadence
      N_MC:      64,
    });
  } catch (err) {
    return res.status(500).json({ error: `promote: ${err.message}` });
  }

  return res.json(result);
});

module.exports = router;
