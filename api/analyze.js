import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

const SYSTEM = `You are an FM analyst for Nandi Meraki, a premium 203-unit residential community in Bangalore (111 East Block + 92 South Block). Extract data and generate insights from raw sheet text.

Indian FM benchmarks: maintenance cost ₹4–6/sqft (target ₹5), ticket resolution ≥85%, occupancy ≥60% within 6 months of handover. Security is a fixed ~₹1,11,000/month — flag variable spend drivers.

Return ONLY a valid raw JSON object. No markdown, no backticks, no text before or after.`;

// Column indices in FM-monthly for each month
const COL = { Oct:2, Nov:3, Dec:4, Jan:6, Feb:7, Apr:9 };
const ALL_FM_MONTHS = ['Oct','Nov','Dec','Jan','Feb','Apr'];

// Period → months in FM-monthly
const PERIOD_MONTHS = {
  'Q3 2025': ['Oct','Nov','Dec'],
  'Q4 2025': ['Jan','Feb'],
  'Q1 2026': ['Apr'],
  'All Time': ['Oct','Nov','Dec','Jan','Feb','Apr'],
  Oct:['Oct'], Nov:['Nov'], Dec:['Dec'], Jan:['Jan'], Feb:['Feb'], Apr:['Apr'],
};

const PERIOD_LABEL = {
  'Q3 2025': 'Q3 2025 (Oct–Dec)', 'Q4 2025': 'Q4 2025 (Jan–Feb)',
  'Q1 2026': 'Q1 2026 (Apr)',      'All Time': 'All Time (Oct–Apr)',
  Oct:'October 2025', Nov:'November 2025', Dec:'December 2025',
  Jan:'January 2026', Feb:'February 2026', Apr:'April 2026',
};

const PERIOD_DATES = {
  'Q3 2025': 'October – December 2025', 'Q4 2025': 'January – February 2026',
  'Q1 2026': 'April 2026',              'All Time': 'October 2025 – April 2026',
  Oct:'October 2025', Nov:'November 2025', Dec:'December 2025',
  Jan:'January 2026', Feb:'February 2026', Apr:'April 2026',
};

// Which expense months to include per period
const PERIOD_EXP_MONTHS = {
  'Q3 2025': ['Oct-25','Nov-25','Dec-25'],
  'Q4 2025': ['Jan-26','Feb-26'],
  'Q1 2026': ['Apr-26'],
  'All Time': ['Oct-25','Nov-25','Dec-25','Jan-26','Feb-26','Mar-26','Apr-26'],
  Oct:['Oct-25'], Nov:['Nov-25'], Dec:['Dec-25'],
  Jan:['Jan-26'], Feb:['Feb-26'], Apr:['Apr-26'],
};

// Which FM-monthly months precede the period (for previous period context)
const PREV_FM_MONTHS = {
  'Q4 2025': ['Oct','Nov','Dec'],
  'Q1 2026': ['Jan','Feb'],
  Nov:['Oct'], Dec:['Nov'], Jan:['Dec'], Feb:['Jan'], Apr:['Feb'],
};

