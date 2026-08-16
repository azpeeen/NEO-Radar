'use strict';

/**
 * supporters.js — Ko-fi supporter ledger.
 *
 * Uses better-sqlite3 when available (native, fast); falls back to a
 * JSON file store with the identical API surface, mirroring the
 * backend-selection pattern in api/cache.js.
 *
 * Schema:
 *   id          INTEGER PRIMARY KEY AUTOINCREMENT
 *   name        TEXT NOT NULL
 *   amount      REAL NOT NULL
 *   currency    TEXT DEFAULT 'USD'
 *   message     TEXT
 *   kofi_id     TEXT UNIQUE   (prevents duplicate webhook deliveries)
 *   created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
 *   visible     INTEGER DEFAULT 1
 */

const fs   = require('fs');
const path = require('path');

const CACHE_DIR   = path.join(__dirname, '..', '..', '.cache');
const JSON_FILE   = path.join(CACHE_DIR, 'supporters.json');
const SQLITE_PATH = path.join(CACHE_DIR, 'supporters.db');

try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}

// ─── SQLite backend ──────────────────────────────────────────────────────────

let db = null;

function tryInitSQLite() {
  try {
    const Database = require('better-sqlite3');
    const instance = new Database(SQLITE_PATH);
    instance.exec(`
      CREATE TABLE IF NOT EXISTS supporters (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT     NOT NULL,
        amount     REAL     NOT NULL,
        currency   TEXT     DEFAULT 'USD',
        message    TEXT,
        kofi_id    TEXT     UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        visible    INTEGER  DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_supporters_created ON supporters(created_at);
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
  console.log('[supporters] better-sqlite3 unavailable → JSON file store');
}

// ─── JSON fallback backend ───────────────────────────────────────────────────

function jsonLoad() {
  try { return JSON.parse(fs.readFileSync(JSON_FILE, 'utf8')); }
  catch { return { nextId: 1, rows: [] }; }
}

function jsonSave(store) {
  try { fs.writeFileSync(JSON_FILE, JSON.stringify(store), 'utf8'); }
  catch (e) { console.warn('[supporters] jsonSave error:', e.message); }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Insert a new supporter. Silently ignores duplicate kofi_id values.
 * @param {{name: string, amount: number, currency?: string, message?: string, kofi_id?: string}} data
 */
function addSupporter(data) {
  const name     = data.name;
  const amount   = data.amount;
  const currency = data.currency || 'USD';
  const message  = data.message || null;
  const kofiId   = data.kofi_id || null;

  if (USE_SQLITE) {
    db.prepare(`
      INSERT OR IGNORE INTO supporters (name, amount, currency, message, kofi_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, amount, currency, message, kofiId);
    return;
  }

  const store = jsonLoad();
  if (kofiId && store.rows.some(r => r.kofi_id === kofiId)) return;

  store.rows.push({
    id:         store.nextId++,
    name,
    amount,
    currency,
    message,
    kofi_id:    kofiId,
    created_at: new Date().toISOString(),
    visible:    1,
  });
  jsonSave(store);
}

/**
 * Return visible supporters, most recent first.
 * @param {number} [limit=50]
 */
function getSupporters(limit = 50) {
  if (USE_SQLITE) {
    return db.prepare(`
      SELECT * FROM supporters
      WHERE visible = 1
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit);
  }

  const store = jsonLoad();
  return store.rows
    .filter(r => r.visible === 1)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit);
}

/** Admin: hide a supporter from public listing without deleting the record. */
function hideSupporterById(id) {
  if (USE_SQLITE) {
    db.prepare('UPDATE supporters SET visible = 0 WHERE id = ?').run(id);
    return;
  }

  const store = jsonLoad();
  const row = store.rows.find(r => r.id === id);
  if (row) { row.visible = 0; jsonSave(store); }
}

module.exports = { addSupporter, getSupporters, hideSupporterById };
