'use strict';

const { Router } = require('express');
const { getCatalog, getById } = require('../src/data/catalog');
const { keplerToCartesian, orbitalPeriod } = require('../src/physics/bodies');
const { propagate }    = require('../src/physics/integrator');
const { ephemerisAt, sunOnlyEphemeris } = require('../src/physics/ephemeris');
const horizons         = require('../api/horizons');

const router = Router();

// ─── Constants ────────────────────────────────────────────────────────────────

// Days from J2000.0 to simulation start (2026-05-27 12:00 TT)
const T0 = 9643;
// Julian Date at T0
const T0_JD = horizons.JD_J2000 + T0;  // 2461188.0
// 42 years forward: 2026 → 2068
const T1 = T0 + 42 * 365.25;
// AU → km
const AU_KM = 149_597_870.7;
// Output every 30 days ≈ 511 frames
const DT_OUT = 30;
const OPTS   = { dt0: 1.0, tol: 1e-10 };

// ─── Initial state helpers ────────────────────────────────────────────────────

/** Initial state from catalog Keplerian elements (fallback). */
function keplerian_state0(neo) {
  const n_deg = 360 / orbitalPeriod(neo.a);
  const M     = ((neo.M + n_deg * T0) % 360 + 360) % 360;
  const { r, v } = keplerToCartesian({ ...neo, M });
  return [r[0], r[1], r[2], v[0], v[1], v[2]];
}

/**
 * Try to get the initial state vector from JPL Horizons.
 * Returns null if unavailable; caller falls back to Keplerian.
 */
async function getJPLstate0(neo) {
  // Only fetch for objects that have a numeric SPK-ID
  const numericId = /^\d+$/.test(neo.id);
  if (!numericId) return null;

  try {
    const sv = await horizons.getStateVector(neo.id, T0_JD);
    if (!sv) return null;
    return [sv.r[0], sv.r[1], sv.r[2], sv.v[0], sv.v[1], sv.v[2]];
  } catch {
    return null;
  }
}

// ─── Perturbation diff ────────────────────────────────────────────────────────

// Module-level cache (in-memory, per-process lifetime)
const perturbCache = new Map();

function computePerturbDiff(state0) {
  const sunOnly = sunOnlyEphemeris();
  const framesN = propagate(state0, T0, T1, DT_OUT, ephemerisAt, OPTS);
  const framesK = propagate(state0, T0, T1, DT_OUT, sunOnly,     OPTS);

  const len     = Math.min(framesN.length, framesK.length);
  const epochs  = [];
  const devKm   = [];

  for (let i = 0; i < len; i++) {
    const sN = framesN[i].state;
    const sK = framesK[i].state;
    epochs.push(framesN[i].t);
    const dx = sN[0]-sK[0], dy = sN[1]-sK[1], dz = sN[2]-sK[2];
    devKm.push(Math.sqrt(dx*dx + dy*dy + dz*dz) * AU_KM);
  }

  const lastN  = framesN[framesN.length - 1].state;
  const lastK  = framesK[framesK.length - 1].state;
  const dvKms  = Math.sqrt(
    (lastN[3]-lastK[3])**2 + (lastN[4]-lastK[4])**2 + (lastN[5]-lastK[5])**2
  ) * AU_KM / 86_400;

  return {
    epochs,
    devKm,
    stats: {
      finalDevKm: Math.round(devKm[devKm.length - 1] || 0),
      dvKms:      dvKms.toFixed(6),
      maxDevKm:   Math.round(Math.max(...devKm)),
      nFrames:    len,
      seedSource: null,   // filled in by route
    },
  };
}

// ─── Route ────────────────────────────────────────────────────────────────────

router.get('/:id?', async (req, res) => {
  const catalog = getCatalog();
  const id  = req.params.id || '99942';
  const neo = getById(id) || catalog[0];

  // Build initial state: prefer real JPL vector, fall back to Keplerian
  let state0     = null;
  let seedSource = 'keplerian';
  let jplData    = null;

  try {
    const jplState = await getJPLstate0(neo);
    if (jplState) {
      state0     = jplState;
      seedSource = 'JPL_HORIZONS';
      jplData    = { epochJD: T0_JD, source: 'JPL_HORIZONS' };
    }
  } catch (err) {
    console.warn(`[asteroid] Horizons state vector unavailable for ${neo.id}:`, err.message);
  }

  if (!state0) {
    state0 = keplerian_state0(neo);
  }

  // Compute perturbation diff (cached by id + seed source)
  let perturbData = null;
  const cacheKey  = `${neo.id}:${seedSource}`;

  try {
    if (perturbCache.has(cacheKey)) {
      perturbData = perturbCache.get(cacheKey);
    } else {
      perturbData = computePerturbDiff(state0);
      perturbData.stats.seedSource = seedSource;
      perturbCache.set(cacheKey, perturbData);
    }
  } catch (err) {
    console.warn(`[asteroid] perturbation diff failed for ${neo.id}:`, err.message);
  }

  res.render('asteroid', {
    page:        'asteroid',
    title:       `${neo.name} · Asteroid Dossier — NEO Radar`,
    neo,
    neos:        catalog,
    perturbData,
    jplData,
    seedSource,
  });
});

module.exports = router;
