// The portfolio review: "a mentor going over your month". Given everything
// the app knows about the portfolio, it scores the month in each category,
// combines the categories into one overall score, follows that score back
// over the previous months, and words the result (portfolioReviewText.js).
//
// Pure and deterministic - the same data and the same `today` always give
// the same review - so it is tested directly and can be recomputed for any
// month the user picks. No external service is called; the facts come
// from the holdings, the ledger, and the historical closes the page has
// already fetched.
//
// The text is a separate layer on top of the numbers on purpose: a later
// AI phrasing layer would replace buildReviewText and nothing else.
import { realizedLots } from '../shared/transactionLedger';
import { computeRealizedGains } from './realizedGains';
import { computeTaxLossHarvestingOpportunities } from './taxLossHarvesting';
import { computeHistoricalPortfolioSeries, isLotHeldOn } from './historicalPortfolioValue';
import { buildSeriesFromHistoricalValues, computeStatsFromSeries } from './portfolioStats';
import {
  allocationOn,
  buildMonthFacts,
  buildReviewContext,
  daysBetween,
  hasLedgerTrades,
  monthKeyOf,
  monthRange,
  shiftMonth
} from './portfolioReviewData';
import {
  combineCategoryScores,
  detectBiases,
  drawdownStats,
  scoreActivity,
  scoreBenchmark,
  scoreCash,
  scoreComparison,
  scoreCosts,
  scoreDecisions,
  scoreDiscipline,
  scoreDiversification,
  scoreDividends,
  scoreGoal,
  scoreRiskAdjusted,
  scoreSuccess,
  scoreTax,
  scoreVolume
} from './portfolioReviewScoring';
import { CATEGORY_ORDER, HISTORY_MONTHS, RISK_FREE_RATE_ANNUAL_PCT, TAX_CONFIG, THRESHOLDS } from './portfolioReviewConfig';
import { buildReviewText } from './portfolioReviewText';
import { toNum } from './formatters';

const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

// Cost and value of each security held on `date`, for the decision
// quality fallback (open positions, when there are too few closed trades).
function openPositionsOn(ctx, allocation, date) {
  return ctx.lotGroups
    .map((g) => {
      const item = allocation.items.find((i) => i.id === g.id);
      if (!item) return null;
      const cost = g.lots
        .filter((lot) => isLotHeldOn(lot, date))
        .reduce((s, lot) => s + toNum(lot.purchasePrice) * toNum(lot.quantity) * (g.market === 'american' ? toNum(lot.exchangeRate) || 0 : 1), 0);
      return cost > 0 ? { id: g.id, label: item.label, cost, value: item.value, gain: item.value - cost } : null;
    })
    .filter(Boolean);
}

// Volatility, drawdown and annualized return over the trailing year (or
// since inception, if shorter), from the cash-flow-neutral weekly curve.
function riskStatsFor(ctx, end) {
  const minDays = THRESHOLDS.riskAdjusted.minMonthsForScore * 30;
  if (!ctx.hasPriceData && (ctx.expanded.israeliStocks.length || ctx.expanded.americanStocks.length)) {
    return { enough: false, reason: 'נתוני המחירים ההיסטוריים עדיין לא נטענו' };
  }
  const yearAgo = addDays(end, -365);
  const from = ctx.inception > yearAgo ? ctx.inception : yearAgo;
  if (daysBetween(from, end) < minDays) {
    return { enough: false, reason: `נדרשים לפחות ${THRESHOLDS.riskAdjusted.minMonthsForScore} חודשים של היסטוריה` };
  }
  const raw = computeHistoricalPortfolioSeries(from, end, ctx.expanded, ctx.priceData, { anchorLedgerAccountsToFirstRecord: true });
  const series = buildSeriesFromHistoricalValues(raw);
  if (series.length < 8) return { enough: false, reason: 'אין מספיק נקודות מחיר לחישוב תנודתיות' };
  const stats = computeStatsFromSeries(series, ctx.returnFlows);
  const dd = drawdownStats(stats.twrIndexSeries);
  return {
    enough: true,
    from: series[0].date,
    to: series[series.length - 1].date,
    volatilityPct: stats.volatilityPercent,
    annualReturnPct: stats.annualizedReturnPercent,
    totalReturnPct: stats.totalReturnPercent,
    ...dd
  };
}

