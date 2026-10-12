// Rule-based recommendations: rebalance, trim, take profit, harvest a tax
// loss, deploy idle cash.
//
// Each rule is a pure function of one PortfolioContext and returns zero or
// more recommendations; a resolver then merges what several rules said
// about the same symbol, drops trades too small to be worth their costs,
// and ranks the rest. Every recommendation carries the numbers that fired
// it (`inputs`), so the page can answer "why am I seeing this?".
//
// THESE ARE PROMPTS, NOT ADVICE. They are mechanical rules over the user's
// own targets and thresholds; the page says so wherever it shows them.
//
// Tax figures follow the rest of the app: 25% on the REAL gain (CPI-indexed
// for Israeli securities, FX-indexed for foreign ones - the same per-lot
// figures taxLossHarvesting.js computes), with losses offsetting gains
// within the calendar year.

import { computeRebalancingPlan, isValidTargetAllocation, CATEGORY_LABELS_HE } from './rebalancing';
import { computeTaxLossHarvestingOpportunities } from './taxLossHarvesting';
import { calculateAmericanStockMetrics } from './portfolioMath';
import { normalizeIsraeliPrice } from './formatters';
import { selectLotsForSale } from '../shared/transactionLedger';
import { computeRealizedGains } from './realizedGains';

export const TAX_RATE = 0.25;

export const DEFAULT_RECOMMENDATION_PREFS = {
  driftAbsPp: 5, // category drift that triggers a rebalance, in percentage points...
  driftRel: 0.25, // ...or relative to its target (the "5/25 rule")
  positionCapPct: 15, // single-position concentration cap, % of the portfolio
  profitTakePct: 50, // unrealized gain that makes an over-weight position a profit-taking candidate
  tlhMinLossILS: 1000, // smallest real loss worth harvesting
  lotMethod: 'FIFO', // how the broker matches sold units to lots
  usTaxResident: false, // the US 30-day wash-sale rule applies to US tax residents
  minTradeILS: 500, // trades smaller than this are dropped
  maxItems: 7,
  enabledRules: ['drift', 'concentration', 'profit-taking', 'tax-loss-harvest', 'cash-drag']
};

export const RULE_LABELS_HE = {
  drift: 'סטייה מהקצאת יעד',
  concentration: 'ריכוזיות',
  'profit-taking': 'מימוש רווחים',
  'tax-loss-harvest': 'קיזוז הפסדים',
  'cash-drag': 'מזומן עודף'
};

const SEVERITY_RANK = { low: 0, medium: 1, high: 2 };
const DAY_MS = 86400000;
const WASH_SALE_DAYS = 30;

const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Context

const lotValueILS = (market, lot) =>
  market === 'american'
    ? calculateAmericanStockMetrics(lot).totalCurrentValueILS
    : (normalizeIsraeliPrice(lot.currentPrice) || 0) * (Number(lot.quantity) || 0);

const lotCostILS = (market, lot) =>
  market === 'american'
    ? (Number(lot.purchasePrice) || 0) * (Number(lot.quantity) || 0) * (Number(lot.exchangeRate) || 0)
    : (Number(lot.purchasePrice) || 0) * (Number(lot.quantity) || 0);

