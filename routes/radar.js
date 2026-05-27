'use strict';

const { Router } = require('express');
const { MOCK_NEOS } = require('../api/mock');

const router = Router();

router.get('/', (req, res) => {
  res.render('radar', {
    page: 'radar',
    title: 'NEO Radar — Orbital Visualizer',
    neos: MOCK_NEOS,
  });
});

module.exports = router;
