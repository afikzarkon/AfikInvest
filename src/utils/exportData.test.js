import {
  buildIsraeliStocksExportRows,
  buildAmericanStocksExportRows,
  buildPensionFundsExportRows,
  buildCashFundsExportRows,
  buildBankBalancesExportRows,
  buildBankSavingsFundsExportRows,
  buildSummaryExportRows,
  buildHeadlineMetrics,
  buildPortfolioReportSections,
  buildIsraeliStocksSummaryRows,
  buildAmericanStocksSummaryRows,
  buildReportAsOf,
  buildAllocationSlices,
  buildSectorSlices,
  formatReportDateTime,
  MAX_SECTOR_SLICES
} from './exportData';

describe('when the report is true for', () => {
  test('dates and times are written the Israeli way, in Israel time', () => {
    // 21:30 UTC is already the next day in Israel.
    expect(formatReportDateTime(new Date('2026-10-12T21:30:00Z'))).toBe('13/10/2026 בשעה 00:30');
  });

  test('the as-of moment is the last price refresh; fund statements are stated separately', () => {
    const asOf = buildReportAsOf({
      generatedAt: new Date('2026-10-12T15:42:00Z'),
      pricesAsOf: new Date('2026-10-12T15:30:00Z'),
      pensionFunds: [
        { currentValue: 100, currentValueDate: '2026-09-30' },
        { currentValue: 100, currentValueDate: '2026-08-31' },
        { currentValue: 0, currentValueDate: '2020-01-01' }
      ]
    });
    expect(asOf).toEqual({
      asOf: 'נכון ל-12/10/2026 בשעה 18:30',
      prices: 'מחירי שוק מ-12/10/2026 בשעה 18:30',
      statements: 'קופות גמל לפי דוחות מ-31/08/2026 עד 30/09/2026',
      generated: 'הופק 12/10/2026 בשעה 18:42'
    });
  });

  test('without a live price refresh it says the prices are the saved ones', () => {
    const asOf = buildReportAsOf({ generatedAt: new Date('2026-10-12T15:42:00Z') });
    expect(asOf.asOf).toBe('נכון ל-12/10/2026 בשעה 18:42');
    expect(asOf.prices).toBe('מחירי שוק: האחרונים שנשמרו');
    expect(asOf.statements).toBe('');
  });
});

describe('the distribution charts', () => {
  test('by asset class: the non-empty classes, with shares that add up to 100', () => {
    const slices = buildAllocationSlices({ capitalIsraeliILS: 300, capitalAmericanILS: 500, capitalPensionILS: 200, capitalBankILS: 0 });
    expect(slices.map((s) => [s.label, s.percent])).toEqual([
      ['בורסה ישראלית', 30],
      ['בורסה אמריקאית', 50],
      ['קופות גמל', 20]
    ]);
    expect(buildAllocationSlices(null)).toEqual([]);
  });

  test('by sector: shares only, small sectors merged into "אחר"', () => {
    const americanStocks = Array.from({ length: MAX_SECTOR_SLICES + 2 }, (_, i) => ({
      stockName: `S${i}`,
      quantity: 1,
      currentPrice: 100 - i,
      currentExchangeRate: 1
    }));
    const sectorBySymbol = Object.fromEntries(americanStocks.map((s, i) => [s.stockName, { sector: `Sector${i}` }]));
    const slices = buildSectorSlices({ americanStocks, sectorBySymbol });
    expect(slices).toHaveLength(MAX_SECTOR_SLICES);
    expect(slices[slices.length - 1].label).toBe('אחר');
    expect(slices.reduce((sum, s) => sum + s.percent, 0)).toBeCloseTo(100, 0);
    expect(buildSectorSlices({})).toEqual([]);
  });
});

