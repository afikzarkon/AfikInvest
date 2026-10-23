// Historical portfolio performance: the equity curve, the return since
// inception, and annualized volatility.
//
// WHERE THE NUMBERS COME FROM (this changed)
// ------------------------------------------
// These used to be computed from saved daily value snapshots - rows the app
// wrote whenever the user happened to open it. That made every figure here
// a function of *usage*, not of the market: a user who opened the app twice
// in March and once in July got a three-point "performance over time", and
// "return since inception" measured from whenever they first logged in
// rather than from when they actually started investing.
//
// Performance is now computed on the fly from real historical closing
// prices (TASE + Yahoo, plus the USD/ILS history for the American side -
// see utils/historicalPortfolioValue.js and server/historicalPricesRoutes.js),
// valuing the holdings the portfolio actually contained on each date. So:
//
//   * the curve starts at the earliest purchase date in the portfolio, not
//     at the first snapshot;
//   * it has a point for every sampled date in that whole span, whether or
//     not the app was open that day;
//   * nothing has to be saved in advance for it to work, and correcting a
//     purchase date or quantity corrects the whole history immediately.
//
// buildEquitySeries below still normalizes the saved-snapshot shape, since
// snapshots remain the source for the monthly checkpoint comparison; it's
// just no longer where performance comes from.
//
// WHAT THE SERIES COVERS is decided before it reaches this module. Every
// function here is scope-agnostic: give it a series and the flows that
// belong to that series, and it returns that selection's return. The
// selection itself is made in utils/portfolioSegments.js, which defaults to
// equities only and can narrow further to a single market.
//
// The pairing matters and is the caller's responsibility: a series covering
// only Israeli equities must be given only Israeli flows. Feeding it the
// whole portfolio's contributions would net American purchases out of
// Israeli sub-periods, which is not a smaller error than including the
// holdings themselves - it is a stranger one, since the money would be
// subtracted from a portfolio it never entered.

import { calculateModifiedDietzReturn } from './modifiedDietz';
import { cashFlowsInPeriod } from './portfolioCashFlows';

