/**
 * @jest-environment node
 */
const { buildReportModel, modifiedDietz } = require('./reportModel');

const bd = (israeli, apple, pension, bank) => ({
  israeli: [{ key: '604611', label: 'לאומי (604611)', value: israeli }],
  american: apple === null ? [] : [{ key: 'AAPL', label: 'AAPL', value: apple }],
  pension: [{ key: 'גמל', label: 'גמל', value: pension }],
  cashFunds: [],
  bank: [{ key: 'bank-1', label: 'עו"ש', value: bank }],
  bankSavings: []
});
const snap = (month, b) => ({ month, breakdown: b, totalValueILS: ['israeli', 'american', 'pension', 'bank'].reduce((s, k) => s + b[k].reduce((t, i) => t + i.value, 0), 0) });

const base = () => ({
  month: '2026-08',
  snapshots: [snap('2026-07', bd(30000, 40000, 100000, 15000)), snap('2026-08', bd(33000, 38000, 104000, 12000))],
  portfolio: {
    pensionFunds: [{ id: 1, fundName: 'גמל', deposits: [{ date: '2026-08-15', amount: 2000 }, { date: '2026-07-15', amount: 2000 }] }],
    israeliStocks: [{ id: 7, stockName: '604611', purchaseDate: '2026-08-05', purchasePrice: 10, quantity: 100 }]
  },
  transactions: [
    { id: 'd', type: 'DIVIDEND', date: '2026-08-12', assetClass: 'american', assetId: 'AAPL', amount: 25, taxWithheld: 6.25, currency: 'USD', fxRate: 3.6 }
  ],
  generatedAt: '2026-09-05T00:00:00Z'
});

test('executive summary: net worth, change, capital added and Modified Dietz return', () => {
  const m = buildReportModel(base());
  expect(m.summary).toMatchObject({ netWorthILS: 187000, prevNetWorthILS: 185000, changeILS: 2000 });
  // capital: pension deposit 2000 + purchase 1000 - dividend paid out 67.5
  expect(m.summary.netCapitalAddedILS).toBeCloseTo(2932.5, 6);
  expect(m.summary.marketChangeILS).toBeCloseTo(2000 - 2932.5, 6);
  expect(m.summary.returnPct).toBeCloseTo(
    modifiedDietz(185000, 187000, [{ date: '2026-08-05', amount: 1000 }, { date: '2026-08-12', amount: -67.5 }, { date: '2026-08-15', amount: 2000 }], '2026-07-31', '2026-08-31'),
    10
  );
  expect(m.previousIsAdjacent).toBe(true);
  expect(m.summary.netWorthUSD).toBeNull();
});

test('USD figures use the month-end rates', () => {
  const m = buildReportModel({ ...base(), usdRateEnd: 4, usdRatePrev: 3.7 });
  expect(m.summary.netWorthUSD).toBe(46750);
  expect(m.summary.changeUSD).toBeCloseTo(187000 / 4 - 185000 / 3.7, 6);
});

test('allocation groups and targets', () => {
  const m = buildReportModel({ ...base(), targets: { israeli: 20, american: 30, pension: 40, bank: 10 } });
  const eq = m.allocation.find((a) => a.key === 'equities');
  expect(eq).toMatchObject({ value: 71000, targetPercent: 50 });
  expect(eq.percent).toBeCloseTo((71000 / 187000) * 100, 6);
  expect(m.allocation.map((a) => a.key)).toEqual(['equities', 'fixedIncome', 'pension', 'cash']);
});

test("movers are ranked by contribution net of each item's own flows", () => {
  const m = buildReportModel(base());
  // 604611: +3000 value, 1000 of it bought -> +2000; pension +4000 with 2000 deposited -> +2000
  // AAPL: -2000 value, dividend 67.5 paid out -> -1932.5; bank -3000, no flow -> -3000
  expect(m.topMovers.map((x) => [x.key, Math.round(x.contributionILS)])).toEqual([
    ['604611', 2000],
    ['גמל', 2000]
  ]);
  expect(m.topDraggers.map((x) => [x.key, Math.round(x.contributionILS * 10) / 10])).toEqual([
    ['bank-1', -3000],
    ['AAPL', -1932.5]
  ]);
  expect(m.topMovers[0].percent).toBeCloseTo((2000 / 31000) * 100, 6);
});

test('cash flow summary', () => {
  const m = buildReportModel(base());
  expect(m.cashFlow).toMatchObject({ purchasesILS: 1000, depositsILS: 2000, withdrawalsILS: -0, saleProceedsILS: -0 });
  expect(m.cashFlow.dividends).toEqual([{ date: '2026-08-12', symbol: 'AAPL', currency: 'USD', gross: 25, taxWithheld: 6.25, net: 18.75, netILS: 67.5 }]);
});

