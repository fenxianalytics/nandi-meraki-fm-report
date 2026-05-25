import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

const SYSTEM = `You are an FM analyst for Nandi Meraki, a premium 203-unit residential community in Bangalore (111 East Block + 92 South Block). Extract data and generate insights from raw sheet text.

Indian FM benchmarks: maintenance cost ₹4–6/sqft (target ₹5), ticket resolution ≥85%, occupancy ≥60% within 6 months of handover. Security is a fixed ~₹1,11,000/month — flag variable spend drivers.

CRITICAL — NULL HANDLING: Only return null for a field if the source cell is completely empty. If any text exists in a cell, extract the best value possible. When data is genuinely missing, explain why specifically in the context field — never say just "no data". Examples: "Category breakdown not recorded for Jan" or "South Block tracking began Dec 2025".

OCCUPANCY RULE: Quarterly occupancy = end of period month only. Q3=Dec(44/107=41%), Q4=Feb(75/128=59%), Q1=Apr(91/148=61%). Use the LAST month of the period for totalOccupied, totalHandedOver, occupancyRate. Never use first month of quarter.

INVOICE COVERAGE RULE: Invoice coverage = invoices sent / OCCUPIED units (not handed-over). Apr: 105/91=115% → MET. Q3: 80/44=181% → MET. Always divide by occupied.

Return ONLY a valid raw JSON object. No markdown, no backticks, no text before or after.`;

const COL = { Oct:2, Nov:3, Dec:4, Jan:6, Feb:7, Apr:9 };
const ALL_FM_MONTHS = ['Oct','Nov','Dec','Jan','Feb','Apr'];

const PERIOD_MONTHS = {
  'Q3 2025': ['Oct','Nov','Dec'],
  'Q4 2025': ['Jan','Feb'],
  'Q1 2026': ['Apr'],
  'All Time': ['Oct','Nov','Dec','Jan','Feb','Apr'],
  Oct:['Oct'], Nov:['Nov'], Dec:['Dec'], Jan:['Jan'], Feb:['Feb'], Apr:['Apr'],
};

const PERIOD_LABEL = {
  'Q3 2025': 'Q3 2025 (Oct–Dec)', 'Q4 2025': 'Q4 2025 (Jan–Mar)',
  'Q1 2026': 'Q1 2026 (Apr)',      'All Time': 'All Time (Oct–Apr)',
  Oct:'October 2025', Nov:'November 2025', Dec:'December 2025',
  Jan:'January 2026', Feb:'February 2026', Apr:'April 2026',
};

const PERIOD_DATES = {
  'Q3 2025': 'October – December 2025', 'Q4 2025': 'January – March 2026',
  'Q1 2026': 'April 2026',              'All Time': 'October 2025 – April 2026',
  Oct:'October 2025', Nov:'November 2025', Dec:'December 2025',
  Jan:'January 2026', Feb:'February 2026', Apr:'April 2026',
};

const PERIOD_EXP_MONTHS = {
  'Q3 2025': ['Oct-25','Nov-25','Dec-25'],
  'Q4 2025': ['Jan-26','Feb-26','Mar-26'],
  'Q1 2026': ['Apr-26'],
  'All Time': ['Oct-25','Nov-25','Dec-25','Jan-26','Feb-26','Mar-26','Apr-26'],
  Oct:['Oct-25'], Nov:['Nov-25'], Dec:['Dec-25'],
  Jan:['Jan-26'], Feb:['Feb-26'], Apr:['Apr-26'],
};

const PREV_FM_MONTHS = {
  'Q4 2025': ['Oct','Nov','Dec'],
  'Q1 2026': ['Jan','Feb'],
  Nov:['Oct'], Dec:['Nov'], Jan:['Dec'], Feb:['Jan'], Apr:['Feb'],
};

const PREV_EXP_MONTHS = {
  'Q4 2025': ['Oct-25','Nov-25','Dec-25'],
  'Q1 2026': ['Jan-26','Feb-26','Mar-26'],
  Nov:['Oct-25'], Dec:['Nov-25'], Jan:['Dec-25'], Feb:['Jan-26'], Apr:['Feb-26'],
};

function cellStr(val) {
  if (val === '' || val === null || val === undefined) return '""';
  return JSON.stringify(String(val).slice(0, 200));
}

