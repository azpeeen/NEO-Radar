'use strict';

/**
 * horizons.js — JPL Horizons API client.
 * https://ssd.jpl.nasa.gov/horizons/
 *
 * All queries use format=json which wraps Horizons text output in:
 *   { "signature": {...}, "result": "...text..." }
 *
 * The text output contains $$SOE / $$EOE markers delimiting the
 * ephemeris table. Parsers use regex on the text inside these markers.
 *
 * Reference frame: heliocentric ecliptic J2000 (REF_PLANE=ECLIPTIC,
 * REF_SYSTEM=J2000, CENTER=@Sun). No obliquity rotation needed because
 * Horizons already delivers vectors in the ecliptic frame.
 *
 * Units: AU for position, AU/day for velocity (OUT_UNITS=AU-D).
 * These match the physics engine's internal units exactly.
 */

const cache = require('./cache');

const HORIZONS = 'https://ssd.jpl.nasa.gov/api/horizons.api';
const CAD_API  = 'https://ssd.jpl.nasa.gov/cad.api';  // Close Approach Database
const TIMEOUT  = 8_000;
const TTL      = 14 * 60 * 60; // 14 h

// J2000.0 Julian Date
const JD_J2000 = 2_451_545.0;

async function fetchText(url) {
  const { default: fetch } = await import('node-fetch');
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.result) throw new Error('No result field in Horizons response');
    return json.result;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Horizons request timed out after 8s');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Text parsers ─────────────────────────────────────────────────────────────

/** Extract the $$SOE…$$EOE block from Horizons text. Returns null if not found. */
function extractSOE(text) {
  const m = text.match(/\$\$SOE\s*([\s\S]*?)\s*\$\$EOE/);
  return m ? m[1] : null;
}

/** Check whether Horizons indicates the object was not found. */
function isNotFound(text) {
  return /No\s+ephemeris\s+for|OBJECT NOT FOUND|Cannot find/i.test(text);
}

/**
 * Parse X/Y/Z and VX/VY/VZ from a Horizons VECTORS block.
 * Handles both inline (single line) and two-line formats.
 *
 * Example Horizons text inside $$SOE:
 *   2461188.000000000 = A.D. 2026-May-27 12:00:00.0000 TDB
 *    X = 7.12345E-01 Y = 5.23456E-01 Z =-1.23456E-02
 *    VX=-1.23456E-02 VY= 7.89012E-03 VZ= 5.67890E-04
 *    LT=  6.14...  RG= 1.0...  RR= 1.0...
 */
function parseVectors(soe) {
  // Match X/Y/Z (with optional spaces around =)
  const posRe = /X\s*=\s*([-\d.E+]+)\s+Y\s*=\s*([-\d.E+]+)\s+Z\s*=\s*([-\d.E+]+)/i;
  const velRe = /VX\s*=\s*([-\d.E+]+)\s+VY\s*=\s*([-\d.E+]+)\s+VZ\s*=\s*([-\d.E+]+)/i;

  const pm = soe.match(posRe);
  const vm = soe.match(velRe);
  if (!pm || !vm) return null;

  return {
    r: [parseFloat(pm[1]), parseFloat(pm[2]), parseFloat(pm[3])],
    v: [parseFloat(vm[1]), parseFloat(vm[2]), parseFloat(vm[3])],
  };
}

/**
 * Parse orbital elements from a Horizons ELEMENTS block.
 *
 * Example inside $$SOE:
 *   EC= 1.9138...E-01  QR= 7.460...E-01  TP= 2448944.5
 *   OM= 2.044...E+02   W = 1.264...E+02  IN= 3.339...E+00
 *   A = 9.224...E-01   AD= 1.097...E+00  PR= 3.233...E+02
 *   MA= 8.836...E+01
 */
