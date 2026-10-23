// "תובנות מהירות על התיק": the one to three things most worth knowing about
// the portfolio right now, for the top of the dashboard.
//
// Nothing here is computed afresh. Every figure is one the app already
// works out elsewhere, read from it:
//   - per holding: portfolioAnalysis.js's stockDistribution (value, share of
//     the portfolio, profit, today's change - only a market that traded today)
//   - yesterday: lastSessionChange.js's bySymbol
//   - fund vs single stock: portfolioReviewData.js's describeSecurity
//   - thresholds: portfolioReviewConfig.js's (the review's own alerts)
//   - stale prices: usePriceRefresh.js's findStalePrices
//   - a fund's return since its last update: portfolioMath.js's
//     calculateLedgerPeriodReturn
//
// Each candidate gets a priority; the highest win, at most one of a kind,
// so three warnings about prices never crowd out everything else. With
// nothing unusual, a general line about the portfolio's return and split
// stands in. Pure: data in, [{ key, kind, tone, icon, title, text }] out.
import { THRESHOLDS } from './portfolioReviewConfig';
import { describeSecurity } from './portfolioReviewData';
import { findStalePrices, STALE_PRICE_MS } from '../hooks/usePriceRefresh';
import { calculateLedgerPeriodReturn } from './portfolioMath';
import { formatPriceWithSign } from './formatters';

// A day's move this large, either way, is news.
export const MOVER_PCT = 3;
// A price not refreshed in this long is out of date (a weekend included).
export const PRICE_STALE_DAYS = 4;
// A provident fund's value not updated in this long is out of date - most
// report monthly.
export const FUND_STALE_DAYS = 75;
// A fund's return since its previous update worth mentioning.
export const FUND_MOVE_PCT = 3;
export const MAX_INSIGHTS = 3;

