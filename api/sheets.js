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

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = parseFloat(String(v).replace(/[₹,%\s,]/g, ''));
  return isNaN(n) ? 0 : n;
}

function safeStr(v) {
  if (v === null || v === undefined || String(v).trim() === '') return 'N/A';
  return String(v).trim();
}

function findColIdx(headers, ...keywords) {
  for (const kw of keywords) {
    const i = headers.findIndex(h => h && String(h).toLowerCase().includes(kw.toLowerCase()));
    if (i !== -1) return i;
  }
  return -1;
}

function findRowIdx(rows, ...keywords) {
  for (const kw of keywords) {
    const i = rows.findIndex(r => r[0] && String(r[0]).toLowerCase().includes(kw.toLowerCase()));
    if (i !== -1) return i;
  }
  return -1;
}

function rowVals(rows, rowIdx, colIdxArr) {
  if (rowIdx === -1) return colIdxArr.map(() => 0);
  const row = rows[rowIdx] || [];
  return colIdxArr.map(ci => (ci === -1 ? 0 : safeNum(row[ci])));
}

function rowStrVals(rows, rowIdx, colIdxArr) {
  if (rowIdx === -1) return colIdxArr.map(() => 'N/A');
  const row = rows[rowIdx] || [];
  return colIdxArr.map(ci => (ci === -1 ? 'N/A' : safeStr(row[ci])));
}

// ── Period helpers ───────────────────────────────────────────────────────────

const PERIOD_MAP = {
  'Q3 2025': { months: ['Oct', 'Nov', 'Dec'], label: 'Q3 2025 (Oct–Dec)', dates: 'October – December 2025', planKey: 'Q3 Plan' },
  'Q4 2025': { months: ['Jan', 'Feb', 'Mar'], label: 'Q4 2025 (Jan–Mar)', dates: 'January – March 2026', planKey: 'Q4 Plan' },
  'Q1 2026': { months: ['Apr', 'May', 'Jun'], label: 'Q1 2026 (Apr–Jun)', dates: 'April – June 2026', planKey: 'Q1 Plan' },
};

const MONTH_SINGLES = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May'];

function resolvePeriod(period) {
  if (PERIOD_MAP[period]) return { ...PERIOD_MAP[period], type: 'quarter' };
  if (MONTH_SINGLES.includes(period)) {
    return { months: [period], label: period, dates: period + ' 2025/2026', planKey: null, type: 'month' };
  }
  // Week — return all months so data is available
  return { months: ['Jan', 'Feb', 'Mar'], label: period, dates: period, planKey: 'Q4 Plan', type: 'week' };
}

// ── Status normalizer ────────────────────────────────────────────────────────

function normalizeStatus(raw) {
  if (!raw || raw === 'N/A') return 'Pending';
  const l = raw.toLowerCase();
  if (l.includes('operational') || l.includes('active') || l.includes('running') || l.includes('yes') || l.includes('done')) return 'Operational';
  if (l.includes('partial') || l.includes('progress') || l.includes('ongoing') || l.includes('initiated')) return 'Partial';
  if (l.includes('pending') || l.includes('not') || l.includes('inactive') || l.includes('no')) return 'Pending';
  if (raw.match(/\d+\/\d+/)) {
    const [a, b] = raw.split('/').map(Number);
    const pct = b > 0 ? a / b : 0;
    if (pct >= 0.8) return 'Operational';
    if (pct >= 0.4) return 'Partial';
    return 'Pending';
  }
  return 'Partial';
}

// ── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const period = (req.query && req.query.period) || 'Q4 2025';
  const pInfo = resolvePeriod(period);
  const { months } = pInfo;

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
    const mHeaders = monthly[0] || [];
    const mRows = monthly.slice(1);

    // Find column indices for each month
    const mCols = months.map(m => findColIdx(mHeaders, m));
    // Plan column
    const planCol = pInfo.planKey ? findColIdx(mHeaders, pInfo.planKey) : -1;

    const getVals = (...keywords) => {
      const ri = findRowIdx(mRows, ...keywords);
      return rowVals(mRows, ri, mCols);
    };

    const getPlanVal = (...keywords) => {
      const ri = findRowIdx(mRows, ...keywords);
      if (ri === -1 || planCol === -1) return 0;
      return safeNum((mRows[ri] || [])[planCol]);
    };

    const getStrVals = (...keywords) => {
      const ri = findRowIdx(mRows, ...keywords);
      return rowStrVals(mRows, ri, mCols);
    };

    const getLatestStr = (...keywords) => {
      const vals = getStrVals(...keywords);
      const last = vals.reverse().find(v => v !== 'N/A');
      return last || 'N/A';
    };

    // Core metrics
    const costPerSqft   = getVals('cost per sqft', 'cost/sqft', 'maintenance cost');
    const ticketsRcvd   = getVals('tickets received', 'ticket received', 'complaints received');
    const ticketsClosed = getVals('tickets closed', 'ticket closed', 'complaints closed');
    const handedOver    = getVals('handed over', 'handover', 'units handed');
    const occupied      = getVals('occupied', 'occupancy units', 'units occupied');
    const invoicesSent  = getVals('invoice', 'maintenance invoice');

    // Ticket categories
    const tcatKeywords = [
      ['Plumbing',       'plumbing'],
      ['Electrical',     'electrical'],
      ['Carpentry',      'carpentry', 'carpenter'],
      ['Hot Water',      'hot water', 'geyser'],
      ['Seepage',        'seepage', 'leakage', 'leak'],
      ['Common Area',    'common area'],
      ['Video Door',     'video door', 'vdp', 'intercom'],
      ['Housekeeping',   'housekeeping', 'cleaning'],
    ];
    const ticketCategories = tcatKeywords.map(([name, ...kws]) => ({
      name,
      count: getVals(...kws).reduce((a, b) => a + b, 0),
    })).filter(c => c.count > 0).sort((a, b) => b.count - a.count);

    // Sustainability
    const sustainKeys = [
      { key: 'ecoSTP',               label: 'Eco-STP',                 kws: ['eco-stp', 'ecostp', 'stp'] },
      { key: 'solar',                label: 'Solar Net Metering',       kws: ['solar', 'net meter'] },
      { key: 'heatPump',             label: 'Heat Pump',                kws: ['heat pump'] },
      { key: 'hasirudala',           label: 'Hasirudala Waste',         kws: ['hasirudala', 'waste', 'garbage'] },
      { key: 'waterTreatment',       label: 'Water Treatment',          kws: ['water treatment', 'wtp'] },
      { key: 'implementationIdeas',  label: 'Implementation Ideas',     kws: ['implementation', 'ideas'] },
    ];
    const sustainability = sustainKeys.map(({ key, label, kws }) => {
      const raw = getLatestStr(...kws);
      return { key, label, rawValue: raw, status: normalizeStatus(raw) };
    });

    // Works
    const eastCompleted  = getVals('east block.*complete', 'east.*done', 'east block completed').reduce((a,b)=>a+b,0)
                        || getVals('east.*works.*done', 'east completed').reduce((a,b)=>a+b,0);
    const eastTotal      = getVals('east block.*total', 'east.*total works').reduce((a,b)=>a+b,0);
    const southCompleted = getVals('south block.*complete', 'south.*done', 'south block completed').reduce((a,b)=>a+b,0)
                        || getVals('south.*works.*done', 'south completed').reduce((a,b)=>a+b,0);
    const southTotal     = getVals('south block.*total', 'south.*total works').reduce((a,b)=>a+b,0);

    // Derived
    const totalTicketsRcvd   = ticketsRcvd.reduce((a,b)=>a+b,0);
    const totalTicketsClosed = ticketsClosed.reduce((a,b)=>a+b,0);
    const resolutionRate     = totalTicketsRcvd > 0 ? Math.round((totalTicketsClosed / totalTicketsRcvd) * 100) : 0;
    const avgCostPerSqft     = costPerSqft.length > 0
      ? Math.round((costPerSqft.reduce((a,b)=>a+b,0) / costPerSqft.filter(v=>v>0).length) * 100) / 100
      : 0;
    const totalHandedOver = handedOver.reduce((a,b)=>a+b,0);
    const totalOccupied   = occupied.reduce((a,b)=>a+b,0);
    const occupancyRate   = totalHandedOver > 0 ? Math.round((totalOccupied / totalHandedOver) * 100) : 0;
    const topCategory     = ticketCategories[0]?.name || 'N/A';

    // Plan targets
    const planCostPerSqft    = getPlanVal('cost per sqft', 'maintenance cost') || 5;
    const planTicketResRate  = getPlanVal('resolution rate', 'ticket resolution') || 85;
    const planOccupancy      = getPlanVal('occupancy', 'occupied') || 60;

    // ── Parse FM expenses ───────────────────────────────────────────────────
    const eHeaders = expenses[0] || [];
    const eRows    = expenses.slice(1);
    const eCols    = months.map(m => findColIdx(eHeaders, m));

    const catKeywords = [
      ['Housekeeping',     'housekeeping', 'cleaning'],
      ['Security',         'security', 'guard'],
      ['Maintenance Staff','maintenance staff', 'technician', 'plumber'],
      ['Utilities',        'utilities', 'electricity', 'water bill', 'eb ', 'bwssb'],
      ['Horticulture',     'horticulture', 'gardening', 'landscap'],
      ['Repairs',          'repair', 'material', 'spares'],
      ['Administrative',   'admin', 'management fee', 'audit', 'professional'],
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
    const wkCol    = findColIdx(wHeaders, 'week');
    const dtCol    = findColIdx(wHeaders, 'date');
    const topicCol = findColIdx(wHeaders, 'topic', 'activity');
    const stCol    = findColIdx(wHeaders, 'status');
    const notesCol = findColIdx(wHeaders, 'notes', 'remark', 'comment');

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
        if (pInfo.type === 'week') {
          return w.week.toLowerCase().includes(period.toLowerCase());
        }
        // For quarters/months, include all weekly entries (report uses them for works)
        return true;
      })
      .slice(0, 20); // limit to 20 entries

    // ── Assemble response ───────────────────────────────────────────────────
    return res.status(200).json({
      period,
      periodLabel:  pInfo.label,
      periodDates:  pInfo.dates,
      months,
      plan: {
        costPerSqft:        planCostPerSqft,
        ticketResolutionRate: planTicketResRate,
        occupancyRate:      planOccupancy,
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
        received:       ticketsRcvd,
        closed:         ticketsClosed,
        totalReceived:  totalTicketsRcvd,
        totalClosed:    totalTicketsClosed,
        resolutionRate,
        categories:     ticketCategories,
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
