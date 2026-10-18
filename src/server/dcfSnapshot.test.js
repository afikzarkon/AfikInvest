/**
 * @jest-environment node
 */
// The DCF data snapshot: Yahoo's response shapes parsed into dated, sourced
// figures; one failing source recorded rather than fatal; the route.
const http = require('http');
const express = require('express');
const { parseTimeseries, parseQuote, parseRiskFree, fetchDcfSnapshot, createDcfSnapshotService, QUARTER_FIELDS } = require('./dcfSnapshot');
const { mountValuationRoutes } = require('./valuationRoutes');

const ts = (prefix, type, points) => ({
  meta: { type: [`${prefix}${type}`] },
  [`${prefix}${type}`]: points.map(([asOfDate, raw]) => (raw === null ? null : { asOfDate, currencyCode: 'USD', reportedValue: { raw } }))
});
const timeseries = (prefix) => ({
  timeseries: {
    result: [
      ts(prefix, 'TotalRevenue', [['2026-04-30', 22e9], ['2026-07-31', 29e9]]),
      ts(prefix, 'StockBasedCompensation', [['2026-04-30', 2e9], ['2026-07-31', null]]),
      ts(prefix, 'CurrentDebt', [['2026-07-31', 2.252e9]]),
      ts(prefix, 'SomethingElse', [['2026-07-31', 1]])
    ]
  }
});
const quote = {
  price: { regularMarketPrice: 328.75, regularMarketTime: 1792353601, currency: 'USD', longName: 'Broadcom Inc.', quoteType: 'EQUITY' },
  financialData: { financialCurrency: 'USD' },
  defaultKeyStatistics: { beta: 1.476, sharesOutstanding: 4773629865 },
  assetProfile: { sector: 'Technology', industry: 'Semiconductors' },
  earningsTrend: {
    trend: [
      { period: '0q', endDate: '2026-10-31', revenueEstimate: { avg: 34.9e9 } },
      { period: '0y', endDate: '2026-10-31', revenueEstimate: { avg: 105.978e9, numberOfAnalysts: 40 } },
      { period: '+1y', endDate: '2027-10-31', revenueEstimate: { avg: 173.968e9, numberOfAnalysts: 49 } }
    ]
  }
};

test('timeseries rows by period, only the asked fields, gaps left out', () => {
  const rows = parseTimeseries(timeseries('quarterly'), 'quarterly', QUARTER_FIELDS);
  expect(rows).toEqual([
    { periodEnd: '2026-04-30', currency: 'USD', revenue: 22e9, sbc: 2e9 },
    { periodEnd: '2026-07-31', currency: 'USD', revenue: 29e9, currentDebt: 2.252e9 }
  ]);
});

test('quote: the price dated by its market time; consensus 0y and +1y with year and analysts; beta and profile', () => {
  const q = parseQuote(quote, '2026-10-18');
  expect(q.price).toMatchObject({ value: 328.75, asOf: '2026-10-18', source: expect.stringMatching(/Yahoo/) });
  expect(q.consensus.rev0y).toEqual({ value: 105.978e9, periodEnd: '2026-10-31', analysts: 40 });
  expect(q.consensus.rev1y).toEqual({ value: 173.968e9, periodEnd: '2027-10-31', analysts: 49 });
  expect(q.betaRaw).toMatchObject({ value: 1.476, asOf: '2026-10-18' });
  expect(q.profile).toMatchObject({ sector: 'Technology', industry: 'Semiconductors' });
  expect(parseQuote({ price: {} }, '2026-10-18')).toMatchObject({ price: null, betaRaw: null, consensus: { rev0y: null, rev1y: null } });
});

test('the 10-year yield in percent becomes a dated rate', () => {
  expect(parseRiskFree({ chart: { result: [{ meta: { regularMarketPrice: 5.098, regularMarketTime: 1792353601 } }] } })).toMatchObject({ value: 0.05098, asOf: '2026-10-18' });
  expect(parseRiskFree({ chart: { result: [{ meta: { regularMarketPrice: 0 } }] } })).toBeNull();
});

test('a failing source is recorded, the rest still arrive', async () => {
  const snap = await fetchDcfSnapshot('AVGO', {
    get: async (url, config) => ({ data: timeseries(config.params.type.startsWith('quarterly') ? 'quarterly' : 'annual') }),
    plainGet: async () => {
      throw new Error('unused');
    },
    quoteSummary: async () => {
      throw new Error('crumb refused');
    },
    riskFree: async () => ({ data: { chart: { result: [{ meta: { regularMarketPrice: 5.1, regularMarketTime: 1792353601 } }] } } })
  });
  expect(snap.diagnostics).toEqual({ quarters: 'ok', annual: 'ok', quote: 'error: crumb refused', riskFree: 'ok' });
  expect(snap.price).toBeNull();
  expect(snap.quarters).toHaveLength(2);
  expect(snap.rf.value).toBeCloseTo(0.051, 12);
});

