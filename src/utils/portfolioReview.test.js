import { buildPortfolioReview, scoreTrend } from './portfolioReview';
import { buildSamplePortfolio } from './samplePortfolio';
import {
  coefficientOfVariation,
  combineCategoryScores,
  detectBiases,
  drawdownStats,
  investmentStreak,
  scoreFromPoints,
  scoreGoal,
  scoreTax,
  scoreVolume,
  simulateBenchmark
} from './portfolioReviewScoring';
import { buildMonthFacts, buildReviewContext, monthRange, shiftMonth } from './portfolioReviewData';
import { CATEGORY_WEIGHTS } from './portfolioReviewConfig';
import { setAmountsHidden } from './formatters';
import { applyTransaction, normalizeTransaction } from '../shared/transactionLedger';

const TODAY = '2026-10-21';

// A daily close series from `from` to `to`, moving linearly between the
// given anchors ({ 'YYYY-MM-DD': close }).
function closes(from, to, anchors) {
  const keys = Object.keys(anchors).sort();
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400000) {
    const date = new Date(t).toISOString().slice(0, 10);
    let close;
    if (date <= keys[0]) close = anchors[keys[0]];
    else if (date >= keys[keys.length - 1]) close = anchors[keys[keys.length - 1]];
    else {
      const i = keys.findIndex((k) => k >= date);
      const a = keys[i - 1];
      const b = keys[i];
      const f = (Date.parse(date) - Date.parse(a)) / (Date.parse(b) - Date.parse(a));
      close = anchors[a] + (anchors[b] - anchors[a]) * f;
    }
    out.push({ date, close });
  }
  return out;
}

const usLot = (id, symbol, purchaseDate, price, qty, fx = 3.7, current = price) => ({
  id,
  stockName: symbol,
  purchaseDate,
  purchasePrice: price,
  quantity: qty,
  exchangeRate: fx,
  currentExchangeRate: fx,
  currentPrice: current
});

const ilLot = (id, symbol, name, purchaseDate, price, qty, current = price, extra = {}) => ({
  id,
  stockName: symbol,
  officialName: name,
  purchaseDate,
  purchasePrice: price,
  quantity: qty,
  currentPrice: current,
  securityType: 'מניות',
  branch: 'בנקים',
  ...extra
});

// Monthly purchases of an S&P fund and a single stock, Jan-Oct 2026.
function steadyInvestor() {
  const americanStocks = [];
  let id = 1;
  monthRange('2026-01', '2026-10').forEach((m) => {
    americanStocks.push(usLot(id++, 'VOO', `${m}-05`, 500, 2, 3.7, 560));
  });
  americanStocks.push(usLot(id++, 'AAPL', '2026-01-05', 200, 5, 3.7, 240));
  const priceData = {
    taseHistoricalCloses: {},
    yahooHistoricalCloses: {
      VOO: closes('2025-11-01', TODAY, { '2025-11-01': 480, '2026-01-05': 500, '2026-06-01': 540, '2026-10-21': 560 }),
      AAPL: closes('2025-11-01', TODAY, { '2025-11-01': 190, '2026-01-05': 200, '2026-10-21': 240 })
    },
    fxHistoricalCloses: closes('2025-11-01', TODAY, { '2025-11-01': 3.7 })
  };
  return {
    holdings: { israeliStocks: [], americanStocks, pensionFunds: [], cashFunds: [], bankBalances: [], bankSavingsFunds: [] },
    transactions: [],
    priceData,
    sectorBySymbol: { AAPL: { sector: 'Technology' } },
    today: TODAY
  };
}

describe('scoreFromPoints', () => {
  const points = [[0, 10], [0.5, 55], [1, 100]];
  it('interpolates between points and clamps beyond the ends', () => {
    expect(scoreFromPoints(-1, points)).toBe(10);
    expect(scoreFromPoints(0.25, points)).toBe(33);
    expect(scoreFromPoints(0.75, points)).toBe(78);
    expect(scoreFromPoints(5, points)).toBe(100);
  });
  it('maps Infinity to the top and NaN to null', () => {
    expect(scoreFromPoints(Infinity, points)).toBe(100);
    expect(scoreFromPoints(NaN, points)).toBeNull();
  });
});

