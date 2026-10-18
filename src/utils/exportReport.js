// Generates the downloadable Excel/PDF portfolio reports. Library-calling
// glue only - the actual row/number shaping lives in exportData.js (pure,
// unit-tested there). Split into "build the document object" functions
// (buildPortfolioWorkbook / buildPortfolioPdfDoc, both independently
// testable without touching the DOM) and "build + trigger a browser
// download" functions, so tests can exercise the real document-building
// logic without needing a real browser download to happen.
import ExcelJS from 'exceljs';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { ALEF_REGULAR_BASE64 } from '../assets/fonts/alefRegularBase64';
import { israelToday } from './marketSession';
import {
  buildSummaryExportRows,
  buildIsraeliStocksExportRows,
  buildAmericanStocksExportRows,
  buildPensionFundsExportRows,
  buildCashFundsExportRows,
  buildBankBalancesExportRows,
  buildBankSavingsFundsExportRows,
  buildHeadlineMetrics,
  buildPortfolioReportSections,
  buildReportAsOf,
  buildAllocationSlices,
  buildSectorSlices
} from './exportData';
import { getChartTheme } from './chartTheme';

const todayFileStamp = () => israelToday();

function addSheetFromRows(workbook, sheetName, rows) {
  if (!rows || rows.length === 0) return;
  // rightToLeft makes Excel display the sheet in the natural reading
  // direction for Hebrew content (columns flow right-to-left) - purely a
  // display setting, doesn't affect the underlying cell data.
  const worksheet = workbook.addWorksheet(sheetName, { views: [{ rightToLeft: true }] });
  const headers = Object.keys(rows[0]);
  worksheet.columns = headers.map((header) => ({ header, key: header, width: Math.max(12, header.length + 4) }));
  rows.forEach((row) => worksheet.addRow(row));
  worksheet.getRow(1).font = { bold: true };
}

// data: { summary, israeliStocks, americanStocks, pensionFunds, cashFunds, bankBalances }
export function buildPortfolioWorkbook(data) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'AfikInvest';
  workbook.created = new Date();

  addSheetFromRows(workbook, 'סיכום', buildSummaryExportRows(data.summary));
  addSheetFromRows(workbook, 'מניות ישראליות', buildIsraeliStocksExportRows(data.israeliStocks));
  addSheetFromRows(workbook, 'מניות אמריקאיות', buildAmericanStocksExportRows(data.americanStocks));
  addSheetFromRows(workbook, 'קופות גמל', buildPensionFundsExportRows(data.pensionFunds));
  addSheetFromRows(workbook, 'קרנות כספיות', buildCashFundsExportRows(data.cashFunds));
  addSheetFromRows(workbook, 'עוש', buildBankBalancesExportRows(data.bankBalances));
  addSheetFromRows(workbook, 'קופות חיסכון בבנק', buildBankSavingsFundsExportRows(data.bankSavingsFunds));

  return workbook;
}

