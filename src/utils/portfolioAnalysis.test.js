import { calculatePortfolioAnalysis } from './portfolioAnalysis';

describe('calculatePortfolioAnalysis', () => {
  test('handles an empty portfolio without throwing', () => {
    const analysis = calculatePortfolioAnalysis([], [], [], [], []);
    expect(analysis.exchangeDistribution.total).toBe(0);
    expect(analysis.stockDistribution).toEqual([]);
    expect(analysis.reports.topPerformers).toEqual([]);
    expect(analysis.reports.worstPerformers).toEqual([]);
  });

  test('groups multiple lots of the same stock into one distribution entry', () => {
    const israeliStocks = [
      { stockName: 'TEVA', quantity: 100, purchasePrice: 30, currentPrice: 3500, dailyChangePercent: 1.2, purchaseDate: '2023-01-15' },
      { stockName: 'TEVA', quantity: 50, purchasePrice: 32, currentPrice: 3500, dailyChangePercent: 1.2, purchaseDate: '2023-06-01' }
    ];
    const analysis = calculatePortfolioAnalysis(israeliStocks, [], [], [], []);
    const tevaEntries = analysis.stockDistribution.filter((s) => s.name === 'TEVA');
    expect(tevaEntries).toHaveLength(1);
    expect(tevaEntries[0].totalQuantity).toBe(150);
  });

  test('exchangeDistribution percentages sum to ~100% across categories', () => {
    const israeliStocks = [{ stockName: 'A', quantity: 10, purchasePrice: 10, currentPrice: 1200, dailyChangePercent: 0, purchaseDate: '2023-01-01' }];
    const americanStocks = [{ stockName: 'B', quantity: 5, purchasePrice: 100, currentPrice: 120, exchangeRate: 3.5, currentExchangeRate: 3.5, dailyChangePercent: 0, purchaseDate: '2023-01-01' }];
    const pensionFunds = [{ initialInvestment: 1000, currentValue: 1100, previousValue: 1050, updateDate: '2023-01-01' }];
    const cashFunds = [{ amount: 500, updateDate: '2023-01-01' }];
    const bankBalances = [{ amount: 2000, updateDate: '2023-01-01' }];

    const analysis = calculatePortfolioAnalysis(israeliStocks, americanStocks, pensionFunds, cashFunds, bankBalances);
    const { israeli, american, pension, cashFunds: cf, bank } = analysis.exchangeDistribution;
    const totalPercent = israeli.percentage + american.percentage + pension.percentage + cf.percentage + bank.percentage;
    expect(totalPercent).toBeCloseTo(100, 5);
  });

  describe('Israeli-listed ETFs tracking a foreign index (isForeignAsset/keyword reclassification)', () => {
    test('an Israeli ETF whose name matches a foreign-tracking keyword counts toward exchangeDistribution.american, not .israeli', () => {
      const israeliStocks = [
        { stockName: 'קסם S&P 500', quantity: 10, purchasePrice: 100, currentPrice: 10000, dailyChangePercent: 0, purchaseDate: '2023-01-01' }
      ];
      const analysis = calculatePortfolioAnalysis(israeliStocks, [], [], [], []);
      expect(analysis.exchangeDistribution.israeli.value).toBe(0);
      expect(analysis.exchangeDistribution.american.value).toBeCloseTo(100000, 5); // 10 * 10000 (currentPrice is already in ILS, see normalizeIsraeliPrice)
      // The grand total is unaffected - the value just moved buckets, not created/destroyed.
      expect(analysis.exchangeDistribution.total).toBeCloseTo(100000, 5);
    });

    test('the reclassified ETF still appears in stockDistribution tagged exchange:"american"', () => {
      const israeliStocks = [
        { stockName: 'קסם S&P 500', quantity: 10, purchasePrice: 100, currentPrice: 10000, dailyChangePercent: 0, purchaseDate: '2023-01-01' }
      ];
      const analysis = calculatePortfolioAnalysis(israeliStocks, [], [], [], []);
      const entry = analysis.stockDistribution.find((s) => s.name === 'קסם S&P 500');
      expect(entry.exchange).toBe('american');
    });

    test('a manual isForeignAsset:true override reclassifies an otherwise-ordinary-looking Israeli stock', () => {
      const israeliStocks = [
        { stockName: 'טבע', quantity: 10, purchasePrice: 100, currentPrice: 10000, dailyChangePercent: 0, purchaseDate: '2023-01-01', isForeignAsset: true }
      ];
      const analysis = calculatePortfolioAnalysis(israeliStocks, [], [], [], []);
      expect(analysis.exchangeDistribution.israeli.value).toBe(0);
      expect(analysis.exchangeDistribution.american.value).toBeCloseTo(100000, 5);
    });

    test('a manual isForeignAsset:false override keeps a keyword-matching name classified as Israeli', () => {
      const israeliStocks = [
        { stockName: 'קסם S&P 500', quantity: 10, purchasePrice: 100, currentPrice: 10000, dailyChangePercent: 0, purchaseDate: '2023-01-01', isForeignAsset: false }
      ];
      const analysis = calculatePortfolioAnalysis(israeliStocks, [], [], [], []);
      expect(analysis.exchangeDistribution.israeli.value).toBeCloseTo(100000, 5);
      expect(analysis.exchangeDistribution.american.value).toBe(0);
    });

    test('a legacy item with no isForeignAsset field at all still classifies purely by name (backward compatible)', () => {
      const israeliStocks = [
        { stockName: 'טבע', quantity: 10, purchasePrice: 100, currentPrice: 10000, dailyChangePercent: 0, purchaseDate: '2023-01-01' }
      ];
      const analysis = calculatePortfolioAnalysis(israeliStocks, [], [], [], []);
      expect(analysis.exchangeDistribution.israeli.value).toBeCloseTo(100000, 5);
      expect(analysis.exchangeDistribution.american.value).toBe(0);
    });
  });

  test('classifies profitable stocks as topPerformers and losing stocks as worstPerformers', () => {
    const israeliStocks = [
      { stockName: 'WINNER', quantity: 10, purchasePrice: 10, currentPrice: 2000, dailyChangePercent: 0, purchaseDate: '2023-01-01' }, // profit
      { stockName: 'LOSER', quantity: 10, purchasePrice: 50, currentPrice: 30, dailyChangePercent: 0, purchaseDate: '2023-01-01' }   // loss (currentPrice already in shekels, no agorot conversion since <=1000)
    ];
    const analysis = calculatePortfolioAnalysis(israeliStocks, [], [], [], []);
    const topNames = analysis.reports.topPerformers.map((s) => s.name);
    const worstNames = analysis.reports.worstPerformers.map((s) => s.name);
    expect(topNames).toContain('WINNER');
    expect(worstNames).toContain('LOSER');
    expect(topNames).not.toContain('LOSER');
    expect(worstNames).not.toContain('WINNER');
  });

  test('largestPositions is sorted descending by value', () => {
    const israeliStocks = [
      { stockName: 'SMALL', quantity: 1, purchasePrice: 10, currentPrice: 1000, dailyChangePercent: 0, purchaseDate: '2023-01-01' },
      { stockName: 'BIG', quantity: 100, purchasePrice: 10, currentPrice: 1000, dailyChangePercent: 0, purchaseDate: '2023-01-01' }
    ];
    const analysis = calculatePortfolioAnalysis(israeliStocks, [], [], [], []);
    const values = analysis.reports.largestPositions.map((s) => s.value);
    expect(values).toEqual([...values].sort((a, b) => b - a));
    expect(analysis.reports.largestPositions[0].name).toBe('BIG');
  });

  // THE REPORTED MISMATCH: home said +0.88% and the analysis page +0.32%
  // for the same day. Same shekels, divided by the stocks on one page and
  // by the whole portfolio (provident funds included) on the other.
  test("today's change on the stocks' own base matches the home page, and the whole-portfolio figure is the diluted one", () => {
    const { calculatePortfolioSummary } = require('./portfolioSummary');
    const today = new Date().toISOString().slice(0, 10);
    const israeliStocks = [
      { stockName: 'A', quantity: 10, purchasePrice: 10, currentPrice: 100, dailyChangePercent: 2, dailyChangeTradeDate: today, purchaseDate: '2023-01-01' }
    ];
    // 1,000 in stocks, 2,000 more in a provident fund with no daily price.
    const pensionFunds = [{ currentValue: 2000, updateDate: '2023-01-01' }];

    const analysis = calculatePortfolioAnalysis(israeliStocks, [], pensionFunds, [], []);
    const summary = calculatePortfolioSummary(israeliStocks, [], pensionFunds, [], []);
    const m = analysis.summaryMetrics;

    // +2% on a holding worth 1,000 now: it was 1,000 / 1.02 at the close.
    const change = (1000 * 2) / 102;
    expect(m.dailyChangeILS).toBeCloseTo(change, 6);
    expect(m.dailyChangeStocksPercent).toBeCloseTo(2, 6);
    expect(m.dailyChangeStocksPercent).toBeCloseTo(summary.weightedDailyChange, 6);
    expect(m.weightedDailyChangePercent).toBeCloseTo((change / (3000 - change)) * 100, 6);
  });

  // The three largest holdings are ranked across everything held: with most
  // of the money in provident funds, ranking only the stocks left the
  // largest holdings out of "the largest holdings".
  test('concentration ranks every holding - funds and accounts as well as stocks', () => {
    const israeliStocks = [{ stockName: 'A', officialName: 'אלפא', quantity: 10, purchasePrice: 10, currentPrice: 100, purchaseDate: '2023-01-01' }];
    const pensionFunds = [
      { fundName: 'גמל גדולה', currentValue: 5000, updateDate: '2023-01-01' },
      { fundName: 'גמל קטנה', currentValue: 3000, updateDate: '2023-01-01' }
    ];
    const bankBalances = [{ amount: 1000, updateDate: '2023-01-01' }];
    // Total 1,000 (stock) + 8,000 (funds) + 1,000 (bank) = 10,000.
    const analysis = calculatePortfolioAnalysis(israeliStocks, [], pensionFunds, [], bankBalances);
    const m = analysis.summaryMetrics;

    expect(m.topHoldings.map((h) => h.name)).toEqual(['גמל גדולה', 'גמל קטנה', expect.any(String)]);
    expect(m.topHoldings[0]).toMatchObject({ kind: 'pension', percentage: 50 });
    expect(m.concentrationTop3Percent).toBeCloseTo(90, 6);
  });

  test('summaryMetrics.positionsCount includes every category', () => {
    const israeliStocks = [{ stockName: 'A', quantity: 1, purchasePrice: 1, currentPrice: 100, purchaseDate: '2023-01-01' }];
    const americanStocks = [{ stockName: 'B', quantity: 1, purchasePrice: 1, currentPrice: 1, exchangeRate: 3.5, purchaseDate: '2023-01-01' }];
    const pensionFunds = [{ currentValue: 100, updateDate: '2023-01-01' }];
    const cashFunds = [{ amount: 100, updateDate: '2023-01-01' }];
    const bankBalances = [{ amount: 100, updateDate: '2023-01-01' }];
    const analysis = calculatePortfolioAnalysis(israeliStocks, americanStocks, pensionFunds, cashFunds, bankBalances);
    // 2 distinct stock names + 1 pension + 1 cash fund + 1 bank = 5
    expect(analysis.summaryMetrics.positionsCount).toBe(5);
  });

  test('does not throw on missing/undefined numeric fields', () => {
    const israeliStocks = [{ stockName: 'A' }];
    expect(() => calculatePortfolioAnalysis(israeliStocks, [], [], [], [])).not.toThrow();
  });

  describe('bank savings funds (bankSavingsFunds param)', () => {
    test('a bank savings fund contributes to exchangeDistribution.bankSavings and the overall total', () => {
      const bankSavingsFunds = [
        { fundName: 'חיסכון', interestRate: 0, deposits: [{ date: '2024-01-01', amount: 4000 }] }
      ];
      const analysis = calculatePortfolioAnalysis([], [], [], [], [], bankSavingsFunds);
      expect(analysis.exchangeDistribution.bankSavings.value).toBeCloseTo(4000, 5);
      expect(analysis.exchangeDistribution.bankSavings.percentage).toBeCloseTo(100, 5);
      expect(analysis.exchangeDistribution.total).toBeCloseTo(4000, 5);
      expect(analysis.summaryMetrics.bankSavingsTotalValueILS).toBeCloseTo(4000, 5);
      expect(analysis.summaryMetrics.bankSavingsPositions).toBe(1);
    });

    test('exchangeDistribution percentages (including bankSavings) sum to ~100% across all six categories', () => {
      const israeliStocks = [{ stockName: 'A', quantity: 10, purchasePrice: 10, currentPrice: 1200, dailyChangePercent: 0, purchaseDate: '2023-01-01' }];
      const pensionFunds = [{ initialInvestment: 1000, currentValue: 1100, previousValue: 1050, updateDate: '2023-01-01' }];
      const bankSavingsFunds = [{ fundName: 'X', interestRate: 0, deposits: [{ date: '2023-01-01', amount: 900 }] }];

      const analysis = calculatePortfolioAnalysis(israeliStocks, [], pensionFunds, [], [], bankSavingsFunds);
      const { israeli, pension, bankSavings } = analysis.exchangeDistribution;
      expect(israeli.percentage + pension.percentage + bankSavings.percentage).toBeCloseTo(100, 5);
    });

    test('omitting bankSavingsFunds entirely (backward compatible call) does not throw and treats it as empty', () => {
      const analysis = calculatePortfolioAnalysis([], [], [], [], []);
      expect(analysis.exchangeDistribution.bankSavings.value).toBe(0);
      expect(analysis.summaryMetrics.bankSavingsPositions).toBe(0);
    });
  });
});