describe('combineCategoryScores', () => {
  const cat = (key, score, status = 'scored') => ({ key, score, status, weight: CATEGORY_WEIGHTS[key] });

  it('rescales the weights of the scored categories to 100%', () => {
    const { score, categories } = combineCategoryScores([cat('volume', 100), cat('diversification', 50), cat('cash', 80), cat('goal', null, 'noGoal')]);
    const w = CATEGORY_WEIGHTS;
    const expected = Math.round((100 * w.volume + 50 * w.diversification + 80 * w.cash) / (w.volume + w.diversification + w.cash));
    expect(score).toBe(expected);
    const shares = categories.reduce((s, c) => s + c.effectiveWeight, 0);
    expect(shares).toBeCloseTo(1, 10);
    expect(categories.find((c) => c.key === 'goal').effectiveWeight).toBe(0);
  });

  it('withholds the overall score when too few categories have data', () => {
    const result = combineCategoryScores([cat('volume', 90), cat('cash', 90), cat('tax', null, 'noData')]);
    expect(result.score).toBeNull();
    expect(result.rating).toBeNull();
  });

  it('never counts an information-only category', () => {
    const result = combineCategoryScores([cat('volume', 90), cat('cash', 90), cat('success', 90), { key: 'dividends', score: 0, status: 'info', weight: 0 }]);
    expect(result.score).toBe(90);
  });
});

describe('small helpers', () => {
  it('coefficient of variation is null for no money and 0 for equal amounts', () => {
    expect(coefficientOfVariation([0, 0, 0])).toBeNull();
    expect(coefficientOfVariation([100, 100, 100])).toBe(0);
    expect(coefficientOfVariation([0, 0, 300])).toBeCloseTo(Math.SQRT2, 5);
  });

  it('streak counts back and ignores a running month with nothing yet', () => {
    const m = (invested, isPartial = false) => ({ invested, isPartial });
    expect(investmentStreak([m(1), m(0), m(1), m(1), m(0, true)])).toBe(2);
    expect(investmentStreak([m(1), m(1), m(5, true)])).toBe(3);
    expect(investmentStreak([m(1), m(0)])).toBe(0);
    expect(investmentStreak([])).toBe(0);
  });

  it('drawdown finds the deepest fall and the recovery', () => {
    const series = [
      { date: '2026-01-01', indexed: 100 },
      { date: '2026-02-01', indexed: 120 },
      { date: '2026-03-01', indexed: 90 },
      { date: '2026-04-01', indexed: 125 }
    ];
    const dd = drawdownStats(series);
    expect(dd.maxDrawdownPct).toBeCloseTo(25, 5);
    expect(dd.peakDate).toBe('2026-02-01');
    expect(dd.troughDate).toBe('2026-03-01');
    expect(dd.recovered).toBe(true);
    expect(dd.recoveryDays).toBe(31);
    expect(drawdownStats(series.slice(0, 3)).recovered).toBe(false);
  });

  it('trend reads the slope of the score', () => {
    expect(scoreTrend([{ score: 50 }, { score: 55 }, { score: 60 }]).direction).toBe('improving');
    expect(scoreTrend([{ score: 60 }, { score: 60 }, { score: 61 }]).direction).toBe('stable');
    expect(scoreTrend([{ score: 70 }, { score: 60 }, { score: 50 }]).direction).toBe('eroding');
    expect(scoreTrend([{ score: 70 }, { score: null }]).direction).toBeNull();
  });
});

describe('benchmark simulation', () => {
  const index = [
    { date: '2026-01-01', close: 100 },
    { date: '2026-06-01', close: 120 },
    { date: '2026-10-01', close: 110 }
  ];
  it('buys units with each purchase and sells them with each sale', () => {
    const sim = simulateBenchmark([{ date: '2026-01-01', amount: 1000 }, { date: '2026-06-01', amount: -600 }], index, '2026-10-20');
    // 10 units, then 5 sold at 120 -> 5 units x 110
    expect(sim.value).toBeCloseTo(550, 6);
    expect(sim.netInvested).toBe(400);
  });
  it('gives nothing without index data or flows', () => {
    expect(simulateBenchmark([{ date: '2026-01-01', amount: 1 }], [], '2026-10-01')).toBeNull();
    expect(simulateBenchmark([], index, '2026-10-01')).toBeNull();
    // all flows predate the index
    expect(simulateBenchmark([{ date: '2025-01-01', amount: 100 }], index, '2026-10-01')).toBeNull();
  });
});