describe('buildIsraeliStocksExportRows', () => {
  test('computes purchase/current/profit from currentPrice as already stored (₪, not agorot)', () => {
    // currentPrice is already in ₪ by the time it's in state - every write
    // path already converts agorot->₪ itself (see App.js/usePriceRefresh.js
    // and the project note against re-dividing by 100 here).
    const rows = buildIsraeliStocksExportRows([
      { stockName: 'TEVA', purchaseDate: '2023-01-15', purchasePrice: 30, quantity: 100, currentPrice: 35 }
    ]);
    expect(rows[0]['סה"כ רכישה (₪)']).toBe(3000);
    expect(rows[0]['סה"כ שווי נוכחי (₪)']).toBe(3500);
    expect(rows[0]['רווח/הפסד (₪)']).toBe(500);
    expect(rows[0]['רווח/הפסד (%)']).toBeCloseTo(16.67, 2);
  });

  // The whole point of the Israeli sheet: a holding has to be identifiable
  // both to a person (the name) and at the exchange (the security number),
  // and for an Israeli holding those live in two different fields.
  test('carries the official name and the TASE security number as separate columns', () => {
    const rows = buildIsraeliStocksExportRows([
      {
        stockName: '629014',
        officialName: 'טבע תעשיות',
        securityType: 'מניה',
        branch: 'ביומד',
        purchaseDate: '2023-01-15',
        purchasePrice: 30,
        quantity: 100,
        currentPrice: 35
      }
    ]);
    expect(rows[0]['שם נייר']).toBe('טבע תעשיות');
    expect(rows[0]['מספר נייר']).toBe('629014');
    expect(rows[0]['סוג נייר']).toBe('מניה');
    expect(rows[0]['ענף']).toBe('ביומד');
  });

  // Holdings entered before officialName existed carry only the number;
  // the name column falls back to it rather than exporting a blank.
  test('falls back to the raw identifier when no official name was resolved', () => {
    const rows = buildIsraeliStocksExportRows([{ stockName: '629014', quantity: 1 }]);
    expect(rows[0]['שם נייר']).toBe('629014');
    expect(rows[0]['מספר נייר']).toBe('629014');
  });

  test('flags a TASE-listed fund that tracks a foreign index', () => {
    const rows = buildIsraeliStocksExportRows([
      { stockName: '1', officialName: 'קסם S&P 500', isForeignETF: true, quantity: 1 },
      { stockName: '2', officialName: 'טבע תעשיות', quantity: 1 }
    ]);
    expect(rows[0]['נכס זר']).toBe('כן');
    expect(rows[1]['נכס זר']).toBe('לא');
  });

  test('handles an empty/missing list without throwing', () => {
    expect(buildIsraeliStocksExportRows([])).toEqual([]);
    expect(buildIsraeliStocksExportRows(null)).toEqual([]);
  });
});

describe('buildAmericanStocksExportRows', () => {
  test('reports both USD and ILS value/profit using calculateAmericanStockMetrics', () => {
    const rows = buildAmericanStocksExportRows([
      {
        stockName: 'AAPL',
        purchaseDate: '2022-03-01',
        purchasePrice: 150,
        quantity: 10,
        currentPrice: 190,
        exchangeRate: 3.6,
        currentExchangeRate: 3.7
      }
    ]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row['סימול']).toBe('AAPL');
    expect(row['סה"כ שווי נוכחי ($)']).toBe(1900); // 190 * 10
    expect(row['סה"כ שווי נוכחי (₪)']).toBe(7030); // 1900 * 3.7
    expect(row['רווח/הפסד ($)']).toBe(400); // (190-150)*10
    expect(row['רווח/הפסד (%)']).toBeCloseTo(26.67, 2);
  });

  // Both rates and the resulting FX impact, because a dollar gain and a
  // shekel gain can point in opposite directions and the report has to
  // show which part came from which.
  test('carries both exchange rates and the currency effect between them', () => {
    const rows = buildAmericanStocksExportRows([
      { stockName: 'AAPL', purchasePrice: 150, quantity: 10, currentPrice: 190, exchangeRate: 3.6, currentExchangeRate: 3.7 }
    ]);
    expect(rows[0]['שער חליפין בקנייה']).toBe(3.6);
    expect(rows[0]['שער חליפין נוכחי']).toBe(3.7);
    expect(rows[0]['השפעת שער חליפין (₪)']).toBeCloseTo(190, 2); // 1900 * (3.7-3.6)
  });

  test('handles an empty/missing list without throwing', () => {
    expect(buildAmericanStocksExportRows([])).toEqual([]);
    expect(buildAmericanStocksExportRows(undefined)).toEqual([]);
  });
});

