import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

// ---------- FM ----------

const FM_SYSTEM = `You are an FM analyst for Nandi Meraki, a 203-unit residential community in Bangalore (East Block: 111 units, South Block: 92 units). Extract structured data from raw Google Sheet text.

Rules:
- For handover/works (cumulative): use the LAST month's value in the period.
- For complaints/billing: sum all period months.
- Expenses tab has a CUMULATIVE row — use the individual month rows for period totals.
- "color" field for sustainability: "green" = operational, "amber" = in progress / partial, "red" = failed / not started.
- Numbers only in numeric fields (no ₹ or commas).
- Return ONLY valid raw JSON. No markdown, no backticks, no text before or after.`;

function buildFMPrompt(rawSheets, period, periodMonths) {
  const tabs = rawSheets.tabs || {};
  const tabsText = Object.entries(tabs).map(([name, text]) =>
    `=== ${name.toUpperCase()} TAB ===\n${text}`
  ).join('\n\n');

  return `Analyse FM data for Nandi Meraki. Period: "${period}" — focus on months: [${periodMonths.join(', ')}]

${tabsText}

EXTRACTION GUIDE:
- Handover tab: each row = one month. Find rows for the period months. eastBlock.received = East Block Apts Received (cumulative, use last month). southBlock.received = South Block Apts Received (cumulative). eastWorksComplete/Total from East Works Completed col. southWorksComplete/Total from South Works Completed col.
- Complaints tab: received, closed, open, closeRate% per month. Sum period months for totals. Extract category counts from category columns.
- Billing tab: costPerSqft from Cost/Sqft col. East/South invoiced counts. Use last period month for costPerSqft.
- Sustainability tab: status text for each of the 6 systems (Heat Pump, Solar, Eco STP, Water Meters/Aegir, OWC, Hasiru Dala). Count systems that are "Operational" or "Active" for systemsActive.
- Expenses tab: Col B=Events, C=Security, D=Pest, E=Total per month. Row 13 or labeled "CUMULATIVE" has cumulative totals. Sum period months for total.
- Staffing tab: scores (/5), attendance %, horticulture executive status, roster changes.
- Ideas tab: count rows by Status column (Completed/Done vs In Progress vs Pending).

Return exactly this JSON (all numbers numeric, no nulls in arrays, use 0 for missing numbers):
{
  "dept": "fm",
  "periodLabel": "${period} (${periodMonths.join(' – ')})",
  "handover": {
    "eastBlock": { "received": 0, "total": 111, "pct": 0 },
    "southBlock": { "received": 0, "total": 92, "pct": 0 },
    "eastWorksComplete": 0, "eastWorksTotal": 0,
    "southWorksComplete": 0, "southWorksTotal": 0,
    "amenitiesThisPeriod": "",
    "prioritySouthPending": "",
    "notes": ""
  },
  "complaints": {
    "received": 0, "closed": 0, "open": 0, "closeRate": 0,
    "monthTrend": [{ "month": "", "received": 0, "closed": 0 }],
    "categories": [
      {"name":"Plumbing","count":0},{"name":"Electrical","count":0},
      {"name":"Common Area","count":0},{"name":"Seepage","count":0},
      {"name":"Carpentry","count":0},{"name":"Hot Water","count":0},
      {"name":"Water Meter","count":0},{"name":"Housekeeping","count":0},
      {"name":"Lift","count":0},{"name":"Gas","count":0},
      {"name":"Car Parking","count":0},{"name":"Security","count":0},
      {"name":"Video Door Phone","count":0},{"name":"Others","count":0}
    ],
    "recurringIssue": "",
    "insight": ""
  },
  "billing": {
    "costPerSqft": 0, "benchmark": 5,
    "eastInvoiced": 0, "eastTotal": 103,
    "southInvoiced": 0, "southTotal": 92,
    "waterMeters": "", "collectionIssues": "", "mygate": "",
    "costTrend": [{ "month": "", "value": 0 }],
    "insight": ""
  },
  "sustainability": {
    "heatPump":    { "status": "", "note": "", "color": "green" },
    "solar":       { "status": "", "note": "", "color": "amber" },
    "ecoSTP":      { "status": "", "note": "", "color": "amber" },
    "waterMeters": { "status": "", "note": "", "color": "green" },
    "owc":         { "status": "", "note": "", "color": "green" },
    "hasiruDala":  { "status": "", "note": "", "color": "green" },
    "systemsActive": 0, "systemsTotal": 6,
    "insight": ""
  },
  "expenses": {
    "total": 0, "events": 0, "security": 0, "pest": 0,
    "monthTrend": [{ "month": "", "total": 0, "events": 0, "security": 0, "pest": 0 }],
    "cumulative": { "events": 0, "security": 0, "pest": 0, "total": 0 },
    "keyItems": "",
    "insight": ""
  },
  "staffing": {
    "hkScore": 0, "securityScore": 0, "mstScore": 0,
    "hkAttendance": 0, "securityAttendance": 0, "mstAttendance": 0,
    "horticultureStatus": "", "rosterNotes": "", "keyChange": ""
  },
  "ideas": {
    "total": 0, "completed": 0, "inProgress": 0, "pending": 0,
    "highlights": []
  },
  "highlights": {
    "win": "",
    "risk": "",
    "action": ""
  }
}`;
}