test('cached per symbol; a partial snapshot only briefly', async () => {
  let t = 0;
  const fetch = jest.fn(async (s) => ({ ticker: s, diagnostics: { quote: s === 'BAD' ? 'error: x' : 'ok' } }));
  const get = createDcfSnapshotService({ fetch, now: () => t });
  await get('AVGO');
  await get('BAD');
  t = 20 * 60 * 1000;
  await get('AVGO');
  await get('BAD');
  expect(fetch.mock.calls.map((c) => c[0])).toEqual(['AVGO', 'BAD', 'BAD']);
});

test('the route: a bad symbol is refused, a good one returns the snapshot', async () => {
  const app = express();
  mountValuationRoutes(app, { valuation: { getValuation: async () => ({}) }, dcfSnapshot: async (s) => ({ ticker: s }) });
  const server = app.listen(0);
  const port = server.address().port;
  const get = (path) =>
    new Promise((resolve, reject) => {
      http.get({ port, path }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      }).on('error', reject);
    });
  try {
    expect((await get('/api/valuation/bad%20sym/dcf')).status).toBe(400);
    expect(await get('/api/valuation/avgo/dcf')).toEqual({ status: 200, body: { ticker: 'AVGO' } });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

describe('the last 10-year yield, kept for when the source is down', () => {
  const { createReferenceMemory } = require('./dcfSnapshot');
  const deps = (riskFree, memory) => ({
    get: async (url, config) => ({ data: timeseries(config.params.type.startsWith('quarterly') ? 'quarterly' : 'annual') }),
    plainGet: async () => ({ data: {} }),
    quoteSummary: async () => quote,
    riskFree,
    memory
  });
  const tnx = (pct) => async () => ({ data: { chart: { result: [{ meta: { regularMarketPrice: pct, regularMarketTime: 1792353601 } }] } } });
  const down = async () => {
    throw new Error('chart down');
  };

  test('a fetched yield is remembered; when the chart fails it comes back as rfLastSaved, never as rf', async () => {
    const memory = createReferenceMemory();
    const first = await fetchDcfSnapshot('NOW', deps(tnx(5.098), memory));
    expect(first.rf.value).toBeCloseTo(0.05098, 12);
    expect(first.rfLastSaved).toBeNull();
    const second = await fetchDcfSnapshot('NOW', deps(down, memory));
    expect(second.rf).toBeNull();
    expect(second.rfLastSaved).toMatchObject({ value: first.rf.value, asOf: first.rf.asOf });
  });

  test('nothing remembered yet: neither', async () => {
    const snap = await fetchDcfSnapshot('NOW', deps(down, createReferenceMemory()));
    expect(snap.rf).toBeNull();
    expect(snap.rfLastSaved).toBeNull();
  });

  test('persisted in the market_reference table, so a restarted server still has it', async () => {
    const Database = require('better-sqlite3');
    const { makeSqliteSql } = require('./sqlAdapter');
    const db = new Database(':memory:');
    const sql = makeSqliteSql(db);
    await sql.exec('CREATE TABLE IF NOT EXISTS market_reference (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
    const before = createReferenceMemory();
    before.attach(sql);
    await before.set('rf', { value: 0.051, asOf: '2026-10-16' });
    await before.set('rf', { value: 0.05098, asOf: '2026-10-18' });
    const after = createReferenceMemory();
    after.attach(sql);
    expect(await after.get('rf')).toEqual({ value: 0.05098, asOf: '2026-10-18' });
    db.close();
  });
});

test('cash components are fetched; strategic investments are not', () => {
  const { QUARTER_FIELDS: fields } = require('./dcfSnapshot');
  expect(fields).toMatchObject({
    cash: 'CashAndCashEquivalents',
    shortTermInvestments: 'OtherShortTermInvestments',
    longTermMarketable: 'InvestmentinFinancialAssets',
    availableForSale: 'AvailableForSaleSecurities'
  });
  expect(Object.values(fields)).not.toEqual(expect.arrayContaining(['LongTermEquityInvestment']));
  expect(Object.values(fields)).not.toContain('InvestmentsAndAdvances');
});
