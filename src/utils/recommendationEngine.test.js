import {
  buildRecommendationContext,
  runRecommendationEngine,
  driftRule,
  concentrationRule,
  profitTakingRule,
  taxLossHarvestRule,
  cashDragRule,
  resolveRecommendations,
  harvestableLoss,
  washSaleCheck,
  realGainOfSale,
  DEFAULT_RECOMMENDATION_PREFS
} from './recommendationEngine';
import { calculatePortfolioAnalysis } from './portfolioAnalysis';
import { applyTransaction, normalizeTransaction } from '../shared/transactionLedger';

// No CPI: real gain falls back to the nominal gain, which keeps the numbers
// easy to verify by hand.
function makeCtx(overrides = {}, holdings = {}) {
  const h = {
    israeliStocks: [],
    americanStocks: [],
    pensionFunds: [],
    cashFunds: [],
    bankBalances: [],
    bankSavingsFunds: [],
    ...holdings
  };
  const analysis = calculatePortfolioAnalysis(h.israeliStocks, h.americanStocks, h.pensionFunds, h.cashFunds, h.bankBalances, h.bankSavingsFunds);
  return buildRecommendationContext({ ...h, analysis, today: '2026-06-15', ...overrides });
}

// Winner: bought 100 @ ₪10, now ₪30 = ₪3,000 (gain +200%).
// Loser (two lots): 50 @ ₪40 (2024) and 50 @ ₪20 (2025), now ₪25.
const winner = { id: 1, stockName: 'WIN', purchaseDate: '2024-01-01', purchasePrice: 10, quantity: 100, currentPrice: 30 };
const loserOld = { id: 2, stockName: 'LOSE', purchaseDate: '2024-01-01', purchasePrice: 40, quantity: 50, currentPrice: 25 };
const loserNew = { id: 3, stockName: 'LOSE', purchaseDate: '2025-01-01', purchasePrice: 20, quantity: 50, currentPrice: 25 };
const bank = { id: 9, amount: 2000 };

describe('context', () => {
  test('groups lots into positions with weight and unrealized gain', () => {
    const ctx = makeCtx({}, { israeliStocks: [winner, loserOld, loserNew], bankBalances: [bank] });
    expect(ctx.totalValueILS).toBe(3000 + 2500 + 2000);
    const win = ctx.positions.find((p) => p.symbol === 'WIN');
    expect(win).toMatchObject({ units: 100, valueILS: 3000, costILS: 1000, realGainILS: 2000 });
    expect(win.weightPct).toBeCloseTo(40, 6);
    expect(win.unrealizedGainPct).toBeCloseTo(200, 6);
    const lose = ctx.positions.find((p) => p.symbol === 'LOSE');
    expect(lose.realGainILS).toBe(-750 + 250);
  });
});

describe('drift rule (5pp or 25% relative)', () => {
  const holdings = { israeliStocks: [winner], bankBalances: [{ id: 9, amount: 7000 }] }; // 30% / 70%
  test('fires on absolute drift', () => {
    const ctx = makeCtx({ targets: { israeli: 40, american: 0, pension: 0, cashFunds: 0, bank: 60, bankSavings: 0 } }, holdings);
    const recs = driftRule.evaluate(ctx);
    expect(recs.map((r) => [r.category, Math.round(r.amountILS)])).toEqual([
      ['israeli', 1000],
      ['bank', -1000]
    ]);
  });
  test('fires on relative drift even when the absolute drift is small', () => {
    // Raise the absolute bar out of reach so only the 25% relative test can fire.
    const prefs = { driftAbsPp: 20 };
    // 30% held vs a 26% target: 4pp = 15% relative -> nothing
    expect(driftRule.evaluate(makeCtx({ targets: { israeli: 26, american: 0, pension: 0, cashFunds: 0, bank: 74, bankSavings: 0 }, prefs }, holdings))).toEqual([]);
    // 30% held vs a 22% target: 8pp = 36% relative -> fires; the cash side
    // (70% vs 78%: 8pp = 10% relative) does not
    const recs = driftRule.evaluate(makeCtx({ targets: { israeli: 22, american: 0, pension: 0, cashFunds: 0, bank: 78, bankSavings: 0 }, prefs }, holdings));
    expect(recs.map((r) => r.category)).toEqual(['israeli']);
  });
  test('no valid targets -> nothing', () => {
    expect(driftRule.evaluate(makeCtx({ targets: { israeli: 10 } }, holdings))).toEqual([]);
  });
});