// ---------- DM ----------

const DM_SYSTEM = `You are a digital marketing analyst for Nandi Meraki (Bangalore real estate). Extract data from raw Google Sheet text.

Context:
- DM monthly report: wide sheet where Column A = metric name, and remaining columns are months in pairs (e.g. "October - Planned", "October - Achieved"). Look at the header row to identify which column = which month.
- DM expenses: rows = expense line items, columns = months (header row 2 shows month names like "June 2023", "July 2023" etc.).
- Target CPQL = ₹1,200. Monthly budget = ₹6L (600,000). Instagram target = 4,200. LinkedIn target = 2,500.
- Numbers only in numeric fields.
- Return ONLY valid raw JSON. No markdown, no backticks.`;

function buildDMPrompt(rawSheets, period, periodMonths) {
  const tabs = rawSheets.tabs || {};
  const tabsText = Object.entries(tabs).map(([name, text]) =>
    `=== ${name.toUpperCase()} TAB ===\n${text}`
  ).join('\n\n');

  const monthsList = periodMonths.join(', ');

  return `Analyse DM data for Nandi Meraki. Period: "${period}" — focus on months: [${monthsList}]

${tabsText}

EXTRACTION GUIDE:
- DM monthly report: Find the "Achieved" column(s) for each period month. Key metrics by section:
  Section 1 "Organic Marketing": IG followers (target 1800/4200), LinkedIn (target 800/2500), Facebook, YouTube, Content Calendar adherence %.
  Section 2 "Paid Marketing": CPL, CPQL (target 1200), % QL (qual rate, target 30%), QL count (target 330), Site Visits (target 130), Leads (target 1100).
  Section 3 "Conversions": No. of Conversions/Bookings, Conversion Ratio, Cost per conversion.
  For trend data: also extract the last 6-8 months before the period.

- DM expenses: Find columns matching the period months. Sum line items for each channel.
  Key channels: 99 Acres, MyGate, Magic Bricks, Housing.com, Website/Kenyt, Facebook, Instagram, Google, Wati, ChatGPT, Misc.
  Row with "Total Expense" gives the monthly total.

- For CPQL trend: extract CPQL values for the last 6-8 months to show trend.
- For social media trend: extract Instagram and LinkedIn followers for last 6-8 months.
- For spend trend: extract total monthly spend for last 6 months.

Return exactly this JSON:
{
  "dept": "dm",
  "periodLabel": "${period} (${periodMonths.join(' – ')})",
  "leadPerformance": {
    "cpql": { "current": 0, "target": 1200, "prevMonth": 0 },
    "qualRate": { "current": 0, "target": 30 },
    "ql": { "current": 0, "target": 330 },
    "siteVisits": { "current": 0, "target": 130 },
    "leads": { "current": 0, "target": 1100 },
    "bookings": 0,
    "cpqlTrend": [{ "month": "", "value": 0 }],
    "funnelTable": [
      { "stage": "Total Leads", "monthData": {}, "target": 1100 },
      { "stage": "Qualified Leads", "monthData": {}, "target": 330 },
      { "stage": "Site Visits", "monthData": {}, "target": 130 },
      { "stage": "Bookings", "monthData": {}, "target": 3 }
    ],
    "insight": ""
  },
  "contentCalendar": {
    "planAdherence": 0,
    "plannedItems": "",
    "achievedItems": "",
    "adsRun": 0,
    "insight": ""
  },
  "socialMedia": {
    "instagram": { "followers": 0, "new": 0, "target": 4200 },
    "linkedin": { "followers": 0, "new": 0, "target": 2500 },
    "facebook": { "followers": 0, "new": 0 },
    "youtube": { "subscribers": 0, "new": 0 },
    "trendMonths": [],
    "instagramTrend": [],
    "linkedinTrend": [],
    "insight": ""
  },
  "budgetSpend": {
    "allocatedMonthly": 600000,
    "spentThisPeriod": 0,
    "utilisedPct": 0,
    "cumulativeSurplus": 0,
    "breakdown": [
      { "channel": "Google", "amount": 0 },
      { "channel": "Facebook", "amount": 0 },
      { "channel": "Instagram", "amount": 0 },
      { "channel": "Magic Bricks", "amount": 0 },
      { "channel": "99 Acres", "amount": 0 },
      { "channel": "Housing.com", "amount": 0 },
      { "channel": "Wati", "amount": 0 },
      { "channel": "ChatGPT", "amount": 0 },
      { "channel": "Misc", "amount": 0 }
    ],
    "spendTrend": [{ "month": "", "spent": 0 }],
    "insight": ""
  },
  "newsletter": {
    "openRate": 0,
    "benchmark": 45,
    "trend": [{ "month": "", "rate": 0 }],
    "insight": ""
  },
  "portalsChannels": {
    "merakiORM": 0,
    "targetORM": 4.8,
    "portals": [
      { "name": "99 Acres", "status": "Active" },
      { "name": "Magic Bricks", "status": "Active" },
      { "name": "Housing.com", "status": "Active" }
    ],
    "cpBrokers": 0,
    "cpActive": 0,
    "insight": ""
  },
  "highlights": {
    "win": "",
    "risk": "",
    "action": ""
  }
}`;
}

