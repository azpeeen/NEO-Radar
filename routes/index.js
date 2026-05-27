'use strict';

const { Router } = require('express');
const { MOCK_NEOS } = require('../api/mock');

const router = Router();

router.get('/', (req, res) => {
  res.render('index', {
    page: 'index',
    neos: MOCK_NEOS,
  });
});

module.exports = router;