export async function downloadPortfolioExcel(data) {
  const workbook = buildPortfolioWorkbook(data);
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `afikinvest-portfolio-${todayFileStamp()}.xlsx`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// jsPDF's built-in fonts (Helvetica etc.) have no Hebrew glyphs - plain
// Hebrew text renders as garbled Latin-1 characters, confirmed by directly
// generating and inspecting a test PDF during development. Alef-Regular.ttf
// is embedded (SIL OFL 1.1, see assets/fonts/Alef-OFL.txt) specifically to
// fix this; it was verified to cover Hebrew, Latin, digits, and the ₪ sign.
function registerHebrewFont(doc) {
  doc.addFileToVFS('Alef-Regular.ttf', ALEF_REGULAR_BASE64);
  doc.addFont('Alef-Regular.ttf', 'Alef', 'normal');
  doc.setFont('Alef');
}

// jsPDF SECOND-GUESSES EVERY STRING IT IS GIVEN.
//
// Its bidi plugin hooks every text() call - autoTable's included - and by
// default reads the string as "visual left-to-right" and converts it to
// logical order. For a string that is already in visual order (which is
// what toPdfDisplayText below produces) that conversion reverses every
// Latin and digit run inside it: "AfikInvest" was printed as "tsevnIkifA",
// "0.27%" as "%72.0" and "ESPP" as "PPSE". Decoding the glyph order in the
// generated PDF showed it - the text handed to jsPDF was right, and this
// pass is what broke it.
//
// Declaring the input AND the output visual makes that pass a no-op, so
// the characters are drawn exactly in the order this file decided. Done
// by wrapping the instance's text() because autoTable calls it with no
// options of its own.
function drawTextAsGiven(doc) {
  const text = doc.text;
  doc.text = function textInGivenOrder(value, x, y, options, transform) {
    const visual = Object.assign({}, options, { isInputVisual: true, isOutputVisual: true });
    return text.call(this, value, x, y, visual, transform);
  };
}

// A PDF draws glyphs left to right in the order it is given them, with no
// notion of a right-to-left paragraph. So every string is put into VISUAL
// order here, before it reaches jsPDF, and jsPDF is told to leave it alone
// (drawTextAsGiven above). jsPDF's own R2L options are no substitute - a
// blunt whole-string reversal that turned "2023-01-15" into "51-10-3202".
//
// A whole-string reversal is wrong for any string that mixes Hebrew with
// digits or Latin, and plenty do - the cover's date, the footer's
// "הופק ב-AfikInvest", the disclaimer's "(Beta)", the tile notes
// ("12.5% משוקלל"), "מדד S&P 500" and every "name (security id)" cell.
// So this is a small RTL-paragraph reordering (the parts of the Unicode
// Bidi Algorithm these strings exercise):
//   - Latin letters and digits form left-to-right runs, kept in order;
//   - a neutral (space, '-', '.', ',', '/', ':', '&', ...) between two of
//     them belongs to that run ("2026-10-12", "1,234.56", "S&P 500");
//   - %, ₪ and $ next to a digit, and a +/- sign right before one, belong
//     to the number ("12.5%", "-1.72") - except a hyphen right after a
//     Hebrew letter, which is a prefix's ("נכון ל-12/10/2026");
//   - everything else takes the paragraph's right-to-left direction;
//   - the runs are laid out in reverse order, and each RTL run is reversed
//     with its paired brackets mirrored (rule L4), so "(₪)" stays "(₪)".
// A string with no Hebrew in it is returned untouched.
const HEBREW_CHAR_RANGE = /[֐-׿]/;
const BRACKET_MIRRORS = { '(': ')', ')': '(', '[': ']', ']': '[' };
const LTR_STRONG = /[A-Za-z0-9]/;
const DIGIT = /[0-9]/;
const NUMBER_TERMINATORS = new Set(['%', '₪', '$']);

function resolveDirections(chars) {
  const strong = chars.map((ch) => (HEBREW_CHAR_RANGE.test(ch) ? 'R' : LTR_STRONG.test(ch) ? 'L' : null));
  const nearest = (from, step) => {
    for (let i = from; i >= 0 && i < chars.length; i += step) {
      if (strong[i]) return strong[i];
    }
    return 'R'; // the paragraph direction
  };
  return chars.map((ch, i) => {
    if (strong[i]) return strong[i];
    const prevDigit = i > 0 && DIGIT.test(chars[i - 1]);
    const nextDigit = i + 1 < chars.length && DIGIT.test(chars[i + 1]);
    if (NUMBER_TERMINATORS.has(ch) && (prevDigit || nextDigit)) return 'L';
    // A hyphen straight after a Hebrew letter is the prefix's ("ל-12/10",
    // "מ-31/08") and stays with it; anywhere else before a digit it is the
    // number's sign.
    const afterHebrew = i > 0 && strong[i - 1] === 'R';
    if ((ch === '-' || ch === '+') && nextDigit && !afterHebrew) return 'L';
    return nearest(i - 1, -1) === 'L' && nearest(i + 1, 1) === 'L' ? 'L' : 'R';
  });
}

export function toPdfDisplayText(text) {
  const str = String(text);
  if (!HEBREW_CHAR_RANGE.test(str)) return str;
  const chars = [...str];
  const directions = resolveDirections(chars);

  const runs = [];
  chars.forEach((ch, i) => {
    const last = runs[runs.length - 1];
    if (last && last.dir === directions[i]) last.chars.push(ch);
    else runs.push({ dir: directions[i], chars: [ch] });
  });

  return runs
    .reverse()
    .map((run) =>
      run.dir === 'R'
        ? run.chars
            .map((ch) => BRACKET_MIRRORS[ch] || ch)
            .reverse()
            .join('')
        : run.chars.join('')
    )
    .join('');
}

// ---------------------------------------------------------------------
// THE REPORT'S VISUAL LANGUAGE
// ---------------------------------------------------------------------
//
// One accent, one ink, two greys, and a red/green pair reserved for
// gain/loss. Anything the report needs to say is said with type size and
// whitespace rather than with another colour - a printed statement that
// uses six is a statement nobody can find the total in.
//
// RGB triples because that is what jsPDF's setFillColor/setTextColor take.
const INK = [23, 26, 35];
const MUTED = [110, 118, 135];
const ACCENT = [86, 66, 168];
const ACCENT_SOFT = [239, 236, 250];
const RULE = [223, 226, 234];
const ZEBRA = [247, 248, 251];
const POSITIVE = [21, 128, 61];
const NEGATIVE = [185, 28, 28];

// A4 portrait in mm, and the margins every element is placed against, so
// nothing in this file hardcodes "196" the way the old layout did.
const PAGE_WIDTH = 210;
const PAGE_HEIGHT = 297;
const MARGIN = 14;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
// Everything above this may draw; past it, start a new page. Leaves room
// for the footer rule and its page number.
const CONTENT_BOTTOM = PAGE_HEIGHT - 20;

// The right edge is where a Hebrew line starts, so almost every text()
// call in this file anchors to it.
const RIGHT = PAGE_WIDTH - MARGIN;

const formatAmount = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? '');
  return number.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

