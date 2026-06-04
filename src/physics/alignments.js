'use strict';

/**
 * alignments.js — Planetary conjunction / alignment detector.
 *
 * A "conjunction" occurs when 2+ bodies have angular separation < threshold
 * as seen from the Sun (heliocentric angular separation).
 *
 * All time arguments are J2000 day numbers unless noted otherwise.
 * Sim epoch (simTime=0) = J2000 day 9643 (2026-05-27 12:00 UTC).
 */

const { planetPositions } = require('./ephemeris');

const SIM_EPOCH_J2000 = 9643;

const NAME_TO_KEY = {
  Earth:   'earth',
  Jupiter: 'jupiter',
  Saturn:  'saturn',
  Uranus:  'uranus',
  Neptune: 'neptune',
};

const ALL_PLANET_NAMES = ['Earth', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];

function angularSep(r1, r2) {
  const dot = r1[0]*r2[0] + r1[1]*r2[1] + r1[2]*r2[2];
  const m1  = Math.sqrt(r1[0]**2 + r1[1]**2 + r1[2]**2);
  const m2  = Math.sqrt(r2[0]**2 + r2[1]**2 + r2[2]**2);
  return Math.acos(Math.max(-1, Math.min(1, dot / (m1 * m2)))) * 180 / Math.PI;
}

function j2000DayToDate(t) {
  const ms = Date.UTC(2000, 0, 1, 12) + t * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Detect active alignments at a given sim time.
 *
 * @param {number} simTimeDays - days from sim epoch (2026-05-27)
 * @param {string[]} bodies    - planet names to check
 * @param {number}   threshold - angular separation threshold (degrees)
 * @returns {Array<{bodies:string[], separation:number}>}
 */
function detectAlignments(simTimeDays, bodies = ALL_PLANET_NAMES, threshold = 10) {
  const t   = SIM_EPOCH_J2000 + simTimeDays;
  const pos = planetPositions(t);
  const pts = bodies.map(name => ({ name, pos: pos[NAME_TO_KEY[name]] })).filter(b => b.pos);

  const out = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const sep = angularSep(pts[i].pos, pts[j].pos);
      if (sep < threshold) {
        out.push({ bodies: [pts[i].name, pts[j].name], separation: +sep.toFixed(2) });
      }
    }
  }
  return out;
}

/**
 * Scan forward from startJ2000Day until bodyNames are all within threshold of each other.
 * Returns a Promise (async-compatible API).
 *
 * @param {number}   startJ2000Day
 * @param {string[]} bodyNames
 * @param {number}   threshold   - degrees
 * @param {number}   maxDays
 * @returns {Promise<{date,j2000Day,simDay,bodies,minSeparation,type}|null>}
 */
function findNextAlignment(startJ2000Day, bodyNames, threshold = 10, maxDays = 3650) {
  return new Promise((resolve) => {
    let inConj = false;
    let minSep = Infinity;
    let minDay = -1;

    for (let d = 0; d < maxDays; d++) {
      const t   = startJ2000Day + d;
      const pos = planetPositions(t);
      const pts = bodyNames.map(name => pos[NAME_TO_KEY[name]]).filter(Boolean);

      if (pts.length < bodyNames.length) { resolve(null); return; }

      let maxPairSep = 0;
      let localMin   = Infinity;
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const s = angularSep(pts[i], pts[j]);
          if (s > maxPairSep) maxPairSep = s;
          if (s < localMin)   localMin   = s;
        }
      }

      if (maxPairSep < threshold) {
        if (!inConj) { inConj = true; minSep = localMin; minDay = d; }
        else if (localMin < minSep) { minSep = localMin; minDay = d; }
      } else if (inConj) {
        break;
      }
    }

    if (minDay < 0) { resolve(null); return; }

    const t    = startJ2000Day + minDay;
    const type = bodyNames.length > 2 ? 'triple' : 'conjunction';
    resolve({
      date:          j2000DayToDate(t),
      j2000Day:      t,
      simDay:        t - SIM_EPOCH_J2000,
      bodies:        bodyNames,
      minSeparation: +minSep.toFixed(2),
      type,
    });
  });
}

/**
 * Find all upcoming conjunctions for tracked planet pairs within numDays.
 * Synchronous — safe to call at request time.
 *
 * @param {number} startJ2000Day
 * @param {number} numDays
 * @param {number} threshold - degrees
 * @returns {Array<{bodies,date,j2000Day,simDay,minSeparation,type}>}
 */
function findUpcomingAlignments(startJ2000Day, numDays = 365, threshold = 15) {
  const PAIRS = [
    ['Earth',   'Jupiter'],
    ['Earth',   'Saturn'],
    ['Jupiter', 'Saturn'],
    ['Jupiter', 'Uranus'],
    ['Saturn',  'Uranus'],
    ['Jupiter', 'Neptune'],
    ['Uranus',  'Neptune'],
  ];

  const TRIPLES = [
    ['Jupiter', 'Saturn', 'Uranus'],
    ['Earth',   'Jupiter', 'Saturn'],
  ];

  const results = [];

  for (const pair of PAIRS) {
    let inConj = false;
    let minSep = Infinity;
    let minDay = -1;

    for (let d = 0; d < numDays; d++) {
      const t   = startJ2000Day + d;
      const pos = planetPositions(t);
      const p1  = pos[NAME_TO_KEY[pair[0]]];
      const p2  = pos[NAME_TO_KEY[pair[1]]];
      if (!p1 || !p2) break;

      const sep = angularSep(p1, p2);

      if (sep < threshold) {
        if (!inConj) { inConj = true; minSep = sep; minDay = d; }
        else if (sep < minSep) { minSep = sep; minDay = d; }
      } else if (inConj) {
        results.push({
          bodies:        pair,
          date:          j2000DayToDate(startJ2000Day + minDay),
          j2000Day:      startJ2000Day + minDay,
          simDay:        startJ2000Day + minDay - SIM_EPOCH_J2000,
          minSeparation: +minSep.toFixed(2),
          type:          'conjunction',
        });
        inConj = false;
        minSep = Infinity;
        minDay = -1;
      }
    }
    if (inConj && minDay >= 0) {
      results.push({
        bodies:        pair,
        date:          j2000DayToDate(startJ2000Day + minDay),
        j2000Day:      startJ2000Day + minDay,
        simDay:        startJ2000Day + minDay - SIM_EPOCH_J2000,
        minSeparation: +minSep.toFixed(2),
        type:          'conjunction',
      });
    }
  }

  for (const triple of TRIPLES) {
    for (let d = 0; d < numDays; d++) {
      const t   = startJ2000Day + d;
      const pos = planetPositions(t);
      const pts = triple.map(name => pos[NAME_TO_KEY[name]]);
      if (pts.some(p => !p)) break;

      const seps = [];
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          seps.push(angularSep(pts[i], pts[j]));
        }
      }
      if (Math.max(...seps) < threshold) {
        results.push({
          bodies:        triple,
          date:          j2000DayToDate(t),
          j2000Day:      t,
          simDay:        t - SIM_EPOCH_J2000,
          minSeparation: +Math.min(...seps).toFixed(2),
          type:          'triple',
        });
        d += 30;
      }
    }
  }

  results.sort((a, b) => a.j2000Day - b.j2000Day);
  return results.slice(0, 8);
}

module.exports = {
  detectAlignments,
  findNextAlignment,
  findUpcomingAlignments,
  j2000DayToDate,
  SIM_EPOCH_J2000,
};