// Normalizes raw snapshot rows (as returned by GET /api/portfolio-snapshots)
// into a clean, sorted {date, value}[] series.
export const buildEquitySeries = (snapshots) => {
  if (!Array.isArray(snapshots)) return [];
  return snapshots
    .filter((s) => s && s.date && Number.isFinite(Number(s.totalValueILS)))
    .map((s) => ({ date: s.date, value: Number(s.totalValueILS) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
};

// Normalizes the dynamic historical-value series (utils/historicalPortfolioValue.js
// returns {date, valueILS, isPartial}) into the same {date, value}[] shape.
//
// PARTIAL POINTS ARE DROPPED, not plotted.
//
// A point is partial when some holding could not be priced on that date, so
// its value is the sum of the REST of the portfolio - a different portfolio
// from the one every other point measures. Plotted as if it were a
// valuation it reads as a crash and a recovery that never happened: in a
// portfolio holding a ₪5,000 position with no price history, a series
// running 8,000 -> 4,500 -> 6,000 reported -25% for holdings that had
// actually gained 100%. It also wrecks volatility, which is the standard
// deviation of exactly those invented swings.
//
// Dropping the date is the honest alternative: the curve says nothing about
// a day it cannot value, instead of saying something false. The dropped
// dates are not hidden - the caller is told how many there were and which
// holdings caused them, so "we could not price X" is reported as the data
// gap it is (see computeStatsFromSeries's skippedPartialPoints).
export const buildSeriesFromHistoricalValues = (historicalSeries) => {
  if (!Array.isArray(historicalSeries)) return [];
  return historicalSeries
    .filter((p) => p && p.date && !p.isPartial && Number.isFinite(p.valueILS) && p.valueILS > 0)
    .map((p) => ({ date: p.date, value: p.valueILS }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
};

// The dates buildSeriesFromHistoricalValues had to skip, and the holdings
// responsible - so the UI can name what is missing rather than leaving a
// silent gap in the curve.
export const summarizePartialPoints = (historicalSeries) => {
  const partial = (Array.isArray(historicalSeries) ? historicalSeries : []).filter((p) => p && p.isPartial);
  const symbols = new Set();
  partial.forEach((p) => (p.missingSymbols || []).forEach((sym) => symbols.add(sym)));
  return { count: partial.length, symbols: [...symbols].sort() };
};

const MS_PER_DAY = 1000 * 60 * 60 * 24;

const daysBetween = (d1, d2) => {
  const a = new Date(d1);
  const b = new Date(d2);
  const days = (b - a) / MS_PER_DAY;
  return days > 0 ? days : 0.5; // guard against same-day duplicates / clock skew
};

// Returns between consecutive points, each tagged with the number of
// calendar days that elapsed.
export const computePeriodReturns = (series) => {
  const returns = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1];
    const curr = series[i];
    if (prev.value > 0) {
      returns.push({
        date: curr.date,
        periodReturn: curr.value / prev.value - 1,
        days: daysBetween(prev.date, curr.date)
      });
    }
  }
  return returns;
};

// Puts unevenly-spaced period returns on one footing for their spread:
// each log return divided by the square root of its length in days, so
// z = ln(1 + r) / sqrt(days) has the variance of ONE day's return whatever
// the period's length (variance grows with time, the standard deviation
// with its square root). Returns their mean/stdev (sample stdev, n-1).
//
// It used to compound each return down to a daily-equivalent,
// (1 + r)^(1/days) - 1. That divides a return - and so its spread - by the
// number of days, while annualizing multiplies back only by a square root:
// weekly points came out sqrt(7) too calm, and with sqrt(252) on calendar
// days lower still - a weekly spread of 2% read as 4.5% a year instead of
// about 14.4%.
const perDayReturnStats = (returns) => {
  const scaled = returns.filter((r) => r.days > 0 && r.periodReturn > -1).map((r) => Math.log(1 + r.periodReturn) / Math.sqrt(r.days));
  if (!scaled.length) return { mean: null, stdev: null };
  const mean = scaled.reduce((s, v) => s + v, 0) / scaled.length;
  const variance = scaled.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / Math.max(scaled.length - 1, 1);
  return { mean, stdev: Math.sqrt(variance) };
};

// The periods' lengths are calendar days (a Friday-to-Monday step is 3),
// so a per-day spread is annualized by the calendar year.
export const CALENDAR_DAYS_PER_YEAR = 365;

// Annualized volatility (%): the annualized standard deviation of the
// portfolio's returns - perDayReturnStats' stdev x sqrt(365).
//
// AUDIT NOTE. Correct *provided the inputs are real price-driven returns
// sampled on a consistent basis* - and that proviso was what was wrong
// before as well.
//
// The old inputs were saved app-open snapshots: irregular (a 1-day gap next
// to a 40-day gap), sparse, and clustered around whenever the user happened
// to visit. Compounding a 40-day return down to a daily-equivalent
// *smooths away* the volatility that actually occurred inside it, so the
// resulting number was systematically understated, and unstable from one
// user session to the next for reasons that had nothing to do with the
// market.
//
// Fed from the dynamic historical-close series instead, the sampling is
// regular and market-driven, which is what makes the scaling correct
// rather than an approximation layered on an approximation. The
// residual smoothing from sampling weekly rather than daily is real and
// unavoidable (it's what bounds the number of lookups a multi-year chart
// does), which is why the figure stays labelled an estimate.
export const computeVolatilityPercent = (returns) => {
  if (returns.length < 2) return null;
  const { stdev } = perDayReturnStats(returns);
  if (!Number.isFinite(stdev)) return null;
  return stdev * Math.sqrt(CALENDAR_DAYS_PER_YEAR) * 100;
};

export const computeBestWorstPeriod = (returns) => {
  if (!returns.length) return { best: null, worst: null };
  const sorted = [...returns].sort((a, b) => a.periodReturn - b.periodReturn);
  return { worst: sorted[0], best: sorted[sorted.length - 1] };
};

// TIME-WEIGHTED RETURN - the return since inception, with deposits,
// withdrawals and new purchases neutralized.
//
// The naive first-to-last figure (computeTotalReturnPercent below) answers
// "how much bigger is the portfolio now", which is NOT a return: a
// portfolio that went from 100k to 150k purely because 50k was paid into
// it grew 0%, but reads as +50%. Any figure presented as performance has
// to exclude money crossing the portfolio boundary and reflect only what
// the assets themselves did.
//
// Method: split the series at its sampled points, compute each sub-period's
// return with Modified Dietz over the flows that landed inside it (so a
// flow gets credit/blame in proportion to how long it was actually
// invested within that sub-period), then CHAIN them geometrically:
//
//   TWR = [ (1+r1) x (1+r2) x ... x (1+rn) ] - 1
//
// Chaining is what makes it time-weighted: each sub-period is weighted by
// nothing but its own performance, so the size and timing of contributions
// cannot influence the result - which is the property that makes it the
// industry-standard way to measure an investment's performance rather than
// an investor's funding schedule (GIPS).
//
// Because the series is sampled rather than valued on every flow date,
// each sub-period is a Modified Dietz approximation rather than an exact
// daily valuation. With ~weekly sampling a flow is mis-weighted by at most
// a few days inside one sub-period, and never leaks into any other.
//
// A sub-period is skipped (treated as flat, contributing a factor of 1)
// when it has no usable base to divide by - a portfolio that was empty at
// the start of a period has no return for it, only an opening balance.
// One sub-period's growth factor (1 + r), or null when the step has no
// measurable return. Shared by the chained total below and by the indexed
// curve the benchmark is drawn against, so the headline percentage and the
// line on the chart can never come from two different calculations.
const subPeriodGrowthFactor = (prev, curr, cashFlows) => {
  // No opening value: the portfolio started this sub-period empty (or the
  // point is unusable). Whatever it holds at the end arrived as
  // contributions, not as growth.
  if (!(prev.value > 0)) return null;

  const { percent } = calculateModifiedDietzReturn({
    beginningValue: prev.value,
    endingValue: curr.value,
    cashFlows: cashFlowsInPeriod(cashFlows, prev.date, curr.date),
    periodStart: prev.date,
    periodEnd: curr.date
  });

  // Modified Dietz's denominator (beginning value + weighted flows) can
  // reach zero or go negative if a withdrawal empties the portfolio
  // mid-period; there is no meaningful return for such a step.
  if (percent === null || !Number.isFinite(percent)) return null;

  // A factor of 0 or less would mean the portfolio lost its entire value in
  // one step, which would zero the whole chain irrecoverably. Real
  // total-loss steps are indistinguishable here from a data gap, so the
  // step is skipped rather than allowed to swallow the series.
  const factor = 1 + percent / 100;
  return factor > 0 ? factor : null;
};

export const computeTimeWeightedReturnPercent = (series, cashFlows = []) => {
  if (!Array.isArray(series) || series.length < 2) return null;

  let growthFactor = 1;
  let measuredAnySubPeriod = false;

  for (let i = 1; i < series.length; i++) {
    const factor = subPeriodGrowthFactor(series[i - 1], series[i], cashFlows);
    if (factor === null) continue;
    growthFactor *= factor;
    measuredAnySubPeriod = true;
  }

  if (!measuredAnySubPeriod) return null;
  return (growthFactor - 1) * 100;
};

// The same chained time-weighted growth, kept as a curve instead of
// collapsed to one percentage: every point carries what ₪100 invested at
// the first date would be worth by then, with contributions neutralized.
//
// This is what a benchmark has to be compared against. A raw value series
// cannot be: paying ₪50,000 into a portfolio lifts its value line by
// ₪50,000, and against an index that only ever moves on market returns that
// deposit reads as spectacular outperformance. Indexing the raw values to
// 100 does not help - it rescales the deposit, it does not remove it.
export const buildTwrIndexSeries = (series, cashFlows = []) => {
  if (!Array.isArray(series) || series.length === 0) return [];

  let growthFactor = 1;
  return series.map((point, i) => {
    if (i > 0) {
      const factor = subPeriodGrowthFactor(series[i - 1], point, cashFlows);
      // A skipped step carries the previous level forward rather than
      // breaking the line - the same "contributes a factor of 1" rule the
      // chained total uses.
      if (factor !== null) growthFactor *= factor;
    }
    return { date: point.date, value: growthFactor * 100 };
  });
};

// Total return across the whole series, and the same figure annualized
// (CAGR) so a 5-year and a 6-month portfolio can be compared. Both null
// when there isn't enough of a series to divide by.
export const computeTotalReturnPercent = (series) => {
  if (series.length < 2 || !(series[0].value > 0)) return null;
  return (series[series.length - 1].value / series[0].value - 1) * 100;
};

// Annualizes a total-return percentage over the span the series covers.
// Takes the percentage rather than re-deriving it from the endpoints, so it
// annualizes the SAME cash-flow-neutralized figure the UI displays instead
// of silently annualizing the naive one.
export const annualizeReturnPercent = (series, totalReturnPercent) => {
  if (!Array.isArray(series) || series.length < 2) return null;
  if (totalReturnPercent === null || !Number.isFinite(totalReturnPercent)) return null;
  const years = daysBetween(series[0].date, series[series.length - 1].date) / 365;
  if (years <= 0) return null;
  // Under ~a month, annualizing extrapolates noise into a headline figure
  // (a 2% week becomes "180% a year"), so it's withheld rather than shown.
  if (years < 1 / 12) return null;
  const growth = 1 + totalReturnPercent / 100;
  if (growth <= 0) return null;
  return (Math.pow(growth, 1 / years) - 1) * 100;
};

export const computeAnnualizedReturnPercent = (series) =>
  annualizeReturnPercent(series, computeTotalReturnPercent(series));

// Below this many points, volatility is too noisy to show.
const MIN_POINTS_FOR_RISK_STATS = 5;

// series: {date, value}[] - from buildSeriesFromHistoricalValues (the
// dynamic performance curve) or buildEquitySeries (saved snapshots).
// cashFlows: [{date, amount}] external flows to neutralize (see
// portfolioCashFlows.js). Omit them and the return figures fall back to the
// naive value change, which is only correct for a portfolio that was never
// paid into or out of.
export const computeStatsFromSeries = (series, cashFlows = []) => {
  const points = Array.isArray(series) ? series : [];
  const returns = computePeriodReturns(points);
  const hasEnoughForRiskStats = points.length >= MIN_POINTS_FOR_RISK_STATS;
  const { best, worst } = computeBestWorstPeriod(returns);

  // The headline "return since inception". Time-weighted, so contributions
  // and withdrawals are excluded and only the assets' own market
  // performance is left. Falls back to the naive change only when there
  // isn't a single measurable sub-period (e.g. a portfolio funded entirely
  // at the last point), where the two are the same figure anyway.
  const naiveReturnPercent = computeTotalReturnPercent(points);
  const timeWeightedReturnPercent = computeTimeWeightedReturnPercent(points, cashFlows);
  const totalReturnPercent =
    timeWeightedReturnPercent !== null ? timeWeightedReturnPercent : naiveReturnPercent;

  const firstDate = points.length ? points[0].date : null;
  const lastDate = points.length ? points[points.length - 1].date : null;

  // ONLY the flows that fall inside the series' own span.
  //
  // The return figures were already range-correct - they are chained from
  // sub-periods, and a sub-period only ever sees the flows dated inside it -
  // but this total was summed over every flow the portfolio has ever had.
  // Narrowing the chart to 2021-2024 therefore still reported deposits made
  // in 2018 as "money that entered during the period", under a return that
  // had (correctly) ignored them. The two read as a contradiction, and the
  // deposit figure was simply wrong for the window on screen.
  //
  // A flow dated exactly on the first point counts: that point's value is
  // the portfolio as constituted that day, opening purchase included, so the
  // money did enter within the window. Only what predates the window is cut.
  const flowsInRange = firstDate
    ? (cashFlows || []).filter((flow) => flow.date >= firstDate && flow.date <= lastDate)
    : [];
  const netCashFlow = flowsInRange.reduce((sum, flow) => sum + (flow.amount || 0), 0);

  return {
    series: points,
    // The same curve, restated as cash-flow-neutralized growth from a base
    // of 100 - what the benchmark comparison is drawn against.
    twrIndexSeries: buildTwrIndexSeries(points, cashFlows),
    hasHistory: points.length >= 2,
    hasEnoughForRiskStats,
    snapshotsCount: points.length,
    firstDate,
    lastDate,
    totalReturnPercent,
    // Kept separate and exposed deliberately: the difference between the
    // two is the whole point, and showing the neutralized figure without
    // being able to explain what it excluded would be worse than showing
    // neither.
    timeWeightedReturnPercent,
    naiveReturnPercent,
    netCashFlow,
    isCashFlowNeutralized: timeWeightedReturnPercent !== null,
    annualizedReturnPercent: annualizeReturnPercent(points, totalReturnPercent),
    volatilityPercent: hasEnoughForRiskStats ? computeVolatilityPercent(returns) : null,
    bestPeriod: best,
    worstPeriod: worst
  };
};

// Back-compatible entry point for the saved-snapshot series (still used for
// the monthly checkpoint side of the app).
export const computePortfolioStats = (snapshots, cashFlows = []) =>
  computeStatsFromSeries(buildEquitySeries(snapshots), cashFlows);