// ---------- L&R ----------

const LR_SYSTEM = `You are a legal and regulatory analyst for Nandi Meraki (Bangalore real estate project). Extract structured data from raw Google Sheet text.

Context:
- Land tracker and Meraki tracker are in the SAME tab, with land parcels in the upper section and regulatory approvals in the lower section.
- Assets tab lists various asset monetisation/management items.
- PLAN VS ACHEIVED tab has metrics as rows and monthly columns.
- Cases tab has court cases, with recent "Current Status" columns (e.g., "Current Status May", "Current Status June").
- For Cases: use the most recent month's status column that falls within or before the period.
- Return ONLY valid raw JSON. No markdown, no backticks.`;

function buildLRPrompt(rawSheets, period, periodMonths) {
  const tabs = rawSheets.tabs || {};
  const tabsText = Object.entries(tabs).map(([name, text]) =>
    `=== ${name.toUpperCase()} TAB ===\n${text}`
  ).join('\n\n');

  const latestMonth = periodMonths[periodMonths.length - 1] || '';

  return `Analyse L&R data for Nandi Meraki. Period: "${period}" — months: [${periodMonths.join(', ')}]. Latest period month: ${latestMonth}.

${tabsText}

EXTRACTION GUIDE:
- Land tracker section: extract each land parcel with its survey no., registration status (Done/Pending), e-Khata status, pending regulatory items, responsible person, and any blockers.
- Meraki tracker section (below land tracker in same tab): extract each regulatory approval item (BBMP OC, CFO, RERA, etc.) with applied/received status.
- Assets tab: each row = one asset. Extract asset name, category, decision status, current status text, next action, whether management decision is required.
- PLAN VS ACHEIVED tab: metrics have planned target and actual achieved per month. Look for the most recent monthly column in the period. Extract metric name, planned, actual, % achieved, status.
- Cases tab: each row = one court case. Use the "Current Status" column for the latest period month (or most recent month available). Count totals by status (Active/Pending, Settled, Disposed).

Return exactly this JSON:
{
  "dept": "lr",
  "periodLabel": "${period} (${periodMonths.join(' – ')})",
  "landTracker": {
    "totalParcels": 0, "regDone": 0, "regPending": 0,
    "eKhataDone": 0, "eKhataPending": 0,
    "items": [
      {
        "parcel": "",
        "area": "",
        "type": "",
        "regStatus": "",
        "eKhataStatus": "",
        "pendingItems": [],
        "blocker": "",
        "responsible": ""
      }
    ]
  },
  "merakiTracker": {
    "done": 0, "pending": 0, "total": 0,
    "items": [
      {
        "item": "",
        "authority": "",
        "applied": false,
        "received": false,
        "status": "",
        "notes": ""
      }
    ]
  },
  "assets": {
    "total": 0, "inProgress": 0, "pending": 0, "completed": 0,
    "mgmtDecisionsRequired": 0,
    "items": [
      {
        "asset": "",
        "category": "",
        "decisionStatus": "",
        "currentStatus": "",
        "nextAction": "",
        "mgmtRequired": false
      }
    ]
  },
  "planVsAchieved": {
    "period": "${latestMonth}",
    "avgPct": 0,
    "metrics": [
      {
        "metric": "",
        "planned": 0,
        "actual": 0,
        "pct": 0,
        "status": "",
        "notes": ""
      }
    ]
  },
  "cases": {
    "total": 0, "active": 0, "settled": 0, "disposed": 0, "atHighCourt": 0,
    "items": [
      {
        "slNo": 0,
        "property": "",
        "party": "",
        "caseNo": "",
        "status": "",
        "lastHearing": "",
        "nextHearing": "",
        "currentStatus": ""
      }
    ]
  },
  "highlights": {
    "win": "",
    "risk": "",
    "action": ""
  }
}`;
}