describe('volume category', () => {
  const month = (invested, extra = {}) => ({ invested, net: invested, sold: 0, withdrawn: 0, parked: 0, isPartial: false, topStock: null, destinations: {}, ...extra });

  it('compares with the 3- and 6-month averages', () => {
    const history = [month(1000), month(1000), month(1000), month(5000), month(5000), month(5000)];
    const result = scoreVolume({ current: month(4200), history });
    expect(result.metrics.avg3).toBe(5000);
    expect(result.metrics.avg6).toBe(3000);
    expect(result.metrics.vsAvg3Pct).toBeCloseTo(-16, 6);
    expect(result.status).toBe('scored');
  });

  it('does not penalize a running month that is below the average so far', () => {
    const result = scoreVolume({ current: month(0, { isPartial: true }), history: [month(1000), month(1000), month(1000)] });
    const c = result.components.find((x) => x.key === 'amountVsAvg');
    expect(c.available).toBe(false);
    expect(result.partial).toBe(true);
  });

  it('has nothing to say when no money was ever invested (no division by zero)', () => {
    const result = scoreVolume({ current: month(0), history: [month(0), month(0)] });
    expect(result.status).toBe('noData');
    expect(result.score).toBeNull();
    expect(result.metrics.vsAvg3Pct).toBeNull();
  });

  it('flags a month far above the average as a spike', () => {
    const result = scoreVolume({ current: month(10000), history: [month(1000), month(1000), month(1000)] });
    expect(result.metrics.spike).toBe(true);
  });
});

describe('goal and tax', () => {
  const months = (amounts) => amounts.map((net) => ({ net, invested: net, isPartial: false }));

  it('goal: required monthly amount without assuming any return', () => {
    const g = scoreGoal({ goal: { targetAmount: 120000, targetDate: '2027-10-01' }, currentValue: 60000, history: months([5000, 5000, 5000, 5000, 5000]), current: { net: 5000, isPartial: false }, end: '2026-10-21' });
    expect(g.metrics.monthsLeft).toBe(12);
    expect(g.metrics.requiredMonthly).toBe(5000);
    expect(g.metrics.onTrack).toBe(true);
    expect(g.score).toBe(100);
  });

  it('goal: no goal is excluded, not scored zero', () => {
    const g = scoreGoal({ goal: null, currentValue: 1, history: [], current: { net: 0 }, end: TODAY });
    expect(g.status).toBe('noGoal');
    expect(g.score).toBeNull();
  });

  it('goal: an achieved goal scores full', () => {
    const g = scoreGoal({ goal: { targetAmount: 1000, targetDate: '2030-01-01' }, currentValue: 5000, history: [], current: { net: 0 }, end: TODAY });
    expect(g.metrics.achieved).toBe(true);
    expect(g.score).toBe(100);
  });

  it('tax: unused open losses lower the score and name the avoidable tax', () => {
    const t = scoreTax({ realizedYear: { count: 2, netRealGainILS: 10000, estimatedTaxILS: 2500, realGainsILS: 10000, realLossesILS: 0 }, harvest: { totalHarvestableLoss: 4000 }, taxRate: 0.25, year: '2026' });
    expect(t.metrics.avoidableTax).toBe(1000);
    expect(t.status).toBe('scored');
    expect(t.score).toBeLessThan(100);
  });

  it('tax: no sales this year means no data, not a perfect score', () => {
    const t = scoreTax({ realizedYear: undefined, harvest: null, taxRate: 0.25, year: '2026' });
    expect(t.status).toBe('noData');
  });
});

describe('behavioural biases', () => {
  it('finds a purchase after a sharp rise, with its date', () => {
    const holdings = { americanStocks: [usLot(1, 'XYZ', '2026-05-02', 130, 10)] };
    const priceData = { yahooHistoricalCloses: { XYZ: closes('2026-03-01', '2026-06-01', { '2026-03-01': 100, '2026-04-01': 100, '2026-05-01': 130 }) }, fxHistoricalCloses: closes('2026-03-01', '2026-06-01', { '2026-03-01': 3.7 }) };
    const ctx = buildReviewContext({ holdings, priceData, today: TODAY });
    const biases = detectBiases({ ctx, realizedRows: [], from: '2026-01-01', to: '2026-06-01' });
    expect(biases.chasing).toHaveLength(1);
    expect(biases.chasing[0].date).toBe('2026-05-02');
    expect(biases.chasing[0].changePct).toBeGreaterThan(15);
  });

  it('finds a sale at a loss after a sharp fall', () => {
    const holdings = { americanStocks: [] };
    const priceData = { yahooHistoricalCloses: { XYZ: closes('2026-03-01', '2026-06-01', { '2026-03-01': 100, '2026-04-01': 100, '2026-04-30': 70 }) }, fxHistoricalCloses: [] };
    const ctx = buildReviewContext({ holdings, priceData, today: TODAY });
    const realizedRows = [{ txId: 't1', saleDate: '2026-05-01', symbol: 'XYZ', assetClass: 'american', nominalGainILS: -1000, costILS: 3700, holdingDays: 200 }];
    const biases = detectBiases({ ctx, realizedRows, from: '2026-01-01', to: '2026-06-01' });
    expect(biases.panic).toHaveLength(1);
    expect(biases.panic[0].date).toBe('2026-05-01');
  });
});

