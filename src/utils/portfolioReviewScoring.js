// The review's categories: each one turns the month's facts
// (portfolioReviewData.js) into a 0-100 score, the figures behind it, and
// the components the score was averaged from.
//
// A category is a set of COMPONENTS. Each component is one measurable
// question ("how big was this month against the average?") with its own
// metric, its own score and, when it cannot be answered, its own reason.
// The category's score is the average of the components that could be
// answered; when none could, the category says "not enough data" and is
// left out of the overall score instead of scoring a guess. That is the
// whole "don't show a misleading score" rule, applied in one place.
//
// Every threshold comes from portfolioReviewConfig.js.
import { CATEGORY_LABELS_HE, CATEGORY_WEIGHTS, MIN_CATEGORIES_FOR_OVERALL, RATING_BANDS, THRESHOLDS } from './portfolioReviewConfig';
import { ETF_SECTOR_KEY, UNCLASSIFIED_SECTOR_KEY } from './sectorLabels';
import { closeOnOrBefore, isLotHeldOn } from './historicalPortfolioValue';
import { daysBetween, monthKeyOf, shiftMonth } from './portfolioReviewData';
import { toNum } from './formatters';

// ---------------------------------------------------------------------------
// Building blocks

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Piecewise-linear: [[x0, s0], [x1, s1], ...] sorted by x.
export function scoreFromPoints(value, points) {
  if (!Number.isFinite(value)) return value === Infinity ? Math.round(points[points.length - 1][1]) : null;
  if (value <= points[0][0]) return Math.round(points[0][1]);
  for (let i = 1; i < points.length; i++) {
    const [x1, s1] = points[i];
    const [x0, s0] = points[i - 1];
    if (value <= x1) return Math.round(s0 + ((value - x0) / (x1 - x0)) * (s1 - s0));
  }
  return Math.round(points[points.length - 1][1]);
}

const mean = (list) => (list.length ? list.reduce((s, v) => s + v, 0) / list.length : null);

const stdev = (list) => {
  const m = mean(list);
  if (m === null || list.length < 2) return null;
  return Math.sqrt(list.reduce((s, v) => s + (v - m) ** 2, 0) / list.length);
};

export const safeRatio = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : null);

// A component that was measured.
const scored = (key, label, value, score, unit) => ({ key, label, value, unit, score, available: score !== null && score !== undefined });
// A component that could not be.
const skipped = (key, label, reason) => ({ key, label, value: null, score: null, available: false, reason });

// Folds components into the category result.
export function finishCategory(key, { components = [], metrics = {}, reason = null, status = null, partial = false, alerts = [] }) {
  const available = components.filter((c) => c.available);
  const score = available.length ? Math.round(mean(available.map((c) => c.score))) : null;
  let finalStatus = status;
  if (!finalStatus) finalStatus = score === null ? 'noData' : 'scored';
  return {
    key,
    label: CATEGORY_LABELS_HE[key],
    weight: CATEGORY_WEIGHTS[key] || 0,
    status: finalStatus,
    score: finalStatus === 'scored' ? score : null,
    reason: finalStatus === 'scored' ? null : reason || (components.find((c) => c.reason) || {}).reason || null,
    components,
    metrics,
    partial,
    alerts
  };
}

export function ratingLabel(score) {
  if (score === null || score === undefined) return null;
  return RATING_BANDS.find((band) => score >= band.min).label;
}

// The overall score: a weighted average of the scored categories, their
// weights rescaled to sum to 100% (so a category without data neither
// counts as zero nor shrinks the scale).
export function combineCategoryScores(categories, { minCategories = MIN_CATEGORIES_FOR_OVERALL } = {}) {
  const counted = categories.filter((c) => c.status === 'scored' && c.weight > 0);
  const totalWeight = counted.reduce((s, c) => s + c.weight, 0);
  const withShares = categories.map((c) => ({
    ...c,
    effectiveWeight: c.status === 'scored' && c.weight > 0 && totalWeight > 0 ? c.weight / totalWeight : 0
  }));
  if (counted.length < minCategories || totalWeight === 0) {
    return { score: null, rating: null, categories: withShares, countedCount: counted.length };
  }
  const score = Math.round(withShares.reduce((s, c) => s + (c.score || 0) * c.effectiveWeight, 0));
  return { score, rating: ratingLabel(score), categories: withShares, countedCount: counted.length };
}

// ---------------------------------------------------------------------------
// Shared helpers over the month list

// Previous months (complete by definition), most recent last.
const lastN = (history, n) => history.slice(Math.max(0, history.length - n));

const investedOf = (months) => months.map((m) => m.invested);

// The coefficient of variation of the monthly amounts: 0 = the same amount
// every month, 1 = as spread as the amounts themselves.
export function coefficientOfVariation(amounts) {
  const m = mean(amounts);
  if (!m || m <= 0) return null;
  return stdev(amounts) / m;
}

// ---------------------------------------------------------------------------
// 1. Investment volume this month

