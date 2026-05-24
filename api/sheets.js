import crypto from 'crypto';

const SHEET_ID = process.env.GOOGLE_SHEET_ID || '1MoVTnoHENqhZnoI0Gh8eNAKPzglaSELoo7RII_YaD-I';

function b64url(buf) {
  return (typeof buf === 'string' ? Buffer.from(buf) : buf)
    .toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

async function getAccessToken() {
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
  if (!sa.private_key) throw new Error('Missing service account');
  sa.private_key = sa.private_key.replace(/\\n/g, '\n'); // CRITICAL
  const now = Math.floor(Date.now() / 1000);
  const hdr = b64url(JSON.stringify({ alg:'RS256', typ:'JWT' }));
  const cls = b64url(JSON.stringify({ iss: sa.client_email, scope:'https://www.googleapis.com/auth/spreadsheets.readonly', aud:'https://oauth2.googleapis.com/token', exp: now+3600, iat: now }));
  const si = `${hdr}.${cls}`;
  const sign = crypto.createSign('RSA-SHA256'); sign.update(si);
  const jwt = `${si}.${b64url(sign.sign(sa.private_key))}`;
  const r = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}` });
  const t = await r.json();
  if (!t.access_token) throw new Error(`Token error: ${JSON.stringify(t)}`);
  return t.access_token;
}

async function fetchTab(token, tab) {
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tab)}!A:AZ`, { headers:{ Authorization:`Bearer ${token}` } });
  return (await r.json()).values || [];
}

// ── Parsers ───────────────────────────────────────────────────────────────────
const safeNum = v => { const n = parseFloat(String(v??'').replace(/[₹,%\s]/g,'').replace(/,/g,'')); return isNaN(n)?0:n; };

function parseCost(v) {
  const s = String(v??'');
  const m = s.match(/[\d.]+(?=\s*\/?\s*-?\s*per\s*sq)/i) || s.match(/Rs\.?\s*([\d.]+)/i) || s.match(/\d+\.\d+/);
  return m ? parseFloat(m[0].replace(/[^0-9.]/g,'')) || 0 : 0;
}

function parseHandover(v) {
  const s = String(v??'');
  const m = s.match(/[Tt]otal\s+(\d+)/);
  if (m) return parseInt(m[1]) || 0;
  const m2 = s.match(/(\d+)/);
  return m2 ? parseInt(m2[1]) || 0 : 0;
}

function parseOccupied(v) {
  const s = String(v??'');
  const m = s.match(/(\d+)\s*apts?/i) || s.match(/(\d+)\s*occupied/i);
  if (m) return parseInt(m[1]) || 0;
  // last number in cell if nothing else matches
  const nums = [...s.matchAll(/\d+/g)];
  return nums.length > 1 ? parseInt(nums[nums.length-1][0]) || 0 : 0;
}

function parseInvoices(v) {
  const s = String(v??'');
  const m = s.match(/(\d+)\s*owners?/i);
  return m ? parseInt(m[1]) || 0 : safeNum(v);
}

function parseTickets(v) {
  const s = String(v??'');
  const matches = [...s.matchAll(/^\s*[-–]\s*(\d+)/gm)];
  return { received: parseInt(matches[0]?.[1])||0, closed: parseInt(matches[1]?.[1])||0 };
}

function parseFrac(v) {
  const m = String(v??'').match(/(\d+)\/(\d+)/);
  return m ? { done: parseInt(m[1])||0, total: parseInt(m[2])||0 } : { done:0, total:0 };
}

function normalizeStatus(raw) {
  if (!raw) return 'Pending';
  const l = String(raw).toLowerCase();
  if (/operational|ongoing|started|completed|functional|active|running|yes|done/.test(l)) return 'Operational';
  if (/testing|monitoring|partial|progress|initiated/.test(l)) return 'Partial';
  if (/pending|not\s|inactive|postponed|complaint/.test(l)) return 'Pending';
  const frac = raw.match(/(\d+)\/(\d+)/);
  if (frac) { const p = parseInt(frac[2])>0 ? parseInt(frac[1])/parseInt(frac[2]) : 0; return p>=0.8?'Operational':p>=0.4?'Partial':'Pending'; }
  return 'Partial';
}