// Cells arrive from exportData.js already rounded; this only decides how
// they are typeset. Numbers get thousands separators (an eight-digit
// shekel figure is unreadable without them). Text stays in logical order
// here - drawDetailTable puts it into visual order line by line.
const formatCell = (value) => {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number') return formatAmount(value);
  return String(value);
};

// Which columns hold figures, decided once per table from its first row
// rather than per cell - so a column with one blank cell in it does not
// change alignment halfway down.
const numericColumns = (rows, headers) =>
  headers.map((header) => rows.some((row) => typeof row[header] === 'number'));

// ---------------------------------------------------------------------
// PAGE FURNITURE
// ---------------------------------------------------------------------

// The band across the top of the first page: what this document is, and
// the moment its figures are true for. A report that outlives the screen
// it came from has to carry its own date - and say which figures are
// older than that date and where they come from (see buildReportAsOf).
function drawCoverHeader(doc, asOf) {
  doc.setFillColor(...ACCENT);
  doc.rect(0, 0, PAGE_WIDTH, 36, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(20);
  doc.text(toPdfDisplayText('דוח תיק השקעות'), RIGHT, 14, { align: 'right' });

  doc.setFontSize(11);
  doc.text(toPdfDisplayText(asOf.asOf), RIGHT, 22, { align: 'right' });

  doc.setFontSize(8);
  const basis = [asOf.prices, asOf.statements, asOf.generated].filter(Boolean).join(' · ');
  doc.text(toPdfDisplayText(basis), RIGHT, 29, { align: 'right' });

  // The product name stays Latin and stays on its own text() call - see
  // toPdfDisplayText's note on why a mixed-script string is not safe here.
  doc.setFontSize(13);
  doc.text('AfikInvest', MARGIN, 15);
  doc.setFontSize(8);
  doc.text('Portfolio Report', MARGIN, 21);

  doc.setTextColor(...INK);
}

// A quiet footer rule with the page number, drawn on every page at the
// very end (see stampFooters) rather than as each page is filled - the
// total page count is only known once the document is complete.
function stampFooters(doc) {
  const pageCount = doc.internal.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.2);
    doc.line(MARGIN, PAGE_HEIGHT - 14, RIGHT, PAGE_HEIGHT - 14);

    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text(`${page} / ${pageCount}`, MARGIN, PAGE_HEIGHT - 9);
    doc.text(
      toPdfDisplayText('הופק ב-AfikInvest · אומדן בלבד, אינו ייעוץ מס או השקעות'),
      RIGHT,
      PAGE_HEIGHT - 9,
      { align: 'right' }
    );
    doc.setTextColor(...INK);
  }
}