describe('stock distribution display names', () => {
  test('carries a readable "name (security id)" label alongside the raw key for an Israeli holding', () => {
    const analysis = calculatePortfolioAnalysis(
      [{ stockName: '629014', officialName: 'טבע', quantity: 10, purchasePrice: 30, currentPrice: 35, purchaseDate: '2023-01-15' }],
      [],
      [],
      [],
      [],
      []
    );
    const entry = analysis.stockDistribution.find((s) => s.name === '629014');
    // `name` stays the key everything else matches on; displayName is what
    // a reader should see - a bare 7-digit number identifies nothing.
    expect(entry.name).toBe('629014');
    expect(entry.displayName).toBe('טבע (629014)');
  });

  test('falls back to the security id when no name has been resolved', () => {
    const analysis = calculatePortfolioAnalysis(
      [{ stockName: '1234567', quantity: 1, purchasePrice: 1, currentPrice: 1, purchaseDate: '2023-01-15' }],
      [],
      [],
      [],
      [],
      []
    );
    expect(analysis.stockDistribution[0].displayName).toBe('1234567');
  });

  test('an American ticker is already readable, so its display name is just the ticker', () => {
    const analysis = calculatePortfolioAnalysis(
      [],
      [{ stockName: 'AAPL', quantity: 1, purchasePrice: 100, currentPrice: 120, exchangeRate: 3.6, currentExchangeRate: 3.7, purchaseDate: '2023-01-15' }],
      [],
      [],
      [],
      []
    );
    expect(analysis.stockDistribution[0].displayName).toBe('AAPL');
  });
});

describe('per-holding annual return', () => {
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

  test('a holding under a year shows its return since purchase, not an annualized extrapolation', () => {
    const analysis = calculatePortfolioAnalysis(
      [{ stockName: 'NEW', quantity: 10, purchasePrice: 100, currentPrice: 105, purchaseDate: daysAgo(10) }],
      [], [], [], []
    );
    const s = analysis.stockDistribution[0];
    expect(s.annualizedIsPeriod).toBe(true);
    expect(s.annualizedReturn).toBeCloseTo(0.05, 6);
  });

  test('a holding of a year or more is annualized', () => {
    const analysis = calculatePortfolioAnalysis(
      [{ stockName: 'OLD', quantity: 10, purchasePrice: 100, currentPrice: 121, purchaseDate: daysAgo(730) }],
      [], [], [], []
    );
    const s = analysis.stockDistribution[0];
    expect(s.annualizedIsPeriod).toBe(false);
    expect(s.annualizedReturn).toBeCloseTo(0.1, 2);
  });
});
