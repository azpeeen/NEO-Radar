'use strict';

const { Router } = require('express');

const router = Router();

router.get('/', (req, res) => {
  res.render('methodology', {
    page: 'methodology',
    title: 'NEO Radar — Methodology',
  });
});

module.exports = router;