// A cursor over the document: how far down the current page we are, and
// whether the next block fits. Passing `y` through every draw function and
// remembering to compare it against the page height at each one is what
// made the old layout clip titles at the bottom edge.
function createFlow(doc) {
  let y = 46;
  return {
    get y() {
      return y;
    },
    set y(value) {
      y = value;
    },
    // `needed` is how much vertical room the caller is about to use. A
    // heading asks for its own height PLUS the first row of whatever
    // follows it, so a heading is never left stranded alone at the foot
    // of a page.
    ensure(needed) {
      if (y + needed <= CONTENT_BOTTOM) return;
      doc.addPage();
      y = MARGIN + 6;
    }
  };
}

// ---------------------------------------------------------------------
// BLOCKS
// ---------------------------------------------------------------------

// The four headline figures, as a row of tiles. The first thing the report
// says, and for most readings the only thing they need.
function drawHeadlineTiles(doc, flow, metrics) {
  if (!metrics.length) return;
  const columns = 4;
  const gap = 3;
  const tileWidth = (CONTENT_WIDTH - gap * (columns - 1)) / columns;
  const tileHeight = 24;

  flow.ensure(tileHeight + 6);

  metrics.slice(0, columns).forEach((metric, index) => {
    // Right to left: the first tile is the rightmost one, because that is
    // where a Hebrew reader starts.
    const x = RIGHT - tileWidth - index * (tileWidth + gap);

    doc.setFillColor(...ACCENT_SOFT);
    doc.roundedRect(x, flow.y, tileWidth, tileHeight, 2, 2, 'F');

    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text(toPdfDisplayText(metric.label), x + tileWidth - 4, flow.y + 7, { align: 'right' });

    const signed = metric.signed && metric.value !== 0;
    doc.setTextColor(...(signed ? (metric.value > 0 ? POSITIVE : NEGATIVE) : INK));
    doc.setFontSize(12);
    doc.text(
      `${signed && metric.value > 0 ? '+' : ''}${formatAmount(metric.value)} ${metric.unit}`,
      x + tileWidth - 4,
      flow.y + 15,
      { align: 'right' }
    );

    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    doc.text(toPdfDisplayText(metric.note), x + tileWidth - 4, flow.y + 20.5, { align: 'right' });
  });

  doc.setTextColor(...INK);
  flow.y += tileHeight + 10;
}

const SECTION_HEADING_HEIGHT = 12;

// A section heading: the name of an asset class, over an accent rule.
// `keepWith` is the height of everything that follows it and belongs with
// it, so a heading is never left at the foot of a page with its figures
// or its table on the next one.
function drawSectionHeading(doc, flow, title, keepWith = 16) {
  flow.ensure(SECTION_HEADING_HEIGHT + keepWith);

  doc.setFontSize(13);
  doc.setTextColor(...INK);
  doc.text(toPdfDisplayText(title), RIGHT, flow.y, { align: 'right' });

  doc.setDrawColor(...ACCENT);
  doc.setLineWidth(0.6);
  doc.line(MARGIN, flow.y + 2.5, RIGHT, flow.y + 2.5);

  flow.y += 8;
}

const METRIC_COLUMNS = 2;
const METRIC_ROW_HEIGHT = 6;

// How tall a metric list will be, so the section above it can reserve the
// room before anything is drawn (see the block-measuring note in
// buildPortfolioPdfDoc).
function measureMetricList(metrics) {
  if (!metrics || metrics.length === 0) return 0;
  return Math.ceil(metrics.length / METRIC_COLUMNS) * METRIC_ROW_HEIGHT + 6;
}

