// Exact time-weighted return and money-weighted return (XIRR).
//
// WHY BOTH
//   TWR answers "how good were the investments?" - every deposit, purchase,
//   sale and withdrawal is neutralized, so it is what a benchmark is
//   compared against.
//   MWR answers "how did MY money do, timing included?" - money added just
//   before a fall counts against it, money added before a rise for it.
//   A TWR well above the MWR means the timing of the contributions cost
//   money; the reverse means it helped.
//
// EXACT TWR vs the existing one
//   portfolioStats.js chains Modified Dietz sub-periods between SAMPLED
//   valuation dates (weekly), which approximates where inside each week a
//   flow landed. The exact form breaks the chain AT every flow date instead,
//   using a real valuation just before and just after the flow, so no flow
//   is ever weighted by approximation:
//
//     TWR = prod_i ( V_before(d_i) / V_after(d_(i-1)) ) - 1
//
//   With daily closing prices, a flow on day d is treated as happening at
//   the close: V_before(d) prices the holdings as they stood at the end of
//   the previous day at d's close; V_after(d) prices them after the day's
//   purchases (at cost, the day-0 anchor of historicalPortfolioValue.js) and
//   sales. One known simplification: the difference between a sale's fill
//   price and that day's close is not attributed to either sub-period.
//
// An ES module used by the React app only (it builds on historicalPortfolioValue.js).

import { computePortfolioValueAtDate } from './historicalPortfolioValue';

// ---------------------------------------------------------------------------
// Exact TWR

// The holdings as they stood before the flows dated `date`: lots bought on
// that day are removed, and closed slices sold that day are still held.
export const holdingsBeforeFlowsOn = (holdings, date) => {
  const adjust = (lots) =>
    (lots || [])
      .filter((lot) => !(lot.purchaseDate && lot.purchaseDate === date))
      .map((lot) => (lot.soldDate && lot.soldDate === date ? { ...lot, soldDate: null } : lot));
  return {
    ...holdings,
    israeliStocks: adjust(holdings.israeliStocks),
    americanStocks: adjust(holdings.americanStocks)
  };
};

// Pure chain over explicit valuations. points: [{ date, before, after }]
// ascending, where `after` is the value once that date's flows happened.
// Sub-periods whose opening value is not positive (an empty portfolio) are
// skipped - they have no return, only funding.
export const chainExactTwr = (points) => {
  if (!Array.isArray(points) || points.length < 2) return null;
  let growth = 1;
  let measured = false;
  for (let i = 1; i < points.length; i += 1) {
    const start = points[i - 1].after;
    const end = points[i].before;
    if (!(start > 0) || !Number.isFinite(end)) continue;
    growth *= end / start;
    measured = true;
  }
  return measured ? growth - 1 : null;
};

// Exact TWR over [fromDate, toDate] for the given holdings (already
// expanded with closed slices), price data and cash flows. Returns
// { percent, subPeriods, isPartial, missingSymbols } - percent null when
// nothing could be measured. A valuation that could not be completed
// (missing price) makes the whole result partial rather than silently wrong.
export const computeExactTwr = ({ fromDate, toDate, holdings, priceData, cashFlows = [], options = {} }) => {
  if (!fromDate || !toDate || fromDate > toDate) return { percent: null, subPeriods: 0, isPartial: false, missingSymbols: [] };
  const flowDates = [...new Set((cashFlows || []).map((f) => f.date).filter((d) => d > fromDate && d <= toDate))].sort();
  const dates = [fromDate, ...flowDates.filter((d) => d !== toDate), toDate];

  const missing = new Set();
  let isPartial = false;
  const valueAt = (date, h) => {
    const v = computePortfolioValueAtDate(date, h, priceData, options);
    if (v.isPartial) {
      isPartial = true;
      (v.missingSymbols || []).forEach((s) => missing.add(s));
    }
    return v.valueILS;
  };

  const points = dates.map((date, i) => {
    const after = valueAt(date, holdings);
    const hasFlow = flowDates.includes(date);
    const before = i === 0 ? after : hasFlow ? valueAt(date, holdingsBeforeFlowsOn(holdings, date)) : after;
    return { date, before, after };
  });

  const r = chainExactTwr(points);
  return {
    percent: r === null ? null : r * 100,
    subPeriods: points.length - 1,
    isPartial,
    missingSymbols: [...missing].sort()
  };
};