// ---------- Fallbacks ----------

const FM_FALLBACK = {
  dept: 'fm', periodLabel: '',
  handover: { eastBlock:{received:0,total:111,pct:0}, southBlock:{received:0,total:92,pct:0}, eastWorksComplete:0, eastWorksTotal:0, southWorksComplete:0, southWorksTotal:0, amenitiesThisPeriod:'', prioritySouthPending:'', notes:'' },
  complaints: { received:0, closed:0, open:0, closeRate:0, monthTrend:[], categories:[], recurringIssue:'', insight:'Analysis unavailable — please regenerate.' },
  billing: { costPerSqft:0, benchmark:5, eastInvoiced:0, eastTotal:103, southInvoiced:0, southTotal:92, waterMeters:'', collectionIssues:'', mygate:'', costTrend:[], insight:'' },
  sustainability: { heatPump:{status:'',note:'',color:'amber'}, solar:{status:'',note:'',color:'amber'}, ecoSTP:{status:'',note:'',color:'amber'}, waterMeters:{status:'',note:'',color:'amber'}, owc:{status:'',note:'',color:'amber'}, hasiruDala:{status:'',note:'',color:'amber'}, systemsActive:0, systemsTotal:6, insight:'' },
  expenses: { total:0, events:0, security:0, pest:0, monthTrend:[], cumulative:{events:0,security:0,pest:0,total:0}, keyItems:'', insight:'' },
  staffing: { hkScore:0, securityScore:0, mstScore:0, hkAttendance:0, securityAttendance:0, mstAttendance:0, horticultureStatus:'', rosterNotes:'', keyChange:'' },
  ideas: { total:0, completed:0, inProgress:0, pending:0, highlights:[] },
  highlights: { win:'Report loaded — AI analysis unavailable.', risk:'Please regenerate to load insights.', action:'Click Generate again.' },
};