const ils = (v) => `${formatPriceWithSign(v)} ₪`;
const pct = (v, digits = 1) => `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
const DAY_MS = 86400000;

const nameOf = (s) => s.displayName || s.name;

// The holdings, with what kind of security each is.
function holdingsWithKind(analysis, { israeliStocks = [], americanStocks = [] }) {
  const lotBySymbol = new Map();
  israeliStocks.forEach((l) => lotBySymbol.has(l.stockName) || lotBySymbol.set(l.stockName, { market: 'israeli', lot: l }));
  americanStocks.forEach((l) => lotBySymbol.has(l.stockName) || lotBySymbol.set(l.stockName, { market: 'american', lot: l }));
  return ((analysis && analysis.stockDistribution) || [])
    .filter((s) => s.value > 0)
    .map((s) => {
      const found = lotBySymbol.get(s.name);
      const security = found ? describeSecurity(found.market, found.lot) : null;
      return { ...s, market: found ? found.market : s.exchange, instrument: security ? security.instrument : 'stock' };
    });
}

function moverInsight(holdings, lastSession) {
  const today = holdings
    .filter((h) => Math.abs(h.dailyChange) >= MOVER_PCT)
    .sort((a, b) => Math.abs(b.dailyChange) - Math.abs(a.dailyChange))[0];
  if (today) {
    const up = today.dailyChange > 0;
    return {
      key: `mover:${today.name}`,
      kind: 'mover',
      priority: 90 + Math.abs(today.dailyChange),
      tone: up ? 'up' : 'down',
      icon: up ? '🚀' : '📉',
      title: `${nameOf(today)} ${up ? 'זינקה' : 'צנחה'} היום ב-${pct(today.dailyChange)}`,
      text: `אחזקה של ${ils(today.value)}, ${today.percentage.toFixed(1)}% מהתיק.`
    };
  }
  // No big move today - perhaps on the last completed session.
  const bySymbol = (lastSession && lastSession.bySymbol) || {};
  const yesterday = holdings
    .map((h) => ({ h, r: bySymbol[`${h.market}:${h.market === 'american' ? String(h.name).toUpperCase() : h.name}`] }))
    .filter(({ r }) => r && Number.isFinite(r.pct) && Math.abs(r.pct) >= MOVER_PCT)
    .sort((a, b) => Math.abs(b.r.pct) - Math.abs(a.r.pct))[0];
  if (!yesterday) return null;
  const up = yesterday.r.pct > 0;
  return {
    key: `mover-last:${yesterday.h.name}`,
    kind: 'mover',
    priority: 75 + Math.abs(yesterday.r.pct),
    tone: up ? 'up' : 'down',
    icon: up ? '🚀' : '📉',
    title: `${nameOf(yesterday.h)} ${up ? 'עלתה' : 'ירדה'} ב-${pct(yesterday.r.pct)} ביום המסחר האחרון`,
    text: `${up ? 'רווח' : 'הפסד'} של ${ils(Math.abs(yesterday.r.changeILS))} ביום אחד.`
  };
}

function concentrationInsight(holdings) {
  // Single stocks only: a broad index fund at 40% is not one company's risk.
  const top = holdings.filter((h) => h.instrument === 'stock').sort((a, b) => b.percentage - a.percentage)[0];
  const limit = THRESHOLDS.diversification.largestPositionAlertPct;
  if (!top || top.percentage < limit) return null;
  return {
    key: `concentration:${top.name}`,
    kind: 'concentration',
    priority: 80 + Math.min(top.percentage - limit, 19),
    tone: 'warn',
    icon: '⚠️',
    title: `${nameOf(top)} היא ${top.percentage.toFixed(0)}% מהתיק שלך`,
    text: `מניה בודדת מעל ${limit}% מהתיק - תנועה חדה שלה מזיזה את כל התיק.`
  };
}

function exposureInsight(analysis) {
  const ex = (analysis && analysis.exchangeDistribution) || {};
  const total = ex.total || 0;
  if (!(total > 0)) return null;
  const limit = THRESHOLDS.diversification.currencyAlertPct;
  const abroad = ex.american ? ex.american.percentage : 0;
  const israel = ex.israeli ? ex.israeli.percentage : 0;
  if (abroad >= limit) {
    return {
      key: 'exposure:abroad',
      kind: 'exposure',
      priority: 55,
      tone: 'info',
      icon: '💵',
      title: `${abroad.toFixed(0)}% מהתיק חשוף לדולר ולשוק האמריקאי`,
      text: 'כל שינוי בשער הדולר-שקל משנה את שווי רוב התיק.'
    };
  }
  if (israel >= limit) {
    return {
      key: 'exposure:israel',
      kind: 'exposure',
      priority: 50,
      tone: 'info',
      icon: '🇮🇱',
      title: `${israel.toFixed(0)}% מהתיק בבורסת תל אביב`,
      text: 'כמעט כל התיק תלוי בשוק אחד ובמטבע אחד.'
    };
  }
  return null;
}

function performerInsight(holdings) {
  // Holdings of some size only - a 2-share position's +300% says little.
  const meaningful = holdings.filter((h) => h.totalPurchaseValue > 0 && h.percentage >= 2);
  if (!meaningful.length) return null;
  const sorted = [...meaningful].sort((a, b) => b.profitPercentage - a.profitPercentage);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  if (worst !== best && worst.profitPercentage <= -15) {
    return {
      key: `performer:worst:${worst.name}`,
      kind: 'performer',
      priority: 48,
      tone: 'down',
      icon: '🔻',
      title: `${nameOf(worst)} בהפסד של ${pct(worst.profitPercentage)}`,
      text: `${ils(worst.profit)} מתחת לעלות - האחזקה המפסידה ביותר בתיק.`
    };
  }
  if (best.profitPercentage > 0) {
    return {
      key: `performer:best:${best.name}`,
      kind: 'performer',
      priority: 45,
      tone: 'up',
      icon: '🏆',
      title: `${nameOf(best)} ברווח של ${pct(best.profitPercentage)}`,
      text: `${ils(best.profit)} מעל העלות - האחזקה הרווחית ביותר בתיק.`
    };
  }
  return null;
}

function priceHealthInsight({ israeliStocks = [], americanStocks = [] }, { pricesLoaded, now }) {
  // Only once the first refresh is over - before it every price is "old".
  if (!pricesLoaded) return null;
  const stocks = [...israeliStocks, ...americanStocks];
  const missing = [...new Set(stocks.filter((s) => !(Number(s.currentPrice) > 0)).map((s) => String(s.officialName || '').trim() || s.stockName))];
  // findStalePrices counts a price fresh for STALE_PRICE_MS; shifting `now`
  // back stretches that to PRICE_STALE_DAYS.
  const stale = findStalePrices(stocks, now - PRICE_STALE_DAYS * DAY_MS + STALE_PRICE_MS).filter((s) => !missing.includes(s.name));
  const names = missing.length ? missing : stale.map((s) => s.name);
  if (!names.length) return null;
  const list = names.slice(0, 2).join(', ') + (names.length > 2 ? ` ועוד ${names.length - 2}` : '');
  return {
    key: 'health:prices',
    kind: 'health',
    priority: missing.length ? 85 : 70,
    tone: 'warn',
    icon: '🔄',
    title: missing.length ? `אין מחיר ל-${list}` : `המחיר של ${list} לא התעדכן כמה ימים`,
    text: 'השווי והתשואות של אחזקות אלה לא מעודכנים עד שיתקבל מחיר.'
  };
}

function fundInsights({ pensionFunds = [] }, { now }) {
  const out = [];
  const valueDate = (f) => f.currentValueDate || f.updateDate || '';
  const outdated = pensionFunds
    .filter((f) => !f.valueFromLedger && valueDate(f))
    .map((f) => ({ f, days: Math.floor((now - Date.parse(`${valueDate(f).slice(0, 10)}T00:00:00Z`)) / DAY_MS) }))
    .filter(({ days }) => days >= FUND_STALE_DAYS)
    .sort((a, b) => b.days - a.days)[0];
  if (outdated) {
    out.push({
      key: `health:fund:${outdated.f.id}`,
      kind: 'fundHealth',
      priority: 60,
      tone: 'warn',
      icon: '🗓️',
      title: `${outdated.f.fundName || 'קופת גמל'} לא עודכנה ${outdated.days} ימים`,
      text: 'עדכון השווי מהדוח האחרון ישלים את התמונה ואת התשואה.'
    });
  }
  // The largest move since the previous update, deposits netted out.
  const moved = pensionFunds
    .filter((f) => (f.previousValue ?? 0) > 0)
    .map((f) => ({ f, r: calculateLedgerPeriodReturn(f) }))
    .filter(({ r }) => r.base > 0 && Number.isFinite(r.percent) && Math.abs(r.percent) >= FUND_MOVE_PCT)
    .sort((a, b) => Math.abs(b.r.percent) - Math.abs(a.r.percent))[0];
  if (moved) {
    const up = moved.r.percent > 0;
    out.push({
      key: `fund:${moved.f.id}`,
      kind: 'fund',
      priority: 40,
      tone: up ? 'up' : 'down',
      icon: up ? '📈' : '📉',
      title: `${moved.f.fundName || 'קופת גמל'}: ${pct(moved.r.percent)} מאז העדכון הקודם`,
      text: `${up ? 'רווח' : 'הפסד'} של ${ils(Math.abs(moved.r.gain))}, בניכוי ההפקדות בתקופה.`
    });
  }
  return out;
}

// The fallback when nothing stands out: where the portfolio is overall.
function generalInsight(summary, analysis) {
  if (!summary || !(summary.capitalTotalILS > 0)) return null;
  const ex = (analysis && analysis.exchangeDistribution) || {};
  const parts = [
    ['israeli', 'ת"א'],
    ['american', 'חו"ל'],
    ['pension', 'קופות'],
    ['cashFunds', 'כספיות'],
    ['bank', 'עו"ש'],
    ['bankSavings', 'חיסכון']
  ]
    .map(([k, label]) => ({ label, p: ex[k] ? ex[k].percentage : 0 }))
    .filter((x) => x.p >= 1)
    .sort((a, b) => b.p - a.p)
    .slice(0, 3)
    .map((x) => `${x.label} ${x.p.toFixed(0)}%`)
    .join(' · ');
  const invested = summary.totalPurchaseILS > 0;
  const profitPct = invested ? (summary.totalProfitILS / summary.totalPurchaseILS) * 100 : null;
  return {
    key: 'general',
    kind: 'general',
    priority: 10,
    tone: profitPct === null ? 'info' : profitPct >= 0 ? 'up' : 'down',
    icon: '📊',
    title: profitPct === null ? `שווי התיק ${ils(summary.capitalTotalILS)}` : `התיק ${profitPct >= 0 ? 'ברווח' : 'בהפסד'} של ${pct(profitPct)} מההשקעה`,
    text: parts ? `החלוקה: ${parts}.` : 'אין עדיין חלוקה להציג.'
  };
}

// holdings: the open lots and accounts; analysis: calculatePortfolioAnalysis;
// summary: calculatePortfolioSummary; lastSession: computeLastSessionChange.
export function buildQuickInsights({ holdings = {}, analysis = null, summary = null, lastSession = null, pricesLoaded = false, now = Date.now(), max = MAX_INSIGHTS } = {}) {
  const h = holdingsWithKind(analysis, holdings);
  const candidates = [
    moverInsight(h, lastSession),
    priceHealthInsight(holdings, { pricesLoaded, now }),
    concentrationInsight(h),
    exposureInsight(analysis),
    performerInsight(h),
    ...fundInsights(holdings, { now })
  ].filter(Boolean);

  const chosen = [];
  const kinds = new Set();
  candidates
    .sort((a, b) => b.priority - a.priority)
    .forEach((c) => {
      if (chosen.length >= max || kinds.has(c.kind)) return;
      kinds.add(c.kind);
      chosen.push(c);
    });
  // Something to say even on a quiet day - and only as the last word, when
  // fewer than two things stood out.
  if (chosen.length < Math.min(2, max)) {
    const general = generalInsight(summary, analysis);
    if (general) chosen.push(general);
  }
  return chosen.map(({ priority, ...rest }) => rest);
}