export function scoreVolume({ current, history }) {
  const t = THRESHOLDS.volume;
  const prev3 = lastN(history, 3);
  const prev6 = lastN(history, 6);
  const avg3 = prev3.length ? mean(investedOf(prev3)) : null;
  const avg6 = prev6.length ? mean(investedOf(prev6)) : null;
  const ratio3 = avg3 > 0 ? current.invested / avg3 : avg3 === 0 && current.invested > 0 ? Infinity : null;
  const ratio6 = avg6 > 0 ? current.invested / avg6 : null;
  const components = [];

  if (!prev3.length) {
    components.push(skipped('amountVsAvg', 'הסכום מול הממוצע שלך', 'אין עדיין חודשים קודמים להשוואה'));
  } else if (ratio3 === null) {
    components.push(skipped('amountVsAvg', 'הסכום מול הממוצע שלך', 'לא הושקע כסף ב-3 החודשים הקודמים ולא החודש'));
  } else if (current.isPartial && ratio3 < 1) {
    // A running month below the average says nothing yet: most people
    // invest once a month, on a date that may still be ahead.
    components.push(skipped('amountVsAvg', 'הסכום מול הממוצע שלך', 'החודש עדיין לא הסתיים'));
  } else {
    components.push(scored('amountVsAvg', 'הסכום מול הממוצע שלך ב-3 חודשים', ratio3, scoreFromPoints(ratio3, t.amountVsAvgPoints), 'ratio'));
  }

  if (current.invested > 0) {
    const share = current.topStock ? current.topStock.shareOfMonth : 0;
    components.push(scored('singleStockShare', 'החלק שהלך למניה בודדת אחת', share * 100, scoreFromPoints(share, t.singleStockSharePoints), 'pct'));
  } else {
    components.push(skipped('singleStockShare', 'החלק שהלך למניה בודדת אחת', 'לא הושקע כסף החודש'));
  }

  const window = current.isPartial ? lastN(history, 6) : [...lastN(history, 5), current];
  const cv = window.length >= 3 ? coefficientOfVariation(investedOf(window)) : null;
  if (cv === null) {
    components.push(skipped('consistency', 'עקביות לאורך 6 חודשים', 'נדרשים לפחות 3 חודשים עם השקעות'));
  } else {
    components.push(scored('consistency', 'עקביות לאורך 6 חודשים', cv, scoreFromPoints(cv, t.consistencyCvPoints), 'cv'));
  }

  const spike = Number.isFinite(ratio3) && ratio3 >= t.spikeRatio;
  const drop = !current.isPartial && ratio3 !== null && Number.isFinite(ratio3) && ratio3 < t.dropRatio;

  return finishCategory('volume', {
    components,
    partial: current.isPartial,
    reason: current.invested === 0 && !history.some((m) => m.invested > 0) ? `לא נרשמו השקעות בחודש זה${history.length ? ` וב-${history.length} החודשים שלפניו` : ''}` : null,
    metrics: {
      invested: current.invested,
      net: current.net,
      sold: current.sold,
      withdrawn: current.withdrawn,
      parked: current.parked,
      avg3,
      avg6,
      vsAvg3Pct: ratio3 !== null && Number.isFinite(ratio3) ? (ratio3 - 1) * 100 : null,
      vsAvg6Pct: ratio6 !== null ? (ratio6 - 1) * 100 : null,
      destinations: current.destinations,
      topStock: current.topStock,
      cv,
      pattern: cv === null ? null : cv <= 0.5 ? 'regular' : cv >= 1 ? 'lumpy' : 'mixed',
      spike,
      drop
    }
  });
}

// ---------------------------------------------------------------------------
// 2. Against previous months

export function scoreComparison({ current, history }) {
  const t = THRESHOLDS.comparison;
  if (!history.length) {
    return finishCategory('comparison', { reason: 'זה החודש הראשון שלך במערכת - אין עדיין למה להשוות', metrics: { rows: [] } });
  }
  const previous = history[history.length - 1];
  const avgWindow = lastN(history, 3);
  const avgOf = (pick) => {
    const vals = avgWindow.map(pick).filter(Number.isFinite);
    return vals.length ? mean(vals) : null;
  };
  const row = (key, label, pick, unit) => {
    const now = pick(current);
    const prev = pick(previous);
    const avg = avgOf(pick);
    return {
      key,
      label,
      unit,
      current: Number.isFinite(now) ? now : null,
      previous: Number.isFinite(prev) ? prev : null,
      average: avg,
      diffPrev: Number.isFinite(now) && Number.isFinite(prev) ? now - prev : null,
      diffAvg: Number.isFinite(now) && avg !== null ? now - avg : null
    };
  };
  const rows = [
    row('invested', 'סכום שהושקע', (m) => m.invested, 'ils'),
    row('returnPct', 'תשואה חודשית', (m) => m.returnPct, 'pct'),
    row('endValue', 'שווי התיק בסוף החודש', (m) => (m.valuePartial ? null : m.endValue), 'ils'),
    // Counts what "סכום שהושקע" sums - purchases and investment deposits -
    // so a month of provident-fund deposits does not read as "0" beside an
    // amount. Sales are in the activity category.
    row('investCount', 'רכישות והפקדות', (m) => m.investCount, 'count')
  ];

  const components = [];
  const window = current.isPartial ? lastN(history, 6) : [...lastN(history, 5), current];
  const returns = window.map((m) => m.returnPct).filter(Number.isFinite);
  if (returns.length >= 3) {
    const chained = (returns.reduce((acc, r) => acc * (1 + r / 100), 1) - 1) * 100;
    components.push(scored('returnTrend', `תשואה מצטברת ב-${returns.length} חודשים`, chained, scoreFromPoints(chained, t.returnTrendPoints), 'pct'));
  } else {
    components.push(skipped('returnTrend', 'תשואה מצטברת ב-6 חודשים', 'נדרשות תשואות של 3 חודשים לפחות (כולל נתוני מחירים)'));
  }
  const complete = current.isPartial ? history : [...history, current];
  if (complete.length >= 6) {
    const recent = mean(investedOf(lastN(complete, 3)));
    const before = mean(investedOf(complete.slice(complete.length - 6, complete.length - 3)));
    const ratio = before > 0 ? recent / before : recent > 0 ? Infinity : null;
    if (ratio === null) components.push(skipped('contributionTrend', 'מגמת ההפקדות', 'לא היו השקעות בחצי השנה האחרונה'));
    else components.push(scored('contributionTrend', '3 החודשים האחרונים מול 3 שלפניהם', ratio, scoreFromPoints(ratio, t.contributionTrendPoints), 'ratio'));
  } else {
    components.push(skipped('contributionTrend', 'מגמת ההפקדות', 'נדרשים 6 חודשים של היסטוריה'));
  }

  return finishCategory('comparison', { components, metrics: { rows, previousMonth: previous.month }, partial: current.isPartial });
}