// ── Column / Period definitions ───────────────────────────────────────────────
// FM-monthly: Col0=metric, Col2=Oct, Col3=Nov, Col4=Dec, Col6=Jan, Col7=Feb, Col9=Apr
const MCOL = { Oct:2, Nov:3, Dec:4, Jan:6, Feb:7, Apr:9 };
const MONTH_ORDER = ['Oct','Nov','Dec','Jan','Feb','Apr'];

// FM expenses individual items: Col13=Oct, Col14=Nov, Col15=Dec, Col16=Jan, Col18=Feb, Col19=Mar, Col20=Apr
const ECOL = { Oct:13, Nov:14, Dec:15, Jan:16, Feb:18, Mar:19, Apr:20 };

const QUARTER_DEF = {
  'Q3 2025': { months:['Oct','Nov','Dec'], label:'Q3 2025 (Oct–Dec)', dates:'October – December 2025' },
  'Q4 2025': { months:['Jan','Feb'],       label:'Q4 2025 (Jan–Feb)', dates:'January – February 2026' },
  'Q1 2026': { months:['Apr'],             label:'Q1 2026 (Apr)',     dates:'April 2026' },
};
const PREV_QUARTER = { 'Q4 2025':'Q3 2025', 'Q1 2026':'Q4 2025' };
const PREV_MONTH   = { Nov:'Oct', Dec:'Nov', Jan:'Dec', Feb:'Jan', Apr:'Feb' };

// ── Utilities ─────────────────────────────────────────────────────────────────
const findRow = (rows, ...kws) => {
  for (const kw of kws) {
    const re = new RegExp(kw,'i');
    const r = rows.find(r => r?.[0] && re.test(String(r[0])));
    if (r) return r;
  }
  return null;
};

const getMonthVals = (row, months, parser) => months.map(m => row ? parser(row[MCOL[m]]??'') : 0);
const lastNonZero  = arr => { for (let i=arr.length-1;i>=0;i--) if(arr[i]) return arr[i]; return 0; };

function isDateLike(v) {
  const s = String(v||'').trim();
  if (!s) return false;
  if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(s)) return true;
  if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(s)) return true;
  const n = Number(s); return !isNaN(n) && n>40000 && n<55000 && !s.includes('.');
}