describe('buildPensionFundsExportRows', () => {
  test('computes period return % only when a previous value exists', () => {
    const rows = buildPensionFundsExportRows([
      { fundName: 'קופה א', currentValue: 111000, currentValueDate: '2024-06-30', previousValue: 100000, previousValueDate: '2024-01-01' },
      { fundName: 'קופה חדשה', currentValue: 5000, currentValueDate: '2024-06-30' } // no previous value yet
    ]);
    expect(rows[0]['שם קופה']).toBe('קופה א');
    expect(rows[0]['תשואת תקופה (%)']).toBeCloseTo(11, 5);
    expect(rows[1]['תשואת תקופה (%)']).toBe('');
  });

  test('summarizes the deposit book alongside the valuation', () => {
    const rows = buildPensionFundsExportRows([
      {
        fundName: 'קופה א',
        currentValue: 12000,
        deposits: [
          { date: '2022-03-01', amount: 5000 },
          { date: '2023-05-01', amount: 5000 }
        ]
      }
    ]);
    expect(rows[0]['סך הפקדות (₪)']).toBe(10000);
    expect(rows[0]['מספר הפקדות']).toBe(2);
    expect(rows[0]['הפקדה ראשונה']).toBe('2022-03-01');
    expect(rows[0]['הפקדה אחרונה']).toBe('2023-05-01');
    expect(rows[0]['רווח/הפסד מצטבר (₪)']).toBe(2000);
    expect(rows[0]['תשואה מצטברת (%)']).toBe(20);
  });

  test('falls back to amount when currentValue is missing (legacy shape)', () => {
    const rows = buildPensionFundsExportRows([{ fundName: 'ישן', amount: 20000 }]);
    expect(rows[0]['שווי נוכחי (₪)']).toBe(20000);
  });

  test('handles an empty/missing list without throwing', () => {
    expect(buildPensionFundsExportRows([])).toEqual([]);
    expect(buildPensionFundsExportRows(null)).toEqual([]);
  });
});

describe('buildCashFundsExportRows / buildBankBalancesExportRows', () => {
  test('shapes cash fund rows, keeping the security number', () => {
    const rows = buildCashFundsExportRows([
      {
        fundName: 'קרן א',
        securityId: '12345',
        currentValue: 5000.456,
        currentValueDate: '2024-01-01',
        deposits: [{ date: '2023-12-01', amount: 5000 }]
      }
    ]);
    expect(rows[0]['שם קרן']).toBe('קרן א');
    expect(rows[0]['מספר נייר']).toBe('12345');
    expect(rows[0]['יתרה נוכחית (₪)']).toBe(5000.46);
    expect(rows[0]['סך הפקדות (₪)']).toBe(5000);
    expect(rows[0]['תאריך עדכון']).toBe('2024-01-01');
  });

  test('shapes bank balance rows', () => {
    const rows = buildBankBalancesExportRows([
      { updateDate: '2024-01-01', amount: 1000, deposits: [{ date: '2024-01-01', amount: 1000 }] }
    ]);
    expect(rows[0]['יתרה נוכחית (₪)']).toBe(1000);
    expect(rows[0]['תאריך עדכון']).toBe('2024-01-01');
    expect(rows[0]['מספר תנועות']).toBe(1);
  });

  // A withdrawal is a negative row in the same book, so the movement total
  // has to net out rather than counting it as another deposit.
  test('nets withdrawals against deposits in the movement total', () => {
    const rows = buildBankBalancesExportRows([
      { deposits: [{ date: '2024-01-01', amount: 1000 }, { date: '2024-02-01', amount: -400 }] }
    ]);
    expect(rows[0]['סך הפקדות/משיכות (₪)']).toBe(600);
    expect(rows[0]['מספר תנועות']).toBe(2);
  });

  test('handle an empty/missing list without throwing', () => {
    expect(buildCashFundsExportRows(null)).toEqual([]);
    expect(buildBankBalancesExportRows(undefined)).toEqual([]);
  });
});

