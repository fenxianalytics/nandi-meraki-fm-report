/**
 * test-sheets.js — run with: node test-sheets.js [period] [type]
 *
 * Reads env vars from a local .env file if present, then calls
 * Google Sheets directly and prints raw output before any parsing.
 *
 * Examples:
 *   node test-sheets.js
 *   node test-sheets.js "Q1 2026" quarter
 *   node test-sheets.js Apr month
 *   node test-sheets.js weekly-latest week
 *
 * Or set env vars inline (PowerShell):
 *   $env:GOOGLE_SHEET_ID="..."; $env:GOOGLE_SERVICE_ACCOUNT_JSON='...'; node test-sheets.js
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ── Load .env.local with multi-line JSON support ──────────────────────────────
// dotenv truncates values at the first real newline, which breaks service
// account JSON (the private_key contains actual \n characters).
// This parser reads the raw file and handles that case.
const __dir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dir, '.env.local');
if (!fs.existsSync(envPath)) {
  console.error('No .env.local file found at', envPath);
  process.exit(1);
}

function loadEnvLocal(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const result = {};
  let i = 0;
  while (i < raw.length) {
    // Skip blank lines and comments
    if (raw[i] === '\n' || raw[i] === '\r' || raw[i] === '#') {
      i = raw.indexOf('\n', i); if (i === -1) break; i++; continue;
    }
    // Read key
    const eq = raw.indexOf('=', i);
    if (eq === -1) break;
    const key = raw.slice(i, eq).trim();
    i = eq + 1;
    // Read value — three cases:
    // 1. Starts with { → read until the matching closing }
    // 2. Starts with " or ' → read until closing quote (same char)
    // 3. Otherwise → read until end of line
    let value = '';
    if (raw[i] === '{') {
      // JSON object — track brace depth, preserve content verbatim
      let depth = 0, start = i;
      while (i < raw.length) {
        if (raw[i] === '{') depth++;
        else if (raw[i] === '}') { depth--; if (depth === 0) { i++; break; } }
        i++;
      }
      value = raw.slice(start, i).trim();
    } else if (raw[i] === '"' || raw[i] === "'") {
      const q = raw[i]; i++;
      const end = raw.indexOf(q, i);
      value = end === -1 ? raw.slice(i) : raw.slice(i, end);
      i = end === -1 ? raw.length : end + 1;
    } else {
      const end = raw.indexOf('\n', i);
      value = (end === -1 ? raw.slice(i) : raw.slice(i, end)).trim();
      i = end === -1 ? raw.length : end + 1;
    }
    if (key) result[key] = value;
    // Advance past newline
    if (i < raw.length && (raw[i] === '\n' || raw[i] === '\r')) i++;
  }
  return result;
}

const parsed = loadEnvLocal(envPath);
for (const [k, v] of Object.entries(parsed)) {
  if (!process.env[k]) process.env[k] = v;
}
console.log('Loaded .env.local — keys:', Object.keys(parsed).join(', '));
console.log('GOOGLE_SERVICE_ACCOUNT_JSON length:', (parsed.GOOGLE_SERVICE_ACCOUNT_JSON || '').length, '\n');

// ── Args ──────────────────────────────────────────────────────────────────────
const PERIOD = process.argv[2] || 'Q1 2026';
const TYPE   = process.argv[3] || 'quarter';
const SHEET_ID = process.env.GOOGLE_SHEET_ID || '1MoVTnoHENqhZnoI0Gh8eNAKPzglaSELoo7RII_YaD-I';

// ── Auth ──────────────────────────────────────────────────────────────────────
function b64url(buf) {
  return (typeof buf === 'string' ? Buffer.from(buf) : buf)
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function getAccessToken() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is not set');

  let sa;
  try {
    sa = JSON.parse(raw);
  } catch (e) {
    throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ${e.message}`);
  }

  if (!sa.private_key)   throw new Error('Service account JSON missing private_key');
  if (!sa.client_email)  throw new Error('Service account JSON missing client_email');

  // Fix escaped newlines — required when JSON is set as an env var
  sa.private_key = sa.private_key.replace(/\\n/g, '\n');

  console.log(`Auth: client_email = ${sa.client_email}`);
  console.log(`Auth: private_key starts with: ${sa.private_key.slice(0, 40).replace(/\n/g, '\\n')}...`);

  const now = Math.floor(Date.now() / 1000);
  const hdr = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const cls = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }));

  const sigInput = `${hdr}.${cls}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(sigInput);
  const jwt = `${sigInput}.${b64url(sign.sign(sa.private_key))}`;

  console.log('Auth: JWT built, requesting token...');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  const tokenResp = await r.json();
  if (tokenResp.error) {
    throw new Error(`OAuth error: ${tokenResp.error} — ${tokenResp.error_description}`);
  }
  if (!tokenResp.access_token) {
    throw new Error(`No access_token in response: ${JSON.stringify(tokenResp)}`);
  }
  console.log('Auth: token obtained OK\n');
  return tokenResp.access_token;
}

// ── Fetch ─────────────────────────────────────────────────────────────────────
async function fetchTab(token, tabName) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tabName)}!A:AZ?valueRenderOption=UNFORMATTED_VALUE`;
  console.log(`Fetching: ${url}`);
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await r.json();

  if (json.error) {
    console.error(`  ERROR from Sheets API: ${json.error.code} ${json.error.message}`);
    return [];
  }

  const values = json.values || [];
  console.log(`  → ${values.length} rows, ${values[0]?.length ?? 0} cols in first row`);
  return values;
}

// ── Print helpers ─────────────────────────────────────────────────────────────
function printRows(label, rows, maxRows = 5) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${label} (first ${Math.min(maxRows, rows.length)} of ${rows.length} rows):`);
  rows.slice(0, maxRows).forEach((row, i) => {
    console.log(`  [${i}]`, JSON.stringify(row));
  });
}

function printRowCols(label, row, colStart, colEnd) {
  if (!row) { console.log(`\n${label}: ROW NOT FOUND`); return; }
  console.log(`\n${label} (cols ${colStart}–${colEnd}):`);
  const slice = (row || []).slice(colStart, colEnd + 1);
  slice.forEach((cell, i) => {
    console.log(`  col${colStart + i}: ${JSON.stringify(cell)}`);
  });
}

function findRow(rows, ...keywords) {
  for (const kw of keywords) {
    const re = new RegExp(kw, 'i');
    const row = rows.find(r => r?.[0] && re.test(String(r[0])));
    if (row) return row;
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(60));
  console.log(`test-sheets.js  period="${PERIOD}"  type="${TYPE}"`);
  console.log(`Sheet ID: ${SHEET_ID}`);
  console.log('='.repeat(60) + '\n');

  const token = await getAccessToken();

  const [mRaw, eRaw, wRaw] = await Promise.all([
    fetchTab(token, 'FM - monthly'),
    fetchTab(token, 'FM expenses by NHPL'),
    fetchTab(token, 'FM - weekly'),
  ]);

  // ── FM - monthly ────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  console.log('FM - MONTHLY (raw)');
  console.log('='.repeat(60));

  printRows('Header + first 5 rows', mRaw, 6);

  const mRows = mRaw.slice(1);
  console.log('\nAll row[0] values (col A = metric name):');
  mRows.forEach((r, i) => {
    if (r?.[0]) console.log(`  mRow[${i}]: "${r[0]}"`);
  });

  // Key rows
  const KEYS = [
    { label: 'Handover status',            kws: ['Handover status', 'handed over', 'handover'] },
    { label: 'Maintenance Cost per sqft',  kws: ['Maintenance Cost per sqft', 'cost per sqft', 'maintenance cost'] },
    { label: 'Maintenance Accounts',       kws: ['Maintenance Accounts', 'maintenance account', 'invoice'] },
    { label: 'MyGate Complaints',          kws: ['MyGate Complaints', 'complaints', 'mygate'] },
    { label: 'East Block Balance work',    kws: ['East Block Balance work', 'east block balance'] },
    { label: 'South Block Balance Work',   kws: ['South Block Balance Work', 'south block balance'] },
    { label: 'Implementation of ideas',    kws: ['Implementation of ideas', 'implementation of idea'] },
    { label: 'Sustainable interventions',  kws: ['Sustainable', 'sustainability'] },
  ];

  // Month column indices (per spec)
  const MCOL = { Oct: 2, Nov: 3, Dec: 4, Jan: 6, Feb: 7, Apr: 9 };
  const MONTHS_ALL = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Apr'];

  console.log('\n' + '─'.repeat(60));
  console.log('KEY ROW CONTENTS (month columns 2,3,4,6,7,9 = Oct–Apr):');
  for (const { label, kws } of KEYS) {
    const row = findRow(mRows, ...kws);
    if (!row) {
      console.log(`\n  [NOT FOUND] "${label}" — tried: ${kws.join(', ')}`);
      continue;
    }
    console.log(`\n  ✓ "${row[0]}":`);
    MONTHS_ALL.forEach(m => {
      const val = row[MCOL[m]];
      console.log(`    ${m} (col${MCOL[m]}): ${JSON.stringify(val)}`);
    });
  }

  // ── FM expenses by NHPL ─────────────────────────────────────────────────────
  console.log('\n\n' + '='.repeat(60));
  console.log('FM EXPENSES BY NHPL (raw)');
  console.log('='.repeat(60));

  printRows('First 8 rows', eRaw, 8);

  console.log('\nExpenses cols 13–20 for first 15 rows:');
  eRaw.slice(0, 15).forEach((row, i) => {
    const slice = (row || []).slice(13, 21);
    if (slice.some(v => v)) {
      console.log(`  eRaw[${i}] col0="${row[0]}" | cols13-20: ${JSON.stringify(slice)}`);
    }
  });

  console.log('\nExpenses: last 15 rows (looking for summary table):');
  eRaw.slice(-15).forEach((row, i) => {
    const ri = eRaw.length - 15 + i;
    const slice = (row || []).slice(13, 21);
    if (slice.some(v => v) || row?.[0]) {
      console.log(`  eRaw[${ri}] col0="${row[0]}" | cols13-20: ${JSON.stringify(slice)}`);
    }
  });

  // Check date-like detection on col14
  console.log('\nExpenses: rows where col14 looks like a date:');
  eRaw.forEach((row, i) => {
    const v = row?.[14];
    if (!v) return;
    const s = String(v).trim();
    const isDate = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(s)
      || /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(s)
      || (!isNaN(Number(s)) && Number(s) > 40000 && Number(s) < 55000 && !s.includes('.'));
    if (isDate) {
      console.log(`  eRaw[${i}] col14="${v}" col15="${row[15]}" col16="${row[16]}" col18="${row[18]}" col19="${row[19]}"`);
    }
  });

  // ── FM - weekly ─────────────────────────────────────────────────────────────
  console.log('\n\n' + '='.repeat(60));
  console.log('FM - WEEKLY (raw)');
  console.log('='.repeat(60));

  printRows('All weekly rows', wRaw, wRaw.length);

  console.log('\nWeekly: col1 (topic) | col2 (latest) | col3 (previous):');
  wRaw.forEach((row, i) => {
    if (row?.[1]) {
      console.log(`  wRaw[${i}] col1="${row[1]}" | col2=${JSON.stringify(row[2])} | col3=${JSON.stringify(row[3])}`);
    }
  });

  console.log('\n' + '='.repeat(60));
  console.log('Done.');
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