// Builds everything the rules read from the app's own data.
export function buildRecommendationContext({
  israeliStocks = [],
  americanStocks = [],
  pensionFunds = [],
  cashFunds = [],
  bankSavingsFunds = [],
  analysis,
  targets = null,
  cpi = null,
  transactions = [],
  prefs = {},
  today = new Date().toISOString().slice(0, 10)
}) {
  const settings = { ...DEFAULT_RECOMMENDATION_PREFS, ...(prefs || {}) };
  const totalValueILS = analysis?.exchangeDistribution?.total || 0;

  // Per-lot real gain, from the same computation the tax page uses.
  const tlh = computeTaxLossHarvestingOpportunities(israeliStocks, americanStocks, pensionFunds, cpi, bankSavingsFunds);
  const realGainByLot = new Map();
  [...tlh.lossPositions, ...tlh.gainPositions].forEach((p) => {
    if (p.category === 'israeli' || p.category === 'american') realGainByLot.set(`${p.category}:${p.id}`, p.realGain);
  });

  const positionsBySymbol = new Map();
  const addLots = (lots, market) => {
    lots.forEach((lot) => {
      const raw = String(lot.stockName || '').trim();
      if (!raw || !(Number(lot.quantity) > 0)) return;
      const symbol = market === 'american' ? raw.toUpperCase() : raw;
      const key = `${market}:${symbol}`;
      const p = positionsBySymbol.get(key) || { key, symbol, market, name: '', units: 0, valueILS: 0, costILS: 0, realGainILS: 0, lots: [] };
      const valueILS = lotValueILS(market, lot);
      const realGain = realGainByLot.has(`${market}:${lot.id}`) ? realGainByLot.get(`${market}:${lot.id}`) : 0;
      p.units += Number(lot.quantity);
      p.valueILS += valueILS;
      p.costILS += lotCostILS(market, lot);
      p.realGainILS += realGain;
      if (!p.name && lot.officialName) p.name = lot.officialName;
      p.lots.push({ ...lot, stockName: symbol, valueILS, realGainILS: realGain });
      positionsBySymbol.set(key, p);
    });
  };
  addLots(israeliStocks, 'israeli');
  addLots(americanStocks, 'american');

  const positions = [...positionsBySymbol.values()].map((p) => ({
    ...p,
    weightPct: totalValueILS > 0 ? (p.valueILS / totalValueILS) * 100 : 0,
    unrealizedGainPct: p.costILS > 0 ? ((p.valueILS - p.costILS) / p.costILS) * 100 : 0
  }));

  const year = today.slice(0, 4);
  const realized = computeRealizedGains(transactions, { indexByMonth: cpi?.indexByMonth || {} });
  const realizedYTD = realized.byYear[year] || { netRealGainILS: 0, realGainsILS: 0, realLossesILS: 0 };

  return {
    today,
    prefs: settings,
    totalValueILS,
    categoryAllocation: analysis?.exchangeDistribution || null,
    targets,
    positions,
    realizedNetGainYTD: realizedYTD.netRealGainILS || 0,
    openRealGainsILS: tlh.totalCurrentGains,
    transactions,
    lotsBySymbol: positionsBySymbol
  };
}

// ---------------------------------------------------------------------------
// Tax helpers

// Real gain realized by selling `units` of a position under the chosen lot
// method (per-lot real gains, pro-rated by the units taken from each lot).
export function realGainOfSale(position, units, lotMethod = 'FIFO', date) {
  const picks = selectLotsForSale(position.lots, {
    assetClass: position.market,
    assetId: position.symbol,
    units: Math.min(units, position.units),
    date: date || '9999-12-31',
    lotMethod: lotMethod === 'SPECIFIC' ? 'HIFO' : lotMethod
  });
  return picks.reduce((sum, { lot, units: taken }) => sum + lot.realGainILS * (taken / Number(lot.quantity)), 0);
}

// Tax on a real gain after offsetting the losses already realized this
// year that have not been used up by realized gains.
function taxOnGain(realGain, ctx) {
  if (realGain <= 0) return 0;
  const unusedLosses = Math.max(0, -ctx.realizedNetGainYTD);
  return Math.max(0, realGain - unusedLosses) * TAX_RATE;
}

// US 30-day wash-sale window: a purchase of the same security within 30
// days BEFORE the sale (or planned within 30 days after) disallows the loss
// for a US taxpayer. Israeli law has no identical statutory rule, but a
// sell-and-rebuy with no economic substance may still be challenged - so the
// recommendation always proposes a similar, not identical, replacement.
export function washSaleCheck(position, transactions, today) {
  const windowStart = addDays(today, -WASH_SALE_DAYS);
  const recentLotBuys = position.lots.filter((lot) => lot.purchaseDate && lot.purchaseDate > windowStart && lot.purchaseDate <= today);
  const recentLedgerBuys = (transactions || []).filter(
    (tx) =>
      tx.type === 'BUY' &&
      tx.assetClass === position.market &&
      String(tx.assetId).toUpperCase() === position.symbol.toUpperCase() &&
      tx.date > windowStart &&
      tx.date <= today
  );
  const dates = [...new Set([...recentLotBuys.map((l) => l.purchaseDate), ...recentLedgerBuys.map((t) => t.date)])].sort();
  return {
    recentBuyDates: dates,
    conflict: dates.length > 0,
    // The first day a sale no longer has a purchase within the prior 30 days.
    clearFrom: dates.length ? addDays(dates[dates.length - 1], WASH_SALE_DAYS + 1) : today,
    // Do not buy it back before this date.
    noRebuyUntil: addDays(today, WASH_SALE_DAYS + 1)
  };
}