describe('buildBankSavingsFundsExportRows', () => {
  test('carries the track, the rate, the linkage and the deposit book', () => {
    const rows = buildBankSavingsFundsExportRows([
      {
        fundName: 'פיקדון שקלי',
        investmentTrack: 'ריבית קבועה',
        interestRate: 4.5,
        isLinkedToIndex: true,
        deposits: [{ date: '2023-01-01', amount: 10000 }]
      }
    ]);
    expect(rows[0]['שם פיקדון']).toBe('פיקדון שקלי');
    expect(rows[0]['מסלול השקעה']).toBe('ריבית קבועה');
    expect(rows[0]['ריבית (%)']).toBe(4.5);
    expect(rows[0]['צמוד למדד']).toBe('כן');
    expect(rows[0]['סך הפקדות (₪)']).toBe(10000);
    expect(rows[0]['מספר הפקדות']).toBe(1);
  });

  test('handles an empty/missing list without throwing', () => {
    expect(buildBankSavingsFundsExportRows([])).toEqual([]);
    expect(buildBankSavingsFundsExportRows(null)).toEqual([]);
  });
});

describe('buildSummaryExportRows', () => {
  test('extracts the headline totals as metric/value pairs', () => {
    const rows = buildSummaryExportRows({
      totalCurrentValueILS: 100000.456,
      totalPurchaseILS: 90000,
      totalProfitILS: 10000.456,
      weightedDailyChange: 1.2345,
      dailyProfitILS: 500
    });
    expect(rows).toEqual([
      { 'מדד': 'סה"כ שווי תיק (₪)', 'ערך': 100000.46 },
      { 'מדד': 'סה"כ השקעה (₪)', 'ערך': 90000 },
      { 'מדד': 'סה"כ רווח/הפסד (₪)', 'ערך': 10000.46 },
      { 'מדד': 'שינוי יומי משוקלל (%)', 'ערך': 1.23 },
      { 'מדד': 'רווח/הפסד יומי (₪)', 'ערך': 500 }
    ]);
  });

  test('returns an empty array for missing summary', () => {
    expect(buildSummaryExportRows(null)).toEqual([]);
    expect(buildSummaryExportRows(undefined)).toEqual([]);
  });
});

describe('buildHeadlineMetrics', () => {
  test('leads with the four figures the dashboard leads with', () => {
    const metrics = buildHeadlineMetrics({
      capitalTotalILS: 250000,
      totalProfitILS: 50000,
      totalPurchaseILS: 200000,
      dailyProfitILS: 300,
      weightedDailyChange: 1.23,
      totalTaxILS: 12500
    });
    expect(metrics.map((m) => m.label)).toEqual([
      'שווי תיק כולל',
      'רווח/הפסד כולל',
      'שינוי יומי',
      'מס צפוי'
    ]);
    expect(metrics[0].value).toBe(250000);
    expect(metrics[1].note).toBe('25% מההשקעה');
  });

  // Nothing invested is not the same as a 0% return, and a report that
  // prints the second for the first is stating something it doesn't know.
  test('says there is no investment rather than reporting a 0% return', () => {
    const metrics = buildHeadlineMetrics({ totalPurchaseILS: 0, totalProfitILS: 0 });
    expect(metrics[1].note).toBe('אין השקעה רשומה');
  });

  test('returns an empty list for a missing summary', () => {
    expect(buildHeadlineMetrics(null)).toEqual([]);
  });
});