function parseElements(soe, epochJD) {
  function field(name) {
    // Match  NAME = VALUE  or  NAME= VALUE  (Horizons uses inconsistent spacing)
    const re = new RegExp(`\\b${name}\\s*=\\s*([\\-\\d.E+]+)`, 'i');
    const m  = soe.match(re);
    return m ? parseFloat(m[1]) : null;
  }

  const a  = field('A');
  const e  = field('EC');
  const i  = field('IN');
  const Om = field('OM');
  const w  = field('W');
  const PR = field('PR');  // period in days
  const TP = field('TP');  // time of periapsis (JD)
  let   MA = field('MA');  // mean anomaly in degrees (may be absent)

  // Compute MA from TP if not provided
  if (MA == null && PR != null && TP != null && epochJD != null) {
    const n_rad = (2 * Math.PI) / PR;       // rad/day
    let   MA_rad = n_rad * (epochJD - TP);  // may be negative
    MA_rad = ((MA_rad % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    MA = MA_rad * (180 / Math.PI);
  }

  if (a == null || e == null) return null;

  return { a, e, i, Omega: Om, omega: w, M: MA, period: PR };
}

/**
 * Parse Julian Date from the first line inside a $$SOE block.
 * Format: "2461188.000000000 = A.D. 2026-May-27 ..."
 */
function parseEpochJD(soe) {
  const m = soe.match(/^[\s]*(\d+\.?\d*)/);
  return m ? parseFloat(m[1]) : null;
}

// ─── Horizons query builder ───────────────────────────────────────────────────

function buildParams(spkId, extra) {
  return new URLSearchParams({
    format:       'json',
    COMMAND:      `'${spkId}'`,
    OBJ_DATA:     'YES',
    MAKE_EPHEM:   'YES',
    CENTER:       '@Sun',        // heliocentric
    REF_PLANE:    'ECLIPTIC',   // ecliptic J2000 — no rotation needed
    REF_SYSTEM:   'J2000',
    OUT_UNITS:    'AU-D',       // AU for position, AU/day for velocity
    ...extra,
  });
}

/**
 * Convert a Julian Date to the Horizons calendar-date string format
 * "YYYY-Mon-DD HH:MM" that the API reliably accepts.
 *
 * We never send "JD NNNNN" because Horizons rejects the space in some
 * server versions ("Too many constants").  Calendar format always works.
 */
function jdToCalendar(jd) {
  const MS_PER_DAY = 86_400_000;
  const j2000 = new Date(Date.UTC(2000, 0, 1, 12, 0, 0)); // 2000-Jan-01.5
  const target = new Date(j2000.getTime() + (jd - JD_J2000) * MS_PER_DAY);
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const y   = target.getUTCFullYear();
  const mon = M[target.getUTCMonth()];
  const d   = String(target.getUTCDate()).padStart(2, '0');
  const h   = String(target.getUTCHours()).padStart(2, '0');
  const min = String(target.getUTCMinutes()).padStart(2, '0');
  return `${y}-${mon}-${d}`; // date-only; Horizons accepts "YYYY-Mon-DD"
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch the heliocentric ecliptic state vector [r, v] for an object at
 * a given Julian Date epoch.
 *
 * @param {string} spkId   SPK-ID or IAU designation (e.g. '99942', '2024 YR4')
 * @param {number} epochJD Julian Date (e.g. 2461188.0 for 2026-May-27)
 * @returns {Promise<{r:number[], v:number[], epoch:number, source:string}|null>}
 */
async function getStateVector(spkId, epochJD) {
  const key    = `sv:${spkId}:${epochJD}`;
  const cached = cache.get(key);
  if (cached) return cached;

  // Use a 2-day window centered on the epoch; grab the first output row.
  // Calendar format avoids the "JD NNN" space-parsing bug in some Horizons versions.
  const params = buildParams(spkId, {
    EPHEM_TYPE: 'VECTORS',
    START_TIME: jdToCalendar(epochJD),
    STOP_TIME:  jdToCalendar(epochJD + 1.0),
    STEP_SIZE:  '1d',
    VEC_TABLE:  '2',            // position + velocity
  });

  try {
    const text = await fetchText(`${HORIZONS}?${params}`);

    if (isNotFound(text)) {
      console.warn(`[horizons] object not found: ${spkId}`);
      return null;
    }

    const soe = extractSOE(text);
    if (!soe) throw new Error('No $$SOE block in Horizons response');

    const pv = parseVectors(soe);
    if (!pv) throw new Error('Could not parse X/Y/Z VX/VY/VZ from response');

    const result = {
      r:      pv.r,
      v:      pv.v,
      epoch:  epochJD - JD_J2000,   // days since J2000 (physics engine units)
      epochJD,
      source: 'JPL_HORIZONS',
    };

    cache.set(key, result);
    return result;
  } catch (err) {
    console.warn(`[horizons] getStateVector(${spkId}, ${epochJD}) error:`, err.message);
    return null;
  }
}

/**
 * Fetch osculating orbital elements for an object at its reference epoch.
 *
 * @param {string} spkId
 * @returns {Promise<{a,e,i,Omega,omega,M,period,source}|null>}
 */
async function getOrbitalElements(spkId) {
  const key    = `el:${spkId}`;
  const cached = cache.get(key);
  if (cached) return cached;

  // Use J2000.0 as reference epoch
  const epochJD = JD_J2000;
  const params  = buildParams(spkId, {
    EPHEM_TYPE:  'ELEMENTS',
    START_TIME:  jdToCalendar(epochJD),
    STOP_TIME:   jdToCalendar(epochJD + 1.0),
    STEP_SIZE:   '1d',
    ELEM_LABELS: 'YES',
  });

  try {
    const text = await fetchText(`${HORIZONS}?${params}`);

    if (isNotFound(text)) {
      console.warn(`[horizons] object not found for elements: ${spkId}`);
      return null;
    }

    const soe = extractSOE(text);
    if (!soe) throw new Error('No $$SOE block');

    const epochJD_actual = parseEpochJD(soe) ?? epochJD;
    const el = parseElements(soe, epochJD_actual);
    if (!el) throw new Error('Could not parse orbital elements');

    const result = { ...el, source: 'JPL_HORIZONS', epochJD: epochJD_actual };
    cache.set(key, result);
    return result;
  } catch (err) {
    console.warn(`[horizons] getOrbitalElements(${spkId}) error:`, err.message);
    return null;
  }
}

/**
 * Fetch close approach events via JPL's Close Approach Database (CAD) API.
 * Returns approaches sorted by Julian Date.
 *
 * @param {string} spkId
 * @param {string} dateStart YYYY-MM-DD start of search window
 * @param {string} dateStop  YYYY-MM-DD end of search window
 * @param {number} [distMax=0.2] maximum approach distance in AU
 * @returns {Promise<Array<{date,jd,missDist_au,missDist_km,velocity_kms}>|null>}
 */
async function getCloseApproaches(spkId, dateStart, dateStop, distMax = 0.2) {
  const key    = `ca:${spkId}:${dateStart}:${dateStop}`;
  const cached = cache.get(key);
  if (cached) return cached;

  try {
    const params = new URLSearchParams({
      body:     spkId,
      datest:   dateStart,
      datestop: dateStop,
      'dist-max': String(distMax),
      'dist-unit': 'au',
      fullname: 'true',
    });

    const { default: fetch } = await import('node-fetch');
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);

    let json;
    try {
      const res = await fetch(`${CAD_API}?${params}`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`CAD API HTTP ${res.status}`);
      json = await res.json();
    } finally {
      clearTimeout(timer);
    }

    if (!json.data || !json.fields) return null;

    const f = json.fields; // field names
    const iJD   = f.indexOf('jd');
    const iCD   = f.indexOf('cd');     // calendar date
    const iDist = f.indexOf('dist');   // nominal miss distance (AU)
    const iVrel = f.indexOf('v_rel');  // relative velocity (km/s)

    const AU_KM = 149_597_870.7;

    const approaches = (json.data || []).map(row => ({
      date:        row[iCD]   ?? null,
      jd:          parseFloat(row[iJD] ?? 0),
      missDist_au: parseFloat(row[iDist] ?? 0),
      missDist_km: Math.round(parseFloat(row[iDist] ?? 0) * AU_KM),
      missDist_ld: Math.round(parseFloat(row[iDist] ?? 0) * AU_KM / 384_400 * 10000) / 10000,
      velocity_kms: parseFloat(row[iVrel] ?? 0),
    })).sort((a, b) => a.jd - b.jd);

    cache.set(key, approaches);
    return approaches;
  } catch (err) {
    console.warn(`[horizons] getCloseApproaches(${spkId}) error:`, err.message);
    return null;
  }
}

module.exports = {
  getStateVector,
  getOrbitalElements,
  getCloseApproaches,
  JD_J2000,
};