// The loss a harvest can actually realize under the lot method. With FIFO
// the oldest lots go first, so the best available loss is the most negative
// running total over the oldest-first sequence; with HIFO/specific
// identification only the loss lots are sold.
export function harvestableLoss(position, lotMethod) {
  const lots = position.lots.slice().sort((a, b) => (a.purchaseDate < b.purchaseDate ? -1 : a.purchaseDate > b.purchaseDate ? 1 : 0));
  if (lotMethod === 'FIFO') {
    let running = 0;
    let best = { loss: 0, units: 0 };
    let units = 0;
    lots.forEach((lot) => {
      running += lot.realGainILS;
      units += Number(lot.quantity);
      if (running < best.loss) best = { loss: running, units };
    });
    return { lossILS: -best.loss, units: best.units };
  }
  const lossLots = lots.filter((l) => l.realGainILS < 0);
  return {
    lossILS: -lossLots.reduce((s, l) => s + l.realGainILS, 0),
    units: lossLots.reduce((s, l) => s + Number(l.quantity), 0)
  };
}

// ---------------------------------------------------------------------------
// Rules

const fmt = (n) => Math.round(n).toLocaleString('en-US');

export const driftRule = {
  id: 'drift',
  evaluate(ctx) {
    if (!ctx.targets || !isValidTargetAllocation(ctx.targets) || !ctx.categoryAllocation) return [];
    const plan = computeRebalancingPlan(ctx.categoryAllocation, ctx.targets);
    return plan.rows
      .filter((r) => r.targetPercent > 0 || r.currentPercent > 0)
      .filter((r) => {
        const abs = Math.abs(r.diffPercent);
        const rel = r.targetPercent > 0 ? abs / r.targetPercent : Infinity;
        return abs >= ctx.prefs.driftAbsPp || rel >= ctx.prefs.driftRel;
      })
      // A relative drift on a tiny target (0.5pp off a 1% target) is not
      // worth a trade; require at least one point either way.
      .filter((r) => Math.abs(r.diffPercent) >= 1)
      .map((r) => {
        const over = r.diffValue < 0;
        return {
          id: `drift:${r.key}`,
          rule: 'drift',
          action: 'REBALANCE',
          category: r.key,
          severity: Math.abs(r.diffPercent) >= 10 ? 'high' : 'medium',
          amountILS: r.diffValue,
          title: `${over ? 'הקטנת' : 'הגדלת'} ${CATEGORY_LABELS_HE[r.key] || r.key}`,
          rationale: `${CATEGORY_LABELS_HE[r.key] || r.key} מהווה ${r.currentPercent.toFixed(1)}% מהתיק מול יעד של ${r.targetPercent}%. ${
            over
              ? `למכור כ-₪${fmt(-r.diffValue)} - או, בלי מס, להפנות הפקדות חדשות לקטגוריות שמתחת ליעד.`
              : `להוסיף כ-₪${fmt(r.diffValue)}, רצוי מהפקדות חדשות.`
          }`,
          inputs: { currentPercent: r.currentPercent, targetPercent: r.targetPercent, diffPercent: r.diffPercent }
        };
      });
  }
};

export const concentrationRule = {
  id: 'concentration',
  evaluate(ctx) {
    const cap = ctx.prefs.positionCapPct;
    return ctx.positions
      .filter((p) => p.weightPct > cap)
      .map((p) => {
        const sellILS = ((p.weightPct - cap) / 100) * ctx.totalValueILS;
        const units = p.units * (sellILS / p.valueILS);
        const realGain = realGainOfSale(p, units, ctx.prefs.lotMethod, ctx.today);
        return {
          id: `concentration:${p.key}`,
          rule: 'concentration',
          action: 'TRIM',
          symbol: p.symbol,
          market: p.market,
          severity: p.weightPct > cap * 1.5 ? 'high' : 'medium',
          amountILS: -sellILS,
          units,
          estTaxILS: taxOnGain(realGain, ctx),
          title: `${p.name || p.symbol}: ${p.weightPct.toFixed(1)}% מהתיק`,
          rationale: `פוזיציה בודדת מעל תקרה של ${cap}%. הקטנה לתקרה פירושה מכירה של כ-₪${fmt(sellILS)} (${units.toFixed(2)} יח').`,
          inputs: { weightPct: p.weightPct, capPct: cap, realGainOfSaleILS: realGain }
        };
      });
  }
};