const DM_FALLBACK = {
  dept: 'dm', periodLabel: '',
  leadPerformance: { cpql:{current:0,target:1200,prevMonth:0}, qualRate:{current:0,target:30}, ql:{current:0,target:330}, siteVisits:{current:0,target:130}, leads:{current:0,target:1100}, bookings:0, cpqlTrend:[], funnelTable:[], insight:'' },
  contentCalendar: { planAdherence:0, plannedItems:'', achievedItems:'', adsRun:0, insight:'' },
  socialMedia: { instagram:{followers:0,new:0,target:4200}, linkedin:{followers:0,new:0,target:2500}, facebook:{followers:0,new:0}, youtube:{subscribers:0,new:0}, trendMonths:[], instagramTrend:[], linkedinTrend:[], insight:'' },
  budgetSpend: { allocatedMonthly:600000, spentThisPeriod:0, utilisedPct:0, cumulativeSurplus:0, breakdown:[], spendTrend:[], insight:'' },
  newsletter: { openRate:0, benchmark:45, trend:[], insight:'' },
  portalsChannels: { merakiORM:0, targetORM:4.8, portals:[], cpBrokers:0, cpActive:0, insight:'' },
  highlights: { win:'Report loaded — AI analysis unavailable.', risk:'Please regenerate to load insights.', action:'Click Generate again.' },
};

const LR_FALLBACK = {
  dept: 'lr', periodLabel: '',
  landTracker: { totalParcels:0, regDone:0, regPending:0, eKhataDone:0, eKhataPending:0, items:[] },
  merakiTracker: { done:0, pending:0, total:0, items:[] },
  assets: { total:0, inProgress:0, pending:0, completed:0, mgmtDecisionsRequired:0, items:[] },
  planVsAchieved: { period:'', avgPct:0, metrics:[] },
  cases: { total:0, active:0, settled:0, disposed:0, atHighCourt:0, items:[] },
  highlights: { win:'Report loaded — AI analysis unavailable.', risk:'Please regenerate to load insights.', action:'Click Generate again.' },
};

const FALLBACKS = { fm: FM_FALLBACK, dm: DM_FALLBACK, lr: LR_FALLBACK };

const SYSTEMS = {
  fm: FM_SYSTEM, dm: DM_SYSTEM, lr: LR_SYSTEM,
};

// ---------- Handler ----------

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { rawSheets, dept = 'fm', period, periodMonths = [] } = req.body || {};
  const fallback = FALLBACKS[dept] || FM_FALLBACK;

  if (!rawSheets) {
    return res.status(200).json({ ...fallback, _error: 'No rawSheets provided' });
  }

  try {
    let prompt;
    if (dept === 'fm') {
      prompt = buildFMPrompt(rawSheets, period, periodMonths);
    } else if (dept === 'dm') {
      prompt = buildDMPrompt(rawSheets, period, periodMonths);
    } else if (dept === 'lr') {
      prompt = buildLRPrompt(rawSheets, period, periodMonths);
    } else {
      return res.status(400).json({ error: `Unknown dept: ${dept}` });
    }

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10000,
      system: SYSTEMS[dept],
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = (msg.content[0]?.text || '').trim();
    let json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    let result;
    try {
      result = JSON.parse(json);
    } catch {
      // Try to close truncated JSON by counting open braces/brackets
      const opens = (json.match(/[{[]/g) || []).length;
      const closes = (json.match(/[}\]]/g) || []).length;
      const diff = opens - closes;
      if (diff > 0) {
        // Strip trailing incomplete string/value then close all open containers
        const trimmed = json.replace(/,?\s*"[^"]*$/, '').replace(/,\s*$/, '');
        const closing = '}'.repeat(Math.min(diff, 10));
        try {
          result = JSON.parse(trimmed + closing);
        } catch {
          console.error('JSON repair failed. Raw:', raw.slice(0, 300));
          return res.status(200).json({ ...fallback, periodLabel: period, _parseError: true });
        }
      } else {
        console.error('JSON parse failed. Raw:', raw.slice(0, 300));
        return res.status(200).json({ ...fallback, periodLabel: period, _parseError: true });
      }
    }

    return res.status(200).json({
      ...fallback,
      ...result,
      fetchTime: new Date().toISOString(),
      periodLabel: result.periodLabel || period,
    });

  } catch (err) {
    console.error('analyze.js error:', err.message);
    return res.status(200).json({ ...fallback, periodLabel: period, _error: err.message });
  }
}
