'use strict';

const { Router } = require('express');
const { MOCK_NEOS } = require('../api/mock');

const router = Router();

router.get('/:id?', (req, res) => {
  const id = req.params.id || '99942';
  const neo = MOCK_NEOS.find(n => n.id === id) || MOCK_NEOS[0];
  res.render('asteroid', {
    page: 'asteroid',
    title: `NEO Radar — ${neo.name}`,
    neo,
    neos: MOCK_NEOS,
  });
});

module.exports = router;
