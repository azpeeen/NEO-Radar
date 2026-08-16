'use strict';

const { Router } = require('express');
const { getSupporters } = require('../src/data/supporters');

const router = Router();

const BRL_TO_USD = 0.18;

function toUSD(amount, currency) {
  return currency === 'BRL' ? amount * BRL_TO_USD : amount;
}

router.get('/', (req, res) => {
  const supporters = getSupporters(50);
  const total = supporters.reduce((sum, s) => sum + toUSD(s.amount, s.currency), 0);

  res.render('about', {
    page:  'about',
    title: 'About — NEO Radar',
    supporters,
    total,
  });
});

module.exports = router;
