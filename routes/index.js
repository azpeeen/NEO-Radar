'use strict';

const { Router }     = require('express');
const { getCatalog } = require('../src/data/catalog');
const neows          = require('../api/neows');
const cache          = require('../api/cache');

const router = Router();

const TTL_30DAY = 6 * 60 * 60; // 6 h

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

// ─── 30-day feed: 5 × 7-day windows, deduped by id, cached 6 h ───────────────

async function get30DayFeed(start) {
  const cacheKey = `feed30:${start}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    console.log('[feed] cache hit');
    return cached; // { feed, fetchedAt }
  }

  const windows = [[0, 7], [7, 14], [14, 21], [21, 28], [28, 30]];
  const byId = new Map();
  let anySuccess = false;

  for (const [s, e] of windows) {
    const chunk = await neows.getFeed(plusDays(start, s), plusDays(start, e));
    if (chunk) {
      anySuccess = true;
      for (const obj of chunk) {
        if (!byId.has(obj.id)) byId.set(obj.id, obj);
      }
    }
  }

  if (!anySuccess) return null;

  const feed = Array.from(byId.values())
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  const fetchedAt = Math.floor(Date.now() / 1000);
  cache.set(cacheKey, { feed, fetchedAt }, TTL_30DAY);
  console.log(`[feed] fetched ${feed.length} objects`);
  return { feed, fetchedAt };
}

// ─── Route ────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const catalog = getCatalog();
  const start   = todayISO();

  // 7-day feed for the neos table / radar
  let neos = catalog;
  let liveDataAvailable = false;

  try {
    const feed7 = await neows.getFeed(start, plusDays(start, 7));
    if (feed7 && feed7.length > 0) {
      neos = mergeFeedWithCatalog(feed7, catalog);
      liveDataAvailable = true;
    }
  } catch (err) {
    console.warn('[index] 7-day feed failed:', err.message);
  }

  // 30-day feed for headline stats
  let monthFeed = null;
  let fetchedAt = 0;

  try {
    const result = await get30DayFeed(start);
    if (result) { monthFeed = result.feed; fetchedAt = result.fetchedAt; }
  } catch (err) {
    console.warn('[index] 30-day feed failed:', err.message);
  }

  const mergedFeed = monthFeed || catalog;
  if (!monthFeed) console.log('[feed] API failed, using catalog fallback');

  const monthlyCount = mergedFeed.length;
  const within5LD    = mergedFeed.filter(n => parseFloat(n.missDist_ld) < 5.0).length;
  const within1LD    = mergedFeed.filter(n => parseFloat(n.missDist_ld) < 1.0).length;

  console.log('[feed] stats:', {
    total: monthlyCount,
    within5LD,
    within1LD,
    sample: mergedFeed.slice(0, 3).map(n => ({
      name: n.name,
      missDist_ld: n.missDist_ld,
      type: typeof n.missDist_ld,
    })),
  });

  const firstApproach = mergedFeed
    .filter(n => n.date || n.nextApproach)
    .sort((a, b) => new Date(a.date || a.nextApproach) - new Date(b.date || b.nextApproach))[0];

  const nextApproach = firstApproach ? {
    name:        firstApproach.name || firstApproach.designation || 'Unknown',
    days:        Math.max(0, Math.round((new Date(firstApproach.date || firstApproach.nextApproach) - Date.now()) / 86400000)),
    missDist_ld: firstApproach.missDist_ld ?? null,
    date:        firstApproach.date || firstApproach.nextApproach || null,
  } : { name: 'Unknown', days: 0, missDist_ld: null, date: null };

  const hoursAgo = fetchedAt
    ? Math.round((Math.floor(Date.now() / 1000) - fetchedAt) / 3600)
    : null;

  res.render('index', {
    page: 'index',
    neos,
    liveDataAvailable,
    monthlyCount,
    within5LD,
    within1LD,
    nextApproach,
    hoursAgo,
  });
});

module.exports = router;
