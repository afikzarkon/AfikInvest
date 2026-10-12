/**
 * @jest-environment node
 */
// buildPortfolioWorkbook/buildPortfolioPdfDoc are pure document-building
// functions with no DOM dependency (only downloadPortfolioExcel/Pdf touch
// the browser). jsPDF's node build pulls in fast-png, which needs
// TextEncoder - present in Node but missing from the jsdom version CRA5
// bundles (the same gap worked around the same way in taseScraper.test.js
// and quotesRoutes.test.js).
import { buildPortfolioWorkbook, buildPortfolioPdfDoc, toPdfDisplayText } from './exportReport';

const sampleData = {
  summary: {
    totalCurrentValueILS: 250000.5,
    totalPurchaseILS: 200000,
    totalProfitILS: 50000.5,
    weightedDailyChange: 1.23,
    dailyProfitILS: 300
  },
  israeliStocks: [
    { stockName: 'טבע', purchaseDate: '2023-01-15', purchasePrice: 30, quantity: 100, currentPrice: 35 }
  ],
  americanStocks: [
    {
      stockName: 'AAPL',
      purchaseDate: '2022-03-01',
      purchasePrice: 150,
      quantity: 10,
      currentPrice: 190,
      exchangeRate: 3.6,
      currentExchangeRate: 3.7
    }
  ],
  pensionFunds: [
    { fundName: 'קופת גמל', currentValue: 111000, currentValueDate: '2024-06-30', previousValue: 100000, previousValueDate: '2024-01-01' }
  ],
  cashFunds: [{ fundName: 'קרן כספית', securityId: '12345', updateDate: '2024-06-01', amount: 20000 }],
  bankBalances: [{ updateDate: '2024-06-01', amount: 15000 }]
};

describe('toPdfDisplayText', () => {
  test('leaves a string with no Hebrew characters completely unchanged', () => {
    expect(toPdfDisplayText('AAPL')).toBe('AAPL');
    expect(toPdfDisplayText('2023-01-15')).toBe('2023-01-15');
    expect(toPdfDisplayText(3000)).toBe('3000');
    expect(toPdfDisplayText('(100)')).toBe('(100)');
  });

  test('reverses a pure Hebrew string character-by-character (jsPDF/autotable draw storage order, not visual order)', () => {
    const hebrew = 'אבגדה';
    expect(toPdfDisplayText(hebrew)).toBe([...hebrew].reverse().join(''));
  });

  test('reverses a multi-word Hebrew phrase - word order flips along with letters, which is what RTL needs', () => {
    const phrase = 'קופת גמל מגדל';
    expect(toPdfDisplayText(phrase)).toBe([...phrase].reverse().join(''));
  });

  test('mirrors paired brackets before reversing, so "(₪)" does not come out as ")₪("', () => {
    expect(toPdfDisplayText('מחיר (₪)')).toBe('(₪) ריחמ');
  });

  // Strings that mix Hebrew with digits or Latin - which the report does
  // print - used to be reversed wholesale: "2026-10-12" came out as
  // "21-01-6202" and "StockView" as "weiVkcotS".
  test('keeps an embedded date, number or Latin word in reading order', () => {
    expect(toPdfDisplayText('הופק בתאריך 2026-10-12')).toBe('2026-10-12 ךיראתב קפוה');
    expect(toPdfDisplayText('הופק ב-StockView')).toBe('StockView-ב קפוה');
    expect(toPdfDisplayText('טבע (629014)')).toBe('(629014) עבט');
    expect(toPdfDisplayText('בשלב בדיקות (Beta) ואינה')).toBe('הניאו (Beta) תוקידב בלשב');
  });

  test('keeps a percent sign, currency sign and minus sign attached to their number', () => {
    expect(toPdfDisplayText('12.5% משוקלל')).toBe('ללקושמ 12.5%');
    expect(toPdfDisplayText('שינוי -1.72')).toBe('-1.72 יוניש');
    expect(toPdfDisplayText('S&P 500 מדד')).toBe('דדמ S&P 500');
  });

  test('a hyphen after a Hebrew prefix letter stays with the letter, not with the number', () => {
    expect(toPdfDisplayText('נכון ל-12/10/2026')).toBe('12/10/2026-ל ןוכנ');
    expect(toPdfDisplayText('מדד S&P 500')).toBe('S&P 500 דדמ');
    expect(toPdfDisplayText('ESPP פאלו אלטו')).toBe('וטלא ולאפ ESPP');
  });

  test('converts a non-string input to its string form before checking for Hebrew', () => {
    expect(toPdfDisplayText(null)).toBe('null');
    expect(toPdfDisplayText(undefined)).toBe('undefined');
  });
});

describe('buildPortfolioWorkbook', () => {
  test('creates one sheet per non-empty category, in the expected order', async () => {
    const workbook = buildPortfolioWorkbook(sampleData);
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual([
      'סיכום',
      'מניות ישראליות',
      'מניות אמריקאיות',
      'קופות גמל',
      'קרנות כספיות',
      'עוש'
    ]);
  });

  test('skips a sheet entirely for an empty category instead of adding a blank one', () => {
    const workbook = buildPortfolioWorkbook({ ...sampleData, cashFunds: [], bankBalances: [] });
    const names = workbook.worksheets.map((ws) => ws.name);
    expect(names).not.toContain('קרנות כספיות');
    expect(names).not.toContain('עוש');
  });

  test('writes the header row and data rows with correct values', () => {
    const workbook = buildPortfolioWorkbook(sampleData);
    const israeliSheet = workbook.worksheets.find((ws) => ws.name === 'מניות ישראליות');
    const headerRow = israeliSheet.getRow(1).values.filter(Boolean);
    expect(headerRow).toContain('שם נייר');
    expect(headerRow).toContain('מספר נייר');
    expect(headerRow).toContain('רווח/הפסד (₪)');

    const dataRow = israeliSheet.getRow(2).values.filter((v) => v !== undefined && v !== null);
    expect(dataRow).toContain('טבע');
    expect(dataRow).toContain(500); // profit
  });

  test('produces a real non-empty xlsx buffer', async () => {
    const workbook = buildPortfolioWorkbook(sampleData);
    const buffer = await workbook.xlsx.writeBuffer();
    expect(buffer.byteLength).toBeGreaterThan(1000);
  });

  test('handles entirely empty data without throwing (produces a workbook with no sheets)', () => {
    const workbook = buildPortfolioWorkbook({});
    expect(workbook.worksheets).toEqual([]);
  });
});

describe('buildPortfolioPdfDoc', () => {
  test('produces a paginated PDF document object for a small portfolio', () => {
    const doc = buildPortfolioPdfDoc(sampleData);
    expect(doc.internal.getNumberOfPages()).toBeGreaterThanOrEqual(1);
  });

  test('produces a real non-empty PDF buffer', () => {
    const doc = buildPortfolioPdfDoc(sampleData);
    const buffer = doc.output('arraybuffer');
    expect(buffer.byteLength).toBeGreaterThan(1000);
  });

  test('handles entirely empty data without throwing', () => {
    expect(() => buildPortfolioPdfDoc({})).not.toThrow();
  });

  test('the embedded Hebrew font is registered on the document (not left on a Hebrew-incapable default)', () => {
    const doc = buildPortfolioPdfDoc(sampleData);
    expect(doc.getFontList().Alef).toBeDefined();
  });
});

