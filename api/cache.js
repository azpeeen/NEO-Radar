'use strict';

/**
 * cache.js — Ephemeris + API response cache.
 *
 * Uses better-sqlite3 when available (native, fast); falls back to a
 * JSON file store with the identical API surface so the rest of the
 * codebase never knows which backend is running.
 *
 * Schema mirrors the spec in NEO_RADAR_CONTEXT.md:
 *   spk_id       TEXT PRIMARY KEY
 *   data         TEXT    JSON-serialised payload
 *   content_hash TEXT    sha256(data) for change detection
 *   fetched_at   INTEGER unix seconds
 *   ttl          INTEGER seconds until expiry (default 50400 = 14 h)
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const CACHE_DIR   = path.join(__dirname, '..', '.cache');
const JSON_FILE   = path.join(CACHE_DIR, 'ephemeris.json');
const SQLITE_PATH = path.join(CACHE_DIR, 'ephemeris.db');
const TTL_DEFAULT = 14 * 60 * 60; // 14 h in seconds

// Ensure .cache/ exists
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

// ─── SQLite backend ──────────────────────────────────────────────────────────

let db = null;

function tryInitSQLite() {
  try {
    const Database = require('better-sqlite3');
    const instance = new Database(SQLITE_PATH);
    instance.exec(`
      CREATE TABLE IF NOT EXISTS cache (
        spk_id       TEXT    PRIMARY KEY,
        data         TEXT    NOT NULL,
        content_hash TEXT    NOT NULL,
        fetched_at   INTEGER NOT NULL,
        ttl          INTEGER NOT NULL DEFAULT ${TTL_DEFAULT}
      );
      CREATE INDEX IF NOT EXISTS idx_fetched ON cache(fetched_at);
    `);
    db = instance;
    return true;
  } catch (e) {
    // Native module unavailable — handled by JSON fallback below
    return false;
  }
}

const USE_SQLITE = tryInitSQLite();
if (!USE_SQLITE) {
  console.log('[cache] better-sqlite3 unavailable → JSON file store');
}

// ─── JSON fallback backend ───────────────────────────────────────────────────

function jsonLoad() {
  try { return JSON.parse(fs.readFileSync(JSON_FILE, 'utf8')); }
  catch { return {}; }
}

function jsonSave(store) {
  try { fs.writeFileSync(JSON_FILE, JSON.stringify(store), 'utf8'); }
  catch (e) { console.warn('[cache] jsonSave error:', e.message); }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Retrieve a cached entry by key. Returns null if missing or expired.
 * @param {string} spkId - cache key (SPK-ID, feed:date, etc.)
 * @returns {any|null}
 */
function get(spkId) {
  const now = Math.floor(Date.now() / 1000);

  if (USE_SQLITE) {
    const row = db.prepare('SELECT * FROM cache WHERE spk_id = ?').get(spkId);
    if (!row) return null;
    if (now > row.fetched_at + row.ttl) return null;
    try { return JSON.parse(row.data); } catch { return null; }
  }

  const store = jsonLoad();
  const entry = store[spkId];
  if (!entry) return null;
  if (now > entry.fetched_at + entry.ttl) return null;
  return entry.data;
}

/**
 * Store a value under the given key.
 * @param {string} spkId
 * @param {any}    data
 * @param {number} [ttl=TTL_DEFAULT] seconds
 */
function set(spkId, data, ttl = TTL_DEFAULT) {
  const json = JSON.stringify(data);
  const hash = sha256(json);
  const now  = Math.floor(Date.now() / 1000);

  if (USE_SQLITE) {
    db.prepare(`
      INSERT INTO cache (spk_id, data, content_hash, fetched_at, ttl)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(spk_id) DO UPDATE SET
        data         = excluded.data,
        content_hash = excluded.content_hash,
        fetched_at   = excluded.fetched_at,
        ttl          = excluded.ttl
    `).run(spkId, json, hash, now, ttl);
    return;
  }

  const store = jsonLoad();
  store[spkId] = { data, hash, fetched_at: now, ttl };
  jsonSave(store);
}

/** Force removal of a single entry. */
function invalidate(spkId) {
  if (USE_SQLITE) {
    db.prepare('DELETE FROM cache WHERE spk_id = ?').run(spkId);
    return;
  }
  const store = jsonLoad();
  delete store[spkId];
  jsonSave(store);
}

/** Remove all entries past their TTL. Called on startup. */
function cleanup() {
  const now = Math.floor(Date.now() / 1000);

  if (USE_SQLITE) {
    const res = db.prepare('DELETE FROM cache WHERE fetched_at + ttl < ?').run(now);
    if (res.changes > 0) {
      console.log(`[cache] cleanup: removed ${res.changes} expired entries`);
    }
    return;
  }

  const store = jsonLoad();
  let removed = 0;
  for (const key of Object.keys(store)) {
    if (now > store[key].fetched_at + store[key].ttl) {
      delete store[key]; removed++;
    }
  }
  if (removed > 0) {
    jsonSave(store);
    console.log(`[cache] cleanup: removed ${removed} expired entries`);
  }
}

/** Return counts for debugging / admin endpoints. */
function stats() {
  const now = Math.floor(Date.now() / 1000);

  if (USE_SQLITE) {
    const total   = db.prepare('SELECT COUNT(*) AS c FROM cache').get().c;
    const expired = db.prepare(
      'SELECT COUNT(*) AS c FROM cache WHERE fetched_at + ttl < ?'
    ).get(now).c;
    return { backend: 'sqlite', total, fresh: total - expired, expired };
  }

  const entries = Object.values(jsonLoad());
  const expired = entries.filter(e => now > e.fetched_at + e.ttl).length;
  return { backend: 'json', total: entries.length, fresh: entries.length - expired, expired };
}

// Purge stale entries on module load (async, non-blocking)
setImmediate(cleanup);

module.exports = { get, set, invalidate, cleanup, stats, TTL_DEFAULT };
