// Price multiples - P/E, P/S, P/FCF - today, over the last five years, and
// against the company's peers.
//
//   P/E   = market cap / net income
//   P/S   = market cap / revenue
//   P/FCF = market cap / (operating cash flow - capital expenditure)
//
// A multiple whose denominator is zero or negative is "N/M" (not
// meaningful) and is left out of every average rather than counted as a
// huge or negative number.
//
// HISTORY
// Sampled at every month-end of the last five years, not once a year: a
// year-end-only sample makes the average hostage to one day's price. At
// each month-end the multiple uses the latest fiscal year whose results
// had been published by then (period end + 60 days), i.e. what an investor
// could actually have known.
//
// SPLITS
// Prices are split-adjusted to today's share basis. Reported share counts
// may or may not be - so each fiscal year's count is multiplied by every
// split after its period end, UNLESS the counts already show the split
// (the later count is within 25% of ratio x the earlier one, which means
// the data was restated). Market cap is then consistent across the series.
//
// Median over mean for the peer benchmark: a mean is dominated by the one
// peer with near-zero earnings.
//
// CommonJS without spread/class syntax - see transactionLedger.js for why.

const METRICS = ['PE', 'PS', 'PFCF'];
const PUBLICATION_LAG_DAYS = 60;
const DAY_MS = 86400000;

const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

// Share of samples at or below `value`, 0..100.
function percentileOf(samples, value) {
  if (!samples.length || value === null || !Number.isFinite(value)) return null;
  const below = samples.filter((s) => s <= value).length;
  return (below / samples.length) * 100;
}

const fcfOf = (y) => (Number.isFinite(y.operatingCashFlow) && Number.isFinite(y.capex) ? y.operatingCashFlow - Math.abs(y.capex) : Number.isFinite(y.freeCashFlow) ? y.freeCashFlow : null);

function denominators(fundamentals) {
  return {
    PE: fundamentals.netIncome,
    PS: fundamentals.revenue,
    PFCF: fcfOf(fundamentals)
  };
}

function multipleFromCap(marketCap, denom) {
  if (!Number.isFinite(marketCap) || !Number.isFinite(denom) || denom <= 0) return null;
  return marketCap / denom;
}

// annual: [{ periodEnd, revenue, netIncome, operatingCashFlow, capex, dilutedShares }]
// splits: [{ date, ratio }]  (ratio 4 = 4-for-1)
// Returns a copy of `annual` with `sharesAdjusted` on today's share basis.
function adjustSharesForSplits(annual, splits) {
  const sorted = (annual || []).slice().sort((a, b) => (a.periodEnd < b.periodEnd ? -1 : 1));
  return sorted.map((year, i) => {
    let shares = year.dilutedShares;
    if (!Number.isFinite(shares) || shares <= 0) return Object.assign({}, year, { sharesAdjusted: null });
    (splits || [])
      .filter((s) => s.date > year.periodEnd && s.ratio > 0 && s.ratio !== 1)
      .forEach((split) => {
        // Is this split already reflected in the counts? Compare with the
        // first later year whose period ends after the split.
        const after = sorted.slice(i + 1).find((y) => y.periodEnd >= split.date && Number.isFinite(y.dilutedShares));
        const restated = after ? Math.abs(after.dilutedShares / (year.dilutedShares * split.ratio) - 1) > 0.25 : false;
        if (!restated) shares *= split.ratio;
      });
    return Object.assign({}, year, { sharesAdjusted: shares });
  });
}

// monthlyCloses: [{ date, close }] split-adjusted, ascending.
// Returns { PE: [values], PS: [...], PFCF: [...], samples: [{date, PE, PS, PFCF}] }
function historicalMultiples({ annual, splits = [], monthlyCloses, fromDate }) {
  const years = adjustSharesForSplits(annual, splits);
  const out = { PE: [], PS: [], PFCF: [], samples: [], totalMonths: 0 };
  (monthlyCloses || []).forEach((point) => {
    if (fromDate && point.date < fromDate) return;
    if (!Number.isFinite(point.close) || point.close <= 0) return;
    out.totalMonths += 1;
    const known = years.filter((y) => addDays(y.periodEnd, PUBLICATION_LAG_DAYS) <= point.date);
    const fy = known[known.length - 1];
    if (!fy || !fy.sharesAdjusted) return;
    const cap = point.close * fy.sharesAdjusted;
    const d = denominators(fy);
    const sample = { date: point.date, fiscalYearEnd: fy.periodEnd };
    METRICS.forEach((m) => {
      const v = multipleFromCap(cap, d[m]);
      sample[m] = v;
      if (v !== null) out[m].push(v);
    });
    out.samples.push(sample);
  });
  return out;
}

// current: { marketCap, ttm: { revenue, netIncome, operatingCashFlow, capex, freeCashFlow } }
// peers: [{ symbol, PE, PS, PFCF }]
// current.fallback: { PE, PS, PFCF } quoted by the data provider, used when
// the statements needed to compute a multiple are unavailable.
function buildMultiplesTable({ current, history, peers = [], peerSource = 'yahoo-peers' }) {
  const d = denominators((current && current.ttm) || {});
  const fallback = (current && current.fallback) || {};
  return METRICS.map((metric) => {
    const values = history ? history[metric] : [];
    const computed = multipleFromCap(current && current.marketCap, d[metric]);
    const now = computed !== null ? computed : Number.isFinite(fallback[metric]) && fallback[metric] > 0 ? fallback[metric] : null;
    const peerValues = (peers || []).map((p) => p[metric]).filter((v) => Number.isFinite(v) && v > 0);
    const avg5y = mean(values);
    const sectorMedian = peerValues.length ? median(peerValues) : null;
    return {
      metric,
      current: now,
      avg5y,
      median5y: median(values),
      min5y: values.length ? Math.min.apply(null, values) : null,
      max5y: values.length ? Math.max.apply(null, values) : null,
      percentile5y: now === null ? null : percentileOf(values, now),
      samples: values.length,
      totalMonths: history ? history.totalMonths : 0,
      sectorMedian,
      peerCount: peerValues.length,
      peerSource,
      vsHistoryPct: now !== null && avg5y ? (now / avg5y - 1) * 100 : null,
      vsSectorPct: now !== null && sectorMedian ? (now / sectorMedian - 1) * 100 : null
    };
  });
}

// Trailing twelve months from the last four quarters (flows summed).
function trailingTwelveMonths(quarters) {
  const q = (quarters || []).slice().sort((a, b) => (a.periodEnd < b.periodEnd ? -1 : 1)).slice(-4);
  if (q.length < 4) return null;
  const sum = (key) => (q.every((x) => Number.isFinite(x[key])) ? q.reduce((s, x) => s + x[key], 0) : null);
  return {
    periodEnd: q[3].periodEnd,
    revenue: sum('revenue'),
    netIncome: sum('netIncome'),
    operatingCashFlow: sum('operatingCashFlow'),
    capex: sum('capex'),
    freeCashFlow: sum('freeCashFlow')
  };
}

exports.METRICS = METRICS;
exports.median = median;
exports.percentileOf = percentileOf;
exports.fcfOf = fcfOf;
exports.adjustSharesForSplits = adjustSharesForSplits;
exports.historicalMultiples = historicalMultiples;
exports.buildMultiplesTable = buildMultiplesTable;
exports.trailingTwelveMonths = trailingTwelveMonths;