export const profitTakingRule = {
  id: 'profit-taking',
  evaluate(ctx) {
    const cap = ctx.prefs.positionCapPct;
    return ctx.positions
      .filter((p) => p.unrealizedGainPct >= ctx.prefs.profitTakePct && p.weightPct > cap)
      .map((p) => {
        // Down to target, not the whole gain: the excess over the cap.
        const sellILS = ((p.weightPct - cap) / 100) * ctx.totalValueILS;
        const units = p.units * (sellILS / p.valueILS);
        const realGain = realGainOfSale(p, units, ctx.prefs.lotMethod, ctx.today);
        const tax = taxOnGain(realGain, ctx);
        return {
          id: `profit-taking:${p.key}`,
          rule: 'profit-taking',
          action: 'TRIM',
          symbol: p.symbol,
          market: p.market,
          severity: p.weightPct > cap * 1.5 ? 'high' : 'medium',
          amountILS: -sellILS,
          units,
          estTaxILS: tax,
          title: `מימוש חלקי ב-${p.name || p.symbol}`,
          rationale: `עלתה ${p.unrealizedGainPct.toFixed(0)}% ומהווה ${p.weightPct.toFixed(1)}% מהתיק. מימוש של כ-₪${fmt(sellILS)} מחזיר אותה ל-${cap}%; מס משוער ₪${fmt(tax)} (${ctx.prefs.lotMethod}), נשאר ביד כ-₪${fmt(sellILS - tax)}.`,
          inputs: { unrealizedGainPct: p.unrealizedGainPct, weightPct: p.weightPct, capPct: cap, realGainOfSaleILS: realGain }
        };
      });
  }
};

export const taxLossHarvestRule = {
  id: 'tax-loss-harvest',
  evaluate(ctx) {
    const month = Number(ctx.today.slice(5, 7));
    const yearEnd = month >= 10;
    // What a harvested loss can offset: gains already realized this year,
    // and - near year end - open gains the user could still realize.
    const offsettable = Math.max(0, ctx.realizedNetGainYTD) + (yearEnd ? ctx.openRealGainsILS : 0);
    if (!(offsettable > 0)) return [];
    return ctx.positions
      .map((p) => ({ p, h: harvestableLoss(p, ctx.prefs.lotMethod) }))
      .filter(({ h }) => h.lossILS >= ctx.prefs.tlhMinLossILS)
      .map(({ p, h }) => {
        const usable = Math.min(h.lossILS, offsettable);
        const saved = usable * TAX_RATE;
        const wash = washSaleCheck(p, ctx.transactions, ctx.today);
        const sellILS = p.valueILS * (h.units / p.units);
        const blockedByWashSale = p.market === 'american' && ctx.prefs.usTaxResident && wash.conflict;
        let rationale = `הפסד ריאלי של ₪${fmt(h.lossILS)} (${ctx.prefs.lotMethod}, ${h.units} יח'). מימוש יקזז רווחים של עד ₪${fmt(usable)} וחוסך כ-₪${fmt(saved)} מס.`;
        rationale += ' כדי לשמור על החשיפה, קנו נייר דומה אך לא זהה (למשל תעודת סל של מנפיק אחר או תעודת סל ענפית).';
        if (blockedByWashSale) {
          rationale += ` כלל ה-Wash Sale: נקנו יחידות ב-${wash.recentBuyDates.join(', ')} - מכירה לפני ${wash.clearFrom} תשלול את ההפסד.`;
        } else if (p.market === 'american' && ctx.prefs.usTaxResident) {
          rationale += ` אל תקנו בחזרה את אותו נייר לפני ${wash.noRebuyUntil} (כלל ה-Wash Sale).`;
        }
        if (yearEnd) rationale += ' כדי שייחשב לשנה הנוכחית, המימוש צריך להתבצע עד סוף דצמבר.';
        return {
          id: `tax-loss-harvest:${p.key}`,
          rule: 'tax-loss-harvest',
          action: 'HARVEST',
          symbol: p.symbol,
          market: p.market,
          severity: blockedByWashSale ? 'low' : yearEnd && month === 12 ? 'high' : 'medium',
          amountILS: -sellILS,
          units: h.units,
          estTaxSavedILS: saved,
          blocked: blockedByWashSale ? { reason: 'WASH_SALE', until: wash.clearFrom } : null,
          title: `קיזוז הפסד ב-${p.name || p.symbol}`,
          rationale,
          inputs: { harvestableLossILS: h.lossILS, offsettableGainsILS: offsettable, lotMethod: ctx.prefs.lotMethod }
        };
      });
  }
};

