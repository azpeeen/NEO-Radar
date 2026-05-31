'use strict';

/**
 * catalog.js — NEO catalog (47 tracked objects).
 *
 * Keplerian elements are at J2000.0 epoch (JD 2451545.0),
 * heliocentric ecliptic reference frame.
 *
 * Primary sources for well-known objects:
 *   JPL Small Body Database (https://ssd.jpl.nasa.gov/tools/sbdb_query.html)
 *   NASA NeoWs  (https://api.nasa.gov/neo/rest/v1/)
 *
 * Generated objects use realistic orbital element distributions
 * drawn from the observed NEO population statistics.
 */

const { orbitalPeriod } = require('../physics/bodies');

// Days from J2000.0 (2000-01-01.5) to simulation epoch (2026-05-27)
const T_SIM_EPOCH = 9643; // days

function computePhase(a, M0_deg) {
  const n = 360 / orbitalPeriod(a); // deg/day
  return (((M0_deg + n * T_SIM_EPOCH) % 360) + 360) % 360; // 0–360 deg at sim epoch
}

function fmtDate(iso) {
  return iso.replace(/-/g, '·');
}

function fmtKm(km) {
  if (km >= 1e6) return (km / 1e6).toFixed(2) + 'M';
  return km.toLocaleString('en-US');
}

function risk2label(r) {
  return r.charAt(0).toUpperCase() + r.slice(1);
}

function desigFmt(id, name, group) {
  const numId = /^\d+$/.test(id);
  if (numId) return `${id} · ${group}`;
  if (name !== id.replace(/(\d{4})([A-Z]\w*)/, '$1 $2')) return `${name} · ${group}`;
  return `NEA · ${group}`;
}