// ---------------------------------------------------------------------------
// MWR / XIRR

const DAY_MS = 86400000;
const yearFrac = (t0, t) => (t - t0) / DAY_MS / 365;

const xnpv = (rate, flows) => {
  const t0 = flows[0].t;
  return flows.reduce((s, f) => s + f.amount / (1 + rate) ** yearFrac(t0, f.t), 0);
};

const dxnpv = (rate, flows) => {
  const t0 = flows[0].t;
  return flows.reduce((s, f) => {
    const y = yearFrac(t0, f.t);
    return s - (y * f.amount) / (1 + rate) ** (y + 1);
  }, 0);
};

// Annual internal rate of return of dated flows (Actual/365, like Excel's
// XIRR). Investor perspective: money paid in is NEGATIVE, money taken out
// (and the final value) POSITIVE. Newton-Raphson from `guess`, bisection on
// [-99.99%, +1000%] if Newton fails. Null when every flow has the same sign
// or no root is bracketed.
export const xirr = (cashFlows, guess = 0.1) => {
  const flows = (cashFlows || [])
    .map((f) => ({ t: Date.parse(`${String(f.date).slice(0, 10)}T00:00:00Z`), amount: Number(f.amount) }))
    .filter((f) => Number.isFinite(f.t) && Number.isFinite(f.amount) && f.amount !== 0)
    .sort((a, b) => a.t - b.t);
  if (!flows.some((f) => f.amount > 0) || !flows.some((f) => f.amount < 0)) return null;

  let r = guess;
  for (let i = 0; i < 50; i += 1) {
    const f = xnpv(r, flows);
    const df = dxnpv(r, flows);
    if (Math.abs(f) < 1e-7) return r;
    if (!Number.isFinite(df) || df === 0) break;
    const next = r - f / df;
    if (!Number.isFinite(next) || next <= -0.9999) break;
    if (Math.abs(next - r) < 1e-10) return next;
    r = next;
  }

  let lo = -0.9999;
  let hi = 10;
  let fLo = xnpv(lo, flows);
  if (fLo * xnpv(hi, flows) > 0) return null;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    const fMid = xnpv(mid, flows);
    if (Math.abs(fMid) < 1e-7 || hi - lo < 1e-10) return mid;
    if (fLo * fMid < 0) {
      hi = mid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return (lo + hi) / 2;
};

// Money-weighted return of a portfolio over a window.
// flows: the portfolio's own flows (+ money in, - money out) as
// portfolioCashFlows.js produces them. The opening value counts as money put
// in at the start, the closing value as money taken out at the end.
//
// Returns { annualPercent, periodPercent, days } - periodPercent is the
// annual rate compounded over the window's own length, which is what a
// window shorter than a year should show (annualizing three weeks of
// return turns noise into a headline).
export const computeMoneyWeightedReturn = ({ fromDate, toDate, startValue = 0, endValue, cashFlows = [] }) => {
  if (!fromDate || !toDate || !(fromDate < toDate) || !Number.isFinite(endValue)) {
    return { annualPercent: null, periodPercent: null, days: 0 };
  }
  const series = [];
  if (startValue > 0) series.push({ date: fromDate, amount: -startValue });
  (cashFlows || [])
    .filter((f) => f.date > fromDate && f.date <= toDate)
    .forEach((f) => series.push({ date: f.date, amount: -f.amount }));
  series.push({ date: toDate, amount: endValue });
  const r = xirr(series);
  const days = Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / DAY_MS);
  if (r === null) return { annualPercent: null, periodPercent: null, days };
  return {
    annualPercent: r * 100,
    periodPercent: ((1 + r) ** (days / 365) - 1) * 100,
    days
  };
};