// An asset class's own figures: label/value pairs in two columns, with the
// class's bottom line picked out in the accent.
//
// Which pair that is comes from the data (a third element on the pair),
// not from its position. Several of these lists end on a tax estimate,
// and drawing the last row as the conclusion would present the tax as
// what the section adds up to.
function drawMetricList(doc, flow, metrics) {
  if (!metrics || metrics.length === 0) return;
  const columnWidth = CONTENT_WIDTH / METRIC_COLUMNS;
  const rowCount = Math.ceil(metrics.length / METRIC_COLUMNS);

  flow.ensure(rowCount * METRIC_ROW_HEIGHT + 4);

  metrics.forEach(([label, value, isTotal], index) => {
    const column = index % METRIC_COLUMNS;
    const row = Math.floor(index / METRIC_COLUMNS);
    const rightEdge = RIGHT - column * columnWidth;
    const y = flow.y + row * METRIC_ROW_HEIGHT;

    doc.setFontSize(8.5);
    doc.setTextColor(...(isTotal ? ACCENT : MUTED));
    doc.text(toPdfDisplayText(label), rightEdge, y, { align: 'right' });

    doc.setTextColor(...(isTotal ? ACCENT : INK));
    doc.text(formatAmount(value), rightEdge - columnWidth + 6, y, { align: 'left' });
  });

  doc.setTextColor(...INK);
  flow.y += rowCount * METRIC_ROW_HEIGHT + 6;
}

