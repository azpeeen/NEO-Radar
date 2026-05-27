'use strict';

// NASA NeoWs API client
// Base URL: https://api.nasa.gov/neo/rest/v1/
// Real integration is next sprint — stub only.

const BASE_URL = 'https://api.nasa.gov/neo/rest/v1';

async function getFeed(startDate, endDate) {
  const key = process.env.NASA_API_KEY || 'DEMO_KEY';
  const url = `${BASE_URL}/feed?start_date=${startDate}&end_date=${endDate}&api_key=${key}`;
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NeoWs feed error: ${res.status}`);
  return res.json();
}

async function getLookup(asteroidId) {
  const key = process.env.NASA_API_KEY || 'DEMO_KEY';
  const url = `${BASE_URL}/neo/${asteroidId}?api_key=${key}`;
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NeoWs lookup error: ${res.status}`);
  return res.json();
}

module.exports = { getFeed, getLookup };