function buildPrompt(rawSheets, period, type) {
  const { monthly, expenses, weekly } = rawSheets;
  const fmMonths  = PERIOD_MONTHS[period]    || ['Apr'];
  const expMonths = PERIOD_EXP_MONTHS[period] || ['Apr-26'];
  const prevFm    = PREV_FM_MONTHS[period]   || [];
  const prevExp   = PREV_EXP_MONTHS[period]  || [];

  const monthlyText = monthly.rows.map(r => {
    const colVals = ALL_FM_MONTHS.map(m =>
      `${m}:${cellStr(r.cells[COL[m]])}`
    ).join(' ');
    return `Row${r.index}(${r.col0.slice(0,35)}): ${colVals}`;
  }).join('\n');

  const expSummaryText = expenses.summaryRows.map(r =>
    `${r.month}: events=${r.events} security=${r.security} pest=${r.pest} TOTAL=${r.total}`
  ).join('\n');

  const topLineItems = expenses.lineItems
    .map(li => ({ li, t: li.oct+li.nov+li.dec+li.jan+li.feb+li.mar+li.apr }))
    .sort((a,b) => b.t - a.t)
    .slice(0, 15)
    .map(({ li }) => `"${li.name}": oct=${li.oct} nov=${li.nov} dec=${li.dec} jan=${li.jan} feb=${li.feb} mar=${li.mar} apr=${li.apr}`)
    .join('\n');

  const weeklyText = weekly.rows
    .filter(r => r.col2)
    .map(r => `"${r.col1}": latest="${r.col2.slice(0,120)}"`)
    .join('\n');

  return `Analyse FM data for Nandi Meraki — period="${period}" (${PERIOD_LABEL[period]||period}).

PERIOD SCOPE: Extract data only for months [${fmMonths.join(', ')}] from FM-monthly.
PREVIOUS PERIOD months for trend comparison: [${prevFm.join(', ')||'none'}]
EXPENSE months to include: [${expMonths.join(', ')}]
PREVIOUS EXPENSE months: [${prevExp.join(', ')||'none'}]

FM-MONTHLY RAW DATA (col2=Oct col3=Nov col4=Dec col6=Jan col7=Feb col9=Apr):
Handover/works = CUMULATIVE — use LAST period month value for totals.
Tickets, invoices = per-month — sum the period months.
${monthlyText}

FM-EXPENSE SUMMARY:
${expSummaryText}

FM-EXPENSE LINE ITEMS (top 15 by total):
${topLineItems}

FM-WEEKLY LATEST DATA:
${weeklyText}

EXTRACTION RULES:
- Row 2 = handover. Parse cumulative handed-over and occupied per month.
  Use LAST period month for totalHandedOver, totalOccupied, occupancyRate.
  East Block max=111, South Block max=92. South Block: 0 for Oct and Nov.
- Row 3 = cost per sqft. Extract ₹/sqft number.
- Row 4 = invoices. Extract count. Coverage = invoices / OCCUPIED (not handed-over).
- Row 5 = tickets. First bullet=received, second=closed per month.
  CATEGORIES: extract count for each from raw cell text for the 15 categories:
  Plumbing, Electrical, Common area, Seepage, Carpentry, Hot water, Water meter,
  Housekeeping, Lift, Gas, Car parking, Maintenance charges, Security, Video door phone, Others.
  Jan categories genuinely missing from sheet — set categoriesNote to
  "Category breakdown not recorded for January" and use 0 for Jan in category counts.
  For quarterly: sum categories across all non-Jan months in period.
- Row 6 = sustainability. For each system: status, note (≤12 words),
  nextAction (specific next step or "Active since DATE — no disruptions").
- Row 7 = East Block works (fraction done/total, CUMULATIVE — use latest period month).
- Row 8 = South Block works (same).
- Row 9 = Implementation ideas (same).
- Row 12 = management context (use for memo, horticulture, feedback assessment).

GOALS (produce exactly 12):
1. Maintenance Cost/Sqft — benchmark ₹4–6, target <₹5, from Row3
2. Ticket Resolution Rate — benchmark ≥85%, from Row5 closed/received
3. Occupancy Rate — benchmark ≥60%, LAST period month from Row2
4. East Block Works — target 100%, LAST period month from Row7
5. South Block Works — target 100%, LAST period month from Row8
6. Implementation of Ideas — target 100%, from Row9
7. Invoice Coverage — target ≥100% of OCCUPIED units, from Row4 ÷ Row2-occupied
8. Horticulture & Landscaping — MET/PARTIAL/MISSED from Row12 and weekly data
9. Resident Feedback — MET/PARTIAL/MISSED from complaint trends and Row12
10. Heat Pump — target Operational, from Row6
11. Eco-STP — target Operational, from Row6
12. Solar & WTP — target Operational, from Row6

STATUS: MET=on/above target | PARTIAL=partially achieved | MISSED=below | NA=no data.
progressPct: numeric = % of target (cap 100). Status: Operational=100, Partial=60, Pending=20.
context: one sentence explaining why — be specific, never say "no data". If genuinely no data, say exactly why (e.g. "South Block works tracking began Dec 2025").

EXPENSE: Sum only the listed expense months. Security = ~₹1,11,000/month fixed.

Return this exact JSON (fill all fields, use 0/[] for missing arrays, never null in arrays):
{
  "periodLabel": "${PERIOD_LABEL[period]||period}",
  "periodDates": "${PERIOD_DATES[period]||period}",
  "months": [<month names for fmMonths>],
  "handover": {
    "handedOver": [<cumulative per period month>],
    "occupied":   [<cumulative per period month>],
    "totalHandedOver": <last period month value>,
    "totalOccupied":   <last period month value>,
    "occupancyRate":   <integer %>,
    "benchmarkRate": 60
  },
  "maintenance": {
    "costPerSqft":  [<per period month, 0 if missing>],
    "avgCostPerSqft": <2dp average of non-zero months>,
    "goalLine": 5,
    "invoicesSent": [<per month>],
    "totalInvoices": <latest month value>
  },
  "tickets": {
    "received": [<per period month>],
    "closed":   [<per period month>],
    "totalReceived": <sum>,
    "totalClosed":   <sum>,
    "resolutionRate": <integer %>,
    "prevTotalReceived": <previous period sum>,
    "categories": [
      {"name":"Plumbing","count":0},{"name":"Electrical","count":0},
      {"name":"Common area","count":0},{"name":"Seepage","count":0},
      {"name":"Carpentry","count":0},{"name":"Hot water","count":0},
      {"name":"Water meter","count":0},{"name":"Housekeeping","count":0},
      {"name":"Lift","count":0},{"name":"Gas","count":0},
      {"name":"Car parking","count":0},{"name":"Maintenance charges","count":0},
      {"name":"Security","count":0},{"name":"Video door phone","count":0},
      {"name":"Others","count":0}
    ],
    "categoriesNote": ""
  },
  "expenses": {
    "total":    <sum of period expense months>,
    "perMonth": [<per expense month>],
    "events":   [<per expense month>],
    "security": [<per expense month>],
    "pest":     [<per expense month>],
    "lineItems": [{"name":"<n>","total":<sum for period>,"amounts":[<per expense month>]}]
  },
  "works": {
    "eastBlock":  {"done":0,"total":0,"pct":0},
    "southBlock": {"done":0,"total":0,"pct":0},
    "ideas":      {"done":0,"total":0}
  },
  "previous": {
    "occupancyRate":0,"totalOccupied":0,"totalHandedOver":0,
    "avgCostPerSqft":0,"totalExpenses":0,"totalReceived":0,"resolutionRate":0
  },
  "healthScore": 0,
  "healthScoreTrend": "—",
  "periodNarrative": "<4-5 sentence executive briefing: what happened this period with specific numbers, biggest achievement with number, biggest concern with number, what to watch next period specifically>",
  "highlights": {
    "win": "<specific achievement with number>",
    "risk": "<specific risk with number>",
    "action": "<specific next step with deadline>"
  },
  "coverSummary": "<one punchy sentence ≤20 words>",
  "goals": [
    {"name":"","benchmark":"","target":"","actual":"","status":"MET","progressPct":0,"context":"<one sentence explaining status — be specific>"}
  ],
  "goalsTrend": "<3-4 sentences: what improved vs last period, what regressed, trend for next period>",
  "ticketAnalysis": {
    "volumeResolution": "<X received, Y closed (Z%). vs previous: better/worse. What drove change.>",
    "topIssues": "<Top 2 categories = X% of tickets. What this means — vendor gap, defect, seasonal.>",
    "pattern": "<One non-obvious insight — trend across months, correlation with handovers etc.>",
    "action": "<One specific action, one owner, one deadline.>"
  },
  "ticketsInsight": "<≤15 words on ticket patterns>",
  "expenseAnalysis": {
    "totalSplit": "<Total ₹X. Security fixed ₹X/month = X% of spend. Variable = ₹X.>",
    "variableDrivers": "<Specific items driving variable spend with ₹ amounts and reason.>",
    "trendWatch": "<vs previous period. One item to watch next period with specific reason.>"
  },
  "expensesInsight": "<≤15 words, must mention security ~₹1.11L/month>",
  "operationsSummary": "<2-3 sentences on operational health — what improved, what's lagging, what to prioritise>",
  "operationsInsight": "<≤15 words on sustainability>",
  "sustainabilityNotes": {
    "heatPump":            {"status":"Partial","note":"","nextAction":""},
    "hasirudala":          {"status":"Partial","note":"","nextAction":""},
    "solar":               {"status":"Partial","note":"","nextAction":""},
    "ecoSTP":              {"status":"Partial","note":"","nextAction":""},
    "waterTreatment":      {"status":"Partial","note":"","nextAction":""},
    "implementationIdeas": {"status":"Partial","note":"","nextAction":""}
  },
  "memo": {
    "point1": "<what went well — 2-3 sentences>",
    "point2": "<biggest risk — 2-3 sentences>",
    "point3": "<pattern emerging — 2-3 sentences>",
    "point4": "<recommendation — 2-3 sentences>",
    "point5": "<metric to watch — 2-3 sentences>"
  }
}`;
}

