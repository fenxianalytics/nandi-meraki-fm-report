import crypto from 'crypto';

const SHEET_ID = process.env.GOOGLE_SHEET_ID || '1MoVTnoHENqhZnoI0Gh8eNAKPzglaSELoo7RII_YaD-I';

// ── JWT / OAuth ──────────────────────────────────────────────────────────────

function b64url(input) {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function getAccessToken() {
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
  if (!sa.client_email || !sa.private_key) throw new Error('Missing service account credentials');

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }));

  const signingInput = `${header}.${claims}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const sig = b64url(sign.sign(sa.private_key));
  const jwt = `${signingInput}.${sig}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const tok = await resp.json();
  if (!tok.access_token) throw new Error(`Token error: ${JSON.stringify(tok)}`);
  return tok.access_token;
}

async function fetchTab(token, tabName) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tabName)}!A:AZ`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await resp.json();
  return json.values || [];
}

// ── Value parsers ─────────────────────────────────────────────────────────────

function safeNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = parseFloat(String(v).replace(/[₹,%\s]/g, '').replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

// Handles "Rs. 4.44 per sq. ft.", "Rs. 4.33/ per sq. ft.", etc.
function parseCostStr(v) {
  if (!v || String(v).trim() === '') return 0;
  const m = String(v).match(/[\d.]+(?=\s*\/?\s*per\s*sq)/i);
  if (m) return parseFloat(m[0]) || 0;
  const m2 = String(v).match(/\d+\.\d+/);
  if (m2) return parseFloat(m2[0]) || 0;
  return safeNum(v);
}

// Handles "107 (82 East + 25 South)", "Total 45", plain integers
function parseHandoverNum(v) {
  if (!v || String(v).trim() === '') return 0;
  const s = String(v);
  const mTotal = s.match(/[Tt]otal\s+(\d+)/);
  if (mTotal) return parseInt(mTotal[1], 10) || 0;
  const m = s.match(/\d+/);
  return m ? parseInt(m[0], 10) || 0 : 0;
}

function safeStr(v) {
  if (v === null || v === undefined || String(v).trim() === '') return 'N/A';
  return String(v).trim();
}

// ── Row lookup ────────────────────────────────────────────────────────────────

// Search col 0 of each row; keywords are treated as regex patterns
function findRow(rows, ...keywords) {
  for (const kw of keywords) {
    const re = new RegExp(kw, 'i');
    const row = rows.find(r => r[0] && re.test(String(r[0])));
    if (row) return row;
  }
  return null;
}

function getNumVals(rows, cols, parser, ...keywords) {
  const row = findRow(rows, ...keywords);
  if (!row) return cols.map(() => 0);
  return cols.map(c => parser(row[c] ?? ''));
}

function getStrVals(rows, cols, ...keywords) {
  const row = findRow(rows, ...keywords);
  if (!row) return cols.map(() => 'N/A');
  return cols.map(c => safeStr(row[c] ?? ''));
}

function getPlanVal(rows, planCol, ...keywords) {
  if (planCol < 0) return 0;
  const row = findRow(rows, ...keywords);
  if (!row) return 0;
  return safeNum(row[planCol] ?? '');
}

// ── Period map ────────────────────────────────────────────────────────────────
// Actual sheet column layout (from debug endpoint):
//   Col 0 : metric name
//   Col 1 : Q3 Plan   | Col 2: Oct | Col 3: Nov | Col 4: Dec
//   Col 5 : Q4 Plan   | Col 6: Jan | Col 7: Feb  (no March column)
//   Col 8 : Q1 Plan   | Col 9: Apr

const PERIOD_MAP = {
  'Q3 2025': {
    label: 'Q3 2025 (Oct–Dec)', dates: 'October – December 2025',
    months: ['Oct', 'Nov', 'Dec'], dataCols: [2, 3, 4], planCol: 1, type: 'quarter',
  },
  'Q4 2025': {
    label: 'Q4 2025 (Jan–Feb)', dates: 'January – February 2026',
    months: ['Jan', 'Feb'], dataCols: [6, 7], planCol: 5, type: 'quarter',
  },
  'Q1 2026': {
    label: 'Q1 2026 (Apr)', dates: 'April 2026',
    months: ['Apr'], dataCols: [9], planCol: 8, type: 'quarter',
  },
};

function resolvePeriod(period) {
  if (PERIOD_MAP[period]) return PERIOD_MAP[period];
  return { ...PERIOD_MAP['Q4 2025'], label: period, dates: period, type: 'week' };
}

// ── Status normalizer ─────────────────────────────────────────────────────────

function normalizeStatus(raw) {
  if (!raw || raw === 'N/A') return 'Pending';
  const l = raw.toLowerCase();
  if (l.includes('operational') || l.includes('active') || l.includes('running') ||
      l.includes('yes') || l.includes('done') || l.includes('functional')) return 'Operational';
  if (l.includes('partial') || l.includes('progress') || l.includes('ongoing') ||
      l.includes('initiated')) return 'Partial';
  if (l.includes('pending') || l.includes('not ') || l.includes('inactive') ||
      l.includes('no ')) return 'Pending';
  const frac = raw.match(/(\d+)\/(\d+)/);
  if (frac) {
    const pct = Number(frac[2]) > 0 ? Number(frac[1]) / Number(frac[2]) : 0;
    if (pct >= 0.8) return 'Operational';
    if (pct >= 0.4) return 'Partial';
    return 'Pending';
  }
  return 'Partial';
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const period = (req.query && req.query.period) || 'Q4 2025';
  const pInfo = resolvePeriod(period);
  const { months, dataCols, planCol } = pInfo;

  try {
    const token = await getAccessToken();

    const [monthlyResult, expensesResult, weeklyResult] = await Promise.allSettled([
      fetchTab(token, 'FM - monthly'),
      fetchTab(token, 'FM expenses by NHPL'),
      fetchTab(token, 'FM - weekly'),
    ]);

    const monthly  = monthlyResult.status  === 'fulfilled' ? monthlyResult.value  : [];
    const expenses = expensesResult.status === 'fulfilled' ? expensesResult.value : [];
    const weekly   = weeklyResult.status   === 'fulfilled' ? weeklyResult.value   : [];

    // ── Parse FM - monthly ──────────────────────────────────────────────────
    const mRows = monthly.slice(1);

    const costPerSqft   = getNumVals(mRows, dataCols, parseCostStr,
      'Maintenance Cost per sqft', 'cost per sqft', 'maintenance cost');

    const handedOver    = getNumVals(mRows, dataCols, parseHandoverNum,
      'Handover status', 'handed over', 'handover');

    const occupied      = getNumVals(mRows, dataCols, parseHandoverNum,
      'Occupied units', 'units occupied', 'occupied');

    const invoicesSent  = getNumVals(mRows, dataCols, safeNum,
      'Maintenance Accounts', 'maintenance account', 'invoice');

    const ticketsRcvd   = getNumVals(mRows, dataCols, safeNum,
      'Tickets received', 'ticket received', 'complaints received');

    const ticketsClosed = getNumVals(mRows, dataCols, safeNum,
      'Tickets closed', 'ticket closed', 'complaints closed');

    // Ticket categories
    const tcatKeywords = [
      ['Plumbing',     'plumbing'],
      ['Electrical',   'electrical'],
      ['Carpentry',    'carpentry', 'carpenter'],
      ['Hot Water',    'hot water', 'geyser'],
      ['Seepage',      'seepage', 'leakage', 'leak'],
      ['Common Area',  'common area'],
      ['Video Door',   'video door', 'vdp', 'intercom'],
      ['Housekeeping', 'housekeeping', 'cleaning'],
    ];
    const ticketCategories = tcatKeywords.map(([name, ...kws]) => ({
      name,
      count: getNumVals(mRows, dataCols, safeNum, ...kws).reduce((a, b) => a + b, 0),
    })).filter(c => c.count > 0).sort((a, b) => b.count - a.count);

    // Sustainability — one row per system in the sheet
    const sustainDefs = [
      { key: 'ecoSTP',              label: 'Eco-STP',               kws: ['Eco STP', 'eco-stp', 'ecostp'] },
      { key: 'solar',               label: 'Solar Net Metering',     kws: ['Solar', 'net meter'] },
      { key: 'heatPump',            label: 'Heat Pump',              kws: ['Heat pump'] },
      { key: 'hasirudala',          label: 'Hasirudala Waste',       kws: ['Hasiru Dala', 'hasirudala', 'waste management'] },
      { key: 'waterTreatment',      label: 'Water Treatment',        kws: ['Water meter', 'water treatment', 'wtp'] },
      { key: 'implementationIdeas', label: 'Implementation Ideas',   kws: ['implementation idea', 'implementation'] },
    ];
    const sustainability = sustainDefs.map(({ key, label, kws }) => {
      const vals = getStrVals(mRows, dataCols, ...kws);
      const raw = [...vals].reverse().find(v => v !== 'N/A') || 'N/A';
      return { key, label, rawValue: raw, status: normalizeStatus(raw) };
    });

    // Works progress
    const eastCompleted  = getNumVals(mRows, dataCols, safeNum, 'east block.*complet', 'east.*done', 'east completed').reduce((a,b)=>a+b,0);
    const eastTotal      = getNumVals(mRows, dataCols, safeNum, 'east block.*total',   'east.*total').reduce((a,b)=>a+b,0);
    const southCompleted = getNumVals(mRows, dataCols, safeNum, 'south block.*complet','south.*done', 'south completed').reduce((a,b)=>a+b,0);
    const southTotal     = getNumVals(mRows, dataCols, safeNum, 'south block.*total',  'south.*total').reduce((a,b)=>a+b,0);

    // Plan targets
    const planCostPerSqft   = getPlanVal(mRows, planCol, 'Maintenance Cost per sqft', 'cost per sqft') || 5;
    const planTicketResRate = getPlanVal(mRows, planCol, 'resolution rate', 'ticket resolution') || 85;
    const planOccupancy     = getPlanVal(mRows, planCol, 'occupancy', 'occupied') || 60;

    // Derived
    const totalTicketsRcvd   = ticketsRcvd.reduce((a,b)=>a+b,0);
    const totalTicketsClosed = ticketsClosed.reduce((a,b)=>a+b,0);
    const resolutionRate     = totalTicketsRcvd > 0 ? Math.round((totalTicketsClosed / totalTicketsRcvd) * 100) : 0;
    const nonZeroCosts       = costPerSqft.filter(v => v > 0);
    const avgCostPerSqft     = nonZeroCosts.length > 0
      ? Math.round((nonZeroCosts.reduce((a,b)=>a+b,0) / nonZeroCosts.length) * 100) / 100
      : 0;
    const totalHandedOver = handedOver.reduce((a,b)=>a+b,0);
    const totalOccupied   = occupied.reduce((a,b)=>a+b,0);
    const occupancyRate   = totalHandedOver > 0 ? Math.round((totalOccupied / totalHandedOver) * 100) : 0;
    const topCategory     = ticketCategories[0]?.name || 'N/A';

    // ── Parse FM expenses ───────────────────────────────────────────────────
    const eHeaders = expenses[0] || [];
    const eRows    = expenses.slice(1);
    // Expenses tab uses named month headers — keep dynamic lookup for this tab
    const eCols = months.map(m => {
      const i = eHeaders.findIndex(h => h && String(h).toLowerCase().includes(m.toLowerCase()));
      return i !== -1 ? i : -1;
    });

    const catKeywords = [
      ['Housekeeping',      'housekeeping', 'cleaning'],
      ['Security',          'security', 'guard'],
      ['Maintenance Staff', 'maintenance staff', 'technician', 'plumber'],
      ['Utilities',         'utilities', 'electricity', 'water bill', 'eb ', 'bwssb'],
      ['Horticulture',      'horticulture', 'gardening', 'landscap'],
      ['Repairs',           'repair', 'material', 'spares'],
      ['Administrative',    'admin', 'management fee', 'audit', 'professional'],
    ];

    const expCategories = catKeywords.map(([name, ...kws]) => {
      let amount = 0;
      eRows.forEach(row => {
        const label = safeStr(row[0]).toLowerCase();
        if (kws.some(kw => label.includes(kw))) {
          amount += eCols.reduce((acc, ci) => acc + (ci === -1 ? 0 : safeNum(row[ci])), 0);
        }
      });
      return { name, amount: Math.round(amount) };
    }).filter(c => c.amount > 0).sort((a,b) => b.amount - a.amount);

    const totalExpenses = expCategories.reduce((a,c) => a + c.amount, 0);

    // ── Parse FM weekly ─────────────────────────────────────────────────────
    const wHeaders = weekly[0] || [];
    const wRows    = weekly.slice(1);
    const wkCol    = wHeaders.findIndex(h => h && /week/i.test(h));
    const dtCol    = wHeaders.findIndex(h => h && /date/i.test(h));
    const topicCol = wHeaders.findIndex(h => h && /topic|activity/i.test(h));
    const stCol    = wHeaders.findIndex(h => h && /status/i.test(h));
    const notesCol = wHeaders.findIndex(h => h && /notes|remark|comment/i.test(h));

    const weeklyItems = wRows
      .filter(row => row && row.some(c => c))
      .map(row => ({
        week:   safeStr(row[wkCol]),
        date:   safeStr(row[dtCol]),
        topic:  safeStr(row[topicCol]),
        status: safeStr(row[stCol]),
        notes:  safeStr(row[notesCol]),
      }))
      .filter(w => {
        if (pInfo.type === 'week') return w.week.toLowerCase().includes(period.toLowerCase());
        return true;
      })
      .slice(0, 20);

    // ── Assemble response ───────────────────────────────────────────────────
    return res.status(200).json({
      period,
      periodLabel:  pInfo.label,
      periodDates:  pInfo.dates,
      months,
      plan: {
        costPerSqft:          planCostPerSqft,
        ticketResolutionRate: planTicketResRate,
        occupancyRate:        planOccupancy,
      },
      maintenance: {
        costPerSqft,
        avgCostPerSqft,
        goalLine: 5,
        invoicesSent,
      },
      expenses: {
        total:      totalExpenses,
        categories: expCategories,
      },
      tickets: {
        received:      ticketsRcvd,
        closed:        ticketsClosed,
        totalReceived: totalTicketsRcvd,
        totalClosed:   totalTicketsClosed,
        resolutionRate,
        categories:    ticketCategories,
        topCategory,
      },
      handover: {
        handedOver,
        occupied,
        totalHandedOver,
        totalOccupied,
        occupancyRate,
        benchmarkRate: 60,
      },
      sustainability,
      works: {
        eastBlock:  { completed: eastCompleted,  total: eastTotal,  pct: eastTotal  > 0 ? Math.round(eastCompleted  / eastTotal  * 100) : 0 },
        southBlock: { completed: southCompleted, total: southTotal, pct: southTotal > 0 ? Math.round(southCompleted / southTotal * 100) : 0 },
      },
      weekly: weeklyItems,
    });

  } catch (err) {
    console.error('sheets.js error:', err);
    return res.status(200).json({
      period,
      periodLabel: pInfo.label,
      periodDates: pInfo.dates,
      months,
      plan: { costPerSqft: 5, ticketResolutionRate: 85, occupancyRate: 60 },
      maintenance: { costPerSqft: [], avgCostPerSqft: 0, goalLine: 5, invoicesSent: [] },
      expenses: { total: 0, categories: [] },
      tickets: { received: [], closed: [], totalReceived: 0, totalClosed: 0, resolutionRate: 0, categories: [], topCategory: 'N/A' },
      handover: { handedOver: [], occupied: [], totalHandedOver: 0, totalOccupied: 0, occupancyRate: 0, benchmarkRate: 60 },
      sustainability: [],
      works: { eastBlock: { completed: 0, total: 0, pct: 0 }, southBlock: { completed: 0, total: 0, pct: 0 } },
      weekly: [],
      _error: err.message,
    });
  }
}