describe('buildPortfolioReportSections', () => {
  const data = {
    summary: { capitalTotalILS: 1000, capitalIsraeliILS: 1000 },
    israeliStocks: [{ stockName: '629014', officialName: 'טבע', purchasePrice: 10, quantity: 10, currentPrice: 12 }]
  };

  test('covers every asset class, in report order', () => {
    expect(buildPortfolioReportSections(data).map((s) => s.title)).toEqual([
      'מצב ההון - פירוט לפי אפיק',
      'השקעה נטו - שני השווקים יחד',
      'בורסה ישראלית',
      'בורסה אמריקאית',
      'קופות גמל להשקעה',
      'קרנות כספיות',
      'עובר ושב (עו"ש)',
      'קופת חיסכון בבנק'
    ]);
  });

  test('puts the itemized rows under the asset class they belong to', () => {
    const israeli = buildPortfolioReportSections(data).find((s) => s.title === 'בורסה ישראלית');
    expect(israeli.isEmpty).toBe(false);
    expect(israeli.rows).toHaveLength(1);
    expect(israeli.rows[0]['שם נייר']).toBe('טבע');
    expect(israeli.metrics.length).toBeGreaterThan(0);
  });

  // An A4 page is 182mm wide, so the spreadsheet's sixteen US columns come
  // to ~11mm each - about five characters before a header wraps. The
  // printed report takes a narrower projection; the spreadsheet keeps the
  // full record.
  test('the printed table is a narrower projection than the spreadsheet row', () => {
    const us = buildPortfolioReportSections({
      summary: {},
      americanStocks: [
        { stockName: 'AAPL', purchasePrice: 150, quantity: 10, currentPrice: 190, exchangeRate: 3.6, currentExchangeRate: 3.7 }
      ]
    }).find((s) => s.title === 'בורסה אמריקאית');

    const full = Object.keys(buildAmericanStocksExportRows([{ stockName: 'AAPL' }])[0]);
    const printed = Object.keys(us.rows[0]);
    expect(printed.length).toBeLessThan(full.length);
    // Still identifies the holding and still states what it is worth.
    expect(printed).toContain('סימול');
    expect(printed).toContain('סה"כ שווי נוכחי (₪)');
    // Every printed column is a real column of the underlying row, not a
    // name that quietly stopped matching one.
    printed.forEach((key) => expect(full).toContain(key));
  });

  test('the Israeli printed table keeps both the name and the security number', () => {
    const israeli = buildPortfolioReportSections(data).find((s) => s.title === 'בורסה ישראלית');
    expect(Object.keys(israeli.rows[0])).toEqual(
      expect.arrayContaining(['שם נייר', 'מספר נייר'])
    );
  });

  // Several of these lists end on a tax estimate. Marking "the last one"
  // as the section's conclusion would print the tax as what the section
  // adds up to, so the bottom line says so for itself.
  test('every section names its own bottom line rather than relying on position', () => {
    buildPortfolioReportSections(data).forEach((section) => {
      const totals = section.metrics.filter(([, , isTotal]) => isTotal);
      expect(totals).toHaveLength(1);
    });
  });

  test('a section whose bottom line is not its last-listed figure still marks it', () => {
    const us = buildPortfolioReportSections(data).find((s) => s.title === 'בורסה אמריקאית');
    const total = us.metrics.find(([, , isTotal]) => isTotal);
    expect(total[0]).toBe('שווי נוכחי (₪)');
    expect(us.metrics.some(([label, , isTotal]) => /מס צפוי/.test(label) && isTotal)).toBe(false);
  });

  // An asset class the user holds nothing in still gets a heading, so an
  // empty account is distinguishable from one the report forgot.
  test('keeps an empty class as a section that says it is empty', () => {
    const us = buildPortfolioReportSections(data).find((s) => s.title === 'בורסה אמריקאית');
    expect(us.isEmpty).toBe(true);
    expect(us.rows).toEqual([]);
    expect(us.emptyNote).toBeTruthy();
  });

  test('handles entirely missing data without throwing', () => {
    expect(() => buildPortfolioReportSections()).not.toThrow();
    expect(buildPortfolioReportSections({}).every((s) => s.isEmpty || s.rows.length === 0)).toBe(true);
  });
});