// ---------------------------------------------------------------------------
// 3. How this month's investments did

export function scoreSuccess({ current }) {
  const t = THRESHOLDS.success;
  const measured = current.positions.filter((p) => !p.missing && Number.isFinite(p.pnl));
  const missing = current.positions.filter((p) => p.missing);
  const winners = measured.filter((p) => p.pnl > 0);
  const losers = measured.filter((p) => p.pnl < 0);
  const components = [];

  if (Number.isFinite(current.returnPct)) {
    components.push(scored('monthReturn', 'תשואת התיק החודש', current.returnPct, scoreFromPoints(current.returnPct, t.monthReturnPoints), 'pct'));
  } else {
    components.push(skipped('monthReturn', 'תשואת התיק החודש', current.valuePartial ? 'חסרים נתוני מחירים לחלק מהניירות' : 'אין שווי תחילת חודש להשוואה'));
  }
  const decided = winners.length + losers.length;
  if (decided > 0) {
    const winRate = (winners.length / decided) * 100;
    components.push(scored('winRate', 'אחוז ההשקעות בפלוס', winRate, Math.round(winRate), 'pct'));
  } else {
    components.push(skipped('winRate', 'אחוז ההשקעות בפלוס', 'אין ניירות ערך עם נתוני מחיר לחודש זה'));
  }

  const boughtNow = measured.filter((p) => p.boughtThisMonth);
  return finishCategory('success', {
    components,
    partial: current.isPartial,
    reason: !current.positions.length ? 'לא הוחזקו ניירות ערך בחודש זה' : null,
    metrics: {
      returnPct: current.returnPct,
      gain: current.gain,
      positions: measured,
      winners: winners.length,
      losers: losers.length,
      best: measured[0] && measured[0].pnl > 0 ? measured[0] : null,
      worst: measured.length && measured[measured.length - 1].pnl < 0 ? measured[measured.length - 1] : null,
      missing: missing.map((p) => p.label),
      boughtThisMonth: boughtNow.length,
      boughtThisMonthPositive: boughtNow.filter((p) => p.pnl > 0).length
    }
  });
}

// ---------------------------------------------------------------------------
// 4. Diversification and risk

// A split computed without some of the holdings would be a different
// portfolio's split, so it is not computed at all.
export const unpricedReason = (allocation) =>
  `חסרים נתוני מחירים לתאריך זה עבור ${allocation.unpriced.slice(0, 3).join(', ')}${allocation.unpriced.length > 3 ? ' ועוד' : ''}`;

const DIVERSIFIED_INSTRUMENTS = new Set(['fund', 'providentFund', 'deposit']);

export function scoreDiversification({ allocation }) {
  const t = THRESHOLDS.diversification;
  if (!allocation || !(allocation.total > 0)) {
    return finishCategory('diversification', { reason: 'התיק ריק' });
  }
  if (allocation.unpriced.length) {
    return finishCategory('diversification', { reason: unpricedReason(allocation), metrics: { unpriced: allocation.unpriced } });
  }
  const components = [];
  const alerts = [];
  const investedItems = allocation.items.filter((i) => i.instrument !== 'cash' && i.instrument !== 'moneyMarket');
  const investedTotal = investedItems.reduce((s, i) => s + i.value, 0);
  const stocks = investedItems.filter((i) => i.instrument === 'stock').sort((a, b) => b.value - a.value);

  // Largest single stock, of the invested portfolio.
  let largest = null;
  if (investedTotal > 0) {
    largest = stocks[0] ? { label: stocks[0].label, pct: (stocks[0].value / investedTotal) * 100 } : { label: null, pct: 0 };
    components.push(scored('largestPosition', 'המניה הבודדת הגדולה', largest.pct, scoreFromPoints(largest.pct, t.largestPositionPoints), 'pct'));
    if (largest.pct >= t.largestPositionAlertPct) {
      alerts.push({ level: 'warning', key: 'largestPosition', pct: largest.pct, label: largest.label });
    }
  } else {
    components.push(skipped('largestPosition', 'המניה הבודדת הגדולה', 'אין השקעות מעבר למזומן'));
  }

  // Largest sector among the securities. Funds and unclassified holdings
  // stay in the denominator but are not a "sector" to be concentrated in.
  const sectors = allocation.bySector.filter((s) => s.key !== ETF_SECTOR_KEY && s.key !== UNCLASSIFIED_SECTOR_KEY);
  const unclassifiedShare = (allocation.bySector.find((s) => s.key === UNCLASSIFIED_SECTOR_KEY) || {}).share || 0;
  let topSector = null;
  if (!(allocation.securitiesTotal > 0)) {
    components.push(skipped('topSector', 'הסקטור הגדול', 'אין ניירות ערך בתיק'));
  } else if (unclassifiedShare > 0.5) {
    components.push(skipped('topSector', 'הסקטור הגדול', 'הסקטור של רוב הניירות עדיין לא ידוע'));
  } else {
    topSector = sectors[0] ? { label: sectors[0].label, key: sectors[0].key, pct: sectors[0].share * 100 } : { label: null, pct: 0 };
    components.push(scored('topSector', 'הסקטור הגדול', topSector.pct, scoreFromPoints(topSector.pct, t.topSectorPoints), 'pct'));
    if (topSector.pct >= t.topSectorAlertPct) alerts.push({ level: 'warning', key: 'topSector', pct: topSector.pct, label: topSector.label });
  }

  const topCurrency = allocation.byCurrency[0] ? { key: allocation.byCurrency[0].key, label: allocation.byCurrency[0].label, pct: allocation.byCurrency[0].share * 100 } : null;
  if (topCurrency) {
    components.push(scored('currency', 'המטבע הדומיננטי', topCurrency.pct, scoreFromPoints(topCurrency.pct, t.currencyPoints), 'pct'));
    if (topCurrency.pct >= t.currencyAlertPct) alerts.push({ level: 'info', key: 'currency', pct: topCurrency.pct, label: topCurrency.label });
  }

  let israelPct = null;
  if (allocation.securitiesTotal > 0) {
    israelPct = ((allocation.byRegion.find((r) => r.key === 'israel') || {}).share || 0) * 100;
    components.push(scored('homeBias', 'החלק בישראל מתוך ניירות הערך', israelPct, scoreFromPoints(israelPct, t.homeBiasPoints), 'pct'));
    if (israelPct >= t.homeBiasAlertPct) alerts.push({ level: 'info', key: 'homeBias', pct: israelPct });
  } else {
    components.push(skipped('homeBias', 'ישראל מול העולם', 'אין ניירות ערך בתיק'));
  }

  return finishCategory('diversification', {
    components,
    alerts,
    metrics: {
      largest,
      topSector,
      topCurrency,
      israelPct,
      sectorCount: sectors.length,
      holdingsCount: allocation.items.length,
      diversifiedShare: investedTotal > 0 ? investedItems.filter((i) => DIVERSIFIED_INSTRUMENTS.has(i.instrument)).reduce((s, i) => s + i.value, 0) / investedTotal : null,
      byInstrument: allocation.byInstrument,
      bySector: allocation.bySector,
      byCurrency: allocation.byCurrency,
      byRegion: allocation.byRegion,
      unpriced: allocation.unpriced
    }
  });
}

