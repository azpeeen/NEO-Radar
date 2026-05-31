'use strict';

/**
 * neows.js — NASA Near-Earth Object Web Service client.
 * Base URL: https://api.nasa.gov/neo/rest/v1/
 *
 * All functions return null on error — callers must handle the fallback.
 * Timeout: 8 s per request. 429 (rate limit) warns and returns null.
 * Feed results are cached 6 h; single-object lookups cached 14 h.
 */

const cache = require('./cache');

const BASE      = 'https://api.nasa.gov/neo/rest/v1';
const TIMEOUT   = 8_000;       // ms
const TTL_FEED  = 6  * 60 * 60; // 6 h  — feed data refreshes relatively often
const TTL_NEO   = 14 * 60 * 60; // 14 h — individual objects change slowly
const LD_KM     = 384_400;       // km per lunar distance

function apiKey() {
  return process.env.NASA_API_KEY || 'DEMO_KEY';
}

async function fetchJSON(url) {
  const { default: fetch } = await import('node-fetch');
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (res.status === 429) {
      console.warn('[neows] 429 rate-limited — returning null');
      return { _rateLimit: true };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Request timed out after 8s');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Risk classification ──────────────────────────────────────────────────────

function riskLevel(missDist_ld, isPHA) {
  if (missDist_ld < 0.05 && isPHA) return 'hazardous';
  if (missDist_ld < 0.1)           return 'caution';
  if (missDist_ld < 1.0)           return 'monitor';
  return 'safe';
}

// ─── Response shape ───────────────────────────────────────────────────────────

function parseCloseApproach(ca) {
  const km  = parseFloat(ca.miss_distance?.kilometers  || 0);
  const ld  = parseFloat(ca.miss_distance?.lunar        || 0);
  const vel = parseFloat(ca.relative_velocity?.kilometers_per_second || 0);
  return {
    date:        ca.close_approach_date   || null,
    dateFull:    ca.close_approach_date_full || null,
    missDist_km: Math.round(km),
    missDist_ld: Math.round(ld * 10000) / 10000,
    velocity_kms: Math.round(vel * 100) / 100,
    body:        ca.orbiting_body || 'Earth',
  };
}

function parseNeoEntry(obj) {
  const ca    = (obj.close_approach_data || [])[0] || {};
  const caD   = parseCloseApproach(ca);
  const diam  = obj.estimated_diameter?.meters || {};
  const diamM = diam.estimated_diameter_min != null
    ? Math.round((diam.estimated_diameter_min + diam.estimated_diameter_max) / 2)
    : null;
  const isPHA = !!obj.is_potentially_hazardous_asteroid;

  return {
    id:           String(obj.id || ''),
    name:         (obj.name || '').replace(/[()]/g, '').trim(),
    designation:  (obj.designation || obj.name || '').replace(/[()]/g, '').trim(),
    ...caD,
    diameter_m:   diamM,
    riskLevel:    riskLevel(caD.missDist_ld, isPHA),
    isPHA,
    absH:         obj.absolute_magnitude_h ?? null,
    source:       'NASA_NEOWS',
  };
}

// ─── Public functions ─────────────────────────────────────────────────────────

/**
 * Fetch close approaches for a date window (max 7 days per NASA's limit).
 * Returns a flat array sorted by miss distance, or null on failure.
 *
 * @param {string} startDate YYYY-MM-DD
 * @param {string} endDate   YYYY-MM-DD
 * @returns {Promise<object[]|null>}
 */
async function getFeed(startDate, endDate) {
  // Enforce 7-day cap
  const s = new Date(startDate);
  let   e = new Date(endDate);
  if ((e - s) / 86_400_000 > 7) {
    e = new Date(s.getTime() + 7 * 86_400_000);
    endDate = e.toISOString().slice(0, 10);
  }

  const key    = `feed:${startDate}:${endDate}`;
  const cached = cache.get(key);
  if (cached) return cached;

  try {
    const url  = `${BASE}/feed?start_date=${startDate}&end_date=${endDate}&api_key=${apiKey()}`;
    const json = await fetchJSON(url);
    if (json._rateLimit) return null;

    const neos = Object.values(json.near_earth_objects || {})
      .flat()
      .map(parseNeoEntry)
      .sort((a, b) => a.missDist_km - b.missDist_km);

    cache.set(key, neos, TTL_FEED);
    return neos;
  } catch (err) {
    console.warn('[neows] getFeed error:', err.message);
    return null;
  }
}

/**
 * Fetch full data for a single asteroid by SPK-ID.
 * Includes all historical close approach data and orbital elements.
 *
 * @param {string} id SPK-ID or designation
 * @returns {Promise<object|null>}
 */
async function getNeo(id) {
  const key    = `neo:${id}`;
  const cached = cache.get(key);
  if (cached) return cached;

  try {
    const url  = `${BASE}/neo/${id}?api_key=${apiKey()}`;
    const obj  = await fetchJSON(url);
    if (obj._rateLimit) return null;

    const base = parseNeoEntry({
      ...obj,
      close_approach_data: obj.close_approach_data || [],
    });

    const data = {
      ...base,
      allApproaches: (obj.close_approach_data || []).map(parseCloseApproach),
      orbitalData:   obj.orbital_data || null,
    };

    cache.set(key, data, TTL_NEO);
    return data;
  } catch (err) {
    console.warn('[neows] getNeo error:', err.message);
    return null;
  }
}

/**
 * Browse the full NEO catalog, paginated (20 per page).
 *
 * @param {number} page 0-indexed page number
 * @returns {Promise<{page:object, total:number, neos:object[]}|null>}
 */
async function getBrowse(page = 0) {
  const key    = `browse:${page}`;
  const cached = cache.get(key);
  if (cached) return cached;

  try {
    const url  = `${BASE}/neo/browse?page=${page}&size=20&api_key=${apiKey()}`;
    const json = await fetchJSON(url);
    if (json._rateLimit) return null;

    const data = {
      page:  json.page,
      total: json.page?.total_elements ?? null,
      neos:  (json.near_earth_objects || []).map(o =>
        parseNeoEntry({ ...o, close_approach_data: o.close_approach_data || [] })
      ),
    };

    cache.set(key, data, TTL_NEO);
    return data;
  } catch (err) {
    console.warn('[neows] getBrowse error:', err.message);
    return null;
  }
}

module.exports = { getFeed, getNeo, getBrowse };
