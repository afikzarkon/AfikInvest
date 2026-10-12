import { buildSamplePortfolio } from './samplePortfolio';
import { calculatePortfolioSummary } from './portfolioSummary';

const today = new Date(Date.UTC(2026, 8, 24));

test('fills every asset class', () => {
  const sample = buildSamplePortfolio(today);
  [
    'israeliStocks',
    'americanStocks',
    'pensionFunds',
    'bankBalances',
    'cashFunds',
    'bankSavingsFunds'
  ].forEach((key) => {
    expect(sample[key].length).toBeGreaterThan(0);
  });
});

test('gives every row a unique id', () => {
  const sample = buildSamplePortfolio(today);
  const ids = Object.values(sample)
    .flat()
    .map((row) => row.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test('dates the ledger values to this month and the one before', () => {
  const [fund] = buildSamplePortfolio(today).pensionFunds;
  expect(fund.currentValueDate).toBe('2026-09-01');
  expect(fund.previousValueDate).toBe('2026-08-01');
});

test('includes more than one lot of the same share', () => {
  const { israeliStocks, americanStocks } = buildSamplePortfolio(today);
  const repeated = (lots) => lots.length > new Set(lots.map((lot) => lot.stockName)).size;
  expect(repeated(israeliStocks)).toBe(true);
  expect(repeated(americanStocks)).toBe(true);
});

test('produces a positive valuation before any live price arrives', () => {
  const s = buildSamplePortfolio(today);
  const summary = calculatePortfolioSummary(
    s.israeliStocks,
    s.americanStocks,
    s.pensionFunds,
    s.cashFunds,
    s.bankBalances,
    {},
    s.bankSavingsFunds
  );
  expect(summary.capitalTotalILS).toBeGreaterThan(0);
  expect(Number.isFinite(summary.totalProfitILS)).toBe(true);
});

test('keeps each ledger account amount equal to its current value', () => {
  const s = buildSamplePortfolio(today);
  [...s.pensionFunds, ...s.bankBalances, ...s.cashFunds].forEach((account) => {
    expect(account.amount).toBe(account.currentValue);
  });
});