// ---------------------------------------------------------------------------
// 5. Discipline and persistence

// Consecutive months with money invested, counting back from the most
// recent month that has any (a running month that has none yet does not
// break the streak - it may still come).
export function investmentStreak(months) {
  let i = months.length - 1;
  if (i >= 0 && months[i].isPartial && !(months[i].invested > 0)) i -= 1;
  let streak = 0;
  for (; i >= 0 && months[i].invested > 0; i--) streak += 1;
  return streak;
}

export function scoreDiscipline({ current, history }) {
  const t = THRESHOLDS.discipline;
  const months = [...history, current];
  const streak = investmentStreak(months);
  const window = lastN(current.isPartial && !(current.invested > 0) ? history : months, t.regularityWindowMonths);
  const activeMonths = window.filter((m) => m.invested > 0).length;
  const cv = coefficientOfVariation(investedOf(window));
  if (months.length < t.minMonthsForScore) {
    return finishCategory('discipline', {
      reason: `נדרשים לפחות ${t.minMonthsForScore} חודשים של היסטוריה (יש ${months.length})`,
      metrics: { streak, activeMonths, windowMonths: window.length, cv }
    });
  }
  const components = [
    scored('streak', 'רצף חודשים של השקעה', streak, Math.round(clamp(streak / t.fullStreakMonths, 0, 1) * 100), 'months'),
    scored('regularity', `חודשים עם השקעה מתוך ${window.length}`, window.length ? (activeMonths / window.length) * 100 : 0, window.length ? Math.round((activeMonths / window.length) * 100) : 0, 'pct')
  ];
  return finishCategory('discipline', {
    components,
    metrics: { streak, activeMonths, windowMonths: window.length, cv, habit: cv === null ? null : cv <= 0.5 ? 'regular' : 'lumpy' }
  });
}

// ---------------------------------------------------------------------------
// 6. Risk-adjusted return

// From a cash-flow-neutral index series (portfolioStats' twrIndexSeries):
// the deepest peak-to-trough fall, and how long it took to get back.
export function drawdownStats(indexSeries) {
  let peak = null;
  let peakDate = null;
  let worst = { pct: 0, peakDate: null, troughDate: null, peakValue: null };
  (indexSeries || []).forEach((p) => {
    const v = p.indexed !== undefined ? p.indexed : p.value;
    if (!Number.isFinite(v)) return;
    if (peak === null || v > peak) {
      peak = v;
      peakDate = p.date;
    }
    const dd = peak > 0 ? ((peak - v) / peak) * 100 : 0;
    if (dd > worst.pct) worst = { pct: dd, peakDate, troughDate: p.date, peakValue: peak };
  });
  let recoveryDays = null;
  let recovered = worst.pct === 0;
  if (worst.troughDate) {
    const after = indexSeries.find((p) => p.date > worst.troughDate && (p.indexed !== undefined ? p.indexed : p.value) >= worst.peakValue);
    if (after) {
      recovered = true;
      recoveryDays = daysBetween(worst.troughDate, after.date);
    }
  }
  return { maxDrawdownPct: worst.pct, peakDate: worst.peakDate, troughDate: worst.troughDate, recovered, recoveryDays };
}

export function scoreRiskAdjusted({ riskStats, riskFreePct }) {
  const t = THRESHOLDS.riskAdjusted;
  if (!riskStats || !riskStats.enough) {
    return finishCategory('riskAdjusted', {
      reason: riskStats && riskStats.reason ? riskStats.reason : `נדרשים לפחות ${t.minMonthsForScore} חודשים של נתוני מחירים`,
      metrics: riskStats || {}
    });
  }
  const { volatilityPct, maxDrawdownPct, annualReturnPct } = riskStats;
  const sharpe = Number.isFinite(volatilityPct) && volatilityPct > 0 && Number.isFinite(annualReturnPct) ? (annualReturnPct - riskFreePct) / volatilityPct : null;
  const components = [
    Number.isFinite(volatilityPct) ? scored('volatility', 'תנודתיות שנתית', volatilityPct, scoreFromPoints(volatilityPct, t.volatilityPoints), 'pct') : skipped('volatility', 'תנודתיות שנתית', 'אין מספיק נקודות מחיר'),
    scored('drawdown', 'ירידה מקסימלית', maxDrawdownPct, scoreFromPoints(maxDrawdownPct, t.drawdownPoints), 'pct'),
    sharpe !== null ? scored('sharpe', 'יחס תשואה לסיכון (Sharpe)', sharpe, scoreFromPoints(sharpe, t.sharpePoints), 'ratio') : skipped('sharpe', 'יחס תשואה לסיכון (Sharpe)', 'לא ניתן לחשב ללא תנודתיות')
  ];
  return finishCategory('riskAdjusted', { components, metrics: { ...riskStats, sharpe, riskFreePct } });
}