describe('concentration and profit taking', () => {
  const holdings = { israeliStocks: [winner, loserOld, loserNew], bankBalances: [bank] };

  test('concentration trims to the cap with FIFO tax', () => {
    const ctx = makeCtx({}, holdings);
    const [rec] = concentrationRule.evaluate(ctx).filter((r) => r.symbol === 'WIN');
    // 40% -> 15% of ₪7,500 = sell ₪1,875 = 62.5 units, gain 62.5 × ₪20 = ₪1,250, tax ₪312.5
    expect(rec.amountILS).toBeCloseTo(-1875, 6);
    expect(rec.units).toBeCloseTo(62.5, 6);
    expect(rec.estTaxILS).toBeCloseTo(312.5, 6);
    // LOSE is 33% too
    expect(concentrationRule.evaluate(ctx).map((r) => r.symbol).sort()).toEqual(['LOSE', 'WIN']);
  });

  test('profit taking only when the gain is large AND the position is over target', () => {
    const ctx = makeCtx({}, holdings);
    expect(profitTakingRule.evaluate(ctx).map((r) => r.symbol)).toEqual(['WIN']);
    const small = makeCtx({ prefs: { positionCapPct: 50 } }, holdings);
    expect(profitTakingRule.evaluate(small)).toEqual([]);
  });

  test('realized losses this year reduce the tax on a trim', () => {
    const p = { israeliStocks: [{ id: 50, stockName: 'OLD', purchaseDate: '2024-01-01', purchasePrice: 10, quantity: 10, currentPrice: 10 }] };
    const sale = { ...normalizeTransaction({ type: 'SELL', date: '2026-03-01', assetClass: 'israeli', assetId: 'OLD', units: 10, price: 5 }), id: 's' };
    const { transaction } = applyTransaction(p, sale);
    const ctx = makeCtx({ transactions: [transaction] }, holdings);
    expect(ctx.realizedNetGainYTD).toBe(-50);
    const [rec] = concentrationRule.evaluate(ctx).filter((r) => r.symbol === 'WIN');
    expect(rec.estTaxILS).toBeCloseTo((1250 - 50) * 0.25, 6);
  });

  test('the resolver merges concentration and profit-taking into one trim', () => {
    const ctx = makeCtx({}, holdings);
    const recs = resolveRecommendations([...concentrationRule.evaluate(ctx), ...profitTakingRule.evaluate(ctx)], ctx.prefs);
    const win = recs.filter((r) => r.symbol === 'WIN');
    expect(win).toHaveLength(1);
    expect(win[0]).toMatchObject({ rule: 'profit-taking', alsoFlagged: ['concentration'] });
  });
});