export const cashDragRule = {
  id: 'cash-drag',
  evaluate(ctx) {
    if (!ctx.targets || !isValidTargetAllocation(ctx.targets) || !ctx.categoryAllocation) return [];
    const plan = computeRebalancingPlan(ctx.categoryAllocation, ctx.targets);
    const cashKeys = ['bank', 'cashFunds'];
    const cash = plan.rows.filter((r) => cashKeys.includes(r.key));
    const excessPp = cash.reduce((s, r) => s + (r.currentPercent - r.targetPercent), 0);
    if (excessPp <= ctx.prefs.driftAbsPp) return [];
    const underweight = plan.rows.filter((r) => !cashKeys.includes(r.key) && r.diffValue > 0).sort((a, b) => b.diffValue - a.diffValue)[0];
    if (!underweight) return [];
    const amount = Math.min(underweight.diffValue, (excessPp / 100) * ctx.totalValueILS);
    return [
      {
        id: 'cash-drag',
        rule: 'cash-drag',
        action: 'DEPLOY',
        category: underweight.key,
        severity: 'medium',
        amountILS: amount,
        title: `להשקיע מזומן עודף ב${CATEGORY_LABELS_HE[underweight.key] || underweight.key}`,
        rationale: `מזומן ועו"ש גבוהים ביעד ב-${excessPp.toFixed(1)} נקודות אחוז. העברה של כ-₪${fmt(amount)} ל${CATEGORY_LABELS_HE[underweight.key] || underweight.key}, שנמצאת מתחת ליעד, מאזנת את שתיהן בלי מכירה ובלי מס.`,
        inputs: { excessCashPp: excessPp }
      }
    ];
  }
};

export const DEFAULT_RULES = [driftRule, concentrationRule, profitTakingRule, taxLossHarvestRule, cashDragRule];

// ---------------------------------------------------------------------------
// Resolver

export function resolveRecommendations(items, prefs = DEFAULT_RECOMMENDATION_PREFS) {
  const bySymbol = new Map();
  const others = [];
  items.forEach((item) => {
    if (!item.symbol) {
      others.push(item);
      return;
    }
    const key = `${item.market}:${item.symbol}`;
    if (!bySymbol.has(key)) bySymbol.set(key, []);
    bySymbol.get(key).push(item);
  });

  const merged = [];
  bySymbol.forEach((list) => {
    const harvest = list.find((i) => i.action === 'HARVEST');
    const trims = list.filter((i) => i.action === 'TRIM');
    if (harvest) {
      // Selling losses first beats trimming the same position: the harvest
      // sells the loss lots, which also reduces the over-weight.
      merged.push({ ...harvest, alsoFlagged: trims.map((t) => t.rule) });
      return;
    }
    if (trims.length > 1) {
      // Concentration and profit-taking on one position describe the same
      // trade; keep one, with both reasons.
      const primary = trims.find((t) => t.rule === 'profit-taking') || trims[0];
      const top = trims.reduce((a, b) => (SEVERITY_RANK[b.severity] > SEVERITY_RANK[a.severity] ? b : a));
      merged.push({ ...primary, severity: top.severity, alsoFlagged: trims.filter((t) => t !== primary).map((t) => t.rule) });
      return;
    }
    merged.push(...list);
  });

  return merged
    .concat(others)
    .filter((i) => Math.abs(i.amountILS || 0) >= prefs.minTradeILS)
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        Math.abs(b.amountILS || 0) + (b.estTaxSavedILS || 0) - (Math.abs(a.amountILS || 0) + (a.estTaxSavedILS || 0))
    )
    .slice(0, prefs.maxItems);
}

export function runRecommendationEngine(ctx, rules = DEFAULT_RULES) {
  const enabled = new Set(ctx.prefs.enabledRules);
  const raw = rules.filter((r) => enabled.has(r.id)).flatMap((r) => r.evaluate(ctx));
  return resolveRecommendations(raw, ctx.prefs);
}
