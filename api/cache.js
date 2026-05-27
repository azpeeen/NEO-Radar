'use strict';

// Ephemeris cache — 14h TTL, content-hash invalidation.
// Backed by a JSON file on disk. Replace with better-sqlite3 once
// a native build environment (Python + node-gyp) is available.

const fs   = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '..', 'ephemeris-cache.json');
const TTL_MS     = 14 * 60 * 60 * 1000; // 14 hours

function load() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch { return {}; }
}

function save(store) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(store), 'utf8');
}

function get(spkId) {
  const store = load();
  const entry = store[spkId];
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > TTL_MS) return null;
  return entry.payload;
}

function set(spkId, payload, hash) {
  const store = load();
  store[spkId] = { payload, hash, cachedAt: Date.now() };
  save(store);
}

function invalidate(spkId) {
  const store = load();
  delete store[spkId];
  save(store);
}

module.exports = { get, set, invalidate };
