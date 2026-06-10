import crypto from 'crypto';

const SHEET_IDS = {
  fm: process.env.GOOGLE_SHEET_ID_FM || '1ZuOkst1VvzmmnZUxYHSPOKPwz9J_KeTHt_2_suUQqpo',
  dm: process.env.GOOGLE_SHEET_ID_DM || '1Oz-eYtOb8gJtmtLVd5nNpOOSNu6QYQq70ONt5Jrl8LI',
  lr: process.env.GOOGLE_SHEET_ID_LR || '14seJ2f5gghZMMkhJgnV_pnj09lSLyDlo1trSQZwOIso',
};

const DEPT_TABS = {
  fm: [
    { name: 'Handover',       range: 'A:K' },
    { name: 'Complaints',     range: 'A:V' },
    { name: 'Billing',        range: 'A:J' },
    { name: 'Sustainability', range: 'A:J' },
    { name: 'Expenses',       range: 'A:G' },
    { name: 'Staffing',       range: 'A:J' },
    { name: 'Ideas',          range: 'A:I' },
  ],
  dm: [
    { name: 'DM monthly report', range: 'A:BH' },
    { name: 'DM expenses',       range: 'A:AM' },
  ],
  lr: [
    { name: 'Land tracker/Meraki tracker', range: 'A:L' },
    { name: 'Assets',           range: 'A:H' },
    { name: 'PLAN VS ACHEIVED', range: 'A:L' },
    { name: 'Cases',            range: 'A:J' },
  ],
};

function b64url(buf) {
  return (typeof buf === 'string' ? Buffer.from(buf) : buf)
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function getAccessToken() {
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
  if (!sa.private_key) throw new Error('Missing service account credentials');
  sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const hdr = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
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

function rowsToText(rows, maxRows = 200) {
  return rows
    .slice(0, maxRows)
    .map(row => row.map(cell => String(cell ?? '').replace(/\n/g, ' ').slice(0, 300)).join(' | '))
    .filter(line => line.replace(/\|/g, '').trim())
    .join('\n');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const dept = ((req.query && req.query.dept) || 'fm').toLowerCase();
  if (!DEPT_TABS[dept]) {
    return res.status(400).json({ error: `Invalid dept "${dept}". Use fm, dm, or lr.` });
  }

  try {
    const token = await getAccessToken();
    const sheetId = SHEET_IDS[dept];
    const tabConfig = DEPT_TABS[dept];

    const settled = await Promise.allSettled(
      tabConfig.map(async ({ name, range }) => {
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(name)}!${range}?valueRenderOption=UNFORMATTED_VALUE`;
        const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        const json = await r.json();
        if (json.error) throw new Error(`Sheets error for "${name}": ${json.error.message}`);
        return { name, rows: json.values || [] };
      })
    );

    const tabs = {};
    for (let i = 0; i < settled.length; i++) {
      const tabName = tabConfig[i].name;
      if (settled[i].status === 'fulfilled') {
        tabs[tabName] = rowsToText(settled[i].value.rows);
      } else {
        tabs[tabName] = `ERROR: ${settled[i].reason?.message || 'Unknown error'}`;
      }
    }

    return res.status(200).json({ dept, fetchTime: new Date().toISOString(), tabs });

  } catch (err) {
    console.error('sheets.js error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
