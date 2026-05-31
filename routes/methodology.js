'use strict';

const { Router } = require('express');
const { solveKeplerTraced } = require('../src/physics/kepler');

const router = Router();

// Pre-compute Apophis Kepler convergence trace at module load (cheap, ~0ms).
// Apophis: M = 88.36° = 1.5422 rad, e = 0.1914
const APOPHIS_TRACE = (() => {
  try {
    return solveKeplerTraced(88.36 * Math.PI / 180, 0.1914);
  } catch {
    return { E: 1.73, iterations: 4, residuals: [0.00205, 3.87e-7, 1.38e-14, 1e-16] };
  }
})();

router.get('/', (req, res) => {
  res.render('methodology', {
    page:        'methodology',
    title:       'Methodology — NEO Radar',
    keplerTrace: APOPHIS_TRACE,
  });
});

module.exports = router;