// ---------------------------------------------------------------------------
// 7. Decision quality and behavioural biases

function nativeClose(market, symbol, date, priceData) {
  const series = market === 'american' ? (priceData.yahooHistoricalCloses || {})[symbol] : (priceData.taseHistoricalCloses || {})[symbol];
  return closeOnOrBefore(date, series);
}

const priceChangePct = (market, symbol, from, to, priceData) => {
  const a = nativeClose(market, symbol, from, priceData);
  const b = nativeClose(market, symbol, to, priceData);
  if (!(a > 0) || !(b > 0)) return null;
  return ((b - a) / a) * 100;
};

const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

// Closed trades, one per sale: what it made or lost in ILS.
export function closedTrades(realizedRows) {
  const bySale = new Map();
  (realizedRows || []).forEach((row) => {
    const t = bySale.get(row.txId) || { txId: row.txId, date: row.saleDate, symbol: row.symbol, market: row.assetClass, gain: 0, cost: 0, minHoldingDays: Infinity };
    t.gain += row.nominalGainILS;
    t.cost += row.costILS;
    t.minHoldingDays = Math.min(t.minHoldingDays, row.holdingDays);
    bySale.set(row.txId, t);
  });
  return [...bySale.values()];
}

// The three patterns, each case with its date so the page can say when.
export function detectBiases({ ctx, realizedRows, from, to }) {
  const t = THRESHOLDS.decisions;
  const pd = ctx.priceData;
  const out = { chasing: [], panic: [], disposition: [], checkable: { chasing: 0, sells: 0 } };

  ctx.events
    .filter((e) => e.kind === 'buy' && e.date > from && e.date <= to && e.security && (e.security.market === 'israeli' || e.security.market === 'american'))
    .forEach((e) => {
      const rise = priceChangePct(e.security.market, e.security.symbol, addDays(e.date, -t.chasingWindowDays), addDays(e.date, -1), pd);
      if (rise === null) return;
      out.checkable.chasing += 1;
      if (rise >= t.chasingRisePct) out.chasing.push({ date: e.date, label: e.security.label, symbol: e.security.symbol, changePct: rise });
    });

  const trades = closedTrades(realizedRows).filter((tr) => tr.date > from && tr.date <= to);
  out.checkable.sells = trades.length;
  trades.forEach((tr) => {
    const market = tr.market;
    if (tr.gain < 0) {
      const drop = priceChangePct(market, tr.symbol, addDays(tr.date, -t.panicWindowDays), addDays(tr.date, -1), pd);
      if (drop !== null && drop <= -t.panicDropPct) out.panic.push({ date: tr.date, label: tr.symbol, symbol: tr.symbol, changePct: drop });
    }
    if (tr.gain > 0 && tr.minHoldingDays <= t.dispositionWinnerMaxDays) {
      // Another holding sitting at a loss, held longer than this winner.
      const loser = ctx.lotGroups.find((g) => {
        if (g.symbol === tr.symbol) return false;
        const lots = g.lots.filter((lot) => isLotHeldOn(lot, tr.date));
        if (!lots.length) return false;
        const oldest = lots.map((l) => l.purchaseDate).sort()[0];
        if (daysBetween(oldest, tr.date) <= tr.minHoldingDays) return false;
        const close = nativeClose(g.market, g.symbol, tr.date, pd);
        if (!(close > 0)) return false;
        const priceNow = g.market === 'american' ? close : close / 100;
        const cost = lots.reduce((s, l) => s + toNum(l.purchasePrice) * toNum(l.quantity), 0);
        const value = lots.reduce((s, l) => s + priceNow * toNum(l.quantity), 0);
        return cost > 0 && ((value - cost) / cost) * 100 <= -t.dispositionLoserMinLossPct;
      });
      if (loser) out.disposition.push({ date: tr.date, label: tr.symbol, symbol: tr.symbol, heldLoser: loser.symbol, holdingDays: tr.minHoldingDays });
    }
  });
  return out;
}

