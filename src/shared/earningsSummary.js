// Ported from day-trader-skill (MIT, Jake Schincariol)
//
// "What changed" in plain Hebrew, generated only from the filed numbers
// (server/earningsService.js): the latest quarter against the same quarter a
// year earlier first (many businesses are seasonal), margins in percentage
// points, and the caveats facts.py prints - a derived Q4, net income above
// operating income (one-offs), SEC data that lags a filed report.
// Pure; used by the server route and the earnings page.

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function moneyHe(v) {
  if (!isNum(v)) return 'לא זמין';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)} מיליארד דולר`;
  return `${sign}${(abs / 1e6).toFixed(1)} מיליון דולר`;
}

const fmtPct = (v) => `${Math.abs(v).toFixed(1)}%`;

// "עלייה של 12.1%" / "ירידה של 3.0%" / "ללא שינוי"
function changeHe(v) {
  if (!isNum(v)) return null;
  if (v === 0) return 'ללא שינוי';
  return `${v > 0 ? 'עלייה' : 'ירידה'} של ${fmtPct(v)}`;
}

function pointsHe(v) {
  if (!isNum(v)) return null;
  if (v === 0) return 'ללא שינוי';
  return `${v > 0 ? 'עלייה' : 'ירידה'} של ${Math.abs(v).toFixed(1)} נקודות אחוז`;
}

const MARGINS = [
  ['grossMargin', 'grossMarginYoyPt', 'שולי הרווח הגולמי'],
  ['operatingMargin', 'operatingMarginYoyPt', 'שולי הרווח התפעולי'],
  ['netMargin', 'netMarginYoyPt', 'שולי הרווח הנקי']
];

// buildEarningsSummary({ quarters, ttm, staleNote }) -> string[]
function buildEarningsSummary(data) {
  const rows = (data && data.quarters) || [];
  if (!rows.length) return [];
  const cur = rows[0];
  const prev = rows[1] || null;
  const out = [];

  const label = (cur.fiscal || '').trim();
  let line = `ברבעון שהסתיים ב-${cur.end}${label ? ` (${label})` : ''}${cur.derived ? ', מחושב מהדוח השנתי' : ''}: הכנסות של ${moneyHe(cur.revenue)}`;
  const revChange = changeHe(cur.revenueYoy);
  if (revChange) line += `, ${revChange} לעומת הרבעון המקביל אשתקד`;
  out.push(`${line}.`);

  const parts = [];
  if (isNum(cur.netIncome)) {
    const c = changeHe(cur.netIncomeYoy);
    parts.push(`רווח נקי ${moneyHe(cur.netIncome)}${c ? ` (${c})` : ''}`);
  }
  if (isNum(cur.epsDiluted)) {
    const c = changeHe(cur.epsYoy);
    parts.push(`רווח מדולל למניה ${cur.epsDiluted.toFixed(2)} דולר${c ? ` (${c})` : ''}`);
  }
  if (parts.length) out.push(`${parts.join(', ')}.`);

  for (const [key, yoyKey, name] of MARGINS) {
    if (!isNum(cur[key])) continue;
    let s = `${name} ${cur[key].toFixed(1)}%`;
    const yoy = pointsHe(cur[yoyKey]);
    if (yoy) s += `, ${yoy} לעומת אשתקד`;
    else if (prev && isNum(prev[key])) s += `, ${pointsHe(Math.round((cur[key] - prev[key]) * 10) / 10)} לעומת הרבעון הקודם`;
    out.push(`${s}.`);
  }

  if (isNum(cur.netIncome) && isNum(cur.operatingIncome) && cur.netIncome > cur.operatingIncome) {
    out.push('הרווח הנקי גבוה מהרווח התפעולי: כלולים בו רווחים מחוץ לפעילות העסקית (השקעות, מסים). כדאי לבדוק בדוח לפני שקוראים בזה צמיחה.');
  }

  const ttm = (data && data.ttm) || {};
  if (isNum(ttm.revenue)) {
    let s = `בארבעת הרבעונים האחרונים: הכנסות של ${moneyHe(ttm.revenue)}`;
    if (isNum(ttm.netIncome)) s += `, רווח נקי ${moneyHe(ttm.netIncome)}`;
    if (isNum(ttm.epsDiluted)) s += `, רווח מדולל למניה ${ttm.epsDiluted.toFixed(2)} דולר`;
    out.push(`${s}.`);
  }

  if (rows.some((r) => r.derived)) {
    out.push('רבעון רביעי מסומן "מחושב": הדוח השנתי פחות שלושת הרבעונים שבתוכו; הרווח למניה בו משוער.');
  }

  const note = data && data.staleNote;
  if (note) {
    out.push(`נתוני ה-XBRL של SEC נעצרים ב-${note.factsEnd}, אבל כבר הוגש ${note.form} לתקופה שהסתיימה ב-${note.period} (ב-${note.filed}). כדאי לקרוא אותו ישירות.`);
  }
  return out;
}

exports.buildEarningsSummary = buildEarningsSummary;
exports.moneyHe = moneyHe;
