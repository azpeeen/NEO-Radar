'use strict';

const path = require('path');
const fs   = require('fs');

const CACHE_DIR  = path.join(__dirname, '..', '..', '.cache');
const JSON_PATH  = path.join(CACHE_DIR, 'asteroids_mpc.json');
const DB_PATH    = path.join(CACHE_DIR, 'asteroids_mpc.db');

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS asteroids_mpc (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    designation TEXT,
    name        TEXT,
    H           REAL,
    epoch_jd    REAL,
    M           REAL,
    w           REAL,
    node        REAL,
    i           REAL,
    e           REAL,
    a           REAL
  )
`;

async function seedMPC() {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}

  // ── Try SQLite first ──────────────────────────────────────────────────────
  try {
    const Database = require('better-sqlite3');
    const db = new Database(DB_PATH);
    db.exec(CREATE_TABLE);

    const existing = db.prepare('SELECT COUNT(*) AS c FROM asteroids_mpc').get().c;
    if (existing > 0) {
      console.log(`[MPC] SQLite already seeded (${existing} asteroids)`);
      db.close();
      return existing;
    }

    const { parseMPC } = require('./parseMPC');
    const asteroids = parseMPC();
    const total = asteroids.length;
    console.log(`[MPC] Parsed ${total} asteroids — inserting into SQLite...`);

    const insert = db.prepare(`
      INSERT INTO asteroids_mpc (designation, name, H, epoch_jd, M, w, node, i, e, a)
      VALUES (@designation, @name, @H, @epoch_jd, @M, @w, @node, @i, @e, @a)
    `);
    const insertBatch = db.transaction((batch) => { for (const ast of batch) insert.run(ast); });

    const BATCH = 500;
    for (let off = 0; off < total; off += BATCH) {
      insertBatch(asteroids.slice(off, off + BATCH));
      const done = Math.min(off + BATCH, total);
      if (done % 5000 === 0 || done === total) console.log(`[MPC] ${done} / ${total}`);
    }

    db.close();
    console.log(`[MPC] Seed concluído: ${total} asteroides (SQLite)`);
    return total;

  } catch (sqliteErr) {
    if (!sqliteErr.message.includes('Cannot find module')) {
      console.warn('[MPC] SQLite error:', sqliteErr.message);
    }
    // fall through to JSON
  }

  // ── JSON fallback ─────────────────────────────────────────────────────────
  if (fs.existsSync(JSON_PATH)) {
    try {
      const count = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')).length;
      console.log(`[MPC] JSON already seeded (${count} asteroids)`);
      return count;
    } catch {}
  }

  const { parseMPC } = require('./parseMPC');
  const asteroids = parseMPC();
  const total = asteroids.length;
  console.log(`[MPC] Parsed ${total} asteroids — writing JSON cache...`);

  fs.writeFileSync(JSON_PATH, JSON.stringify(asteroids), 'utf8');
  console.log(`[MPC] Seed concluído: ${total} asteroides (JSON)`);
  return total;
}

module.exports = seedMPC;