describe('month facts', () => {
  it('counts purchases and provident deposits as invested, cash deposits as parked', () => {
    const holdings = {
      israeliStocks: [ilLot(1, '604611', 'לאומי', '2026-09-10', 40, 100)],
      americanStocks: [usLot(2, 'MSFT', '2026-09-15', 400, 2, 3.7)],
      pensionFunds: [{ id: 3, fundName: 'גמל', deposits: [{ date: '2026-09-01', amount: 1000 }], currentValue: 1000, currentValueDate: '2026-09-01' }],
      cashFunds: [{ id: 4, fundName: 'כספית', deposits: [{ date: '2026-09-02', amount: 5000 }], currentValue: 5000, currentValueDate: '2026-09-02' }]
    };
    const ctx = buildReviewContext({ holdings, today: TODAY });
    const f = buildMonthFacts('2026-09', ctx);
    expect(f.invested).toBeCloseTo(4000 + 2960 + 1000, 6);
    expect(f.parked).toBe(5000);
    expect(f.buys).toBe(2);
    expect(f.isPartial).toBe(false);
    const accounts = f.destinations.byAccount.map((d) => d.key);
    expect(accounts).toEqual(['israeli', 'american', 'pension']);
    expect(f.destinations.byCurrency.find((d) => d.key === 'USD').amount).toBeCloseTo(2960, 6);
  });

  it('counts a partly-sold lot as one purchase, at its full cost', () => {
    let portfolio = { israeliStocks: [], americanStocks: [] };
    const txs = [];
    const record = (input, id) => {
      const tx = { ...normalizeTransaction(input, { today: TODAY }), id };
      const applied = applyTransaction(portfolio, tx, { newLotId: id === 'b' ? 501 : undefined });
      portfolio = applied.portfolio;
      txs.push(applied.transaction);
    };
    record({ type: 'BUY', date: '2026-02-10', assetClass: 'american', assetId: 'NVDA', units: 30, price: 100, fees: 0, fxRate: 4 }, 'b');
    record({ type: 'SELL', date: '2026-04-01', assetClass: 'american', assetId: 'NVDA', units: 10, price: 120, fees: 2, fxRate: 4 }, 's');
    const ctx = buildReviewContext({ holdings: portfolio, transactions: txs, today: TODAY });
    const buys = ctx.events.filter((e) => e.kind === 'buy');
    expect(buys).toHaveLength(1);
    expect(buys[0].amountILS).toBeCloseTo(12000, 6);
    const fees = ctx.events.filter((e) => e.kind === 'fee');
    expect(fees[0].amountILS).toBe(8);
    expect(buildMonthFacts('2026-04', ctx).sold).toBeCloseTo((1200 - 2) * 4, 6);
  });

  it('records the conversion cost of a trade with the rate actually paid', () => {
    const tx = { ...normalizeTransaction({ type: 'BUY', date: '2026-02-10', assetClass: 'american', assetId: 'NVDA', units: 10, price: 100, fees: 0, fxRate: 3.7, fxPaidRate: 3.75 }, { today: TODAY }), id: 'b' };
    const applied = applyTransaction({ israeliStocks: [], americanStocks: [] }, tx, { newLotId: 7 });
    const ctx = buildReviewContext({ holdings: applied.portfolio, transactions: [applied.transaction], today: TODAY });
    const fx = ctx.events.filter((e) => e.kind === 'fxCost');
    expect(fx).toHaveLength(1);
    expect(fx[0].amountILS).toBeCloseTo(50, 6);
  });

  it('marks the running month as partial and ends it today', () => {
    const ctx = buildReviewContext({ holdings: { americanStocks: [usLot(1, 'VOO', '2026-10-05', 500, 1)] }, today: TODAY });
    const f = buildMonthFacts('2026-10', ctx);
    expect(f.isPartial).toBe(true);
    expect(f.end).toBe(TODAY);
    expect(f.elapsedFraction).toBeGreaterThan(0.6);
    expect(f.elapsedFraction).toBeLessThan(0.7);
  });

  it('has no return when prices are missing, rather than a wrong one', () => {
    const ctx = buildReviewContext({ holdings: { americanStocks: [usLot(1, 'VOO', '2026-08-05', 500, 1)] }, today: TODAY });
    const f = buildMonthFacts('2026-09', ctx);
    expect(f.valuePartial).toBe(true);
    expect(f.returnPct).toBeNull();
    expect(f.positions[0].missing).toBe(true);
  });

  it('takes a finished month-end the closes cannot value from a daily snapshot near it', () => {
    const holdings = { americanStocks: [usLot(1, 'VOO', '2026-08-05', 500, 1)] };
    const valueSnapshots = [
      { date: '2026-08-31', totalValueILS: 1900 },
      { date: '2026-09-29', totalValueILS: 2000 },
      { date: '2026-09-20', totalValueILS: 1500 }
    ];
    const f = buildMonthFacts('2026-09', buildReviewContext({ holdings, valueSnapshots, today: TODAY }));
    expect(f.valuePartial).toBe(false);
    expect(f.endValue).toBe(2000);
    expect(f.endValueFromSnapshot).toBe('2026-09-29');
    expect(f.returnPct).toBeCloseTo((2000 / 1900 - 1) * 100, 6);
    // Nothing within 3 days of the month-end: still unknown.
    const none = buildMonthFacts('2026-09', buildReviewContext({ holdings, valueSnapshots: [{ date: '2026-09-20', totalValueILS: 1500 }], today: TODAY }));
    expect(none.valuePartial).toBe(true);
  });
});

