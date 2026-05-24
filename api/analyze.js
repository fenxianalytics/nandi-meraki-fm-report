import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

const SYSTEM = `You are a senior Facility Management analyst for Nandi Meraki, a premium Indian residential community in Bangalore.

Indian FM benchmarks you always apply:
• Ticket resolution rate: ≥85% excellent | 70-84% acceptable | <70% needs attention
• Maintenance cost/sqft/month: ₹4–6 normal, ₹5 target
• Occupancy ramp: 60%+ within 12 months = healthy
• Security cost is a fixed ₹1,11,000/month — flag what is driving variable spend
• Works completion: flag anything behind pace

Return ONLY a raw JSON object. No markdown. No backticks. No preamble. Nothing before or after. Only the JSON.`;

function buildPrompt(data, period) {
  const d = data;
  const prev = d.previous || {};
  return `Analyze FM data for Nandi Meraki — ${period} — and return insights JSON.

PERIOD: ${d.periodLabel} | DATES: ${d.periodDates} | MONTHS: ${(d.months||[]).join(', ')}

HANDOVER & OCCUPANCY:
- Handed over per month: ${JSON.stringify(d.handover?.handedOver)}
- Occupied per month: ${JSON.stringify(d.handover?.occupied)}
- Total handed over: ${d.handover?.totalHandedOver} | Total occupied: ${d.handover?.totalOccupied}
- Occupancy rate: ${d.handover?.occupancyRate}% vs 60% benchmark
- Previous period occupancy: ${prev.occupancyRate}%

MAINTENANCE COST (₹/sqft):
- By month: ${JSON.stringify(d.maintenance?.costPerSqft)}
- Average: ₹${d.maintenance?.avgCostPerSqft} vs ₹5 target
- Previous average: ₹${prev.avgCostPerSqft}
- Invoices sent: ${JSON.stringify(d.maintenance?.invoicesSent)} | Total: ${d.maintenance?.totalInvoices}

TICKETS:
- Received per month: ${JSON.stringify(d.tickets?.received)}
- Closed per month: ${JSON.stringify(d.tickets?.closed)}
- Total received: ${d.tickets?.totalReceived} | Total closed: ${d.tickets?.totalClosed}
- Resolution rate: ${d.tickets?.resolutionRate}% | Previous: ${prev.resolutionRate}%
- Previous total received: ${prev.totalReceived}
${d.tickets?.totalReceived > 0 && prev.totalReceived > 0 ? `- Change vs previous: ${Math.round((d.tickets.totalReceived - prev.totalReceived)/prev.totalReceived*100)}%` : ''}

EXPENSES:
- Total: ₹${(d.expenses?.total||0).toLocaleString('en-IN')}
- By month: ${JSON.stringify(d.expenses?.perMonth)}
- Events per month: ${JSON.stringify(d.expenses?.events)}
- Security per month: ${JSON.stringify(d.expenses?.security)} (fixed ~₹1,11,000/month)
- Pest per month: ${JSON.stringify(d.expenses?.pest)}
- Previous period total: ₹${(prev.totalExpenses||0).toLocaleString('en-IN')}
- Top line items: ${(d.expenses?.lineItems||[]).slice(0,5).map(i=>`${i.name}: ₹${(i.total||0).toLocaleString('en-IN')}`).join(', ')}

WORKS PROGRESS:
- East Block: ${d.works?.eastBlock?.done}/${d.works?.eastBlock?.total} (${d.works?.eastBlock?.pct}%)
- South Block: ${d.works?.southBlock?.done}/${d.works?.southBlock?.total} (${d.works?.southBlock?.pct}%)
- Ideas implemented: ${d.works?.ideas?.done}/${d.works?.ideas?.total}

SUSTAINABILITY (latest status per system):
${(d.sustainability||[]).map(s=>`- ${s.label}: "${s.rawValue}" → ${s.status}`).join('\n')}

NARRATIVE TEXT FROM SHEET (for goal categorisation):
${(d.narrative||'').slice(0,2000)}

Return this exact JSON (no extra fields):
{
  "healthScore": <integer 0-100>,
  "healthScoreTrend": "<+N or -N vs previous period>",
  "coverSummary": "<one punchy sentence ≤20 words summarising this period>",
  "goals": {
    "met": ["<initiative that was clearly achieved>", ...],
    "partial": ["<initiative mostly on track>", ...],
    "missed": ["<initiative below target or at risk>", ...]
  },
  "ticketsInsight": "<one line ≤15 words on ticket patterns, mention any spike>",
  "expensesInsight": "<one line ≤15 words on spend — security is fixed, flag variable drivers>",
  "operationsInsight": "<one line ≤15 words on sustainability/infrastructure>",
  "sustainabilityNotes": {
    "heatPump":            {"status": "<Operational|Partial|Pending>", "note": "<≤12 words>"},
    "hasirudala":          {"status": "<Operational|Partial|Pending>", "note": "<≤12 words>"},
    "solar":               {"status": "<Operational|Partial|Pending>", "note": "<≤12 words>"},
    "ecoSTP":              {"status": "<Operational|Partial|Pending>", "note": "<≤12 words>"},
    "waterTreatment":      {"status": "<Operational|Partial|Pending>", "note": "<≤12 words>"},
    "implementationIdeas": {"status": "<Operational|Partial|Pending>", "note": "<≤12 words>"}
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
  healthScore: 0, healthScoreTrend: '—',
  coverSummary: 'FM data loaded — analysis unavailable.',
  goals: { met:[], partial:[], missed:[] },
  ticketsInsight: 'Analysis unavailable.',
  expensesInsight: 'Analysis unavailable.',
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
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') return res.status(200).end();
  if (req.method!=='POST') return res.status(405).json({ error:'POST only' });

  try {
    const { data, period } = req.body || {};
    if (!data) return res.status(200).json(FALLBACK);

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: SYSTEM,
      messages: [{ role:'user', content: buildPrompt(data, period||data.period||'the selected period') }],
    });

    const raw  = (msg.content[0]?.text||'').trim();
    const json = raw.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/i,'').trim();

    let insights;
    try { insights = JSON.parse(json); }
    catch { console.error('JSON parse failed:', raw.slice(0,300)); insights = { ...FALLBACK, _parseError:true }; }

    return res.status(200).json(insights);
  } catch (err) {
    console.error('analyze.js error:', err.message);
    return res.status(200).json({ ...FALLBACK, _error: err.message });
  }
}
