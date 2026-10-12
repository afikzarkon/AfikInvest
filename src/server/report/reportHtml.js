// The monthly report as a self-contained HTML document for Chrome to print
// (see pdfRenderer.js). Right-to-left Hebrew is laid out by the browser's own
// bidi algorithm - no manual text reversal like the jsPDF export needs - and
// numbers are isolated as LTR runs so "-₪1,234" never flips inside Hebrew.
//
// Everything is inline: the Alef font as a data URI, the charts as SVG, the
// styles in one <style>. The renderer blocks all network access, so nothing
// here may reference an external URL. Every string from the model is
// escaped.
const fs = require('fs');
const path = require('path');
const { EVENT_LABELS_HE } = require('../../shared/eventCalendar');

const escapeHtml = (value) =>
  String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const HEBREW_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const monthLabel = (month) => {
  const [y, m] = String(month).split('-').map(Number);
  return `${HEBREW_MONTHS[m - 1] || ''} ${y}`;
};

const fmtMoney = (v, currency = '₪') => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const sign = v < 0 ? '-' : '';
  return `${sign}${currency}${Math.round(Math.abs(v)).toLocaleString('en-US')}`;
};
const fmtSigned = (v, currency = '₪') => (v > 0 ? `+${fmtMoney(v, currency)}` : fmtMoney(v, currency));
const fmtPct = (v, signed = true, digits = 1) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${signed && v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
};
const EVENT_STATUS_HE = { confirmed: 'מאושר', estimated: 'הערכה', projected: 'משוער' };
const num = (text) => `<span class="num">${escapeHtml(text)}</span>`;
const tone = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

const PALETTE = ['#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777'];

// Donut chart of the allocation groups. Colors are by the group's position
// in the full list (same as the legend), so a zero-value group that draws
// no arc does not shift every later color.
function donutSvg(slices) {
  const total = slices.reduce((s, x) => s + Math.max(0, x.value), 0);
  if (!(total > 0)) return '';
  const r = 70;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const arcs = slices
    .map((s, i) => ({ s, color: PALETTE[i % PALETTE.length] }))
    .filter(({ s }) => s.value > 0)
    .map(({ s, color }) => {
      const len = (s.value / total) * c;
      const arc = `<circle r="${r}" cx="90" cy="90" fill="none" stroke="${color}" stroke-width="28" stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 90 90)"/>`;
      offset += len;
      return arc;
    })
    .join('');
  return `<svg class="donut" viewBox="0 0 180 180" width="180" height="180" role="img" aria-label="פיזור נכסים">${arcs}</svg>`;
}

// A bar inside the row it belongs to, scaled to the largest |contribution|
// in the table.
function barCell(value, max) {
  const width = max > 0 ? Math.max(2, (Math.abs(value) / max) * 100) : 0;
  return `<td class="bar-cell"><span class="bar ${value >= 0 ? 'bar-pos' : 'bar-neg'}" style="width:${width.toFixed(1)}%"></span></td>`;
}

