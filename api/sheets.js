import crypto from 'crypto';

const SHEET_ID = process.env.GOOGLE_SHEET_ID || '1MoVTnoHENqhZnoI0Gh8eNAKPzglaSELoo7RII_YaD-I';

function b64url(buf) {
  return (typeof buf === 'string' ? Buffer.from(buf) : buf)
    .toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

async function getAccessToken() {
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
  if (!sa.private_key) throw new Error('Missing service account');
  sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const hdr = b64url(JSON.stringify({ alg:'RS256', typ:'JWT' }));
  const cls = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, iat: now,
  }));
  const si = `${hdr}.${cls}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(si);
  const jwt = `${si}.${b64url(sign.sign(sa.private_key))}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const t = await r.json();
  if (!t.access_token) throw new Error(`Token error: ${JSON.stringify(t)}`);
  return t.access_token;
}

async function fetchTab(token, tab) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tab)}!A:AZ?valueRenderOption=UNFORMATTED_VALUE`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await r.json();
  if (json.error) throw new Error(`Sheets API error for "${tab}": ${json.error.message}`);
  return json.values || [];
}

// Line items to skip (non-individual expense rows)
const SKIP_NAMES = /budget|sharing|residents|nhpl|total/i;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const token = await getAccessToken();
    const [mR, eR, wR] = await Promise.allSettled([
      fetchTab(token, 'FM - monthly'),
      fetchTab(token, 'FM expenses by NHPL'),
      fetchTab(token, 'FM - weekly'),
    ]);
    const mRaw = mR.status === 'fulfilled' ? mR.value : [];
    const eRaw = eR.status === 'fulfilled' ? eR.value : [];
    const wRaw = wR.status === 'fulfilled' ? wR.value : [];

    // FM-monthly: header row + data rows 1–12
    // Col mapping: col2=Oct, col3=Nov, col4=Dec, col6=Jan, col7=Feb, col9=Apr
    const monthly = {
      headers: (mRaw[0] || []).map(String),
      rows: mRaw.slice(1, 13).map((cells, i) => ({
        index: i + 1,
        col0: String(cells?.[0] || ''),
        cells: (cells || []).slice(0, 12).map(c => (c === undefined || c === null) ? '' : c),
      })),
    };

    // FM expenses summary: rows 35–41 (0-indexed), hardcoded positions
    // col15=events, col16=security, col18=pest, col19=total (UNFORMATTED = raw numbers)
    const EXP_MONTHS = ['Oct-25', 'Nov-25', 'Dec-25', 'Jan-26', 'Feb-26', 'Mar-26', 'Apr-26'];
    const summaryRows = EXP_MONTHS.map((month, i) => {
      const row = eRaw[35 + i] || [];
      return {
        month,
        events:   Number(row[15] || 0),
        security: Number(row[16] || 0),
        pest:     Number(row[18] || 0),
        total:    Number(row[19] || 0),
      };
    });

    // FM expenses line items: rows 0–34
    // Col mapping: col13=Oct, col14=Nov, col15=Dec, col16=Jan, col18=Feb, col19=Mar, col20=Apr
    const lineItems = [];
    for (let i = 0; i < Math.min(35, eRaw.length); i++) {
      const row = eRaw[i] || [];
      const name = String(row[0] || '').trim();
      if (!name || name.length < 3 || SKIP_NAMES.test(name)) continue;
      const oct = Number(row[13] || 0), nov = Number(row[14] || 0), dec = Number(row[15] || 0);
      const jan = Number(row[16] || 0), feb = Number(row[18] || 0);
      const mar = Number(row[19] || 0), apr = Number(row[20] || 0);
      if (oct + nov + dec + jan + feb + mar + apr === 0) continue;
      lineItems.push({ name, oct, nov, dec, jan, feb, mar, apr });
    }

    // FM-weekly: all rows with a topic (col1)
    const weekly = {
      rows: wRaw
        .map((cells, i) => ({
          index: i,
          col1: String(cells?.[1] || ''),
          col2: String(cells?.[2] || ''),
          col3: String(cells?.[3] || ''),
        }))
        .filter(r => r.col1),
    };

    return res.status(200).json({
      fetchTime: new Date().toISOString(),
      monthly,
      expenses: { summaryRows, lineItems },
      weekly,
    });

  } catch (err) {
    console.error('sheets.js error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
