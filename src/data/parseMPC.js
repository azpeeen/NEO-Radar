'use strict';

const fs   = require('fs');
const path = require('path');

const MPC_FILE = path.join(__dirname, 'nea_mpc.txt');

// Packed MPC epoch letter → century base year
const CENTURY = { I: 1800, J: 1900, K: 2000 };

// Month letter decode: 1-9 = Jan-Sep, A=Oct, B=Nov, C=Dec
function decodeMonth(ch) {
  if (ch >= '1' && ch <= '9') return parseInt(ch, 10);
  if (ch === 'A') return 10;
  if (ch === 'B') return 11;
  if (ch === 'C') return 12;
  return NaN;
}

// Day letter decode: 1-9 = 1-9, A=10 .. V=31
function decodeDay(ch) {
  if (ch >= '1' && ch <= '9') return parseInt(ch, 10);
  const code = ch.charCodeAt(0) - 55; // 'A'=65 → 10, 'B'→11, ..., 'V'→31
  if (code >= 10 && code <= 31) return code;
  return NaN;
}

// Gregorian calendar to Julian Day Number (0h TT = JDN − 0.5)
function gregorianToJD(year, month, day) {
  const A = Math.floor((14 - month) / 12);
  const y = year + 4800 - A;
  const m = month + 12 * A - 3;
  const JDN = day
    + Math.floor((153 * m + 2) / 5)
    + 365 * y
    + Math.floor(y / 4)
    - Math.floor(y / 100)
    + Math.floor(y / 400)
    - 32045;
  return JDN - 0.5; // 0h TT
}

// Decode packed MPC epoch (e.g. "K25BL") → Julian Date
function decodeMPCEpoch(packed) {
  if (!packed || packed.length < 5) return NaN;
  const century = CENTURY[packed[0]];
  if (century === undefined) return NaN;
  const year  = century + parseInt(packed.slice(1, 3), 10);
  const month = decodeMonth(packed[3]);
  const day   = decodeDay(packed[4]);
  if (isNaN(year) || isNaN(month) || isNaN(day)) return NaN;
  return gregorianToJD(year, month, day);
}

/**
 * Parse the MPC MPCORB.DES fixed-width file.
 * Column ranges are 0-indexed, end-inclusive → JS slice(start, end+1).
 *
 * Returns array of:
 *   { designation, H, epoch_jd, M, w, node, i, e, a, name }
 */
function parseMPC(filePath = MPC_FILE) {
  const text  = fs.readFileSync(filePath, 'utf8');
  const lines = text.split('\n');
  const result = [];

  for (const line of lines) {
    if (line.length < 104) continue;

    const designation = line.slice(0, 7).trim();
    if (!designation) continue;

    const H         = parseFloat(line.slice(8,  13));
    const epoch_jd  = decodeMPCEpoch(line.slice(20, 25).trim());
    const M         = parseFloat(line.slice(26, 36));
    const w         = parseFloat(line.slice(37, 47));
    const node      = parseFloat(line.slice(48, 58));
    const i         = parseFloat(line.slice(59, 69));
    const e         = parseFloat(line.slice(70, 80));
    const a         = parseFloat(line.slice(92, 104));
    const name      = line.length > 166 ? line.slice(166, 194).trim() : '';

    if (
      isNaN(H) || isNaN(epoch_jd) || isNaN(M) || isNaN(w) ||
      isNaN(node) || isNaN(i) || isNaN(e) || isNaN(a) || a <= 0
    ) continue;

    result.push({ designation, H, epoch_jd, M, w, node, i, e, a, name });
  }

  return result;
}

module.exports = { parseMPC };
