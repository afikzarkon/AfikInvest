// What the exported PDF actually draws, read back out of the finished file.
//
// jsPDF's bidi plugin used to re-reorder the already-visual text, so the
// report printed "StockView" as "weiVkcotS", "0.27%" as "%72.0" and "ESPP"
// as "PPSE". That happened inside jsPDF, after toPdfDisplayText had done
// its job correctly, so a test of toPdfDisplayText alone could never catch
// it - only the glyphs in the file show it.
//
// Runs in the default (jsdom) environment on purpose: that resolves to
// jsPDF's browser build, the one the app ships, which carries the bidi
// plugin. The node build exportReport.test.js runs against does not.
import { buildPortfolioPdfDoc, toPdfDisplayText } from './exportReport';

const zlib = require('zlib');

// Every string the PDF shows, in drawing (left-to-right glyph) order:
// each text operator's glyph ids mapped back to characters through the
// embedded font's ToUnicode table.
function drawnText(doc) {
  const raw = doc.output();
  const streams = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = streamRe.exec(raw))) {
    const bytes = Buffer.from(m[1], 'latin1');
    try {
      streams.push(zlib.inflateSync(bytes).toString('latin1'));
    } catch {
      streams.push(m[1]);
    }
  }
  const content = streams.join('\n');
  const glyphs = {};
  const tableRe = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((m = tableRe.exec(content))) {
    const pairRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let p;
    while ((p = pairRe.exec(m[1]))) glyphs[p[1].toLowerCase().padStart(4, '0')] = String.fromCharCode(parseInt(p[2], 16));
  }
  const lines = [];
  const showRe = /<([0-9a-fA-F]+)>\s*Tj/g;
  while ((m = showRe.exec(content))) {
    let line = '';
    for (let i = 0; i < m[1].length; i += 4) line += glyphs[m[1].slice(i, i + 4).toLowerCase()] || '?';
    lines.push(line);
  }
  return lines;
}

const portfolio = {
  summary: {
    capitalTotalILS: 250000,
    capitalIsraeliILS: 1900,
    capitalAmericanILS: 7030,
    capitalPensionILS: 111000,
    totalPurchaseILS: 200000,
    totalProfitILS: 50000,
    weightedDailyChange: 0.27,
    dailyProfitILS: 300
  },
  israeliStocks: [
    { stockName: '1159250', officialName: 'קסם S&P 500', purchaseDate: '2024-01-02', purchasePrice: 150, quantity: 10, currentPrice: 190 }
  ],
  americanStocks: [{ stockName: 'AAPL', purchaseDate: '2022-03-01', purchasePrice: 150, quantity: 10, currentPrice: 190, currentExchangeRate: 3.7 }],
  pensionFunds: [{ fundName: 'ESPP פאלו אלטו', currentValue: 111000, currentValueDate: '2026-09-30', deposits: [] }],
  cashFunds: [],
  bankBalances: [],
  bankSavingsFunds: [],
  sectorBySymbol: { AAPL: { sector: 'Technology' } },
  pricesAsOf: new Date('2026-10-12T15:30:00Z'),
  generatedAt: new Date('2026-10-12T15:42:00Z')
};

let drawn;
beforeAll(() => {
  drawn = drawnText(buildPortfolioPdfDoc(portfolio));
});

test('mixed Hebrew / English / number strings are drawn in visual order, not reversed again', () => {
  const all = drawn.join('\n');
  expect(all).toContain(toPdfDisplayText('הופק ב-StockView · אומדן בלבד'));
  expect(all).toContain(toPdfDisplayText('0.27% משוקלל'));
  expect(all).not.toMatch(/weiVkcotS|%72\.0|PPSE|005 P&S/);
});

test('a wrapped cell keeps its lines in reading order', () => {
  // The fund's name wraps in its column: "ESPP פאלו" over "אלטו".
  expect(drawn).toContain(toPdfDisplayText('ESPP פאלו'));
  expect(drawn).toContain(toPdfDisplayText('אלטו'));
  // And the security name starts on its first line.
  const nameLines = drawn.filter((line) => line.includes('םסק'));
  expect(nameLines.length).toBeGreaterThan(0);
  nameLines.forEach((line) => expect(line.endsWith('םסק')).toBe(true));
});

test('the cover says when the figures are true for, and where the older ones come from', () => {
  const all = drawn.join('\n');
  expect(all).toContain(toPdfDisplayText('נכון ל-12/10/2026 בשעה 18:30'));
  expect(all).toContain(toPdfDisplayText('קופות גמל לפי דוחות מ-30/09/2026'));
});

test('draws the two distribution donuts with their legends', () => {
  expect(drawn).toContain(toPdfDisplayText('פיזור התיק'));
  expect(drawn).toContain(toPdfDisplayText('לפי אפיק'));
  expect(drawn).toContain(toPdfDisplayText('לפי סקטור'));
  expect(drawn).toContain(toPdfDisplayText('טכנולוגיה'));
  expect(drawn).toContain(toPdfDisplayText('קופות גמל'));
});
