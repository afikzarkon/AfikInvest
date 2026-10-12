import { chainExactTwr, computeExactTwr, xirr, computeMoneyWeightedReturn, holdingsBeforeFlowsOn } from './performanceReturns';
import { buildPortfolioCashFlows } from './portfolioCashFlows';
import { computeTimeWeightedReturnPercent, buildSeriesFromHistoricalValues } from './portfolioStats';
import { computeHistoricalPortfolioSeries } from './historicalPortfolioValue';
import { applyTransaction, normalizeTransaction, expandHoldingsWithClosedLots } from '../shared/transactionLedger';

describe('xirr', () => {
  test('one year, +10%', () => {
    expect(xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: 1100 }])).toBeCloseTo(0.1, 8);
  });

  test("Excel's documented XIRR example: 37.336%", () => {
    const r = xirr([
      { date: '2008-01-01', amount: -10000 },
      { date: '2008-03-01', amount: 2750 },
      { date: '2008-10-30', amount: 4250 },
      { date: '2009-02-15', amount: 3250 },
      { date: '2009-04-01', amount: 2750 }
    ]);
    expect(r).toBeCloseTo(0.373362535, 6);
  });

  test('a total loss and a huge gain are still found (bisection fallback)', () => {
    expect(xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: 1 }])).toBeCloseTo(-0.999, 3);
    expect(xirr([{ date: '2025-01-01', amount: -100 }, { date: '2025-07-01', amount: 400 }])).toBeGreaterThan(5);
  });

  test('no sign change -> null', () => {
    expect(xirr([{ date: '2025-01-01', amount: -1 }, { date: '2025-06-01', amount: -2 }])).toBeNull();
    expect(xirr([])).toBeNull();
  });
});

describe('chainExactTwr', () => {
  test('100 -> 110, deposit 100, 210 -> 189  =>  -1%', () => {
    const r = chainExactTwr([
      { date: 'a', before: 100, after: 100 },
      { date: 'b', before: 110, after: 210 },
      { date: 'c', before: 189, after: 189 }
    ]);
    expect(r).toBeCloseTo(-0.01, 12);
  });

  test('an empty opening sub-period is skipped', () => {
    expect(chainExactTwr([{ before: 0, after: 0 }, { before: 0, after: 100 }, { before: 120, after: 120 }])).toBeCloseTo(0.2, 12);
    expect(chainExactTwr([{ before: 0, after: 0 }])).toBeNull();
  });
});

describe('computeMoneyWeightedReturn', () => {
  test('bad timing: TWR -1%, MWR much worse', () => {
    const mwr = computeMoneyWeightedReturn({
      fromDate: '2025-01-01',
      toDate: '2026-01-01',
      startValue: 100,
      endValue: 189,
      cashFlows: [{ date: '2025-07-01', amount: 100 }]
    });
    expect(mwr.annualPercent).toBeCloseTo(-7.27, 1);
    expect(mwr.days).toBe(365);
    expect(mwr.periodPercent).toBeCloseTo(mwr.annualPercent, 6);
  });

  test('a short window reports the period rate, not the annualized one', () => {
    const mwr = computeMoneyWeightedReturn({ fromDate: '2025-01-01', toDate: '2025-02-01', startValue: 1000, endValue: 1020 });
    expect(mwr.periodPercent).toBeCloseTo(2, 6);
    expect(mwr.annualPercent).toBeGreaterThan(25);
  });
});

// A market that rises 10% by March, then falls 10%: prices in agorot.
const closes = [];
for (let d = new Date('2025-01-01T00:00:00Z'); d <= new Date('2025-06-30T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
  const date = d.toISOString().slice(0, 10);
  closes.push({ date, close: date < '2025-03-01' ? 1000 : date < '2025-05-01' ? 1100 : 990 });
}
const priceData = { taseHistoricalCloses: { X: closes }, yahooHistoricalCloses: {}, fxHistoricalCloses: [] };

describe('computeExactTwr', () => {
  test('a mid-period purchase at the close price does not move the TWR', () => {
    const holdings = {
      israeliStocks: [
        { id: 1, stockName: 'X', purchaseDate: '2025-01-01', purchasePrice: 10, quantity: 100 },
        { id: 2, stockName: 'X', purchaseDate: '2025-04-10', purchasePrice: 11, quantity: 100 }
      ]
    };
    const flows = buildPortfolioCashFlows(holdings);
    const exact = computeExactTwr({ fromDate: '2025-01-01', toDate: '2025-06-30', holdings, priceData, cashFlows: flows });
    // +10% then -10%: 1.1 * 0.9 - 1 = -1%, regardless of the extra 100 units.
    expect(exact.percent).toBeCloseTo(-1, 10);
    expect(exact.subPeriods).toBe(2);
    expect(exact.isPartial).toBe(false);
  });

  test('with a recorded sale it still measures only the market', () => {
    const start = { israeliStocks: [{ id: 1, stockName: 'X', purchaseDate: '2025-01-01', purchasePrice: 10, quantity: 100 }] };
    const sale = { ...normalizeTransaction({ type: 'SELL', date: '2025-04-01', assetClass: 'israeli', assetId: 'X', units: 60, price: 11 }), id: 's' };
    const { portfolio, transaction } = applyTransaction(start, sale);
    const history = expandHoldingsWithClosedLots(portfolio, [transaction]);
    const flows = buildPortfolioCashFlows({ ...history, transactions: [transaction] });
    const exact = computeExactTwr({ fromDate: '2025-01-01', toDate: '2025-06-30', holdings: history, priceData, cashFlows: flows });
    expect(exact.percent).toBeCloseTo(-1, 10);

    // The sampled Modified Dietz TWR agrees closely.
    const series = buildSeriesFromHistoricalValues(computeHistoricalPortfolioSeries('2025-01-01', '2025-06-30', history, priceData));
    expect(computeTimeWeightedReturnPercent(series, flows)).toBeCloseTo(-1, 6);
  });

  test('missing prices make the result partial', () => {
    const holdings = { israeliStocks: [{ id: 1, stockName: 'NOPRICE', purchaseDate: '2025-01-01', purchasePrice: 10, quantity: 1 }] };
    const r = computeExactTwr({ fromDate: '2025-01-02', toDate: '2025-06-30', holdings, priceData, cashFlows: [] });
    expect(r.isPartial).toBe(true);
    expect(r.missingSymbols).toEqual(['NOPRICE']);
  });

  test('holdingsBeforeFlowsOn drops same-day buys and keeps same-day sales', () => {
    const h = holdingsBeforeFlowsOn(
      { israeliStocks: [{ purchaseDate: '2025-04-01' }, { purchaseDate: '2025-01-01', soldDate: '2025-04-01' }], americanStocks: [] },
      '2025-04-01'
    );
    expect(h.israeliStocks).toEqual([{ purchaseDate: '2025-01-01', soldDate: null }]);
  });
});