// The itemized rows under a section: every stock, fund or account that
// makes up the figures above it.
//
// autoTable owns its own pagination, so the flow cursor is handed to it as
// a start position and read back from doc.lastAutoTable afterwards.
function drawDetailTable(doc, flow, rows) {
  if (!rows || rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const isNumeric = numericColumns(rows, headers);

  // Reversed, because autoTable lays columns out left to right and this
  // document is read right to left - so the first key in exportData.js's
  // row object has to be the LAST column autoTable draws.
  const order = headers.map((_, index) => headers.length - 1 - index);

  flow.ensure(20);

  autoTable(doc, {
    startY: flow.y,
    margin: { left: MARGIN, right: MARGIN, bottom: 20 },
    head: [order.map((index) => headers[index])],
    body: rows.map((row) => order.map((index) => formatCell(row[headers[index]]))),
    // A long name wraps onto several lines, and the wrap has to be decided
    // on the text as it is READ: reordering first and wrapping after put
    // the end of a name on its first line. So autoTable gets the logical
    // text, measures and splits it, and each line is put into visual order
    // just before it is drawn. A cell drawn twice (the header row repeats
    // on every page) is converted once - its converted lines are marked.
    willDrawCell: ({ cell }) => {
      if (cell.text === cell.visualLines) return;
      cell.visualLines = cell.text.map(toPdfDisplayText);
      cell.text = cell.visualLines;
    },
    theme: 'plain',
    // jspdf-autotable defaults header cells to fontStyle 'bold', which
    // silently falls back to a non-Hebrew font since only the 'normal'
    // weight of Alef is registered (confirmed during development: without
    // this override, header text renders as garbled Latin-1 characters,
    // the same failure mode as unregistered Hebrew text entirely).
    styles: {
      font: 'Alef',
      fontStyle: 'normal',
      fontSize: 7,
      cellPadding: { top: 2, right: 2, bottom: 2, left: 2 },
      textColor: INK,
      lineColor: RULE,
      lineWidth: 0.1,
      overflow: 'linebreak'
    },
    headStyles: {
      font: 'Alef',
      fontStyle: 'normal',
      fontSize: 7,
      fillColor: ACCENT,
      textColor: [255, 255, 255],
      halign: 'center',
      cellPadding: { top: 2.5, right: 2, bottom: 2.5, left: 2 }
    },
    // A rule under every row would be a grid; a tint on every other one
    // does the same job of keeping the eye on a line without adding ink.
    alternateRowStyles: { fillColor: ZEBRA },
    // A figure column is read by comparing digits down it, which only
    // works when they share an edge. Text columns stay right-aligned with
    // the rest of the document.
    columnStyles: order.reduce((acc, headerIndex, columnIndex) => {
      acc[columnIndex] = { halign: isNumeric[headerIndex] ? 'left' : 'right' };
      return acc;
    }, {})
  });

  flow.y = doc.lastAutoTable.finalY + 8;
}

// ---------------------------------------------------------------------
// THE DISTRIBUTION DONUTS
// ---------------------------------------------------------------------
//
// The analysis page's two donuts - by asset class and by sector - side by
// side, each with its legend under it. Same palette as the app's light
// theme, so a slice is the same colour on paper as on screen.

const hexToRgb = (hex) => {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const SLICE_COLORS = getChartTheme('light').categorical.map(hexToRgb);

const DONUT_RADIUS = 17;
const DONUT_HOLE = 0.56;
const LEGEND_ROW = 5.2;
const CHART_GAP = 8;

// One wedge, as a filled polygon: jsPDF has no arc primitive, and at this
// size a point every two degrees is indistinguishable from a curve.
function drawWedge(doc, cx, cy, radius, startAngle, endAngle) {
  const steps = Math.max(2, Math.ceil(((endAngle - startAngle) * 180) / Math.PI / 2));
  const points = [[cx, cy]];
  for (let i = 0; i <= steps; i += 1) {
    const angle = startAngle + ((endAngle - startAngle) * i) / steps;
    points.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
  }
  const deltas = points.slice(1).map(([x, y], i) => [x - points[i][0], y - points[i][1]]);
  doc.lines(deltas, cx, cy, [1, 1], 'F', true);
}

function drawDonut(doc, cx, cy, slices) {
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  if (slices.length === 1) {
    doc.setFillColor(...SLICE_COLORS[0]);
    doc.circle(cx, cy, DONUT_RADIUS, 'F');
  } else {
    // From twelve o'clock, clockwise (y grows downwards on the page).
    let angle = -Math.PI / 2;
    slices.forEach((slice, index) => {
      const sweep = (slice.value / total) * Math.PI * 2;
      doc.setFillColor(...SLICE_COLORS[index % SLICE_COLORS.length]);
      drawWedge(doc, cx, cy, DONUT_RADIUS, angle, angle + sweep);
      angle += sweep;
    });
  }
  doc.setFillColor(255, 255, 255);
  doc.circle(cx, cy, DONUT_RADIUS * DONUT_HOLE, 'F');
}

const chartHeight = (chart) => 12 + DONUT_RADIUS * 2 + 6 + chart.slices.length * LEGEND_ROW;

// A legend row, right to left: swatch and name, then the share and the
// value against the column's left edge, where the figures line up.
function drawLegendRow(doc, right, left, y, slice, color) {
  doc.setFillColor(...color);
  doc.rect(right - 3, y - 2.6, 3, 3, 'F');

  doc.setFontSize(8);
  doc.setTextColor(...INK);
  doc.text(toPdfDisplayText(slice.label), right - 5, y, { align: 'right' });
  doc.text(`${slice.percent.toFixed(1)}%`, left + 30, y, { align: 'right' });

  doc.setTextColor(...MUTED);
  doc.text(`${Math.round(slice.value).toLocaleString('en-US')} ₪`, left, y, { align: 'left' });
}

function drawDistributionCharts(doc, flow, charts) {
  const drawn = charts.filter((chart) => chart.slices.length > 0);
  if (!drawn.length) return;
  const columnWidth = (CONTENT_WIDTH - CHART_GAP) / 2;
  const height = Math.max(...drawn.map(chartHeight));

  drawSectionHeading(doc, flow, 'פיזור התיק', height);
  const top = flow.y + 2;

  drawn.forEach((chart, index) => {
    // The first chart in the right-hand column, where a Hebrew reader starts.
    const right = RIGHT - index * (columnWidth + CHART_GAP);
    const left = right - columnWidth;

    doc.setFontSize(10);
    doc.setTextColor(...INK);
    doc.text(toPdfDisplayText(chart.title), right, top + 3, { align: 'right' });
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    doc.text(toPdfDisplayText(chart.note), right, top + 8, { align: 'right' });

    const cy = top + 12 + DONUT_RADIUS;
    drawDonut(doc, left + columnWidth / 2, cy, chart.slices);

    chart.slices.forEach((slice, i) => {
      const y = cy + DONUT_RADIUS + 8 + i * LEGEND_ROW;
      drawLegendRow(doc, right, left, y, slice, SLICE_COLORS[i % SLICE_COLORS.length]);
    });
  });

  doc.setTextColor(...INK);
  flow.y = top + height + 6;
}

function drawEmptyNote(doc, flow, note) {
  if (!note) return;
  flow.ensure(10);
  doc.setFontSize(8.5);
  doc.setTextColor(...MUTED);
  doc.text(toPdfDisplayText(note), RIGHT, flow.y, { align: 'right' });
  doc.setTextColor(...INK);
  flow.y += 9;
}

// The standing disclaimer, at the end of the document rather than the
// start: it qualifies every figure above it, and putting it first would
// make the reader scroll past a warning to reach the report they asked
// for. Same text the app's own beta notice carries, for the same reason -
// a printed copy outlives the session it was taken in.
function drawDisclaimer(doc, flow) {
  const lines = [
    'המערכת נמצאת בשלב בדיקות (Beta).',
    'הנתונים בדוח זה הם אומדן בלבד, ואינם ייעוץ מס, ייעוץ השקעות, חוות דעת מחייבת או המלצה לקנות או למכור ניירות ערך.',
    'חישובי המס, ההצמדה למדד וקיזוז ההפסדים הם הערכה חישובית - התייעצו עם יועץ מס או רואה חשבון מוסמך.',
    'מחירים ותשואות עשויים להיות חלקיים או מתעכבים.'
  ];
  const boxHeight = 8 + lines.length * 4.6;

  flow.ensure(boxHeight + 4);

  doc.setFillColor(...ACCENT_SOFT);
  doc.roundedRect(MARGIN, flow.y, CONTENT_WIDTH, boxHeight, 2, 2, 'F');

  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  lines.forEach((line, index) => {
    doc.text(toPdfDisplayText(line), RIGHT - 4, flow.y + 6 + index * 4.6, { align: 'right' });
  });

  doc.setTextColor(...INK);
  flow.y += boxHeight + 4;
}

// data: same shape as buildPortfolioWorkbook. A full printed statement:
// the headline figures, then one section per asset class - its own metrics
// above the itemized rows that make them up - and the standing disclaimer
// at the end.
export function buildPortfolioPdfDoc(data) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  registerHebrewFont(doc);
  drawTextAsGiven(doc);

  drawCoverHeader(
    doc,
    buildReportAsOf({
      generatedAt: data.generatedAt || new Date(),
      pricesAsOf: data.pricesAsOf || null,
      pensionFunds: data.pensionFunds
    })
  );

  const flow = createFlow(doc);

  drawHeadlineTiles(doc, flow, buildHeadlineMetrics(data.summary));

  drawDistributionCharts(doc, flow, [
    { title: 'לפי אפיק', note: 'כל הנכסים', slices: buildAllocationSlices(data.summary) },
    {
      title: 'לפי סקטור',
      note: 'מניות בלבד - ישראל וארה"ב',
      slices: buildSectorSlices({
        americanStocks: data.americanStocks,
        israeliStocks: data.israeliStocks,
        sectorBySymbol: data.sectorBySymbol
      })
    }
  ]);

  buildPortfolioReportSections(data).forEach((section) => {
    // A SECTION IS ONE BLOCK, and the page break is decided once, here.
    //
    // Each piece used to check for itself whether it fit, which is not the
    // same question: the heading and its figures would fit in the last
    // 30mm of a page, the table under them would not, and the reader got
    // a heading on one page and an unlabelled table of figures on the
    // next. So the room reserved for a heading is its own height plus its
    // metrics plus enough of the table to establish what the table is -
    // its header row and a first line of data.
    //
    // Only the START of a long table is kept with the heading. A holdings
    // table that runs to three pages has to break somewhere, and
    // autoTable repeats the column headers on each page it continues onto.
    const detailHeight = section.isEmpty ? 10 : 24;
    drawSectionHeading(doc, flow, section.title, measureMetricList(section.metrics) + detailHeight);
    drawMetricList(doc, flow, section.metrics);
    if (section.isEmpty) {
      drawEmptyNote(doc, flow, section.emptyNote);
    } else {
      drawDetailTable(doc, flow, section.rows);
    }
  });

  drawDisclaimer(doc, flow);
  stampFooters(doc);

  return doc;
}

export function downloadPortfolioPdf(data) {
  const doc = buildPortfolioPdfDoc(data);
  doc.save(`afikinvest-portfolio-${todayFileStamp()}.pdf`);
}
