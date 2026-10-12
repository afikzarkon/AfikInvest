/**
 * @jest-environment node
 */
const {
  parseYahooTimeseries,
  parseFmpStatements,
  parseValuationSummary,
  parseMonthlyChart,
  parsePeers,
  peerMultiples,
  fetchYahooStatements,
  fetchRiskFreeRate
} = require('./fundamentals');

const entry = (asOfDate, raw) => ({ asOfDate, periodType: '12M', currencyCode: 'USD', reportedValue: { raw, fmt: String(raw) } });

test('parses Yahoo fundamentals-timeseries into rows per fiscal year', () => {
  const data = {
    timeseries: {
      result: [
        { meta: { symbol: ['X'], type: ['annualTotalRevenue'] }, timestamp: [1, 2], annualTotalRevenue: [entry('2023-12-31', 100), entry('2024-12-31', 120)] },
        { meta: { symbol: ['X'], type: ['annualCapitalExpenditure'] }, annualCapitalExpenditure: [entry('2024-12-31', -30), null] },
        { meta: { symbol: ['X'], type: ['annualCashAndCashEquivalents'] }, annualCashAndCashEquivalents: [entry('2024-12-31', 50)] },
        { meta: { symbol: ['X'], type: ['annualSomethingElse'] }, annualSomethingElse: [entry('2024-12-31', 1)] },
        { meta: { symbol: ['X'], type: ['annualNetIncome'] } }
      ]
    }
  };
  expect(parseYahooTimeseries(data, 'annual')).toEqual([
    { periodEnd: '2023-12-31', currency: 'USD', revenue: 100 },
    { periodEnd: '2024-12-31', currency: 'USD', revenue: 120, capex: -30, cash: 50, cashAndShortTerm: 50 }
  ]);
  expect(parseYahooTimeseries(null, 'annual')).toEqual([]);
});

test('requests annual and quarterly types, falling back to query1', async () => {
  const data = { timeseries: { result: [{ meta: { type: ['annualTotalRevenue'] }, annualTotalRevenue: [entry('2024-12-31', 1)] }] } };
  const get = jest.fn(async (url) => {
    if (url.startsWith('https://query2')) throw new Error('401');
    return { data };
  });
  const out = await fetchYahooStatements('AAPL', { get });
  expect(out.annual).toEqual([{ periodEnd: '2024-12-31', currency: 'USD', revenue: 1 }]);
  const calls = get.mock.calls.map((c) => [c[0].slice(0, 14), c[1].params.type.split(',')[0]]);
  expect(calls).toEqual(expect.arrayContaining([
    ['https://query2', 'annualTotalRevenue'],
    ['https://query1', 'annualTotalRevenue'],
    ['https://query1', 'quarterlyTotalRevenue']
  ]));
});

test('an empty statements response is an error, not an empty company', async () => {
  const get = jest.fn(async () => ({ data: { timeseries: { result: [] } } }));
  await expect(fetchYahooStatements('AAPL', { get })).rejects.toThrow(/no financial statements/);
});

test('by default the statements go through the crumb-authenticated request', () => {
  const src = require('fs').readFileSync(require.resolve('./fundamentals'), 'utf8');
  expect(src).toMatch(/async function fetchYahooStatements\(symbol, \{ get = crumbGet \}/);
});

test('parses FMP statements into the same shape', () => {
  const rows = parseFmpStatements(
    [{ date: '2024-09-28', reportedCurrency: 'USD', revenue: 391, netIncome: 94, weightedAverageShsOutDil: 15.4 }],
    [{ date: '2024-09-28', operatingCashFlow: 118, capitalExpenditure: -9.4, freeCashFlow: 108.6 }],
    [{ date: '2024-09-28', cashAndShortTermInvestments: 65, totalDebt: 106 }]
  );
  expect(rows).toEqual([
    { periodEnd: '2024-09-28', currency: 'USD', revenue: 391, netIncome: 94, dilutedShares: 15.4, operatingCashFlow: 118, capex: -9.4, freeCashFlow: 108.6, cashAndShortTerm: 65, totalDebt: 106 }
  ]);
});

test('parses the valuation quote summary (plain or wrapped numbers)', () => {
  const s = parseValuationSummary({
    price: { longName: 'Apple Inc.', currency: 'USD', regularMarketPrice: { raw: 230 }, marketCap: 3.5e12, quoteType: 'EQUITY' },
    summaryDetail: { trailingPE: 35, priceToSalesTrailing12Months: 9 },
    financialData: { financialCurrency: 'USD', freeCashflow: 1e11, totalCash: 6e10, totalDebt: 1e11 },
    defaultKeyStatistics: { sharesOutstanding: 1.5e10, beta: 1.2 },
    earningsTrend: { trend: [{ period: '0q', growth: 0.1 }, { period: '+5y', growth: { raw: 0.11 } }] },
    assetProfile: { sector: 'Technology', industry: 'Consumer Electronics' }
  });
  expect(s).toMatchObject({ name: 'Apple Inc.', price: 230, marketCap: 3.5e12, beta: 1.2, analystGrowth5y: 0.11, sector: 'Technology', financialCurrency: 'USD' });
  expect(peerMultiples(s)).toEqual({ PE: 35, PS: 9, PFCF: 35 });
  expect(peerMultiples({ marketCap: 1, freeCashflow: -1 }).PFCF).toBeNull();
});

test('monthly chart: month-end dates, split events, duplicate month deduped', () => {
  const ts = (d) => Date.parse(`${d}T04:00:00Z`) / 1000;
  const data = {
    chart: {
      result: [
        {
          timestamp: [ts('2024-05-01'), ts('2024-06-01'), ts('2024-06-10')],
          indicators: { quote: [{ close: [100, 120, 121] }] },
          events: { splits: { a: { date: ts('2024-06-10'), numerator: 10, denominator: 1 } } }
        }
      ]
    }
  };
  expect(parseMonthlyChart(data)).toEqual({
    closes: [
      { date: '2024-05-31', close: 100 },
      { date: '2024-06-30', close: 121 }
    ],
    splits: [{ date: '2024-06-10', ratio: 10 }],
    meta: { price: null, currency: null, name: null }
  });
  data.chart.result[0].meta = { regularMarketPrice: 123.4, currency: 'USD', longName: 'Netflix, Inc.' };
  expect(parseMonthlyChart(data).meta).toEqual({ price: 123.4, currency: 'USD', name: 'Netflix, Inc.' });
  expect(() => parseMonthlyChart({})).toThrow();
});

test('peers and risk-free rate', async () => {
  expect(parsePeers({ finance: { result: [{ recommendedSymbols: [{ symbol: 'MSFT' }, { symbol: 'GOOG' }] }] } })).toEqual(['MSFT', 'GOOG']);
  expect(parsePeers({})).toEqual([]);
  const get = jest.fn(async () => ({ data: { chart: { result: [{ meta: { regularMarketPrice: 4.25 } }] } } }));
  expect(await fetchRiskFreeRate({ get })).toBeCloseTo(0.0425, 10);
  const bad = jest.fn(async () => ({ data: { chart: { result: [{ meta: { regularMarketPrice: 42.5 } }] } } }));
  expect(await fetchRiskFreeRate({ get: bad })).toBeNull();
});