function moversTable(title, items) {
  if (!items.length) return `<h3>${escapeHtml(title)}</h3><p class="muted">אין</p>`;
  const max = Math.max(...items.map((m) => Math.abs(m.contributionILS)));
  const rows = items
    .map(
      (m) => `<tr>
        <td>${escapeHtml(m.label)}</td>
        <td class="muted">${escapeHtml(m.categoryLabel)}</td>
        <td class="${tone(m.contributionILS)}">${num(fmtSigned(m.contributionILS))}</td>
        <td class="${tone(m.contributionILS)}">${num(fmtPct(m.percent))}</td>
        ${barCell(m.contributionILS, max)}
      </tr>`
    )
    .join('');
  return `<h3>${escapeHtml(title)}</h3>
    <table><thead><tr><th>נכס</th><th>סוג</th><th>תרומה</th><th>שינוי</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

let cachedFont = null;
// The Alef font the client-side PDF export already bundles, read from its
// ES-module source file (the server does not transpile, so it cannot import
// it). Null when the file is missing - Chrome then falls back to a system
// Hebrew font.
function loadAlefBase64() {
  if (cachedFont !== null) return cachedFont || null;
  try {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'fonts', 'alefRegularBase64.js'), 'utf8');
    const match = source.match(/ALEF_REGULAR_BASE64\s*=\s*"([A-Za-z0-9+/=]+)"/);
    cachedFont = match ? match[1] : '';
  } catch {
    cachedFont = '';
  }
  return cachedFont || null;
}

function renderReportHtml(model, { fontBase64 = loadAlefBase64() } = {}) {
  const s = model.summary;
  const fontFace = fontBase64
    ? `@font-face { font-family: 'Alef'; src: url(data:font/ttf;base64,${fontBase64}) format('truetype'); }`
    : '';

  const allocationRows = model.allocation
    .map(
      (a, i) => `<tr>
        <td><span class="swatch" style="background:${PALETTE[i % PALETTE.length]}"></span>${escapeHtml(a.label)}</td>
        <td>${num(fmtMoney(a.value))}</td>
        <td>${num(fmtPct(a.percent, false))}</td>
        <td>${a.targetPercent === null || a.targetPercent === undefined ? '—' : num(fmtPct(a.targetPercent, false))}</td>
      </tr>`
    )
    .join('');

  const categoryRows = model.categories
    .filter((c) => c.value)
    .map((c) => `<tr><td>${escapeHtml(c.label)}</td><td>${num(fmtMoney(c.value))}</td><td>${num(fmtPct(c.percent, false))}</td></tr>`)
    .join('');

  const cf = model.cashFlow;
  const estimatedRows = (cf.estimatedDividends || [])
    .map(
      (d) => `<tr><td>${num(d.date)}</td><td>${escapeHtml(d.symbol)}</td><td>${num(`${d.gross.toFixed(2)} ${d.currency}`)}</td><td class="muted">${num(`${d.units} × ${d.amountPerShare.toFixed(4)}`)}</td><td>${d.grossILS === null ? '—' : num(fmtMoney(d.grossILS))}</td></tr>`
    )
    .join('');
  const dividendRows = cf.dividends
    .map(
      (d) => `<tr><td>${num(d.date)}</td><td>${escapeHtml(d.symbol)}</td><td>${num(`${d.gross.toFixed(2)} ${d.currency}`)}</td><td>${num(`${d.taxWithheld.toFixed(2)} ${d.currency}`)}</td><td>${num(fmtMoney(d.netILS))}</td></tr>`
    )
    .join('');

  const eventRows = model.upcomingEvents
    .map(
      (e) => `<tr><td>${num(e.eventDate)}</td><td>${escapeHtml(e.symbol)}</td><td>${escapeHtml(EVENT_LABELS_HE[e.eventType] || e.eventType)}</td><td class="muted">${escapeHtml(EVENT_STATUS_HE[e.status] || e.status)}</td></tr>`
    )
    .join('');

  const freshnessRows = model.dataFreshness
    .map(
      (a) => `<tr><td>${escapeHtml(a.name)}</td><td>${num(a.valueDate || '—')}</td><td>${a.excluded ? '<span class="muted">הוחרג</span>' : a.updated ? '<span class="pos">עודכן</span>' : '<span class="neg">לא עודכן</span>'}</td></tr>`
    )
    .join('');

  const prevNote = !model.previousMonth
    ? 'אין חודש קודם שמור להשוואה.'
    : model.previousIsAdjacent
    ? ''
    : `ההשוואה היא מול ${escapeHtml(monthLabel(model.previousMonth))} (החודש הקודם לא נשמר).`;

  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<title>דוח חודשי - ${escapeHtml(monthLabel(model.month))}</title>
<style>
${fontFace}
@page { size: A4; margin: 14mm 12mm 16mm; }
* { box-sizing: border-box; }
body { font-family: 'Alef', 'Arial', sans-serif; color: #1f2937; font-size: 11pt; margin: 0; }
h1 { font-size: 20pt; margin: 0 0 2mm; }
h2 { font-size: 14pt; margin: 8mm 0 3mm; border-bottom: 1px solid #e5e7eb; padding-bottom: 1.5mm; break-after: avoid; }
h3 { font-size: 11.5pt; margin: 4mm 0 2mm; }
section { break-inside: avoid; }
.muted { color: #6b7280; }
.pos { color: #15803d; }
.neg { color: #b91c1c; }
.num { direction: ltr; unicode-bidi: isolate; font-variant-numeric: tabular-nums; }
.kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3mm; }
.kpi { border: 1px solid #e5e7eb; border-radius: 3mm; padding: 3mm 4mm; }
.kpi .label { color: #6b7280; font-size: 9.5pt; }
.kpi .value { font-size: 16pt; font-weight: 700; margin-top: 1mm; }
.kpi .sub { font-size: 9pt; color: #6b7280; margin-top: 1mm; }
table { width: 100%; border-collapse: collapse; font-size: 10pt; }
th, td { text-align: right; padding: 1.6mm 2mm; border-bottom: 1px solid #f1f5f9; }
th { color: #6b7280; font-weight: 600; background: #f8fafc; }
.alloc { display: grid; grid-template-columns: 50mm 1fr; gap: 6mm; align-items: center; }
.swatch { display: inline-block; width: 3mm; height: 3mm; border-radius: 1mm; margin-inline-end: 2mm; }
.bar-cell { width: 40%; }
.bar { display: block; height: 3mm; border-radius: 1mm; }
.bar-pos { background: #16a34a; }
.bar-neg { background: #dc2626; }
.note { font-size: 8.5pt; color: #6b7280; margin-top: 2mm; line-height: 1.5; }
.header { display: flex; justify-content: space-between; align-items: baseline; }
</style>
</head>
<body>
<header class="header">
  <div>
    <h1>דוח חודשי - ${escapeHtml(monthLabel(model.month))}</h1>
    <div class="muted">${escapeHtml(model.userEmail)}</div>
  </div>
  <div class="muted">הופק ${num(String(model.generatedAt).slice(0, 10))}</div>
</header>

<section>
  <h2>תקציר מנהלים</h2>
  <div class="kpis">
    <div class="kpi"><div class="label">שווי נקי</div><div class="value">${num(fmtMoney(s.netWorthILS))}</div>
      <div class="sub">${s.netWorthUSD ? num(fmtMoney(s.netWorthUSD, '$')) : ''}</div></div>
    <div class="kpi"><div class="label">שינוי בחודש</div><div class="value ${tone(s.changeILS)}">${num(fmtSigned(s.changeILS))}</div>
      <div class="sub">${num(fmtPct(s.changePct))}${s.changeUSD !== null && s.changeUSD !== undefined ? ` · ${num(fmtSigned(s.changeUSD, '$'))}` : ''}</div></div>
    <div class="kpi"><div class="label">תשואה חודשית (מנוטרלת הפקדות)</div><div class="value ${tone(s.returnPct)}">${num(fmtPct(s.returnPct, true, 2))}</div>
      <div class="sub">Modified Dietz</div></div>
  </div>
  <table style="margin-top:4mm">
    <tr><td>שינוי מתנועת שוק</td><td class="${tone(s.marketChangeILS)}">${num(fmtSigned(s.marketChangeILS))}</td></tr>
    <tr><td>הון נטו שנוסף (הפקדות וקניות פחות מכירות, משיכות ודיבידנדים)</td><td>${num(fmtSigned(s.netCapitalAddedILS))}</td></tr>
  </table>
  ${prevNote ? `<p class="note">${prevNote}</p>` : ''}
</section>

<section>
  <h2>פיזור נכסים</h2>
  <div class="alloc">
    ${donutSvg(model.allocation)}
    <table><thead><tr><th>קבוצה</th><th>שווי</th><th>משקל</th><th>יעד</th></tr></thead><tbody>${allocationRows}</tbody></table>
  </div>
  <table style="margin-top:4mm"><thead><tr><th>קטגוריה</th><th>שווי</th><th>משקל</th></tr></thead><tbody>${categoryRows}</tbody></table>
</section>

<section>
  <h2>המובילים והמושכים למטה</h2>
  ${moversTable('תרמו הכי הרבה', model.topMovers)}
  ${moversTable('גרעו הכי הרבה', model.topDraggers)}
  <p class="note">התרומה היא השינוי בשווי הנכס בניכוי כסף שנכנס אליו או יצא ממנו בחודש, כך שקנייה חדשה לא נראית כרווח.</p>
</section>

<section>
  <h2>תזרים מזומנים</h2>
  <table>
    <tr><td>דיבידנדים שהתקבלו (נטו, לפי העסקאות שנרשמו)</td><td>${num(fmtMoney(cf.dividendsNetILS))}</td></tr>
    ${estimatedRows ? `<tr><td>דיבידנדים משוערים שלא נרשמו (ברוטו, לפי נתוני שוק)</td><td>${num(fmtMoney(cf.estimatedDividendsGrossILS))}</td></tr>` : ''}
    <tr><td>הפקדות</td><td>${num(fmtMoney(cf.depositsILS))}</td></tr>
    <tr><td>משיכות</td><td>${num(fmtMoney(cf.withdrawalsILS))}</td></tr>
    <tr><td>קניות ניירות ערך</td><td>${num(fmtMoney(cf.purchasesILS))}</td></tr>
    <tr><td>תמורה ממכירות</td><td>${num(fmtMoney(cf.saleProceedsILS))}</td></tr>
    ${cf.declaredILS ? `<tr><td>תזרים שהוזן ידנית</td><td>${num(fmtSigned(cf.declaredILS))}</td></tr>` : ''}
    <tr><th>הון נטו שנוסף / נמשך</th><th>${num(fmtSigned(cf.netCapitalAddedILS))}</th></tr>
    ${cf.realizedCount ? `<tr><td>רווח הון נומינלי ממומש (${cf.realizedCount} מנות)</td><td class="${tone(cf.realizedGainILS)}">${num(fmtSigned(cf.realizedGainILS))}</td></tr>` : ''}
  </table>
  ${estimatedRows ? `<h3>דיבידנדים משוערים (לא נרשמו בעסקאות)</h3><table><thead><tr><th>יום אקס</th><th>נייר</th><th>ברוטו</th><th>יחידות × לחלוקה</th><th>ברוטו בש"ח</th></tr></thead><tbody>${estimatedRows}</tbody></table><p class="note">לפי היסטוריית הדיבידנדים בנתוני השוק והכמות שהוחזקה ביום האקס. אינם נכללים בתשואה ובהון שנוסף - כדי שייכללו, רשמו אותם בעמוד העסקאות עם המס שנוכה בפועל.</p>` : ''}
  ${dividendRows ? `<h3>דיבידנדים</h3><table><thead><tr><th>תאריך</th><th>נייר</th><th>ברוטו</th><th>מס שנוכה</th><th>נטו בש"ח</th></tr></thead><tbody>${dividendRows}</tbody></table>` : ''}
</section>

${eventRows ? `<section><h2>אירועים בחודש הבא</h2><table><thead><tr><th>תאריך</th><th>נייר</th><th>אירוע</th><th>סטטוס</th></tr></thead><tbody>${eventRows}</tbody></table></section>` : ''}

${freshnessRows ? `<section><h2>עדכניות הנתונים</h2><table><thead><tr><th>חשבון</th><th>תאריך ערך</th><th>סטטוס</th></tr></thead><tbody>${freshnessRows}</tbody></table></section>` : ''}

<p class="note">הדוח מבוסס על נקודות הבדיקה החודשיות השמורות ועל העסקאות שנרשמו. תשואה מחושבת בשיטת Modified Dietz. אין בדוח ייעוץ השקעות או ייעוץ מס.</p>
</body>
</html>`;
}

module.exports = { renderReportHtml, escapeHtml, monthLabel, loadAlefBase64 };
