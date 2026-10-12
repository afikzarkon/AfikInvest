// End-to-end accuracy of the transactions ledger against the performance
// engine: a sale or a withdrawal must never be read as an investment loss.
import { applyTransaction, normalizeTransaction, expandHoldingsWithClosedLots } from '../shared/transactionLedger';
import { computeHistoricalPortfolioSeries, computePortfolioValueAtDate } from './historicalPortfolioValue';
import { buildPortfolioCashFlows } from './portfolioCashFlows';
import { buildSeriesFromHistoricalValues, computeTimeWeightedReturnPercent } from './portfolioStats';
import { computeRealizedGains } from './realizedGains';

// A flat-then-rising price for one TASE security (closes in agorot):
// 1000 agorot (₪10) until 2025-03-01, then ₪12.
const taseCloses = [];
for (let d = new Date('2025-01-01T00:00:00Z'); d <= new Date('2025-06-30T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
  const date = d.toISOString().slice(0, 10);
  taseCloses.push({ date, close: date < '2025-03-01' ? 1000 : 1200 });
}
const priceData = { taseHistoricalCloses: { 111: taseCloses }, yahooHistoricalCloses: {}, fxHistoricalCloses: [] };

const startPortfolio = () => ({
  israeliStocks: [
    { id: 1, stockName: '111', purchaseDate: '2025-01-01', purchasePrice: 10, quantity: 100 }
  ],
  americanStocks: [],
  pensionFunds: [],
  cashFunds: [],
  bankBalances: [],
  bankSavingsFunds: []
});

function sellHalf(price = 12, date = '2025-04-01') {
  const tx = {
    ...normalizeTransaction({ type: 'SELL', date, assetClass: 'israeli', assetId: '111', units: 50, price }),
    id: 's1'
  };
  return applyTransaction(startPortfolio(), tx);
}

test('selling half at the market price keeps the TWR at the true +20%', () => {
  const { portfolio, transaction } = sellHalf();
  const history = expandHoldingsWithClosedLots(portfolio, [transaction]);
  const series = buildSeriesFromHistoricalValues(
    computeHistoricalPortfolioSeries('2025-01-01', '2025-06-30', history, priceData)
  );
  const flows = buildPortfolioCashFlows({ ...history, transactions: [transaction] });
  expect(computeTimeWeightedReturnPercent(series, flows)).toBeCloseTo(20, 6);
});

test('without the ledger the same sale reads as a loss (the bug this fixes)', () => {
  // Old behaviour: the lot row is simply edited down to 50 units and no
  // sale is known. The history loses the sold units entirely, so the
  // curve under-reports the whole past.
  const edited = startPortfolio();
  edited.israeliStocks[0].quantity = 50;
  const valueBefore = computePortfolioValueAtDate('2025-02-01', edited, priceData).valueILS;
  expect(valueBefore).toBe(500); // should have been 1000
});

test('the sold units are still valued before the sale and gone from the sale date', () => {
  const { portfolio, transaction } = sellHalf();
  const history = expandHoldingsWithClosedLots(portfolio, [transaction]);
  expect(computePortfolioValueAtDate('2025-03-31', history, priceData).valueILS).toBe(1200);
  expect(computePortfolioValueAtDate('2025-04-01', history, priceData).valueILS).toBe(600);
  // The current position is the open lot only.
  expect(portfolio.israeliStocks.map((l) => l.quantity)).toEqual([50]);
});

test('a dividend paid out counts as return', () => {
  const div = {
    ...normalizeTransaction({ type: 'DIVIDEND', date: '2025-05-01', assetClass: 'israeli', assetId: '111', amount: 100 }),
    id: 'd1'
  };
  const holdings = startPortfolio();
  const series = buildSeriesFromHistoricalValues(
    computeHistoricalPortfolioSeries('2025-01-01', '2025-06-30', holdings, priceData)
  );
  const flows = buildPortfolioCashFlows({ ...holdings, transactions: [div] });
  const twr = computeTimeWeightedReturnPercent(series, flows);
  // price +20% plus ₪100 of dividends on ~₪1,200 received late in the period
  expect(twr).toBeGreaterThan(28);
  expect(twr).toBeLessThan(32);
});

test('a recorded withdrawal from an account is not a loss', () => {
  const account = {
    id: 7,
    fundName: 'גמל',
    currentValue: 10000,
    currentValueDate: '2025-01-01',
    deposits: [{ date: '2025-01-01', amount: 10000 }]
  };
  const withdrawal = {
    ...normalizeTransaction({ type: 'WITHDRAWAL', date: '2025-03-01', assetClass: 'pension', assetId: 7, amount: 4000 }),
    id: 'w1'
  };
  const { portfolio } = applyTransaction({ pensionFunds: [account] }, withdrawal);
  // Balance recorded after the withdrawal: 6,000 - no growth, no loss.
  const after = { ...portfolio.pensionFunds[0], currentValue: 6000, currentValueDate: '2025-03-01', previousValue: 10000, previousValueDate: '2025-01-01' };
  const flows = buildPortfolioCashFlows({ pensionFunds: [after] });
  expect(flows).toEqual([
    { date: '2025-01-01', amount: 10000 },
    { date: '2025-03-01', amount: -4000 }
  ]);
  const series = [
    { date: '2025-01-01', value: 10000 },
    { date: '2025-03-01', value: 6000 }
  ];
  expect(computeTimeWeightedReturnPercent(series, flows.slice(1))).toBeCloseTo(0, 10);
});

describe('computeRealizedGains', () => {
  test('Israeli sale: nominal gain, CPI-indexed real gain and tax', () => {
    const { transaction } = sellHalf(12, '2025-04-01');
    const indexByMonth = { '2025-01': 100, '2025-03': 102 };
    const { rows, totals, byYear } = computeRealizedGains([transaction], { indexByMonth });
    expect(rows).toHaveLength(1);
    expect(rows[0].nominalGainILS).toBe(100); // 50 × (12 − 10)
    // cost 500 indexed to 510 (April falls back to March's 102)
    expect(rows[0].adjustedCostILS).toBeCloseTo(510, 10);
    expect(rows[0].realGainILS).toBeCloseTo(90, 10);
    expect(totals.estimatedTaxILS).toBeCloseTo(22.5, 10);
    expect(byYear['2025'].count).toBe(1);
  });

  test('a real loss offsets a real gain within the year', () => {
    const p = {
      israeliStocks: [
        { id: 1, stockName: 'A', purchaseDate: '2025-01-01', purchasePrice: 10, quantity: 10 },
        { id: 2, stockName: 'B', purchaseDate: '2025-01-01', purchasePrice: 10, quantity: 10 }
      ]
    };
    const s1 = { ...normalizeTransaction({ type: 'SELL', date: '2025-02-01', assetClass: 'israeli', assetId: 'A', units: 10, price: 15 }), id: 'a' };
    const s2 = { ...normalizeTransaction({ type: 'SELL', date: '2025-02-01', assetClass: 'israeli', assetId: 'B', units: 10, price: 8 }), id: 'b' };
    const t1 = applyTransaction(p, s1);
    const t2 = applyTransaction(t1.portfolio, s2);
    const { totals } = computeRealizedGains([t1.transaction, t2.transaction]);
    expect(totals.realGainsILS).toBe(50);
    expect(totals.realLossesILS).toBe(-20);
    expect(totals.estimatedTaxILS).toBeCloseTo(7.5, 10);
    expect(totals.unindexedCount).toBe(2); // no CPI data given
  });

  test('US sale: real gain is the dollar gain at the sale rate', () => {
    const p = { americanStocks: [{ id: 1, stockName: 'X', purchaseDate: '2024-01-01', purchasePrice: 100, quantity: 10, exchangeRate: 3.5 }] };
    const s = { ...normalizeTransaction({ type: 'SELL', date: '2025-01-01', assetClass: 'american', assetId: 'X', units: 10, price: 110, fxRate: 4 }), id: 's' };
    const { transaction } = applyTransaction(p, s);
    const { rows } = computeRealizedGains([transaction]);
    expect(rows[0].nominalGainILS).toBeCloseTo(4400 - 3500, 10);
    expect(rows[0].realGainILS).toBeCloseTo(100 * 4, 10); // $100 gain × 4
  });
});
