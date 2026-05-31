'use strict';

const { Router } = require('express');
const { getCatalog } = require('../src/data/catalog');

const router = Router();

router.get('/', (req, res) => {
  const catalog = getCatalog();

  // Deep-link query params: ?focus=99942&date=2029-04-13
  const focus = req.query.focus || null;
  const date  = req.query.date  || null;

  // Validate focus id
  const focusObj = focus ? catalog.find(n => n.id === focus) : null;
  const focusId  = focusObj ? focusObj.id : 'apophis';

  res.render('radar', {
    page:    'radar',
    title:   'NEO Radar — Orbital Visualizer',
    neos:    catalog,
    focusId,
    focusDate: date || null,
  });
});

module.exports = router;
