import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a senior Facility Management analyst specializing in Indian premium residential communities. You write like a sharp, direct human analyst — not a bullet-point generator.

Indian residential FM industry benchmarks you always apply:
• Ticket resolution rate: ≥85% = excellent | 70–84% = acceptable | <70% = needs attention
• Maintenance cost per sqft per month: ₹4–6 is normal range, ₹5 is the common target
• Occupancy ramp: 60%+ within 12 months of handover = healthy benchmark
• Sustainability system uptime: ≥90% = Operational | 70–89% = Partial | <70% = Pending/at-risk
• Works completion pace: evaluate against planned timelines, flag overdue items

When judging each goal, compare it against BOTH the internal target from the data AND these benchmarks.
Classify goals as: met (green) = clearly achieved, partial (amber) = mostly on track but not fully there, missed (red) = clearly below target or benchmark.

Write your analyst memo like a senior professional writing to a property management board — direct, precise, no filler words.

Return ONLY a valid raw JSON object. No markdown. No backticks. No explanation. No text before or after. Only the JSON.`;

function buildPrompt(data, period) {
  const d = data;
  return `Analyze this FM report data for ${period} and return the JSON insights object.

PERIOD: ${d.periodLabel}
DATES: ${d.periodDates}
MONTHS: ${d.months?.join(', ')}

MAINTENANCE:
- Cost per sqft by month: ${JSON.stringify(d.maintenance?.costPerSqft)}
- Average cost per sqft: ₹${d.maintenance?.avgCostPerSqft}
- Goal line: ₹${d.maintenance?.goalLine}/sqft
- Total expenses: ₹${d.expenses?.total?.toLocaleString('en-IN')}
- Top expense categories: ${(d.expenses?.categories || []).slice(0,5).map(c => `${c.name}: ₹${c.amount?.toLocaleString('en-IN')}`).join(', ')}

TICKETS:
- Received by month: ${JSON.stringify(d.tickets?.received)}
- Closed by month: ${JSON.stringify(d.tickets?.closed)}
- Resolution rate: ${d.tickets?.resolutionRate}% (benchmark: 85%)
- Top categories: ${(d.tickets?.categories || []).slice(0,5).map(c => `${c.name}: ${c.count}`).join(', ')}
- Most recurring: ${d.tickets?.topCategory}

HANDOVER & OCCUPANCY:
- Units handed over by month: ${JSON.stringify(d.handover?.handedOver)}
- Units occupied by month: ${JSON.stringify(d.handover?.occupied)}
- Total handed over: ${d.handover?.totalHandedOver}
- Total occupied: ${d.handover?.totalOccupied}
- Occupancy rate: ${d.handover?.occupancyRate}% (benchmark: ${d.handover?.benchmarkRate}%)

SUSTAINABILITY (latest status):
${(d.sustainability || []).map(s => `- ${s.label}: ${s.rawValue} (normalized: ${s.status})`).join('\n')}

WORKS PROGRESS:
- East Block: ${d.works?.eastBlock?.completed}/${d.works?.eastBlock?.total} works completed (${d.works?.eastBlock?.pct}%)
- South Block: ${d.works?.southBlock?.completed}/${d.works?.southBlock?.total} works completed (${d.works?.southBlock?.pct}%)

INTERNAL TARGETS:
- Cost per sqft target: ₹${d.plan?.costPerSqft}
- Ticket resolution target: ${d.plan?.ticketResolutionRate}%
- Occupancy target: ${d.plan?.occupancyRate}%

Return this exact JSON structure:
{
  "healthScore": <integer 0-100 overall FM health>,
  "healthScoreTrend": <"+N" or "-N" estimated change vs previous period>,
  "coverSummary": "<one punchy sentence, max 20 words, summarizing this period's FM performance>",
  "goals": {
    "met": ["<goal statement>", ...],
    "partial": ["<goal statement>", ...],
    "missed": ["<goal statement>", ...]
  },
  "slide3Insight": "<one line, max 15 words, on cost/maintenance health>",
  "slide4Insight": "<one line, max 15 words, on ticket patterns>",
  "slide5Insight": "<one line, max 15 words, on occupancy health>",
  "sustainability": {
    "ecoSTP":              {"status": "<Operational|Partial|Pending>", "note": "<one line, ≤12 words>"},
    "solar":               {"status": "<Operational|Partial|Pending>", "note": "<one line, ≤12 words>"},
    "heatPump":            {"status": "<Operational|Partial|Pending>", "note": "<one line, ≤12 words>"},
    "hasirudala":          {"status": "<Operational|Partial|Pending>", "note": "<one line, ≤12 words>"},
    "waterTreatment":      {"status": "<Operational|Partial|Pending>", "note": "<one line, ≤12 words>"},
    "implementationIdeas": {"status": "<Operational|Partial|Pending>", "note": "<one line, ≤12 words>"}
  },
  "slide7Insight": "<one line, max 15 words, on works pace>",
  "memo": {
    "point1": "<what went well — 2 sentences, analyst voice>",
    "point2": "<biggest risk or concern — 2 sentences, analyst voice>",
    "point3": "<pattern emerging across the data — 2 sentences, analyst voice>",
    "point4": "<one specific recommendation for next period — 2 sentences, analyst voice>",
    "point5": "<one metric to watch closely — 2 sentences, analyst voice>"
  }
}`;
}

const FALLBACK_INSIGHTS = {
  healthScore: 0,
  healthScoreTrend: '—',
  coverSummary: 'Analysis unavailable — data loaded successfully.',
  goals: { met: [], partial: [], missed: [] },
  slide3Insight: 'Analysis unavailable.',
  slide4Insight: 'Analysis unavailable.',
  slide5Insight: 'Analysis unavailable.',
  sustainability: {
    ecoSTP:              { status: 'Partial', note: 'Status pending analysis.' },
    solar:               { status: 'Partial', note: 'Status pending analysis.' },
    heatPump:            { status: 'Partial', note: 'Status pending analysis.' },
    hasirudala:          { status: 'Partial', note: 'Status pending analysis.' },
    waterTreatment:      { status: 'Partial', note: 'Status pending analysis.' },
    implementationIdeas: { status: 'Partial', note: 'Status pending analysis.' },
  },
  slide7Insight: 'Analysis unavailable.',
  memo: {
    point1: 'Analysis unavailable.',
    point2: 'Analysis unavailable.',
    point3: 'Analysis unavailable.',
    point4: 'Analysis unavailable.',
    point5: 'Analysis unavailable.',
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = req.body || {};
    const { data, period } = body;

    if (!data) return res.status(200).json(FALLBACK_INSIGHTS);

    const userPrompt = buildPrompt(data, period || data.period || 'the selected period');

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const rawText = (message.content[0]?.text || '').trim();

    // Strip any accidental markdown wrapping
    const jsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    let insights;
    try {
      insights = JSON.parse(jsonText);
    } catch {
      console.error('JSON parse failed, raw:', rawText.slice(0, 500));
      insights = { ...FALLBACK_INSIGHTS, _parseError: true };
    }

    return res.status(200).json(insights);

  } catch (err) {
    console.error('analyze.js error:', err.message);
    return res.status(200).json({ ...FALLBACK_INSIGHTS, _error: err.message });
  }
}