describe('buildPortfolioReview', () => {
  afterEach(() => setAmountsHidden(false));

  it('says the portfolio is empty instead of scoring it', () => {
    const review = buildPortfolioReview({ holdings: {}, transactions: [], priceData: {}, today: TODAY });
    expect(review.empty).toBe(true);
    expect(review.score).toBeUndefined();
  });

  it('a brand-new user with one month: no comparison, no discipline, a partial month', () => {
    const review = buildPortfolioReview({
      holdings: { americanStocks: [usLot(1, 'VOO', '2026-10-05', 500, 2, 3.7, 510)] },
      transactions: [],
      priceData: { yahooHistoricalCloses: { VOO: closes('2026-09-01', TODAY, { '2026-09-01': 500, '2026-10-21': 510 }) }, fxHistoricalCloses: closes('2026-09-01', TODAY, { '2026-09-01': 3.7 }) },
      today: TODAY
    });
    const byKey = Object.fromEntries(review.categories.map((c) => [c.key, c]));
    expect(review.months).toEqual(['2026-10']);
    expect(review.isPartial).toBe(true);
    expect(byKey.comparison.status).toBe('noData');
    expect(byKey.discipline.status).toBe('noData');
    expect(byKey.riskAdjusted.status).toBe('noData');
    expect(review.text.profile.key).toBe('beginner');
    review.categories.forEach((c) => {
      if (c.score !== null) {
        expect(c.score).toBeGreaterThanOrEqual(0);
        expect(c.score).toBeLessThanOrEqual(100);
      }
    });
  });

  it('a steady monthly investor: streak, regular habit, comparison and history', () => {
    const review = buildPortfolioReview(steadyInvestor(), { month: '2026-09' });
    const byKey = Object.fromEntries(review.categories.map((c) => [c.key, c]));
    expect(review.selectedMonth).toBe('2026-09');
    expect(review.isPartial).toBe(false);
    expect(byKey.discipline.metrics.streak).toBe(9);
    expect(byKey.discipline.score).toBe(100);
    expect(byKey.volume.metrics.invested).toBeCloseTo(3700, 6);
    expect(byKey.volume.metrics.avg3).toBeCloseTo(3700, 6);
    expect(byKey.comparison.status).toBe('scored');
    expect(Number.isFinite(byKey.success.metrics.returnPct)).toBe(true);
    expect(byKey.riskAdjusted.status).toBe('scored');
    expect(byKey.costs.status).toBe('noData'); // no ledger trades -> fees unknown
    expect(byKey.tax.status).toBe('noData');
    expect(review.score).not.toBeNull();
    expect(review.score).toBeGreaterThanOrEqual(0);
    expect(review.score).toBeLessThanOrEqual(100);
    expect(review.scoreHistory.length).toBe(9);
    expect(review.text.badges.map((b) => b.key)).toContain('streak');
    expect(review.text.good.some((n) => n.text.includes('ברציפות'))).toBe(true);
  });

  it('measures against the index when one is given', () => {
    const input = steadyInvestor();
    const review = buildPortfolioReview(
      { ...input, benchmark: { key: 'sp500', label: 'S&P 500' }, benchmarkPoints: closes('2025-12-01', TODAY, { '2025-12-01': 5000, '2026-10-21': 5000 }) },
      { month: '2026-09' }
    );
    const bm = review.categories.find((c) => c.key === 'benchmark');
    expect(bm.status).toBe('scored');
    // a flat index: the same money is worth exactly what was put in
    expect(bm.metrics.benchmarkValue).toBeCloseTo(bm.metrics.netInvested, 4);
    expect(bm.metrics.excessPct).toBeGreaterThan(0);
  });

  it('without index data, the comparison says so instead of inventing one', () => {
    const review = buildPortfolioReview({ ...steadyInvestor(), benchmark: { key: 'sp500', label: 'S&P 500' }, benchmarkPoints: [] });
    const bm = review.categories.find((c) => c.key === 'benchmark');
    expect(bm.status).toBe('noData');
    expect(bm.reason).toContain('S&P 500');
  });

  it('with no price history at all, price-based figures stay empty', () => {
    const input = { ...steadyInvestor(), priceData: {} };
    const review = buildPortfolioReview(input, { month: '2026-09' });
    const byKey = Object.fromEntries(review.categories.map((c) => [c.key, c]));
    expect(review.priceDataLoaded).toBe(false);
    expect(byKey.success.metrics.returnPct).toBeNull();
    expect(byKey.riskAdjusted.status).toBe('noData');
  });

  it('a goal off pace becomes the one thing to improve', () => {
    const review = buildPortfolioReview({ ...steadyInvestor(), goal: { targetAmount: 1000000, targetDate: '2027-06-01' } }, { month: '2026-09' });
    const goal = review.categories.find((c) => c.key === 'goal');
    expect(goal.status).toBe('scored');
    expect(goal.metrics.onTrack).toBe(false);
    expect(review.text.oneThing.category).toBe('goal');
  });

  it('flags a single stock that dominates the portfolio', () => {
    const review = buildPortfolioReview({
      holdings: { americanStocks: [usLot(1, 'NVDA', '2026-03-05', 100, 100, 3.7, 150), usLot(2, 'VOO', '2026-03-05', 500, 1, 3.7, 500)] },
      priceData: {},
      sectorBySymbol: { NVDA: { sector: 'Technology' } },
      today: TODAY
    });
    const div = review.categories.find((c) => c.key === 'diversification');
    expect(div.alerts.some((a) => a.key === 'largestPosition')).toBe(true);
    expect(review.text.attention.some((n) => n.text.includes('NVDA'))).toBe(true);
  });

  it('works on the demo portfolio end to end, for every month', () => {
    const sample = buildSamplePortfolio(new Date(`${TODAY}T12:00:00Z`));
    const first = buildPortfolioReview({ holdings: sample, transactions: [], priceData: {}, today: TODAY });
    expect(first.months[0]).toBe('2023-01');
    ['2023-01', '2024-09', shiftMonth('2026-10', -1)].forEach((m) => {
      const review = buildPortfolioReview({ holdings: sample, transactions: [], priceData: {}, today: TODAY }, { month: m });
      expect(review.selectedMonth).toBe(m);
      expect(review.text.summaries.volume).toBeTruthy();
    });
  });

  it('masks amounts in the text while privacy mode is on', () => {
    setAmountsHidden(true);
    const review = buildPortfolioReview(steadyInvestor(), { month: '2026-09' });
    const all = [...review.text.good, ...review.text.attention, ...review.text.thoughts].map((n) => n.text).join(' ');
    expect(all).toContain('••••');
    expect(all).not.toMatch(/3,700/);
  });

  it('never mentions the old product name', () => {
    const review = buildPortfolioReview(steadyInvestor());
    // Assembled so the name itself never appears in the source either.
    const oldName = new RegExp(['stock', 'view'].join(''), 'i');
    expect(JSON.stringify(review.text)).not.toMatch(oldName);
  });
});