const PREV_EXP_MONTHS = {
  'Q4 2025': ['Oct-25','Nov-25','Dec-25'],
  'Q1 2026': ['Jan-26','Feb-26'],
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

  // Show ALL months so Haiku can determine cumulative vs period values
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
    .slice(0, 12)
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
Note: Handover/works values are CUMULATIVE — use latest period month's value, not a sum.
Tickets, invoices are per-month — sum the period months.
${monthlyText}

FM-EXPENSE SUMMARY (numbers are UNFORMATTED — no ₹ symbol needed, raw amounts):
${expSummaryText}

FM-EXPENSE LINE ITEMS (top 12 by total):
${topLineItems}

FM-WEEKLY LATEST DATA (12 Mar 2026 snapshot):
${weeklyText}

EXTRACTION RULES:
- Row 2 = handover status. Parse cumulative handed-over and occupied from each month cell.
  "Total N flats" or "Handed over N" → handedOver. "N apts occupied" or "occupied N" → occupied.
  East Block max=111, South Block max=92. South Block: set 0 for Oct and Nov (not yet started).
- Row 3 = cost per sqft. Extract the ₹/sqft number (e.g. "4.44 per sqft" → 4.44).
- Row 4 = maintenance accounts/invoices. Extract number of invoices/owners.
- Row 5 = MyGate complaints. Each cell has bullet lines: "- N\\n- N" where first=received, second=closed.
  Jan categories are missing — set ticketsCategories for Jan to null.
- Row 6 = sustainable interventions. One cell with bullet points per system. Parse status for each system.
- Row 7 = East Block Balance work. Parse as fraction done/total (e.g. "38/42" or "38 out of 42").
- Row 8 = South Block Balance Work. Same fraction format.
- Row 9 = Implementation of ideas. Same fraction format.
- Row 12 = Citadel context — use only for memo, do not extract numbers.

GOALS to evaluate (produce exactly 10):
1. Maintenance Cost/Sqft — benchmark ₹4–6, target <₹5, extract actual from Row3
2. Ticket Resolution Rate — benchmark ≥85%, extract from Row5 totalClosed/totalReceived
3. Occupancy Rate — benchmark ≥60%, extract from Row2 latest month
4. East Block Works — target 100%, extract from Row7 latest month
5. South Block Works — target 100%, extract from Row8 latest month
6. Implementation of Ideas — target 100%, extract from Row9
7. Maintenance Invoice Coverage — target 100% of handed-over units, extract from Row4
8. Heat Pump Status — target Operational, extract from Row6
9. Eco-STP Status — target Operational, extract from Row6
10. Solar & WTP Status — target Operational, extract from Row6

STATUS rules: MET = on/above target | PARTIAL = partially achieved | MISSED = below target | NA = no data for period.
progressPct: for numeric goals, % of target achieved (capped at 100). For status goals: Operational=100, Partial=60, Pending=20.

EXPENSE NOTES for period "${period}":
- Sum only the expense months listed above.
- For line items, sum the relevant month columns from the line items data.
- Previous period total = sum of previous expense months.

Return this exact JSON (fill all fields; use 0/[] for missing, never null in arrays):
{
  "periodLabel": "${PERIOD_LABEL[period]||period}",
  "periodDates": "${PERIOD_DATES[period]||period}",
  "months": [<month names matching fmMonths, use "Mar" only if All Time>],
  "handover": {
    "handedOver": [<number per month in period — cumulative, not incremental>],
    "occupied":   [<number per month in period>],
    "totalHandedOver": <latest cumulative value>,
    "totalOccupied":   <latest cumulative value>,
    "occupancyRate":   <integer, totalOccupied/totalHandedOver*100>,
    "benchmarkRate": 60
  },
  "maintenance": {
    "costPerSqft":  [<₹/sqft per period month, 0 if unavailable>],
    "avgCostPerSqft": <average of non-zero months, 2dp>,
    "goalLine": 5,
    "invoicesSent": [<per month>],
    "totalInvoices": <latest month value>
  },
  "tickets": {
    "received": [<per period month>],
    "closed":   [<per period month>],
    "totalReceived": <sum>,
    "totalClosed":   <sum>,
    "resolutionRate": <integer, totalClosed/totalReceived*100 or 0>,
    "prevTotalReceived": <sum for previous period months>
  },
  "expenses": {
    "total":    <sum of period expense months>,
    "perMonth": [<total per expense month>],
    "events":   [<events per expense month>],
    "security": [<security per expense month>],
    "pest":     [<pest per expense month>],
    "lineItems": [{"name":"<name>","total":<sum for period>,"amounts":[<per expense month>]}]
  },
  "works": {
    "eastBlock":  {"done":<number>,"total":<number>,"pct":<integer>},
    "southBlock": {"done":<number>,"total":<number>,"pct":<integer>},
    "ideas":      {"done":<number>,"total":<number>}
  },
  "previous": {
    "occupancyRate":   <from previous period latest month>,
    "totalOccupied":   <from previous period>,
    "totalHandedOver": <from previous period>,
    "avgCostPerSqft":  <from previous period>,
    "totalExpenses":   <sum of previous expense months>,
    "totalReceived":   <sum of previous ticket months>,
    "resolutionRate":  <from previous period>
  },
  "healthScore": <integer 0-100 composite score>,
  "healthScoreTrend": "<+N or -N vs previous, or — if no previous>",
  "coverSummary": "<one punchy sentence ≤20 words summarising this period>",
  "goals": [
    {"name":"<goal name>","benchmark":"<benchmark text>","target":"<target>","actual":"<actual value with units>","status":"MET|PARTIAL|MISSED|NA","progressPct":<0-100>}
  ],
  "ticketsInsight": "<one line ≤15 words on ticket patterns>",
  "expensesInsight": "<one line ≤15 words — MUST mention security fixed at ~₹1.11L/month>",
  "operationsInsight": "<one line ≤15 words on sustainability>",
  "sustainabilityNotes": {
    "heatPump":            {"status":"Operational|Partial|Pending","note":"<≤12 words>"},
    "hasirudala":          {"status":"Operational|Partial|Pending","note":"<≤12 words>"},
    "solar":               {"status":"Operational|Partial|Pending","note":"<≤12 words>"},
    "ecoSTP":              {"status":"Operational|Partial|Pending","note":"<≤12 words>"},
    "waterTreatment":      {"status":"Operational|Partial|Pending","note":"<≤12 words>"},
    "implementationIdeas": {"status":"Operational|Partial|Pending","note":"<≤12 words>"}
  },
  "memo": {
    "point1": "<what went well — 2-3 sentences, analyst voice>",
    "point2": "<biggest risk or concern — 2-3 sentences>",
    "point3": "<pattern emerging in the data — 2-3 sentences>",
    "point4": "<one specific recommendation for next period — 2-3 sentences>",
    "point5": "<one metric to watch closely — 2-3 sentences>"
  }
}`;
}

const FALLBACK = {
  periodLabel: '', periodDates: '', months: [],
  handover:    { handedOver:[], occupied:[], totalHandedOver:0, totalOccupied:0, occupancyRate:0, benchmarkRate:60 },
  maintenance: { costPerSqft:[], avgCostPerSqft:0, goalLine:5, invoicesSent:[], totalInvoices:0 },
  tickets:     { received:[], closed:[], totalReceived:0, totalClosed:0, resolutionRate:0, prevTotalReceived:0 },
  expenses:    { total:0, perMonth:[], events:[], security:[], pest:[], lineItems:[] },
  works:       { eastBlock:{done:0,total:0,pct:0}, southBlock:{done:0,total:0,pct:0}, ideas:{done:0,total:0} },
  previous:    { occupancyRate:0, totalOccupied:0, totalHandedOver:0, avgCostPerSqft:0, totalExpenses:0, totalReceived:0, resolutionRate:0 },
  healthScore: 0, healthScoreTrend: '—',
  coverSummary: 'FM data loaded — analysis unavailable.',
  goals: [],
  ticketsInsight: 'Analysis unavailable.',
  expensesInsight: 'Security fixed at ~₹1.11L/month; analysis unavailable.',
  operationsInsight: 'Analysis unavailable.',
  sustainabilityNotes: {
    heatPump:            { status:'Partial', note:'Status pending analysis.' },
    hasirudala:          { status:'Partial', note:'Status pending analysis.' },
    solar:               { status:'Partial', note:'Status pending analysis.' },
    ecoSTP:              { status:'Partial', note:'Status pending analysis.' },
    waterTreatment:      { status:'Partial', note:'Status pending analysis.' },
    implementationIdeas: { status:'Partial', note:'Status pending analysis.' },
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
      max_tokens: 2500,
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

    // Merge with fallback to ensure all required keys exist
    return res.status(200).json({
      ...FALLBACK,
      ...result,
      periodLabel: result.periodLabel || periodLabel,
      periodDates: result.periodDates || periodDates,
      fetchTime: new Date().toISOString(),
    });

  } catch (err) {
    console.error('analyze.js error:', err.message);
    return res.status(200).json({ ...FALLBACK, periodLabel, periodDates, _error: err.message });
  }
}