test('a gap month compares against the latest earlier checkpoint and says so', () => {
  const b = base();
  b.snapshots[0].month = '2026-05';
  const m = buildReportModel(b);
  expect(m).toMatchObject({ previousMonth: '2026-05', previousIsAdjacent: false });
});

test('no checkpoint for the month is an error; no previous one is not', () => {
  expect(() => buildReportModel({ ...base(), month: '2026-09' })).toThrow(/no monthly snapshot/);
  const first = buildReportModel({ ...base(), snapshots: [base().snapshots[1]] });
  expect(first.summary.changeILS).toBeNull();
  expect(first.topMovers).toEqual([]);
});

describe('cash-flow fixes', () => {
  const { flowsForMonth, monthFlowsFingerprint, estimateUnrecordedDividends, usSymbolsHeldInMonth } = require('./reportModel');

  test('deposits/withdrawals recorded through the ledger on a current account are cash flows; its opening entry is not', () => {
    const portfolio = {
      bankBalances: [
        { id: 6, amount: 5000, deposits: [{ date: '2026-08-01', amount: 16500 }, { date: '2026-08-18', amount: -1000, txId: 'w1' }, { date: '2026-08-20', amount: 300, txId: 'd1' }] }
      ]
    };
    const flows = flowsForMonth({ portfolio, transactions: [], month: '2026-08' });
    expect(flows.map((f) => [f.kind, f.amount, f.itemKey])).toEqual([
      ['WITHDRAWAL', -1000, 'bank-1'],
      ['DEPOSIT', 300, 'bank-1']
    ]);
    const m = buildReportModel({ ...base(), portfolio: { ...base().portfolio, ...portfolio } });
    expect(m.cashFlow.withdrawalsILS).toBe(1000);
    expect(m.cashFlow.depositsILS).toBe(2300);
  });

  test('the flow fingerprint changes when a transaction lands in the month, not for other months', () => {
    const p = base().portfolio;
    const a = monthFlowsFingerprint({ portfolio: p, transactions: [], month: '2026-08' });
    const div = { id: 'x', type: 'DIVIDEND', date: '2026-08-20', assetClass: 'american', assetId: 'AAPL', amount: 1, taxWithheld: 0, currency: 'USD', fxRate: 3.6 };
    expect(monthFlowsFingerprint({ portfolio: p, transactions: [div], month: '2026-08' })).not.toBe(a);
    expect(monthFlowsFingerprint({ portfolio: p, transactions: [{ ...div, date: '2026-07-20' }], month: '2026-08' })).toBe(a);
  });

  test('unrecorded dividends are estimated from market data for the units held on the ex-date', () => {
    const portfolio = {
      americanStocks: [
        { id: 1, stockName: 'KO', quantity: 100, purchaseDate: '2025-01-01' },
        { id: 2, stockName: 'KO', quantity: 50, purchaseDate: '2026-08-20' }, // bought after the ex-date
        { id: 3, stockName: 'AAPL', quantity: 10, purchaseDate: '2025-01-01' }
      ]
    };
    const recorded = [{ id: 'r', type: 'DIVIDEND', date: '2026-08-14', assetClass: 'american', assetId: 'AAPL', amount: 2.6 }];
    const est = estimateUnrecordedDividends({
      portfolio,
      transactions: recorded,
      month: '2026-08',
      historyBySymbol: { KO: [{ date: '2026-07-15', amountPerShare: 0.5 }, { date: '2026-08-15', amountPerShare: 0.51 }], AAPL: [{ date: '2026-08-11', amountPerShare: 0.26 }] }
    });
    expect(est).toEqual([{ date: '2026-08-15', symbol: 'KO', currency: 'USD', amountPerShare: 0.51, units: 100 }]);
    expect(usSymbolsHeldInMonth({ portfolio, transactions: [], month: '2026-08' })).toEqual(['AAPL', 'KO']);

    const m = buildReportModel({ ...base(), estimatedDividends: est, usdRateEnd: 4 });
    expect(m.cashFlow.estimatedDividends[0]).toMatchObject({ gross: 51, grossILS: 204 });
    expect(m.cashFlow.estimatedDividendsGrossILS).toBe(204);
    // estimates never move the return or the capital figures
    expect(m.summary.netCapitalAddedILS).toBeCloseTo(buildReportModel(base()).summary.netCapitalAddedILS, 10);
  });
});