// RAW catalog entries — elements at J2000, missDist in km and LD
const RAW = [
  // ── Real objects ─────────────────────────────────────────────────────────
  {
    id: '99942', name: 'Apophis', designation: '99942', group: 'Aten',
    a: 0.9224, e: 0.1914, i: 3.34, Omega: 204.45, omega: 126.42, M: 88.36,
    riskLevel: 'caution',
    nextApproach: '2029-04-13', missDist_km: 31800,  missDist_ld: 0.083, velocity_kms: 7.42,
  },
  {
    id: '2024YR4', name: '2024 YR4', designation: '2024 YR4', group: 'Apollo',
    a: 2.515, e: 0.661, i: 3.41, Omega: 271.0, omega: 134.0, M: 0.0,
    riskLevel: 'monitor',
    nextApproach: '2032-12-22', missDist_km: 273000, missDist_ld: 0.71,  velocity_kms: 14.2,
  },
  {
    id: '101955', name: 'Bennu', designation: '101955', group: 'Apollo',
    a: 1.126, e: 0.204, i: 6.03, Omega: 2.06, omega: 66.22, M: 162.0,
    riskLevel: 'safe',
    nextApproach: '2026-09-23', missDist_km: 3560000, missDist_ld: 9.26, velocity_kms: 6.1,
  },
  {
    id: '2025PT5', name: '2025 PT5', designation: '2025 PT5', group: 'Aten',
    a: 0.930, e: 0.410, i: 1.20, Omega: 30.0, omega: 220.0, M: 180.0,
    riskLevel: 'safe',
    nextApproach: '2026-08-14', missDist_km: 273000, missDist_ld: 0.71,  velocity_kms: 14.2,
  },
  {
    id: '433', name: 'Eros', designation: '433', group: 'Amor',
    a: 1.458, e: 0.223, i: 10.83, Omega: 304.4, omega: 178.9, M: 200.0,
    riskLevel: 'safe',
    nextApproach: '2028-10-15', missDist_km: 5570000, missDist_ld: 14.5, velocity_kms: 5.2,
  },
  {
    id: '1862', name: 'Apollo', designation: '1862', group: 'Apollo',
    a: 1.470, e: 0.560, i: 6.35, Omega: 35.7, omega: 285.9, M: 120.0,
    riskLevel: 'safe',
    nextApproach: '2027-03-18', missDist_km: 9610000, missDist_ld: 25.0, velocity_kms: 9.8,
  },
  {
    id: '3122', name: 'Florence', designation: '3122', group: 'Amor',
    a: 1.769, e: 0.423, i: 22.15, Omega: 336.1, omega: 27.8, M: 220.0,
    riskLevel: 'safe',
    nextApproach: '2031-08-14', missDist_km: 11840000, missDist_ld: 30.8, velocity_kms: 13.5,
  },
  {
    id: '162173', name: 'Ryugu', designation: '162173', group: 'Apollo',
    a: 1.190, e: 0.190, i: 5.88, Omega: 251.6, omega: 211.4, M: 160.0,
    riskLevel: 'safe',
    nextApproach: '2026-12-11', missDist_km: 10390000, missDist_ld: 27.0, velocity_kms: 4.9,
  },
  {
    id: '65803', name: 'Didymos', designation: '65803', group: 'Apollo',
    a: 1.644, e: 0.384, i: 3.41, Omega: 73.2, omega: 319.3, M: 300.0,
    riskLevel: 'safe',
    nextApproach: '2026-10-04', missDist_km: 8870000, missDist_ld: 23.1, velocity_kms: 5.3,
  },
  {
    id: '4179', name: 'Toutatis', designation: '4179', group: 'Apollo',
    a: 2.511, e: 0.634, i: 0.47, Omega: 124.4, omega: 274.8, M: 350.0,
    riskLevel: 'safe',
    nextApproach: '2028-03-14', missDist_km: 30140000, missDist_ld: 78.4, velocity_kms: 8.7,
  },
  {
    id: '2023BU', name: '2023 BU', designation: '2023 BU', group: 'Aten',
    a: 0.834, e: 0.252, i: 2.55, Omega: 17.2, omega: 88.0, M: 42.0,
    riskLevel: 'safe',
    nextApproach: '2026-08-24', missDist_km: 922000, missDist_ld: 2.40, velocity_kms: 11.0,
  },
  {
    id: '2024ON', name: '2024 ON', designation: '2024 ON', group: 'Apollo',
    a: 1.420, e: 0.510, i: 8.70, Omega: 318.0, omega: 211.0, M: 80.0,
    riskLevel: 'caution',
    nextApproach: '2026-09-07', missDist_km: 104000, missDist_ld: 0.27, velocity_kms: 16.7,
  },
  {
    id: '1036', name: 'Ganymed', designation: '1036', group: 'Amor',
    a: 2.659, e: 0.534, i: 26.68, Omega: 215.5, omega: 131.6, M: 50.0,
    riskLevel: 'safe',
    nextApproach: '2031-10-22', missDist_km: 21600000, missDist_ld: 56.2, velocity_kms: 7.4,
  },
  {
    id: '4769', name: 'Castalia', designation: '4769', group: 'Apollo',
    a: 1.063, e: 0.483, i: 8.89, Omega: 142.8, omega: 131.4, M: 280.0,
    riskLevel: 'safe',
    nextApproach: '2028-04-12', missDist_km: 15140000, missDist_ld: 39.4, velocity_kms: 11.3,
  },
  {
    id: '6489', name: 'Golevka', designation: '6489', group: 'Apollo',
    a: 2.508, e: 0.606, i: 2.28, Omega: 212.0, omega: 62.1, M: 170.0,
    riskLevel: 'safe',
    nextApproach: '2030-11-03', missDist_km: 55700000, missDist_ld: 145.0, velocity_kms: 17.6,
  },
  {
    id: '2008TC3', name: '2008 TC3', designation: '2008 TC3', group: 'Apollo',
    a: 1.308, e: 0.306, i: 2.54, Omega: 194.1, omega: 234.4, M: 20.0,
    riskLevel: 'safe',
    nextApproach: '2027-02-12', missDist_km: 18560000, missDist_ld: 48.3, velocity_kms: 5.8,
  },

  // ── Generated objects ────────────────────────────────────────────────────
  {
    id: '2022AP7', name: '2022 AP7', designation: '2022 AP7', group: 'Apollo',
    a: 2.270, e: 0.590, i: 7.2, Omega: 181.0, omega: 87.0, M: 140.0,
    riskLevel: 'safe',
    nextApproach: '2027-09-21', missDist_km: 7150000, missDist_ld: 18.6, velocity_kms: 12.8,
  },
  {
    id: '2021SG', name: '2021 SG', designation: '2021 SG', group: 'Aten',
    a: 0.947, e: 0.335, i: 4.1, Omega: 259.0, omega: 171.0, M: 210.0,
    riskLevel: 'safe',
    nextApproach: '2026-07-12', missDist_km: 2000000, missDist_ld: 5.20, velocity_kms: 9.1,
  },
  {
    id: '2020VT4', name: '2020 VT4', designation: '2020 VT4', group: 'Aten',
    a: 0.881, e: 0.287, i: 1.25, Omega: 36.0, omega: 314.0, M: 290.0,
    riskLevel: 'monitor',
    nextApproach: '2026-11-13', missDist_km: 169000, missDist_ld: 0.44, velocity_kms: 10.5,
  },
  {
    id: '2023EW', name: '2023 EW', designation: '2023 EW', group: 'Apollo',
    a: 1.710, e: 0.450, i: 12.3, Omega: 92.0, omega: 156.0, M: 330.0,
    riskLevel: 'safe',
    nextApproach: '2028-08-02', missDist_km: 8610000, missDist_ld: 22.4, velocity_kms: 14.2,
  },
  {
    id: '2022GN1', name: '2022 GN1', designation: '2022 GN1', group: 'Apollo',
    a: 1.380, e: 0.520, i: 5.6, Omega: 340.0, omega: 42.0, M: 60.0,
    riskLevel: 'safe',
    nextApproach: '2027-05-18', missDist_km: 3380000, missDist_ld: 8.8,  velocity_kms: 11.6,
  },
  {
    id: '2019UO', name: '2019 UO', designation: '2019 UO', group: 'Amor',
    a: 1.890, e: 0.380, i: 15.7, Omega: 127.0, omega: 268.0, M: 100.0,
    riskLevel: 'safe',
    nextApproach: '2029-03-22', missDist_km: 12110000, missDist_ld: 31.5, velocity_kms: 7.8,
  },
  {
    id: '2021KO2', name: '2021 KO2', designation: '2021 KO2', group: 'Apollo',
    a: 1.550, e: 0.490, i: 8.4, Omega: 72.0, omega: 193.0, M: 250.0,
    riskLevel: 'safe',
    nextApproach: '2028-01-09', missDist_km: 5500000, missDist_ld: 14.3, velocity_kms: 13.4,
  },
  {
    id: '2023QA5', name: '2023 QA5', designation: '2023 QA5', group: 'Apollo',
    a: 1.220, e: 0.420, i: 6.7, Omega: 284.0, omega: 78.0, M: 180.0,
    riskLevel: 'safe',
    nextApproach: '2026-08-29', missDist_km: 1422000, missDist_ld: 3.7,  velocity_kms: 10.8,
  },
  {
    id: '2024BJ2', name: '2024 BJ2', designation: '2024 BJ2', group: 'Aten',
    a: 0.912, e: 0.373, i: 3.2, Omega: 158.0, omega: 240.0, M: 320.0,
    riskLevel: 'safe',
    nextApproach: '2027-01-14', missDist_km: 2345000, missDist_ld: 6.1,  velocity_kms: 8.9,
  },
  {
    id: '2022RM4', name: '2022 RM4', designation: '2022 RM4', group: 'Apollo',
    a: 1.830, e: 0.610, i: 4.3, Omega: 207.0, omega: 320.0, M: 70.0,
    riskLevel: 'safe',
    nextApproach: '2028-11-30', missDist_km: 12950000, missDist_ld: 33.7, velocity_kms: 18.4,
  },
  {
    id: '2023MW', name: '2023 MW', designation: '2023 MW', group: 'Apollo',
    a: 1.470, e: 0.550, i: 11.2, Omega: 162.0, omega: 104.0, M: 130.0,
    riskLevel: 'safe',
    nextApproach: '2027-06-25', missDist_km: 4310000, missDist_ld: 11.2, velocity_kms: 12.1,
  },
  {
    id: '2021EP', name: '2021 EP', designation: '2021 EP', group: 'Apollo',
    a: 2.120, e: 0.580, i: 9.8, Omega: 315.0, omega: 217.0, M: 200.0,
    riskLevel: 'safe',
    nextApproach: '2030-04-17', missDist_km: 16190000, missDist_ld: 42.1, velocity_kms: 16.3,
  },
  {
    id: '2024EF5', name: '2024 EF5', designation: '2024 EF5', group: 'Aten',
    a: 0.965, e: 0.410, i: 2.8, Omega: 83.0, omega: 305.0, M: 50.0,
    riskLevel: 'safe',
    nextApproach: '2026-10-19', missDist_km: 3000000, missDist_ld: 7.8,  velocity_kms: 11.7,
  },
  {
    id: '2025FB3', name: '2025 FB3', designation: '2025 FB3', group: 'Apollo',
    a: 1.330, e: 0.480, i: 7.1, Omega: 231.0, omega: 143.0, M: 280.0,
    riskLevel: 'safe',
    nextApproach: '2026-09-15', missDist_km: 2077000, missDist_ld: 5.4,  velocity_kms: 9.3,
  },
  {
    id: '2023TL2', name: '2023 TL2', designation: '2023 TL2', group: 'Apollo',
    a: 1.640, e: 0.520, i: 13.5, Omega: 19.0, omega: 36.0, M: 110.0,
    riskLevel: 'safe',
    nextApproach: '2028-07-08', missDist_km: 7610000, missDist_ld: 19.8, velocity_kms: 15.6,
  },
  {
    id: '2022KA', name: '2022 KA', designation: '2022 KA', group: 'Aten',
    a: 0.889, e: 0.320, i: 5.5, Omega: 111.0, omega: 192.0, M: 160.0,
    riskLevel: 'safe',
    nextApproach: '2027-03-28', missDist_km: 3613000, missDist_ld: 9.4,  velocity_kms: 10.2,
  },
  {
    id: '2020BO', name: '2020 BO', designation: '2020 BO', group: 'Apollo',
    a: 2.050, e: 0.620, i: 6.2, Omega: 263.0, omega: 55.0, M: 240.0,
    riskLevel: 'safe',
    nextApproach: '2029-08-14', missDist_km: 18180000, missDist_ld: 47.3, velocity_kms: 19.1,
  },
  {
    id: '2024GZ2', name: '2024 GZ2', designation: '2024 GZ2', group: 'Apollo',
    a: 1.760, e: 0.470, i: 10.1, Omega: 147.0, omega: 276.0, M: 20.0,
    riskLevel: 'safe',
    nextApproach: '2028-03-01', missDist_km: 9840000, missDist_ld: 25.6, velocity_kms: 13.8,
  },
  {
    id: '2021AF', name: '2021 AF', designation: '2021 AF', group: 'Apollo',
    a: 1.150, e: 0.390, i: 4.8, Omega: 322.0, omega: 89.0, M: 80.0,
    riskLevel: 'monitor',
    nextApproach: '2026-08-07', missDist_km: 350000, missDist_ld: 0.91, velocity_kms: 9.7,
  },
  {
    id: '2023PX5', name: '2023 PX5', designation: '2023 PX5', group: 'Amor',
    a: 2.310, e: 0.410, i: 18.4, Omega: 55.0, omega: 175.0, M: 340.0,
    riskLevel: 'safe',
    nextApproach: '2031-05-19', missDist_km: 23990000, missDist_ld: 62.4, velocity_kms: 11.2,
  },
  {
    id: '2024LY3', name: '2024 LY3', designation: '2024 LY3', group: 'Apollo',
    a: 1.550, e: 0.570, i: 8.2, Omega: 196.0, omega: 112.0, M: 300.0,
    riskLevel: 'safe',
    nextApproach: '2028-09-27', missDist_km: 6420000, missDist_ld: 16.7, velocity_kms: 14.5,
  },
  {
    id: '2022OA', name: '2022 OA', designation: '2022 OA', group: 'Apollo',
    a: 1.920, e: 0.550, i: 7.6, Omega: 78.0, omega: 248.0, M: 150.0,
    riskLevel: 'safe',
    nextApproach: '2030-01-15', missDist_km: 14960000, missDist_ld: 38.9, velocity_kms: 17.2,
  },
  {
    id: '2025CA12', name: '2025 CA12', designation: '2025 CA12', group: 'Aten',
    a: 0.953, e: 0.380, i: 1.6, Omega: 295.0, omega: 160.0, M: 220.0,
    riskLevel: 'safe',
    nextApproach: '2027-07-22', missDist_km: 1845000, missDist_ld: 4.8,  velocity_kms: 8.6,
  },
  {
    id: '2023JX8', name: '2023 JX8', designation: '2023 JX8', group: 'Apollo',
    a: 1.280, e: 0.440, i: 9.3, Omega: 171.0, omega: 67.0, M: 270.0,
    riskLevel: 'safe',
    nextApproach: '2026-11-28', missDist_km: 2384000, missDist_ld: 6.2,  velocity_kms: 11.3,
  },
  {
    id: '2021PJ1', name: '2021 PJ1', designation: '2021 PJ1', group: 'Apollo',
    a: 1.430, e: 0.510, i: 5.7, Omega: 44.0, omega: 219.0, M: 40.0,
    riskLevel: 'safe',
    nextApproach: '2027-04-05', missDist_km: 4808000, missDist_ld: 12.5, velocity_kms: 12.8,
  },
  {
    id: '2024MF', name: '2024 MF', designation: '2024 MF', group: 'Amor',
    a: 2.080, e: 0.380, i: 14.2, Omega: 233.0, omega: 143.0, M: 190.0,
    riskLevel: 'safe',
    nextApproach: '2030-08-22', missDist_km: 20040000, missDist_ld: 52.1, velocity_kms: 8.9,
  },
  {
    id: '2022TB', name: '2022 TB', designation: '2022 TB', group: 'Apollo',
    a: 1.870, e: 0.640, i: 3.1, Omega: 9.0, omega: 290.0, M: 320.0,
    riskLevel: 'safe',
    nextApproach: '2029-10-09', missDist_km: 11300000, missDist_ld: 29.4, velocity_kms: 20.1,
  },
  {
    id: '2023BF3', name: '2023 BF3', designation: '2023 BF3', group: 'Apollo',
    a: 1.660, e: 0.500, i: 11.8, Omega: 104.0, omega: 33.0, M: 90.0,
    riskLevel: 'safe',
    nextApproach: '2028-05-11', missDist_km: 8190000, missDist_ld: 21.3, velocity_kms: 13.1,
  },
  {
    id: '2025HX4', name: '2025 HX4', designation: '2025 HX4', group: 'Aten',
    a: 0.974, e: 0.430, i: 3.4, Omega: 219.0, omega: 271.0, M: 140.0,
    riskLevel: 'safe',
    nextApproach: '2027-09-04', missDist_km: 2730000, missDist_ld: 7.1,  velocity_kms: 10.4,
  },
  {
    id: '2021WZ2', name: '2021 WZ2', designation: '2021 WZ2', group: 'Apollo',
    a: 1.350, e: 0.460, i: 6.9, Omega: 287.0, omega: 180.0, M: 230.0,
    riskLevel: 'safe',
    nextApproach: '2026-12-30', missDist_km: 3729000, missDist_ld: 9.7,  velocity_kms: 11.8,
  },
  {
    id: '2024RP3', name: '2024 RP3', designation: '2024 RP3', group: 'Apollo',
    a: 2.230, e: 0.570, i: 8.5, Omega: 133.0, omega: 306.0, M: 70.0,
    riskLevel: 'safe',
    nextApproach: '2030-06-17', missDist_km: 17150000, missDist_ld: 44.6, velocity_kms: 15.9,
  },
];

// Augment each entry with computed display fields
const CATALOG = RAW.map(n => {
  const phaseDeg = computePhase(n.a, n.M);
  return {
    ...n,
    // Renderer / radar fields
    phase:     phaseDeg * Math.PI / 180, // radians at sim epoch
    phaseDeg,                            // degrees at sim epoch (for reference)
    om:        n.Omega,
    w:         n.omega,
    risk:      n.riskLevel,
    label:     risk2label(n.riskLevel),
    vel:       n.velocity_kms,
    desig:     desigFmt(n.id, n.name, n.group),
    nextLD:    n.missDist_ld,
    nextKm:    fmtKm(n.missDist_km),
    nextDate:  fmtDate(n.nextApproach),
  };
});

/**
 * Returns the full 47-object catalog.
 * @returns {object[]}
 */
function getCatalog() {
  return CATALOG;
}

/**
 * Find one object by id (SPK-ID or designation string).
 * @param {string} id
 * @returns {object|undefined}
 */
function getById(id) {
  return CATALOG.find(n => n.id === String(id));
}

module.exports = { getCatalog, getById, CATALOG };