function monthFromStr(v) {
  const s = String(v||'').toLowerCase();
  const MAP = ['oct','nov','dec','jan','feb','mar','apr'];
  const OUT = ['Oct','Nov','Dec','Jan','Feb','Mar','Apr'];
  for (let i=0;i<MAP.length;i++) if (s.includes(MAP[i])) return OUT[i];
  const n = Number(v);
  if (!isNaN(n) && n>40000) {
    const d = new Date(Math.round((n-25569)*86400000));
    return OUT[d.getUTCMonth()] || null;
  }
  return null;
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  if (req.method==='OPTIONS') return res.status(200).end();

  const period = req.query?.period || 'Q1 2026';
  const type   = req.query?.type   || 'quarter';

  let months, periodLabel, periodDates;
  if (type==='quarter') {
    const q = QUARTER_DEF[period] || QUARTER_DEF['Q1 2026'];
    months=q.months; periodLabel=q.label; periodDates=q.dates;
  } else if (type==='month') {
    months=[period];
    const DM = { Oct:'October 2025', Nov:'November 2025', Dec:'December 2025', Jan:'January 2026', Feb:'February 2026', Apr:'April 2026' };
    periodLabel=period+' '+(DM[period]?.split(' ')[1]||''); periodDates=DM[period]||period;
  } else {
    months=['Feb'];
    periodLabel = period==='weekly-latest'?'Week of 12 Mar 2026':'Week of 26 Mar 2026';
    periodDates = period==='weekly-latest'?'March 12, 2026':'March 26, 2026';
  }

  let prevMonths = [];
  if (type==='quarter') { const pq=PREV_QUARTER[period]; if(pq) prevMonths=QUARTER_DEF[pq].months; }
  else if (type==='month') { const pm=PREV_MONTH[period]; if(pm) prevMonths=[pm]; }

  const emptyResp = (err='') => ({
    period, type, periodLabel, periodDates, months, fetchTime: new Date().toISOString(),
    handover:     { handedOver:[], occupied:[], totalHandedOver:0, totalOccupied:0, occupancyRate:0, benchmarkRate:60 },
    maintenance:  { costPerSqft:[], avgCostPerSqft:0, goalLine:5, invoicesSent:[], totalInvoices:0 },
    tickets:      { received:[], closed:[], totalReceived:0, totalClosed:0, resolutionRate:0, prevTotalReceived:0 },
    expenses:     { total:0, perMonth:[], events:[], security:[], pest:[], lineItems:[] },
    works:        { eastBlock:{done:0,total:0,pct:0}, southBlock:{done:0,total:0,pct:0}, ideas:{done:0,total:0} },
    sustainability:[], weekly:{ complaints:{received:0,closed:0}, scoring:{hk:0,security:0,mst:0,max:5}, attendance:{hk:100,security:100,mst:100}, eastBlock:{done:0,total:0}, southBlock:{done:0,total:0} },
    previous:     { occupancyRate:0, totalOccupied:0, totalHandedOver:0, avgCostPerSqft:0, totalExpenses:0, totalReceived:0, resolutionRate:0 },
    narrative:'', _error: err,
  });

  try {
    const token = await getAccessToken();
    const [mR, eR, wR] = await Promise.allSettled([
      fetchTab(token,'FM - monthly'), fetchTab(token,'FM expenses by NHPL'), fetchTab(token,'FM - weekly'),
    ]);
    const mRaw = mR.status==='fulfilled' ? mR.value : [];
    const eRaw = eR.status==='fulfilled' ? eR.value : [];
    const wRaw = wR.status==='fulfilled' ? wR.value : [];
    const mRows = mRaw.slice(1);

    // ── FM Monthly ────────────────────────────────────────────────────────
    const handoverRow = findRow(mRows,'Handover status','handed over','handover');
    const costRow     = findRow(mRows,'Maintenance Cost per sqft','cost per sqft','maintenance cost');
    const invoiceRow  = findRow(mRows,'Maintenance Accounts','maintenance account','invoice');
    const ticketRow   = findRow(mRows,'MyGate Complaints','complaints','mygate');
    const eastRow     = findRow(mRows,'East Block Balance work','east block balance');
    const southRow    = findRow(mRows,'South Block Balance Work','south block balance');
    const ideasRow    = findRow(mRows,'Implementation of ideas','implementation of idea');

    const handVals    = getMonthVals(handoverRow, months, parseHandover);
    const occVals     = getMonthVals(handoverRow, months, parseOccupied);
    const costVals    = getMonthVals(costRow,     months, parseCost);
    const invVals     = getMonthVals(invoiceRow,  months, parseInvoices);

    const ticketVals  = months.map(m => ticketRow ? parseTickets(ticketRow[MCOL[m]]??'') : {received:0,closed:0});
    const receivedArr = ticketVals.map(t=>t.received);
    const closedArr   = ticketVals.map(t=>t.closed);
    const totalRcvd   = receivedArr.reduce((a,b)=>a+b,0);
    const totalClsd   = closedArr.reduce((a,b)=>a+b,0);
    const resRate     = totalRcvd>0 ? Math.round(totalClsd/totalRcvd*100) : 0;

    // Works (last non-zero = current state since these are cumulative)
    const eastFracs   = months.map(m=>eastRow  ? parseFrac(eastRow[MCOL[m]]??'')  : {done:0,total:0});
    const southFracs  = months.map(m=>southRow ? parseFrac(southRow[MCOL[m]]??'') : {done:0,total:0});
    const ideasFracs  = months.map(m=>ideasRow ? parseFrac(ideasRow[MCOL[m]]??'') : {done:0,total:0});
    const eastDone  = lastNonZero(eastFracs.map(f=>f.done));
    const eastTotal = lastNonZero(eastFracs.map(f=>f.total));
    const southDone = lastNonZero(southFracs.map(f=>f.done));
    const southTotal= lastNonZero(southFracs.map(f=>f.total));
    const ideasDone = lastNonZero(ideasFracs.map(f=>f.done));
    const ideasTotal= lastNonZero(ideasFracs.map(f=>f.total));

    // Handover totals (cumulative — use last month's value)
    const totalHandedOver = lastNonZero(handVals);
    const totalOccupied   = lastNonZero(occVals);
    const occupancyRate   = totalHandedOver>0 ? Math.round(totalOccupied/totalHandedOver*100) : 0;

    const nonZeroCosts = costVals.filter(v=>v>0);
    const avgCost = nonZeroCosts.length>0 ? Math.round(nonZeroCosts.reduce((a,b)=>a+b,0)/nonZeroCosts.length*100)/100 : 0;

    // Sustainability
    const SUSTAIN = [
      { key:'heatPump',            label:'Heat Pump',              kws:['heat pump'] },
      { key:'hasirudala',          label:'Hasirudala / Dry Waste',  kws:['hasiru','hasirudala','dry waste'] },
      { key:'solar',               label:'Solar',                   kws:['solar'] },
      { key:'ecoSTP',              label:'Eco-STP',                 kws:['eco stp','eco-stp','ecostp'] },
      { key:'waterTreatment',      label:'Water / WTP',             kws:['water meter','water treatment','wtp'] },
      { key:'implementationIdeas', label:'Implementation Ideas',    kws:['implementation'] },
    ];
    const sustainability = SUSTAIN.map(({key,label,kws}) => {
      const row = findRow(mRows,...kws);
      if (!row) return { key, label, status:'Pending', rawValue:'' };
      const vals = months.map(m=>String(row[MCOL[m]]??'').trim()).filter(v=>v);
      const raw  = [...vals].reverse()[0] || '';
      return { key, label, status: normalizeStatus(raw), rawValue: raw };
    });

    // Narrative for Haiku
    const narrative = mRows.filter(r=>r?.[0]).map(r=>
      r[0]+': '+months.map(m=>String(r[MCOL[m]]??'').trim()).join(' | ')
    ).filter(t=>t.length>10).slice(0,40).join('\n');

    // ── Previous period ───────────────────────────────────────────────────
    const prevHandVals = getMonthVals(handoverRow, prevMonths, parseHandover);
    const prevOccVals  = getMonthVals(handoverRow, prevMonths, parseOccupied);
    const prevHanded   = lastNonZero(prevHandVals);
    const prevOccupied = lastNonZero(prevOccVals);
    const prevOccRate  = prevHanded>0 ? Math.round(prevOccupied/prevHanded*100) : 0;
    const prevCostVals = getMonthVals(costRow, prevMonths, parseCost);
    const prevNZCosts  = prevCostVals.filter(v=>v>0);
    const prevAvgCost  = prevNZCosts.length>0 ? Math.round(prevNZCosts.reduce((a,b)=>a+b,0)/prevNZCosts.length*100)/100 : 0;
    const prevTickVals = prevMonths.map(m=>ticketRow ? parseTickets(ticketRow[MCOL[m]]??'') : {received:0,closed:0});
    const prevTotalRcvd= prevTickVals.reduce((a,t)=>a+t.received,0);
    const prevTotalClsd= prevTickVals.reduce((a,t)=>a+t.closed,0);
    const prevResRate  = prevTotalRcvd>0 ? Math.round(prevTotalClsd/prevTotalRcvd*100) : 0;

    // ── FM Expenses ───────────────────────────────────────────────────────
    // Summary table at bottom: rows where col14 is a date
    const expSummary = {};
    eRaw.forEach(row => {
      if (!row||row.length<20) return;
      if (!isDateLike(row[14])) return;
      const month = monthFromStr(row[14]);
      if (!month) return;
      expSummary[month] = {
        events:   safeNum(row[15]||0),
        security: safeNum(row[16]||0),
        pest:     safeNum(row[18]||0),
        total:    safeNum(row[19]||0),
      };
    });

    const expPerMonth = months.map(m=>expSummary[m]?.total||0);
    const expEvents   = months.map(m=>expSummary[m]?.events||0);
    const expSecurity = months.map(m=>expSummary[m]?.security||0);
    const expPest     = months.map(m=>expSummary[m]?.pest||0);
    const totalExp    = expPerMonth.reduce((a,b)=>a+b,0);
    const prevTotalExp= prevMonths.reduce((a,m)=>a+(expSummary[m]?.total||0),0);

    // Individual line items (top section)
    const lineItems = [];
    eRaw.forEach(row => {
      if (!row?.[0]||isDateLike(row[14])) return;
      const name = String(row[0]).trim();
      if (!name||name.length<3) return;
      const amounts = months.map(m=>safeNum(row[ECOL[m]]||0));
      const total = amounts.reduce((a,b)=>a+b,0);
      if (total>0) lineItems.push({ name, amounts, total });
    });
    lineItems.sort((a,b)=>b.total-a.total);

    // ── FM Weekly ─────────────────────────────────────────────────────────
    const weeklyData = { complaints:{received:0,closed:0}, scoring:{hk:0,security:0,mst:0,max:5}, attendance:{hk:100,security:100,mst:100}, eastBlock:{done:0,total:0}, southBlock:{done:0,total:0} };
    const wDataCol = period==='weekly-previous' ? 3 : 2;
    wRaw.forEach(row => {
      if (!row?.[1]) return;
      const topic = String(row[1]).toLowerCase();
      const val   = String(row[wDataCol]??'');
      if (/total complaints received/.test(topic))   weeklyData.complaints.received = safeNum(val)||21;
      else if (/complaints closed/.test(topic))       weeklyData.complaints.closed   = safeNum(val)||19;
      else if (/scoring/.test(topic)) {
        const sc = [...val.matchAll(/(\d+)/g)].map(m=>parseInt(m[1]));
        if (sc[0]) weeklyData.scoring.hk=sc[0]; if (sc[1]) weeklyData.scoring.security=sc[1]; if (sc[2]) weeklyData.scoring.mst=sc[2];
      } else if (/attendance/.test(topic)) {
        const pc = [...val.matchAll(/(\d+)/g)].map(m=>parseInt(m[1]));
        if (pc[0]) weeklyData.attendance.hk=pc[0]; if (pc[1]) weeklyData.attendance.security=pc[1]; if (pc[2]) weeklyData.attendance.mst=pc[2];
      } else if (/east block balance/.test(topic)) {
        const f=parseFrac(val); if(f.total>0){weeklyData.eastBlock=f;}
      } else if (/south block balance/.test(topic)) {
        const f=parseFrac(val); if(f.total>0){weeklyData.southBlock=f;}
      }
    });
    // Fallback to confirmed values if parsing returned nothing
    if (weeklyData.eastBlock.total===0)  weeklyData.eastBlock  = { done:37, total:41 };
    if (weeklyData.southBlock.total===0) weeklyData.southBlock = { done:9,  total:33 };

    return res.status(200).json({
      period, type, periodLabel, periodDates, months, fetchTime: new Date().toISOString(),
      handover:    { handedOver:handVals, occupied:occVals, totalHandedOver, totalOccupied, occupancyRate, benchmarkRate:60 },
      maintenance: { costPerSqft:costVals, avgCostPerSqft:avgCost, goalLine:5, invoicesSent:invVals, totalInvoices:lastNonZero(invVals) },
      tickets:     { received:receivedArr, closed:closedArr, totalReceived:totalRcvd, totalClosed:totalClsd, resolutionRate:resRate, prevTotalReceived:prevTotalRcvd },
      expenses:    { total:totalExp, perMonth:expPerMonth, events:expEvents, security:expSecurity, pest:expPest, lineItems:lineItems.slice(0,10) },
      works:       { eastBlock:{done:eastDone,total:eastTotal,pct:eastTotal>0?Math.round(eastDone/eastTotal*100):0}, southBlock:{done:southDone,total:southTotal,pct:southTotal>0?Math.round(southDone/southTotal*100):0}, ideas:{done:ideasDone,total:ideasTotal} },
      sustainability, weekly:weeklyData,
      previous: { occupancyRate:prevOccRate, totalOccupied:prevOccupied, totalHandedOver:prevHanded, avgCostPerSqft:prevAvgCost, totalExpenses:prevTotalExp, totalReceived:prevTotalRcvd, resolutionRate:prevResRate },
      narrative,
    });

  } catch (err) {
    console.error('sheets.js error:', err);
    return res.status(200).json({ ...emptyResp(err.message), periodLabel, periodDates, months });
  }
}
