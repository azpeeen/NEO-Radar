'use strict';

// JPL Horizons ephemeris client
// Base URL: https://ssd.jpl.nasa.gov/api/horizons.api
// Real integration is next sprint — stub only.

const BASE_URL = 'https://ssd.jpl.nasa.gov/api/horizons.api';

async function getEphemeris(spkId, startTime, stopTime, stepSize = '1d') {
  const params = new URLSearchParams({
    format: 'json',
    COMMAND: `'${spkId}'`,
    OBJ_DATA: 'YES',
    MAKE_EPHEM: 'YES',
    EPHEM_TYPE: 'VECTORS',
    CENTER: '500@10',      // heliocentric
    START_TIME: startTime,
    STOP_TIME: stopTime,
    STEP_SIZE: stepSize,
    VEC_TABLE: '2',        // position + velocity
    REF_PLANE: 'ECLIPTIC',
    REF_SYSTEM: 'J2000',
    VEC_CORR: 'NONE',
    OUT_UNITS: 'AU-D',
    CSV_FORMAT: 'YES',
  });

  const { default: fetch } = await import('node-fetch');
  const res = await fetch(`${BASE_URL}?${params}`);
  if (!res.ok) throw new Error(`Horizons error: ${res.status}`);
  return res.json();
}

module.exports = { getEphemeris };
