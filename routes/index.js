'use strict';

const { Router }  = require('express');
const { getCatalog } = require('../src/data/catalog');
const neows       = require('../api/neows');

const router = Router();

// ─── Date helpers ─────────────────────────────────────────────────────────────

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function plusDays(iso, n) {
  const d = new Date(iso);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// ─── Merge live feed with catalog ────────────────────────────────────────────

/**
 * Merge a NeoWs feed result with the local catalog.
 * - Feed objects replace catalog entries with the same id (real-time distances).
 * - Catalog objects not in the feed are kept as-is (stable orbital data).
 * - Result is sorted by missDist_km ascending.
 */
function mergeFeedWithCatalog(feed, catalog) {
  const feedById = new Map((feed || []).map(n => [n.id, n]));

  const merged = catalog.map(cat => {
    const live = feedById.get(cat.id);
    if (live) {
      // Overlay live approach data onto the richer catalog entry
      return {
        ...cat,
        missDist_km:  live.missDist_km,
        missDist_ld:  live.missDist_ld,
        velocity_kms: live.velocity_kms,
        riskLevel:    live.riskLevel,
        nextApproach: live.date || cat.nextApproach,
        liveData:     true,
      };
    }
    return cat;
  });

  // Also add feed objects that aren't in our catalog (new objects)
  for (const [id, live] of feedById) {
    if (!catalog.find(c => c.id === id)) {
      merged.push({ ...live, liveData: true });
    }
  }

  return merged.sort((a, b) => a.missDist_km - b.missDist_km);
}

// ─── Route ────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const catalog = getCatalog();

  // Try live NeoWs feed for the next 7 days
  let neos = catalog;
  let liveDataAvailable = false;

  try {
    const start = todayISO();
    const end   = plusDays(start, 7);
    const feed  = await neows.getFeed(start, end);

    if (feed && feed.length > 0) {
      neos = mergeFeedWithCatalog(feed, catalog);
      liveDataAvailable = true;
    }
  } catch (err) {
    console.warn('[index] NeoWs feed failed, using catalog:', err.message);
  }

  res.render('index', {
    page:              'index',
    neos,
    liveDataAvailable,
  });
});

module.exports = router;