export function scoreDecisions({ realizedRows, openPositions, biases }) {
  const t = THRESHOLDS.decisions;
  const components = [];
  const trades = closedTrades(realizedRows);
  let basis = null;
  let outcomes = [];
  if (trades.length >= t.minClosedTrades) {
    basis = 'closed';
    outcomes = trades.map((tr) => tr.gain);
  } else if ((openPositions || []).length >= t.minClosedTrades) {
    basis = 'open';
    outcomes = openPositions.map((p) => p.gain);
  }

  let stats = null;
  if (basis) {
    const wins = outcomes.filter((g) => g > 0);
    const losses = outcomes.filter((g) => g < 0);
    const sumWins = wins.reduce((s, v) => s + v, 0);
    const sumLosses = Math.abs(losses.reduce((s, v) => s + v, 0));
    const avgWin = wins.length ? sumWins / wins.length : null;
    const avgLoss = losses.length ? sumLosses / losses.length : null;
    const profitFactor = sumLosses > 0 ? sumWins / sumLosses : sumWins > 0 ? Infinity : null;
    const payoff = avgWin !== null && avgLoss ? avgWin / avgLoss : avgWin !== null ? Infinity : null;
    stats = { basis, count: outcomes.length, wins: wins.length, losses: losses.length, winRate: outcomes.length ? (wins.length / outcomes.length) * 100 : null, avgWin, avgLoss, profitFactor, payoff };
    const basisNote = basis === 'closed' ? 'עסקאות סגורות' : 'פוזיציות פתוחות';
    components.push(profitFactor === null ? skipped('profitFactor', 'Profit factor', 'אין רווחים או הפסדים') : scored('profitFactor', `Profit factor (${basisNote})`, profitFactor, scoreFromPoints(profitFactor, t.profitFactorPoints), 'ratio'));
    components.push(payoff === null ? skipped('payoff', 'ממוצע רווח מול ממוצע הפסד', 'אין רווחים') : scored('payoff', `ממוצע רווח מול ממוצע הפסד (${basisNote})`, payoff, scoreFromPoints(payoff, t.payoffRatioPoints), 'ratio'));
  } else {
    components.push(skipped('profitFactor', 'יחס רווח להפסד', `נדרשות לפחות ${t.minClosedTrades} עסקאות סגורות או פוזיציות`));
  }

  const checkable = biases && (biases.checkable.chasing > 0 || biases.checkable.sells > 0);
  const cases = biases ? biases.chasing.length + biases.panic.length + biases.disposition.length : 0;
  if (checkable) {
    components.push(scored('biases', 'הטיות התנהגותיות שזוהו', cases, Math.max(t.biasScoreFloor, 100 - cases * t.biasPenaltyPerCase), 'count'));
  } else {
    components.push(skipped('biases', 'הטיות התנהגותיות', 'אין קניות או מכירות עם היסטוריית מחירים לבדיקה'));
  }

  return finishCategory('decisions', { components, metrics: { stats, biases, biasCases: cases, biasesCheckable: Boolean(checkable) } });
}

// ---------------------------------------------------------------------------
// 8. Activity versus patience

export function scoreActivity({ ctx, windowMonths, end }) {
  const t = THRESHOLDS.activity;
  const from = addDays(`${shiftMonth(monthKeyOf(end), -(windowMonths.length - 1))}-01`, -1);
  const inWindow = (e) => e.date > from && e.date <= end;
  const sells = ctx.events.filter((e) => e.kind === 'sell' && inWindow(e));
  const buys = ctx.events.filter((e) => e.kind === 'buy' && inWindow(e));
  const values = windowMonths.map((m) => m.endValue).filter((v) => Number.isFinite(v) && v > 0);
  const avgValue = values.length ? mean(values) : null;
  const months = windowMonths.length;
  const soldGross = sells.reduce((s, e) => s + (e.grossILS || e.amountILS), 0);
  const turnoverPct = avgValue ? (soldGross / avgValue) * 100 * (12 / Math.max(months, 1)) : null;

  // Holding period, weighted by cost: open lots by their age at `end`,
  // closed slices by how long they were held before the sale.
  let weighted = 0;
  let weight = 0;
  let longCost = 0;
  ctx.lotGroups.forEach((g) => {
    g.lots.forEach((lot) => {
      if (!lot.purchaseDate || lot.purchaseDate > end) return;
      const until = lot.soldDate && lot.soldDate <= end ? lot.soldDate : end;
      const days = daysBetween(lot.purchaseDate.slice(0, 10), until);
      const cost = toNum(lot.purchasePrice) * toNum(lot.quantity) * (g.market === 'american' ? toNum(lot.exchangeRate) || 1 : 1);
      if (!(cost > 0)) return;
      weighted += days * cost;
      weight += cost;
      if (days >= t.longTermDays) longCost += cost;
    });
  });
  const avgHoldingDays = weight > 0 ? weighted / weight : null;
  const components = [];
  if (turnoverPct !== null && months >= 3) {
    components.push(scored('turnover', 'מחזור מסחר שנתי', turnoverPct, scoreFromPoints(turnoverPct, t.turnoverPoints), 'pct'));
  } else {
    components.push(skipped('turnover', 'מחזור מסחר שנתי', 'נדרשים 3 חודשים עם שווי תיק ידוע'));
  }
  if (avgHoldingDays !== null) {
    components.push(scored('holding', 'זמן החזקה ממוצע', avgHoldingDays, scoreFromPoints(avgHoldingDays, t.holdingDaysPoints), 'days'));
  } else {
    components.push(skipped('holding', 'זמן החזקה ממוצע', 'אין ניירות ערך עם תאריך קנייה'));
  }
  return finishCategory('activity', {
    components,
    metrics: {
      turnoverPct,
      trades: sells.length + buys.length,
      sells: sells.length,
      buys: buys.length,
      months,
      tradesPerMonth: months ? (sells.length + buys.length) / months : null,
      avgHoldingDays,
      longTermShare: weight > 0 ? longCost / weight : null,
      salesFromLedgerOnly: true
    }
  });
}

// ---------------------------------------------------------------------------
// 9. Costs