// THE SHORT REPORT: each stock once, with its totals and average price.
describe('the short (summary) report', () => {
  const tevaLots = [
    { stockName: '629014', officialName: 'טבע', quantity: 10, purchasePrice: 50, currentPrice: 60, purchaseDate: '2023-01-15' },
    { stockName: '629014', officialName: 'טבע', quantity: 30, purchasePrice: 70, currentPrice: 60, purchaseDate: '2024-05-01' }
  ];
  const aaplLots = [
    { stockName: 'AAPL', quantity: 2, purchasePrice: 100, currentPrice: 150, exchangeRate: 3.5, currentExchangeRate: 3.6 },
    { stockName: 'AAPL', quantity: 2, purchasePrice: 200, currentPrice: 150, exchangeRate: 3.7, currentExchangeRate: 3.6 }
  ];

  test('an Israeli stock bought twice is one row: summed quantity and money, average price', () => {
    const [row] = buildIsraeliStocksSummaryRows(tevaLots);
    expect(row['שם נייר']).toBe('טבע');
    expect(row['מספר קניות']).toBe(2);
    expect(row['כמות']).toBe(40);
    expect(row['סה"כ רכישה (₪)']).toBe(2600); // 500 + 2100
    expect(row['מחיר קנייה ממוצע (₪)']).toBe(65);
    expect(row['סה"כ שווי נוכחי (₪)']).toBe(2400);
    expect(row['רווח/הפסד (₪)']).toBe(-200);
  });

  // The two reports must add up to the same money.
  test('the totals equal the sum of the detailed rows', () => {
    const detailed = buildAmericanStocksExportRows(aaplLots);
    const [row] = buildAmericanStocksSummaryRows(aaplLots);
    const sum = (key) => detailed.reduce((s, r) => s + r[key], 0);
    expect(row['כמות']).toBe(4);
    expect(row['סה"כ שווי נוכחי (₪)']).toBeCloseTo(sum('סה"כ שווי נוכחי (₪)'), 2);
    expect(row['רווח/הפסד (₪)']).toBeCloseTo(sum('רווח/הפסד (₪)'), 2);
    expect(row['מחיר קנייה ממוצע ($)']).toBe(150);
  });

  test('summary mode prints one row per stock, without purchase dates; the default prints every purchase', () => {
    const data = { israeliStocks: tevaLots, americanStocks: aaplLots };
    const bySection = (sections, title) => sections.find((s) => s.title === title);

    const short = buildPortfolioReportSections(data, { mode: 'summary' });
    expect(bySection(short, 'בורסה ישראלית').rows).toHaveLength(1);
    expect(bySection(short, 'בורסה אמריקאית').rows).toHaveLength(1);
    expect(Object.keys(bySection(short, 'בורסה ישראלית').rows[0])).not.toContain('תאריך קנייה');
    expect(Object.keys(bySection(short, 'בורסה ישראלית').rows[0])).toContain('מספר קניות');

    const full = buildPortfolioReportSections(data);
    expect(bySection(full, 'בורסה ישראלית').rows).toHaveLength(2);
    expect(Object.keys(bySection(full, 'בורסה ישראלית').rows[0])).toContain('תאריך קנייה');
  });
});