const FALLBACK = {
  periodLabel: '', periodDates: '', months: [],
  handover:    { handedOver:[], occupied:[], totalHandedOver:0, totalOccupied:0, occupancyRate:0, benchmarkRate:60 },
  maintenance: { costPerSqft:[], avgCostPerSqft:0, goalLine:5, invoicesSent:[], totalInvoices:0 },
  tickets: {
    received:[], closed:[], totalReceived:0, totalClosed:0, resolutionRate:0, prevTotalReceived:0,
    categories:[], categoriesNote:'',
  },
  expenses:    { total:0, perMonth:[], events:[], security:[], pest:[], lineItems:[] },
  works:       { eastBlock:{done:0,total:0,pct:0}, southBlock:{done:0,total:0,pct:0}, ideas:{done:0,total:0} },
  previous:    { occupancyRate:0, totalOccupied:0, totalHandedOver:0, avgCostPerSqft:0, totalExpenses:0, totalReceived:0, resolutionRate:0 },
  healthScore: 0, healthScoreTrend: '—',
  periodNarrative: 'FM data loaded — detailed analysis unavailable. Please regenerate to load AI insights.',
  highlights: {
    win: 'Report data loaded successfully.',
    risk: 'AI analysis unavailable — please regenerate.',
    action: 'Click Generate to reload AI insights.',
  },
  coverSummary: 'FM data loaded — analysis unavailable.',
  goals: [],
  goalsTrend: 'Goal trend analysis unavailable — please regenerate the report.',
  ticketAnalysis: {
    volumeResolution: 'Analysis unavailable.',
    topIssues: 'Analysis unavailable.',
    pattern: 'Analysis unavailable.',
    action: 'Analysis unavailable.',
  },
  ticketsInsight: 'Analysis unavailable.',
  expenseAnalysis: {
    totalSplit: 'Security fixed at ~₹1.11L/month; full analysis unavailable.',
    variableDrivers: 'Analysis unavailable.',
    trendWatch: 'Analysis unavailable.',
  },
  expensesInsight: 'Security fixed at ~₹1.11L/month; analysis unavailable.',
  operationsSummary: 'Operational analysis unavailable — please regenerate the report.',
  operationsInsight: 'Analysis unavailable.',
  sustainabilityNotes: {
    heatPump:            { status:'Partial', note:'Status pending analysis.', nextAction:'Regenerate report for details.' },
    hasirudala:          { status:'Partial', note:'Status pending analysis.', nextAction:'Regenerate report for details.' },
    solar:               { status:'Partial', note:'Status pending analysis.', nextAction:'Regenerate report for details.' },
    ecoSTP:              { status:'Partial', note:'Status pending analysis.', nextAction:'Regenerate report for details.' },
    waterTreatment:      { status:'Partial', note:'Status pending analysis.', nextAction:'Regenerate report for details.' },
    implementationIdeas: { status:'Partial', note:'Status pending analysis.', nextAction:'Regenerate report for details.' },
  },
  memo: { point1:'—', point2:'—', point3:'—', point4:'—', point5:'—' },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { rawSheets, period, type } = req.body || {};
  if (!rawSheets) return res.status(200).json({ ...FALLBACK, _error: 'No rawSheets provided' });

  const periodLabel = PERIOD_LABEL[period] || period || 'the selected period';
  const periodDates = PERIOD_DATES[period] || period || '';

  try {
    const prompt = buildPrompt(rawSheets, period || 'Q1 2026', type || 'quarter');

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4500,
      system: SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw  = (msg.content[0]?.text || '').trim();
    const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    let result;
    try {
      result = JSON.parse(json);
    } catch {
      console.error('JSON parse failed:', raw.slice(0, 400));
      return res.status(200).json({ ...FALLBACK, periodLabel, periodDates, _parseError: true });
    }

    return res.status(200).json({
      ...FALLBACK,
      ...result,
      // Merge nested objects so FALLBACK keys always exist
      ticketAnalysis:  { ...FALLBACK.ticketAnalysis,  ...(result.ticketAnalysis  || {}) },
      expenseAnalysis: { ...FALLBACK.expenseAnalysis, ...(result.expenseAnalysis || {}) },
      highlights:      { ...FALLBACK.highlights,      ...(result.highlights      || {}) },
      tickets: { ...FALLBACK.tickets, ...(result.tickets || {}), categories: result.tickets?.categories || [] },
      periodLabel: result.periodLabel || periodLabel,
      periodDates: result.periodDates || periodDates,
      fetchTime: new Date().toISOString(),
    });

  } catch (err) {
    console.error('analyze.js error:', err.message);
    return res.status(200).json({ ...FALLBACK, periodLabel, periodDates, _error: err.message });
  }
}