export function scoreCosts({ ctx, windowMonths, end, hasLedger }) {
  const t = THRESHOLDS.costs;
  if (!hasLedger) {
    return finishCategory('costs', {
      reason: 'עמלות ועלויות המרה נשמרות רק בעסקאות שנרשמו בטופס "הוספת מידע". דמי ניהול אינם נשמרים במערכת.',
      metrics: { missingFields: ['managementFees', 'fxCosts'] }
    });
  }
  const from = addDays(`${shiftMonth(monthKeyOf(end), -(windowMonths.length - 1))}-01`, -1);
  const fees = ctx.events.filter((e) => e.kind === 'fee' && e.date > from && e.date <= end);
  // Only trades that recorded the rate actually paid tell the conversion
  // cost; with none of them it stays unknown.
  const fxEvents = ctx.events.filter((e) => e.kind === 'fxCost' && e.date > from && e.date <= end);
  const fxCostILS = fxEvents.length ? fxEvents.reduce((s, e) => s + e.amountILS, 0) : null;
  const missingFields = fxEvents.length ? ['managementFees'] : ['managementFees', 'fxCosts'];
  const traded = ctx.events.filter((e) => (e.kind === 'buy' && e.fromLedger) || e.kind === 'sell').filter((e) => e.date > from && e.date <= end);
  const feesILS = fees.reduce((s, e) => s + e.amountILS, 0) + (fxCostILS || 0);
  const tradedILS = traded.reduce((s, e) => s + (e.grossILS || e.amountILS), 0);
  const values = windowMonths.map((m) => m.endValue).filter((v) => Number.isFinite(v) && v > 0);
  const avgValue = values.length ? mean(values) : null;
  const months = Math.max(windowMonths.length, 1);
  const feesPct = avgValue ? (feesILS / avgValue) * 100 * (12 / months) : null;
  const components = [
    feesPct !== null ? scored('feesPct', 'עמלות שנתיות כאחוז מהתיק', feesPct, scoreFromPoints(feesPct, t.feesPctPoints), 'pct') : skipped('feesPct', 'עמלות כאחוז מהתיק', 'שווי התיק אינו ידוע')
  ];
  return finishCategory('costs', {
    components,
    metrics: { feesILS, tradedILS, feesOfTradedPct: tradedILS > 0 ? (feesILS / tradedILS) * 100 : null, feesPct, fxCostILS, months, missingFields }
  });
}

// ---------------------------------------------------------------------------
// 10. Tax efficiency

export function scoreTax({ realizedYear, harvest, taxRate, year }) {
  const t = THRESHOLDS.tax;
  if (!realizedYear || !realizedYear.count) {
    return finishCategory('tax', {
      reason: `לא היו מימושים ב-${year}, כך שעדיין אין מס לייעל`,
      metrics: { year, harvestableLoss: harvest ? harvest.totalHarvestableLoss : null, potentialTaxValue: harvest ? harvest.totalPotentialTaxValue : null }
    });
  }
  const netGain = realizedYear.netRealGainILS;
  const taxDue = realizedYear.estimatedTaxILS;
  const harvestable = harvest ? harvest.totalHarvestableLoss : null;
  const components = [];
  let avoidable = null;
  if (netGain <= 0) {
    components.push(scored('unusedOffset', 'קיזוז הפסדים', 0, 100, 'pct'));
    avoidable = 0;
  } else if (harvestable === null) {
    components.push(skipped('unusedOffset', 'הפסדים פתוחים שלא נוצלו', 'לא ניתן לבדוק הפסדים פתוחים לחודש עבר'));
  } else {
    avoidable = Math.min(netGain, harvestable) * taxRate;
    const ratio = taxDue > 0 ? avoidable / taxDue : 0;
    components.push(scored('unusedOffset', 'חלק מהמס שהפסדים פתוחים יכלו לקזז', ratio * 100, scoreFromPoints(ratio, t.unusedOffsetPoints), 'pct'));
  }
  return finishCategory('tax', {
    components,
    metrics: {
      year,
      sales: realizedYear.count,
      realGains: realizedYear.realGainsILS,
      realLosses: realizedYear.realLossesILS,
      netGain,
      taxDue,
      harvestableLoss: harvestable,
      avoidableTax: avoidable,
      unindexedCount: realizedYear.unindexedCount
    }
  });
}

// ---------------------------------------------------------------------------
// 11. Against a simple alternative

// Every flow into and out of the securities replayed into the index on the
// same dates: units bought with each purchase, sold with each sale.
export function simulateBenchmark(flows, benchmarkPoints, endDate) {
  if (!Array.isArray(benchmarkPoints) || benchmarkPoints.length === 0 || !flows.length) return null;
  let units = 0;
  let netInvested = 0;
  let skippedFlows = 0;
  flows.forEach((f) => {
    const close = closeOnOrBefore(f.date, benchmarkPoints);
    if (!(close > 0)) {
      skippedFlows += 1;
      return;
    }
    units += f.amount / close;
    netInvested += f.amount;
  });
  const endClose = closeOnOrBefore(endDate, benchmarkPoints);
  if (!(endClose > 0) || skippedFlows === flows.length) return null;
  return { value: units * endClose, netInvested, skippedFlows };
}

export function scoreBenchmark({ ctx, benchmark, benchmarkPoints, actualValue, end }) {
  const t = THRESHOLDS.benchmark;
  if (!benchmark) return finishCategory('benchmark', { reason: 'לא נבחר מדד להשוואה' });
  if (!Array.isArray(benchmarkPoints) || !benchmarkPoints.length) {
    return finishCategory('benchmark', { reason: `אין כרגע נתוני ${benchmark.label} זמינים`, metrics: { benchmark } });
  }
  const flows = ctx.events
    .filter((e) => e.date <= end && e.security && (e.security.market === 'israeli' || e.security.market === 'american'))
    .filter((e) => e.kind === 'buy' || e.kind === 'sell' || e.kind === 'dividend')
    .map((e) => ({ date: e.date, amount: e.kind === 'buy' ? e.amountILS : -e.amountILS }));
  if (!flows.length) return finishCategory('benchmark', { reason: 'אין קניות של ניירות ערך להשוואה', metrics: { benchmark } });
  if (!Number.isFinite(actualValue)) return finishCategory('benchmark', { reason: 'שווי ניירות הערך לתאריך זה אינו ידוע', metrics: { benchmark } });
  const sim = simulateBenchmark(flows, benchmarkPoints, end);
  if (!sim || !(sim.value > 0)) return finishCategory('benchmark', { reason: 'נתוני המדד אינם מכסים את תאריכי ההשקעות', metrics: { benchmark } });
  const excessPct = ((actualValue - sim.value) / sim.value) * 100;
  return finishCategory('benchmark', {
    components: [scored('excess', `התיק מול אותו כסף ב-${benchmark.label}`, excessPct, scoreFromPoints(excessPct, t.excessPoints), 'pct')],
    metrics: {
      benchmark,
      actualValue,
      benchmarkValue: sim.value,
      netInvested: sim.netInvested,
      differenceILS: actualValue - sim.value,
      excessPct,
      skippedFlows: sim.skippedFlows,
      firstFlowDate: flows[0].date
    }
  });
}

