import { buildQuickInsights, MOVER_PCT } from './quickInsights';
import { calculatePortfolioAnalysis } from './portfolioAnalysis';
import { calculatePortfolioSummary } from './portfolioSummary';
import { israelToday } from './marketSession';

const TODAY = israelToday();
const NOW = Date.now();
const fresh = new Date(NOW - 60 * 1000).toISOString();

const il = (stockName, officialName, value, extra = {}) => ({
  id: `${stockName}-${extra.id || 1}`,
  stockName,
  officialName,
  purchaseDate: '2024-01-01',
  purchasePrice: 100,
  quantity: value / 100,
  currentPrice: 100,
  dailyChangePercent: 0,
  dailyChangeTradeDate: TODAY,
  priceFetchedAt: fresh,
  securityType: 'מניות',
  ...extra
});

function run(holdings, options = {}) {
  const h = { israeliStocks: [], americanStocks: [], pensionFunds: [], cashFunds: [], bankBalances: [], bankSavingsFunds: [], ...holdings };
  const analysis = calculatePortfolioAnalysis(h.israeliStocks, h.americanStocks, h.pensionFunds, h.cashFunds, h.bankBalances, h.bankSavingsFunds);
  const summary = calculatePortfolioSummary(h.israeliStocks, h.americanStocks, h.pensionFunds, h.cashFunds, h.bankBalances, {}, h.bankSavingsFunds);
  return buildQuickInsights({ holdings: h, analysis, summary, pricesLoaded: true, now: NOW, ...options });
}

describe('buildQuickInsights', () => {
  test('an empty portfolio has nothing to say', () => {
    expect(run({})).toEqual([]);
  });

  test('a big move today leads, in its own colour', () => {
    const out = run({
      israeliStocks: [il('1', 'אלפא', 5000, { dailyChangePercent: MOVER_PCT + 2.2 }), il('2', 'בטא', 5000), il('3', 'גמא', 5000), il('4', 'דלתא', 5000), il('5', 'הא', 5000)]
    });
    expect(out[0].kind).toBe('mover');
    expect(out[0].tone).toBe('up');
    expect(out[0].title).toContain('אלפא');
    expect(out[0].title).toContain('+5.2%');
  });

  test('a single stock above the review threshold is flagged; a broad fund is not', () => {
    const stock = run({ israeliStocks: [il('1', 'אלפא', 8000), il('2', 'בטא', 2000)] });
    expect(stock.some((i) => i.kind === 'concentration' && i.title.includes('אלפא'))).toBe(true);

    const fund = run({ israeliStocks: [il('1', 'קסם מחקה ת"א 125', 8000, { isFund: true, securityType: 'קרן סל' }), il('2', 'בטא', 2000)] });
    expect(fund.some((i) => i.kind === 'concentration' && i.title.includes('קסם'))).toBe(false);
  });

  test('one holding only: one concentration line, no "best and worst" of the same stock', () => {
    const out = run({ israeliStocks: [il('1', 'אלפא', 10000, { currentPrice: 120 })] });
    expect(out.filter((i) => i.kind === 'performer')).toHaveLength(out.some((i) => i.kind === 'performer') ? 1 : 0);
    expect(out.some((i) => i.kind === 'concentration')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(3);
  });

  test('never more than three, and never two of a kind', () => {
    const out = run({
      israeliStocks: [
        il('1', 'אלפא', 9000, { dailyChangePercent: 6, currentPrice: 0 }),
        il('2', 'בטא', 3000, { dailyChangePercent: -7 }),
        il('3', 'גמא', 1000, { priceFetchedAt: null })
      ]
    });
    expect(out.length).toBeLessThanOrEqual(3);
    expect(new Set(out.map((i) => i.kind)).size).toBe(out.length);
  });

  test('a holding with no price is a maintenance hint - but not before the first refresh', () => {
    const holdings = { israeliStocks: [il('1', 'אלפא', 1000, { currentPrice: 0 }), il('2', 'בטא', 1000), il('3', 'גמא', 1000), il('4', 'דלתא', 1000), il('5', 'הא', 1000)] };
    expect(run(holdings).some((i) => i.kind === 'health' && i.title.includes('אלפא'))).toBe(true);
    expect(run(holdings, { pricesLoaded: false }).some((i) => i.kind === 'health')).toBe(false);
  });

  test('a provident fund not updated for months says so', () => {
    const out = run({
      pensionFunds: [{ id: 7, fundName: 'גמל להשקעה', currentValue: 50000, currentValueDate: '2020-01-01', deposits: [{ date: '2019-06-01', amount: 40000 }] }]
    });
    expect(out.some((i) => i.kind === 'fundHealth' && i.title.includes('גמל להשקעה'))).toBe(true);
  });

  test("a fund's return since its previous update, deposits netted out", () => {
    const d = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 10);
    const out = run({
      pensionFunds: [{ id: 8, fundName: 'קופה', previousValue: 100000, previousValueDate: d(40), currentValue: 106000, currentValueDate: d(5), deposits: [] }]
    });
    const fund = out.find((i) => i.kind === 'fund');
    expect(fund).toBeDefined();
    expect(fund.tone).toBe('up');
    expect(fund.title).toContain('+6.0%');
  });

  test('a quiet, balanced portfolio still gets one general line', () => {
    const us = (stockName) => ({ id: stockName, stockName, purchaseDate: '2024-01-01', purchasePrice: 100, quantity: 10, exchangeRate: 3.7, currentExchangeRate: 3.7, currentPrice: 100, dailyChangePercent: 0, dailyChangeTradeDate: TODAY, priceFetchedAt: fresh });
    const out = run({
      israeliStocks: [il('1', 'אלפא', 3700), il('2', 'בטא', 3700), il('3', 'גמא', 3700)],
      americanStocks: [us('AAA'), us('BBB'), us('CCC')],
      pensionFunds: [{ id: 9, fundName: 'קופה', currentValue: 20000, currentValueDate: TODAY, valueFromLedger: true, deposits: [{ date: '2024-01-01', amount: 20000 }] }]
    });
    expect(out.map((i) => i.kind)).toEqual(['general']);
    expect(out[0].text).toContain('קופות');
  });
});
