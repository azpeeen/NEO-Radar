'use strict';

const MOCK_NEOS = [
  {
    id: '99942', name: 'Apophis', designation: '99942', group: 'Aten',
    a: 0.9224, e: 0.1914, i: 3.34, omega: 126.42, Omega: 204.45, M: 88.36,
    riskLevel: 'caution', nextApproach: '2029-04-13',
    missDist_km: 31800, missDist_ld: 0.083, velocity_kms: 7.42,
  },
  {
    id: '2024YR4', name: '2024 YR4', designation: '2024 YR4', group: 'Apollo',
    a: 1.18, e: 0.66, i: 3.41, omega: 0, Omega: 0, M: 0,
    riskLevel: 'monitor', nextApproach: '2026-05-29',
    missDist_km: 273000, missDist_ld: 0.71, velocity_kms: 14.2,
  },
  {
    id: '101955', name: 'Bennu', designation: '101955', group: 'Apollo',
    a: 1.126, e: 0.204, i: 6.03, omega: 66.22, Omega: 2.06, M: 0,
    riskLevel: 'safe', nextApproach: '2026-06-27',
    missDist_km: 922000, missDist_ld: 2.4, velocity_kms: 9.1,
  },
  {
    id: '2025PT5', name: '2025 PT5', designation: '2025 PT5', group: 'Aten',
    a: 0.93, e: 0.41, i: 1.2, omega: 0, Omega: 0, M: 0,
    riskLevel: 'safe', nextApproach: '2026-05-27',
    missDist_km: 273000, missDist_ld: 0.71, velocity_kms: 14.2,
  },
];

module.exports = { MOCK_NEOS };