// ---------------------------------------------------------------------------
// 12. Idle cash

const cashOf = (allocation) =>
  allocation ? allocation.items.filter((i) => i.instrument === 'cash' || i.instrument === 'moneyMarket').reduce((s, i) => s + i.value, 0) : 0;

export function scoreCash({ allocation, previousAllocations = [] }) {
  const t = THRESHOLDS.cash;
  if (!allocation || !(allocation.total > 0)) return finishCategory('cash', { reason: 'התיק ריק' });
  if (allocation.unpriced.length) return finishCategory('cash', { reason: unpricedReason(allocation) });
  const cash = cashOf(allocation);
  const bank = allocation.items.filter((i) => i.instrument === 'cash').reduce((s, i) => s + i.value, 0);
  const sharePct = (cash / allocation.total) * 100;
  // How many month-ends in a row (ending now) the cash share was above the
  // alert line.
  let idleMonths = 0;
  const all = [...previousAllocations, allocation];
  for (let i = all.length - 1; i >= 0; i--) {
    const a = all[i];
    if (!a || !(a.total > 0) || (cashOf(a) / a.total) * 100 < t.idleAlertPct) break;
    idleMonths += 1;
  }
  return finishCategory('cash', {
    components: [scored('cashShare', 'מזומן ושווה מזומן מהתיק', sharePct, scoreFromPoints(sharePct, t.cashSharePoints), 'pct')],
    alerts: sharePct >= t.idleAlertPct ? [{ level: 'info', key: 'idleCash', pct: sharePct, months: idleMonths }] : [],
    metrics: { cash, bank, moneyMarket: cash - bank, sharePct, idleMonths }
  });
}

// ---------------------------------------------------------------------------
// 13. Progress toward the user's goal

export function scoreGoal({ goal, currentValue, history, current, end }) {
  const t = THRESHOLDS.goal;
  const target = goal ? Number(goal.targetAmount) : NaN;
  if (!goal || !(target > 0) || !goal.targetDate) {
    return finishCategory('goal', { status: 'noGoal', reason: 'לא הוגדר יעד' });
  }
  if (!Number.isFinite(currentValue)) return finishCategory('goal', { reason: 'שווי התיק אינו ידוע', metrics: { target } });
  const remaining = target - currentValue;
  const monthsLeft = Math.max(0, (Number(goal.targetDate.slice(0, 4)) - Number(end.slice(0, 4))) * 12 + (Number(goal.targetDate.slice(5, 7)) - Number(end.slice(5, 7))));
  const complete = current.isPartial ? history : [...history, current];
  const recent = lastN(complete, 6);
  const avgMonthlyNet = recent.length ? mean(recent.map((m) => m.net)) : null;
  const progressPct = (currentValue / target) * 100;
  const base = { target, targetDate: goal.targetDate, currentValue, remaining, monthsLeft, avgMonthlyNet, progressPct };

  if (remaining <= 0) {
    return finishCategory('goal', { components: [scored('pace', 'התקדמות ליעד', progressPct, 100, 'pct')], metrics: { ...base, achieved: true } });
  }
  if (monthsLeft === 0) {
    return finishCategory('goal', { components: [scored('pace', 'החלק שהושג מהיעד', progressPct, Math.round(clamp(progressPct, 0, 100)), 'pct')], metrics: { ...base, deadlinePassed: true } });
  }
  // Without assuming any return: the amount that has to be put in every
  // month from now to reach the target by its date.
  const requiredMonthly = remaining / monthsLeft;
  if (avgMonthlyNet === null) {
    return finishCategory('goal', { reason: 'אין עדיין היסטוריית הפקדות להשוואה לקצב הנדרש', metrics: { ...base, requiredMonthly } });
  }
  const paceRatio = requiredMonthly > 0 ? Math.max(0, avgMonthlyNet) / requiredMonthly : Infinity;
  return finishCategory('goal', {
    components: [scored('pace', 'קצב ההפקדות מול הנדרש', paceRatio * 100, scoreFromPoints(paceRatio, t.paceRatioPoints), 'pct')],
    metrics: { ...base, requiredMonthly, paceRatio, onTrack: paceRatio >= 1 }
  });
}

// ---------------------------------------------------------------------------
// 14. Dividends - figures only, no grade

export function scoreDividends({ ctx, end, windowMonths, projectedAnnualILS = null }) {
  const from = addDays(`${shiftMonth(monthKeyOf(end), -11)}-01`, -1);
  const received = ctx.events.filter((e) => e.kind === 'dividend' && e.date > from && e.date <= end);
  const net12m = received.reduce((s, e) => s + e.amountILS, 0);
  const withheld12m = received.reduce((s, e) => s + (e.taxWithheldILS || 0), 0);
  const values = windowMonths.map((m) => m.endValue).filter((v) => Number.isFinite(v) && v > 0);
  const avgValue = values.length ? mean(values) : null;
  const hasAny = received.length > 0 || Number.isFinite(projectedAnnualILS);
  return finishCategory('dividends', {
    status: hasAny ? 'info' : 'noData',
    reason: hasAny ? null : 'לא נרשמו דיבידנדים בשנה האחרונה (דיבידנד נרשם כעסקה בטופס "הוספת מידע")',
    metrics: {
      net12m,
      withheld12m,
      count: received.length,
      monthlyAvg: net12m / 12,
      yieldPct: avgValue ? (net12m / avgValue) * 100 : null,
      projectedAnnualILS: Number.isFinite(projectedAnnualILS) ? projectedAnnualILS : null
    }
  });
}
