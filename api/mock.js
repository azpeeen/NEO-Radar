'use strict';

// Thin compatibility shim — delegates to the canonical catalog.
// Routes that already import { MOCK_NEOS } from '../api/mock' continue to work.

const { getCatalog } = require('../src/data/catalog');

const MOCK_NEOS = getCatalog();

module.exports = { MOCK_NEOS };