// Scores one month. `facts` is the per-month cache; `allocations` caches
// allocationOn by date.
function evaluateMonth(monthKey, state, { forHistory = false } = {}) {
  const { ctx, facts, allocationAt, options } = state;
  const current = facts.get(monthKey);
  const history = [];
  for (let i = HISTORY_MONTHS; i >= 1; i--) {
    const key = shiftMonth(monthKey, -i);
    if (facts.has(key)) history.push(facts.get(key));
  }
  const end = current.end;
  const allocation = allocationAt(end);
  const previousAllocations = history.slice(-6).map((m) => allocationAt(m.end));
  const windowMonths = [...history.slice(-11), current];
  const txUpToEnd = ctx.transactions.filter((tx) => tx && tx.date <= end);
  const realizedRows = realizedLots(txUpToEnd);
  const isCurrentMonth = monthKey === monthKeyOf(ctx.today);
  const year = monthKey.slice(0, 4);
  const realized = computeRealizedGains(txUpToEnd, { indexByMonth: (options.cpi && options.cpi.indexByMonth) || {}, taxRate: TAX_CONFIG.capitalGainsRate });
  const harvest =
    isCurrentMonth && options.cpi
      ? computeTaxLossHarvestingOpportunities(ctx.holdings.israeliStocks, ctx.holdings.americanStocks, ctx.holdings.pensionFunds, options.cpi, ctx.holdings.bankSavingsFunds)
      : null;
  const biasFrom = addDays(`${shiftMonth(monthKey, -(THRESHOLDS.decisions.biasLookbackMonths - 1))}-01`, -1);
  const biases = detectBiases({ ctx, realizedRows, from: biasFrom, to: end });

  const categories = [
    scoreVolume({ current, history }),
    scoreComparison({ current, history }),
    scoreSuccess({ current }),
    scoreDiversification({ allocation }),
    scoreDiscipline({ current, history }),
    scoreRiskAdjusted({ riskStats: riskStatsFor(ctx, end), riskFreePct: RISK_FREE_RATE_ANNUAL_PCT }),
    scoreDecisions({ realizedRows, openPositions: openPositionsOn(ctx, allocation, end), biases }),
    scoreActivity({ ctx, windowMonths, end }),
    scoreCosts({ ctx, windowMonths, end, hasLedger: hasLedgerTrades(txUpToEnd) }),
    scoreTax({ realizedYear: realized.byYear[year], harvest, taxRate: TAX_CONFIG.capitalGainsRate, year }),
    scoreBenchmark({
      ctx,
      benchmark: options.benchmark,
      benchmarkPoints: options.benchmarkPoints,
      actualValue: allocation.unpriced.length ? NaN : allocation.securitiesTotal,
      end
    }),
    scoreCash({ allocation, previousAllocations }),
    scoreGoal({ goal: options.goal, currentValue: allocation.unpriced.length ? NaN : allocation.total, history, current, end }),
    scoreDividends({ ctx, end, windowMonths, projectedAnnualILS: isCurrentMonth ? options.projectedAnnualDividendsILS : null })
  ].sort((a, b) => CATEGORY_ORDER.indexOf(a.key) - CATEGORY_ORDER.indexOf(b.key));

  const overall = combineCategoryScores(categories);
  const result = {
    month: monthKey,
    isPartial: current.isPartial,
    facts: current,
    history,
    allocation,
    score: overall.score,
    rating: overall.rating,
    countedCount: overall.countedCount,
    categories: overall.categories
  };
  if (forHistory) return { month: monthKey, score: overall.score, isPartial: current.isPartial };
  return result;
}

// The direction of the overall score: least-squares slope per month.
export function scoreTrend(points) {
  const valid = points.map((p, i) => ({ x: i, y: p.score })).filter((p) => Number.isFinite(p.y));
  if (valid.length < 3) return { direction: null, slope: null };
  const n = valid.length;
  const mx = valid.reduce((s, p) => s + p.x, 0) / n;
  const my = valid.reduce((s, p) => s + p.y, 0) / n;
  const den = valid.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  const slope = den ? valid.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / den : 0;
  const line = THRESHOLDS.comparison.trendSlopePerMonth;
  return { slope, direction: slope >= line ? 'improving' : slope <= -line ? 'eroding' : 'stable' };
}

// The months the picker offers: inception to today.
export function reviewMonths(ctx) {
  if (!ctx.inception) return [];
  return monthRange(monthKeyOf(ctx.inception), monthKeyOf(ctx.today));
}

// Entry point.
//
// input: { holdings, transactions, priceData, sectorBySymbol, today,
//          liveTotalValueILS, cpi, goal, benchmark, benchmarkPoints (ILS),
//          projectedAnnualDividendsILS }
// month: 'YYYY-MM' to review; defaults to the current month.
export function buildPortfolioReview(input, { month = null, withHistory = true } = {}) {
  const today = input.today;
  const ctx = buildReviewContext({ ...input, today });
  const months = reviewMonths(ctx);
  const base = { today, months, priceDataLoaded: ctx.hasPriceData };
  if (!months.length) return { ...base, empty: true };

  const selected = month && months.includes(month) ? month : months[months.length - 1];
  const facts = new Map();
  months.filter((m) => m <= selected).forEach((m) => facts.set(m, buildMonthFacts(m, ctx)));
  const allocationCache = new Map();
  const allocationAt = (date) => {
    if (!allocationCache.has(date)) allocationCache.set(date, allocationOn(date, { ...ctx, today }));
    return allocationCache.get(date);
  };
  const state = { ctx, facts, allocationAt, options: input };

  const review = evaluateMonth(selected, state);
  const historyPoints = withHistory
    ? months
        .filter((m) => m <= selected)
        .slice(-HISTORY_MONTHS)
        .map((m) => (m === selected ? { month: m, score: review.score, isPartial: review.isPartial } : evaluateMonth(m, state, { forHistory: true })))
    : [];
  const trend = scoreTrend(historyPoints.filter((p) => !p.isPartial));
  const full = { ...base, empty: false, selectedMonth: selected, ...review, scoreHistory: historyPoints, trend, monthsOfHistory: facts.size };
  return { ...full, text: buildReviewText(full) };
}