describe('tax-loss harvesting', () => {
  const holdings = { israeliStocks: [winner, loserOld, loserNew], bankBalances: [bank] };

  test('FIFO can only reach the loss through the oldest lot', () => {
    const ctx = makeCtx({}, holdings);
    const lose = ctx.positions.find((p) => p.symbol === 'LOSE');
    expect(harvestableLoss(lose, 'FIFO')).toEqual({ lossILS: 750, units: 50 });
    // HIFO/specific sells only the loss lot - the same here, by coincidence of order
    expect(harvestableLoss(lose, 'HIFO')).toEqual({ lossILS: 750, units: 50 });
    // Reverse the lot order: under FIFO the gain lot comes first and eats the loss
    const flipped = { ...lose, lots: lose.lots.map((l) => ({ ...l, purchaseDate: l.id === 2 ? '2025-06-01' : '2024-01-01' })) };
    expect(harvestableLoss(flipped, 'FIFO')).toEqual({ lossILS: 500, units: 100 });
    expect(harvestableLoss(flipped, 'HIFO').lossILS).toBe(750);
  });

  test('needs gains to offset: realized this year, or open gains in Q4', () => {
    expect(taxLossHarvestRule.evaluate(makeCtx({ prefs: { tlhMinLossILS: 100 } }, holdings))).toEqual([]); // June, nothing realized
    const q4 = makeCtx({ today: '2026-11-20', prefs: { tlhMinLossILS: 100 } }, holdings);
    const [rec] = taxLossHarvestRule.evaluate(q4);
    expect(rec).toMatchObject({ action: 'HARVEST', symbol: 'LOSE', units: 50 });
    expect(rec.estTaxSavedILS).toBeCloseTo(750 * 0.25, 6);
    expect(rec.rationale).toMatch(/דומה אך לא זהה/);
  });

  test('the minimum loss threshold applies', () => {
    const q4 = makeCtx({ today: '2026-11-20' }, holdings); // default ₪1,000
    expect(taxLossHarvestRule.evaluate(q4)).toEqual([]);
  });

  test('US wash-sale: a recent purchase blocks the harvest for a US taxpayer', () => {
    const us = {
      americanStocks: [
        { id: 1, stockName: 'XYZ', purchaseDate: '2025-01-01', purchasePrice: 100, quantity: 10, exchangeRate: 4, currentExchangeRate: 4, currentPrice: 50 },
        { id: 2, stockName: 'XYZ', purchaseDate: '2026-11-10', purchasePrice: 50, quantity: 1, exchangeRate: 4, currentExchangeRate: 4, currentPrice: 50 }
      ],
      israeliStocks: [winner]
    };
    const ctx = makeCtx({ today: '2026-11-20', prefs: { usTaxResident: true } }, us);
    const xyz = ctx.positions.find((p) => p.symbol === 'XYZ');
    expect(washSaleCheck(xyz, [], '2026-11-20')).toMatchObject({ conflict: true, recentBuyDates: ['2026-11-10'], clearFrom: '2026-12-11' });
    const [rec] = taxLossHarvestRule.evaluate(ctx);
    expect(rec.blocked).toEqual({ reason: 'WASH_SALE', until: '2026-12-11' });
    expect(rec.severity).toBe('low');
    // Not a US taxpayer: not blocked
    const il = makeCtx({ today: '2026-11-20' }, us);
    expect(taxLossHarvestRule.evaluate(il)[0].blocked).toBeNull();
  });
});

test('cash drag deploys excess cash into the most underweight category', () => {
  const holdings = { israeliStocks: [winner], bankBalances: [{ id: 9, amount: 7000 }] };
  const ctx = makeCtx({ targets: { israeli: 60, american: 0, pension: 0, cashFunds: 0, bank: 40, bankSavings: 0 } }, holdings);
  const [rec] = cashDragRule.evaluate(ctx);
  expect(rec).toMatchObject({ action: 'DEPLOY', category: 'israeli' });
  expect(rec.amountILS).toBeCloseTo(3000, 6);
});

test('realGainOfSale follows the lot method', () => {
  const ctx = makeCtx({}, { israeliStocks: [loserOld, loserNew] });
  const lose = ctx.positions[0];
  expect(realGainOfSale(lose, 50, 'FIFO', '2026-06-15')).toBeCloseTo(-750, 6);
  expect(realGainOfSale(lose, 50, 'LIFO', '2026-06-15')).toBeCloseTo(250, 6);
});

test('the engine ranks, filters small trades and respects enabled rules', () => {
  const holdings = { israeliStocks: [winner, loserOld, loserNew], bankBalances: [bank] };
  const ctx = makeCtx({ today: '2026-12-10', prefs: { tlhMinLossILS: 100 } }, holdings);
  const recs = runRecommendationEngine(ctx);
  // Both high severity in December; the larger trade (₪1,875 trim vs a
  // ₪1,250 harvest saving ₪187.5) ranks first.
  expect(recs.map((r) => [r.symbol, r.action])).toEqual([
    ['WIN', 'TRIM'],
    ['LOSE', 'HARVEST']
  ]);
  const onlyDrift = runRecommendationEngine({ ...ctx, prefs: { ...ctx.prefs, enabledRules: ['drift'] } });
  expect(onlyDrift).toEqual([]);
  const bigMin = runRecommendationEngine({ ...ctx, prefs: { ...ctx.prefs, minTradeILS: 100000 } });
  expect(bigMin).toEqual([]);
  expect(DEFAULT_RECOMMENDATION_PREFS.lotMethod).toBe('FIFO');
});
