'use strict';

const { Router } = require('express');
const { getCatalog } = require('../src/data/catalog');
const { findUpcomingAlignments, SIM_EPOCH_J2000 } = require('../src/physics/alignments');

const router = Router();

router.get('/', (req, res) => {
  const catalog = getCatalog();

  // Deep-link query params: ?focus=99942&date=2029-04-13
  const focus = req.query.focus || null;
  const date  = req.query.date  || null;

  // Validate focus id
  const focusObj = focus ? catalog.find(n => n.id === focus) : null;
  const focusId  = focusObj ? focusObj.id : 'apophis';

  // Compute upcoming planetary conjunctions for the next 365 days
  let alignments = [];
  try {
    alignments = findUpcomingAlignments(SIM_EPOCH_J2000, 365, 15);
  } catch (e) {
    // Non-fatal: alignment detection is cosmetic
  }

  res.render('radar', {
    page:    'radar',
    title:   'NEO Radar — Orbital Visualizer',
    neos:    catalog,
    focusId,
    focusDate:  date || null,
    alignments,
  });
});

module.exports = router;
