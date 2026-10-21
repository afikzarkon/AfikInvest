// "Ideas to enrich the portfolio": investments worth getting to know, each
// tied to a specific gap or concentration found in the user's own
// portfolio.
//
// EDUCATIONAL, NOT ADVICE. Nothing here says buy or sell, and nothing is
// ranked by past performance - the catalog does not even carry returns. An
// idea is ranked by how large the gap behind it is.
//
// THE CATALOG IS THE SOURCE OF TRUTH (data/investmentCatalog.json). Only
// items that exist there are ever shown, and only with the fields they
// have; a missing fee is shown as missing, not guessed. Leveraged and
// crypto products are shown only to someone who already holds one.
//
// TRANSPARENT RULES. Each rule below reads one number from the portfolio,
// compares it with a threshold from portfolioReviewConfig.js, and says
// both in its reason. Pure: the review in, ideas out.
import catalogData from '../data/investmentCatalog.json';
import { IDEAS_CONFIG, HORIZON_LABELS_HE, RISK_LABELS_HE } from './portfolioReviewConfig';
import { summarizeAllocation, KNOWN_US_FUNDS } from './portfolioReviewData';
import { combineCategoryScores, scoreDiversification } from './portfolioReviewScoring';
import { ETF_SECTOR_KEY, UNCLASSIFIED_SECTOR_KEY, sectorLabelHe } from './sectorLabels';
import { ils, pct } from './portfolioReviewText';

export const CATALOG = catalogData.items;
export const CATALOG_NOTICE_HE = catalogData.notice;

export const REGION_NAMES_HE = {
  israel: 'ישראל',
  us: 'ארה"ב',
  global: 'העולם כולו',
  globalExUs: 'העולם ללא ארה"ב',
  europe: 'אירופה',
  emerging: 'שווקים מתפתחים',
  abroadOther: 'חו"ל'
};

export const ASSET_CLASS_LABELS_HE = {
  equity: 'מניות',
  bond: 'אג"ח',
  deposit: 'פיקדונות וחיסכון',
  realEstate: 'נדל"ן',
  commodity: 'סחורות',
  crypto: 'קריפטו',
  cash: 'מזומן',
  mixed: 'מעורב / לא ידוע'
};

const TYPE_LABELS_HE = {
  etf: 'קרן סל מנייתית',
  bondEtf: 'קרן סל אג"ח',
  reitEtf: 'קרן סל נדל"ן',
  commodityEtf: 'קרן סחורה',
  leveragedEtf: 'קרן ממונפת',
  cryptoEtf: 'קרן קריפטו'
};
export const typeLabelHe = (type) => TYPE_LABELS_HE[type] || type;

const US_BOND_FUNDS = new Set(['BND', 'AGG', 'TLT', 'IEF', 'SHY', 'BNDX', 'TIP']);
const US_REAL_ESTATE_FUNDS = new Set(['VNQ', 'XLRE']);
const US_COMMODITY_FUNDS = new Set(['GLD', 'IAU', 'SLV']);
const US_FUND_SET = new Set(KNOWN_US_FUNDS);
const BOND_WORDS = ['אג"ח', 'אגח', 'אג״ח', 'בונד', 'BOND'];

const hasWord = (text, words) => words.some((w) => String(text || '').toUpperCase().includes(w.toUpperCase()));

// ---------------------------------------------------------------------------
// What the portfolio is exposed to

export function catalogItemForHolding(item, catalog = CATALOG) {
  if (!item.symbol) return null;
  return catalog.find((c) => c.symbol && c.symbol.toUpperCase() === String(item.symbol).toUpperCase()) || null;
}

// The asset class and region of one allocation item, from the catalog
// when the holding is in it, else from what the app knows about it.
export function exposureOf(item, catalog = CATALOG) {
  const known = catalogItemForHolding(item, catalog);
  if (known) return { assetClass: known.assetClass, region: known.region, catalogId: known.id, leveraged: Boolean(known.leveraged), crypto: Boolean(known.crypto) };
  if (item.instrument === 'cash' || item.instrument === 'moneyMarket') return { assetClass: 'cash', region: null };
  if (item.instrument === 'deposit') return { assetClass: 'deposit', region: 'israel' };
  if (item.instrument === 'providentFund') {
    // Only the fund's name is known; a track named for bonds or for shares
    // is taken at its word, anything else stays unknown.
    if (hasWord(item.label, BOND_WORDS)) return { assetClass: 'bond', region: null };
    if (hasWord(item.label, ['מניות', 'מחקה', 'S&P'])) return { assetClass: 'equity', region: null };
    return { assetClass: 'mixed', region: null };
  }
  if (item.market === 'american') {
    const s = String(item.symbol || '').toUpperCase();
    if (US_BOND_FUNDS.has(s)) return { assetClass: 'bond', region: 'us' };
    if (US_REAL_ESTATE_FUNDS.has(s)) return { assetClass: 'realEstate', region: 'us' };
    if (US_COMMODITY_FUNDS.has(s)) return { assetClass: 'commodity', region: 'global' };
    return { assetClass: 'equity', region: 'us' };
  }
  // A TASE security.
  if (hasWord(item.label, BOND_WORDS)) return { assetClass: 'bond', region: item.region === 'abroad' ? 'abroadOther' : 'israel' };
  if (item.sectorKey === 'Real Estate') return { assetClass: 'realEstate', region: 'israel' };
  return { assetClass: 'equity', region: item.region === 'abroad' ? 'abroadOther' : 'israel' };
}

// Every share the rules read, in percent.
export function portfolioExposure(allocation, catalog = CATALOG) {
  const items = (allocation && allocation.items) || [];
  const enriched = items.map((i) => ({ ...i, ...exposureOf(i, catalog) }));
  const total = enriched.reduce((s, i) => s + i.value, 0);
  const invested = enriched.filter((i) => i.assetClass !== 'cash');
  const investedTotal = invested.reduce((s, i) => s + i.value, 0);
  const share = (list, base) => (base > 0 ? (list.reduce((s, i) => s + i.value, 0) / base) * 100 : 0);

  const byClass = {};
  invested.forEach((i) => {
    byClass[i.assetClass] = (byClass[i.assetClass] || 0) + i.value;
  });
  const classPct = (k) => (investedTotal > 0 ? ((byClass[k] || 0) / investedTotal) * 100 : 0);

  const securities = enriched.filter((i) => i.market === 'israeli' || i.market === 'american');
  const secTotal = securities.reduce((s, i) => s + i.value, 0);
  const g = IDEAS_CONFIG.globalFundUsShare;
  const regionValue = (fn) => securities.reduce((s, i) => s + i.value * fn(i.region), 0);
  const usPct = secTotal > 0 ? (regionValue((r) => (r === 'us' ? 1 : r === 'global' ? g : 0)) / secTotal) * 100 : 0;
  const israelPct = secTotal > 0 ? (regionValue((r) => (r === 'israel' ? 1 : 0)) / secTotal) * 100 : 0;
  const exUsPct = secTotal > 0 ? (regionValue((r) => (r === 'globalExUs' || r === 'europe' || r === 'emerging' ? 1 : r === 'global' ? 1 - g : 0)) / secTotal) * 100 : 0;

  // Single stocks by sector, of the securities.
  const stocks = securities.filter((i) => i.instrument === 'stock');
  const stockSectors = {};
  stocks.forEach((s) => {
    const key = s.sectorKey && s.sectorKey !== UNCLASSIFIED_SECTOR_KEY && s.sectorKey !== ETF_SECTOR_KEY ? s.sectorKey : null;
    if (!key) return;
    if (!stockSectors[key]) stockSectors[key] = { key, value: 0, names: [] };
    stockSectors[key].value += s.value;
    stockSectors[key].names.push(s.label);
  });

  const sectorRows = ((allocation && allocation.bySector) || []).filter((r) => r.key !== ETF_SECTOR_KEY && r.key !== UNCLASSIFIED_SECTOR_KEY);
  const currencyRows = (allocation && allocation.byCurrency) || [];

  return {
    total,
    investedTotal,
    securitiesTotal: secTotal,
    classPct,
    fixedIncomePct: classPct('bond') + classPct('deposit'),
    cashPct: total > 0 ? ((total - investedTotal) / total) * 100 : 0,
    usPct,
    israelPct,
    exUsPct,
    singleStocksPct: share(stocks, investedTotal),
    stockSectors: Object.values(stockSectors)
      .map((s) => ({ ...s, pct: secTotal > 0 ? (s.value / secTotal) * 100 : 0 }))
      .sort((a, b) => b.value - a.value),
    topSector: sectorRows[0] ? { key: sectorRows[0].key, label: sectorRows[0].label, pct: sectorRows[0].share * 100 } : null,
    heldSectors: new Set(sectorRows.map((r) => r.key)),
    dollarPct: ((currencyRows.find((r) => r.key === 'USD') || {}).share || 0) * 100,
    heldSymbols: new Set(securities.map((i) => String(i.symbol || '').toUpperCase()).filter(Boolean)),
    heldCatalogIds: new Set(enriched.map((i) => i.catalogId).filter(Boolean)),
    holdsLeveraged: enriched.some((i) => i.leveraged),
    holdsCrypto: enriched.some((i) => i.crypto),
    usBroadFunds: securities.filter((i) => i.market === 'american' && US_FUND_SET.has(String(i.symbol).toUpperCase()) && i.region === 'us' && i.assetClass === 'equity'),
    unpriced: (allocation && allocation.unpriced) || []
  };
}

// ---------------------------------------------------------------------------
// The rules. Each returns candidates: { id (catalog item), kind, rule,
// priority, reason }.

const find = (catalog, id) => catalog.find((c) => c.id === id);

function rules(ex, catalog) {
  const r = IDEAS_CONFIG.rules;
  const p = IDEAS_CONFIG.priority;
  const out = [];
  const add = (ids, kind, rule, reason) =>
    ids.forEach((id, i) => {
      if (find(catalog, id)) out.push({ id, kind, rule, priority: p[rule] - i, reason });
    });

  // --- Similar to what you know

  // Single stocks of one sector -> a fund on the same sector.
  ex.stockSectors.forEach((s) => {
    const enough = s.pct >= r.sectorStocksPct && (s.names.length >= r.sectorStocksMinCount || s.pct >= r.sectorSingleStockPct);
    if (!enough) return;
    const funds = catalog.filter((c) => c.sectorKey === s.key && !c.leveraged).map((c) => c.id);
    const names = s.names.slice(0, 3).join(', ') + (s.names.length > 3 ? ' ועוד' : '');
    add(funds, 'similar', 'sectorStocksToEtf', `${pct(s.pct)} מניירות הערך שלך ב-${s.names.length === 1 ? 'מניה בודדת' : `${s.names.length} מניות בודדות`} בסקטור ${sectorLabelHe(s.key)} (${names}). קרן על אותו סקטור מחזיקה את אותה חשיפה מפוזרת על עשרות חברות.`);
  });

  // Mostly single stocks of one market -> the broad fund on that market.
  if (ex.singleStocksPct >= r.regionStocksPct) {
    if (ex.israelPct >= 50) add(['il-ta125-tracker'], 'similar', 'regionStocksToBroad', `${pct(ex.singleStocksPct)} מהתיק המושקע במניות בודדות, ורובן בישראל. קרן על ת"א-125 היא אותו שוק בנייר אחד.`);
    else if (ex.usPct >= 50) add(['voo'], 'similar', 'regionStocksToBroad', `${pct(ex.singleStocksPct)} מהתיק המושקע במניות בודדות, ורוב ניירות הערך בארה"ב (${pct(ex.usPct)}). קרן על S&P 500 היא אותו שוק בלי תלות בבחירת חברות.`);
  }

  // An S&P 500 fund held in New York -> the same index listed in Tel Aviv.
  if (ex.usBroadFunds.length) {
    const names = ex.usBroadFunds.map((f) => f.symbol).join(', ');
    add(['il-sp500-tracker', 'vwra'], 'similar', 'sameExposureLocal', `אתה כבר מחזיק קרן מדדית אמריקאית (${names}). קיימות גרסאות של חשיפה דומה הנסחרות בתל אביב או רשומות באירלנד, שנבדלות בעיקר במיסוי, בעלויות ובשעות המסחר.`);
  }

  // --- Complementary or different

  if (ex.investedTotal > 0 && ex.fixedIncomePct < r.fixedIncomeMinPct) {
    const order = ex.dollarPct >= 50 ? ['bnd', 'il-gov-bond-fund', 'shy'] : ['il-gov-bond-fund', 'bnd', 'il-corp-bond-fund'];
    add(order, 'complement', 'noFixedIncome', `אג"ח ופיקדונות הם ${pct(ex.fixedIncomePct, 1)} בלבד מהתיק המושקע שלך. כמעט כל התיק תלוי בשוק המניות.`);
  }
  if (ex.securitiesTotal > 0 && ex.usPct >= r.usHeavyPct && ex.exUsPct < r.exUsMinPct) {
    add(['vxus', 'vgk', 'vwo'], 'complement', 'usConcentration', `${pct(ex.usPct)} מניירות הערך שלך בארה"ב, ו-${pct(ex.exUsPct)} בלבד בשאר העולם מחוץ לישראל - אין לך כמעט חשיפה לשוק האירופי או לשווקים המתפתחים.`);
  }
  if (ex.securitiesTotal > 0 && ex.israelPct >= r.homeHeavyPct) {
    add(['vt', 'vwra'], 'complement', 'homeBias', `${pct(ex.israelPct)} מניירות הערך שלך בישראל. השוק הישראלי הוא חלק קטן מהשוק העולמי, וקרן עולמית מוסיפה אלפי חברות ממדינות אחרות.`);
  }
  if (ex.securitiesTotal > 0 && ex.israelPct < r.homeMinPct && ex.dollarPct >= r.dollarHeavyPct) {
    add(['il-ta125-tracker', 'il-gov-bond-fund'], 'complement', 'noHome', `${pct(ex.dollarPct)} מהתיק חשוף לדולר ופחות מ-${r.homeMinPct}% בישראל. אם את רוב ההוצאות שלך תשלם בשקלים, נכס שקלי מקטין את התלות בשער.`);
  }
  if (ex.topSector && ex.topSector.pct >= r.sectorHeavyPct) {
    const missing = catalog.filter((c) => c.sectorKey && c.sectorKey !== ex.topSector.key && !ex.heldSectors.has(c.sectorKey) && c.assetClass === 'equity' && !c.leveraged);
    const missingNames = missing.slice(0, 3).map((c) => sectorLabelHe(c.sectorKey)).join(', ');
    add(
      [...missing.map((c) => c.id), 'vt'],
      'complement',
      'sectorGap',
      `${pct(ex.topSector.pct)} מניירות הערך שלך בסקטור ${ex.topSector.label}${missingNames ? `, ואין לך חשיפה לסקטורים: ${missingNames}` : ''}.`
    );
  }
  if (ex.investedTotal > 0 && ex.singleStocksPct >= r.singleStocksHeavyPct) {
    add(['vt', 'voo'], 'complement', 'singleStocksHeavy', `${pct(ex.singleStocksPct)} מהתיק המושקע שלך במניות בודדות. קרן מדדית רחבה היא דרך שונה להשקיע: בלי לבחור חברות, ובלי שחברה אחת תכריע.`);
  }
  if (ex.investedTotal >= r.minPortfolioForSatellitesILS && ex.classPct('realEstate') === 0) {
    add(['vnq'], 'complement', 'noRealEstate', 'אין בתיק חשיפה לנדל"ן מניב. קרנות ריט הן דרך סחירה להכיר את סוג הנכס הזה.');
  }
  if (ex.investedTotal >= r.minPortfolioForSatellitesILS && ex.classPct('commodity') === 0) {
    add(['iau'], 'complement', 'noCommodity', 'אין בתיק סחורות. זהב הוא נכס שמתנהג לא פעם אחרת ממניות ואג"ח.');
  }
  return out;
}

// ---------------------------------------------------------------------------
// "What it changes": 10% of the next deposit into the idea, the rest in the
// current mix, and the diversification figures and score before and after.

function asAllocationItem(c, value) {
  const market = c.listing === 'TASE' ? 'israeli' : 'american';
  return {
    id: `idea:${c.id}`,
    market,
    symbol: c.symbol,
    label: c.symbol || c.nameHe,
    instrument: 'fund',
    sectorKey: c.sectorKey || ETF_SECTOR_KEY,
    currency: c.currency,
    region: c.region === 'israel' ? 'israel' : 'abroad',
    account: market,
    value
  };
}

const snapshot = (allocation, review) => {
  const div = scoreDiversification({ allocation });
  const ex = portfolioExposure(allocation);
  const categories = review.categories.map((c) => (c.key === 'diversification' ? { ...div, weight: c.weight } : c));
  return {
    largestPct: div.metrics.largest ? div.metrics.largest.pct : null,
    topSectorPct: div.metrics.topSector ? div.metrics.topSector.pct : null,
    topCurrencyPct: div.metrics.topCurrency ? div.metrics.topCurrency.pct : null,
    israelPct: ex.israelPct,
    fixedIncomePct: ex.fixedIncomePct,
    diversificationScore: div.score,
    overallScore: combineCategoryScores(categories).score
  };
};

export function simulateIdea(c, review, depositILS, share = IDEAS_CONFIG.simulatedDepositShare) {
  const allocation = review.allocation;
  if (!(depositILS > 0) || !allocation || !(allocation.total > 0) || allocation.unpriced.length) return null;
  const invested = allocation.items.filter((i) => i.instrument !== 'cash' && i.instrument !== 'moneyMarket');
  const investedTotal = invested.reduce((s, i) => s + i.value, 0);
  const rest = depositILS * (1 - share);
  const items = allocation.items.map((i) => {
    const extra = investedTotal > 0 && invested.includes(i) ? rest * (i.value / investedTotal) : 0;
    return { ...i, value: i.value + extra };
  });
  const existing = items.find((i) => c.symbol && i.symbol && String(i.symbol).toUpperCase() === c.symbol.toUpperCase());
  if (existing) existing.value += depositILS * share;
  else items.push(asAllocationItem(c, depositILS * share));
  const after = summarizeAllocation(items, { date: allocation.date });
  return { depositILS, share, amountILS: depositILS * share, before: snapshot(allocation, review), after: snapshot(after, review) };
}

// ---------------------------------------------------------------------------
// Fit to the horizon and the investor profile

const HORIZON_RANK = { short: 0, medium: 1, long: 2 };

export function userHorizon(review) {
  const goal = review.categories.find((c) => c.key === 'goal');
  if (goal && goal.status === 'scored' && Number.isFinite(goal.metrics.monthsLeft) && !goal.metrics.achieved) {
    const years = goal.metrics.monthsLeft / 12;
    return { key: years < 2 ? 'short' : years < 5 ? 'medium' : 'long', source: 'goal', years };
  }
  const profile = review.text && review.text.profile && review.text.profile.key;
  if (profile === 'longTerm' || profile === 'steady') return { key: 'long', source: 'behaviour' };
  if (profile === 'active') return { key: 'short', source: 'behaviour' };
  return { key: null, source: null };
}

export function fitFor(c, review) {
  const horizon = userHorizon(review);
  const profile = (review.text && review.text.profile) || {};
  const notes = [];
  notes.push(`אופק מתאים: ${HORIZON_LABELS_HE[c.minHorizon]}.`);
  let horizonMismatch = false;
  if (horizon.key) {
    horizonMismatch = HORIZON_RANK[horizon.key] < HORIZON_RANK[c.minHorizon];
    const yours = horizon.source === 'goal' ? `לפי היעד שלך, כ-${horizon.years.toFixed(1)} שנים` : `לפי ההתנהגות שלך, ${HORIZON_LABELS_HE[horizon.key]}`;
    notes.push(horizonMismatch ? `האופק שלך (${yours}) קצר מזה - שווה לשקול את זה בכובד ראש.` : `האופק שלך (${yours}) תואם.`);
  }
  const cautious = profile.key === 'cautious' || horizon.key === 'short';
  if (c.risk === 'high') notes.push(cautious ? 'רמת הסיכון גבוהה ביחס לפרופיל הזהיר שעולה מהתיק שלך.' : 'רמת סיכון גבוהה: תנודות חדות הן חלק מהמוצר.');
  if (c.risk === 'low' && profile.key === 'active') notes.push('רמת סיכון נמוכה - שונה מאוד מאופי המסחר הפעיל שלך.');
  return { notes, horizonMismatch, userHorizon: horizon };
}

// ---------------------------------------------------------------------------
// Entry point

// nextDeposit: the user's usual monthly investment - the 3-month average,
// else the 6-month one, else this month's.
export function nextDepositEstimate(review) {
  const vol = review.categories.find((c) => c.key === 'volume');
  const m = (vol && vol.metrics) || {};
  if (m.avg3 > 0) return { amount: m.avg3, basis: 'avg3' };
  if (m.avg6 > 0) return { amount: m.avg6, basis: 'avg6' };
  if (review.facts && review.facts.invested > 0) return { amount: review.facts.invested, basis: 'month' };
  return { amount: null, basis: null };
}

export function buildInvestmentIdeas(review, { catalog = CATALOG } = {}) {
  if (!review || review.empty || !review.allocation || !(review.allocation.total > 0)) {
    return { available: false, reason: 'התיק ריק - רעיונות יופיעו אחרי שיהיו בו השקעות.', ideas: [] };
  }
  if (review.allocation.unpriced.length) {
    return { available: false, reason: `חסרים נתוני מחירים עבור ${review.allocation.unpriced.join(', ')}, ולכן אי אפשר לזהות פערים בתיק כרגע.`, ideas: [] };
  }
  const ex = portfolioExposure(review.allocation, catalog);
  const profile = (review.text && review.text.profile) || {};
  const cautious = profile.key === 'cautious';
  const deposit = nextDepositEstimate(review);

  // Merge what several rules said about the same item.
  const byId = new Map();
  rules(ex, catalog).forEach((cand) => {
    const c = find(catalog, cand.id);
    const held = ex.heldCatalogIds.has(c.id) || (c.symbol && ex.heldSymbols.has(c.symbol.toUpperCase()));
    if (held) return;
    if (c.leveraged && !ex.holdsLeveraged) return;
    if (c.crypto && !ex.holdsCrypto) return;
    if (cautious && c.risk === 'high') return;
    // Rules come with every catalog field; an item that would break the
    // "at least one drawback" rule is never shown.
    if (!(c.consHe && c.consHe.length) && !(c.risksHe && c.risksHe.length)) return;
    const existing = byId.get(c.id);
    if (existing) {
      if (!existing.reasons.includes(cand.reason)) existing.reasons.push(cand.reason);
      existing.rules.push(cand.rule);
      existing.priority = Math.max(existing.priority, cand.priority);
      if (cand.kind === 'complement') existing.kind = 'complement';
      return;
    }
    byId.set(c.id, { item: c, kind: cand.kind, rules: [cand.rule], reasons: [cand.reason], priority: cand.priority });
  });

  const ranked = [...byId.values()].sort((a, b) => b.priority - a.priority);
  // One idea per gap before a second idea for any gap: three bond funds
  // say less than a bond fund, a region and a sector.
  const roundRobin = (list, max) => {
    const groups = [];
    list.forEach((idea) => {
      const g = groups.find((x) => x.rule === idea.rules[0]);
      if (g) g.items.push(idea);
      else groups.push({ rule: idea.rules[0], items: [idea] });
    });
    const out = [];
    for (let round = 0; out.length < max && groups.some((g) => g.items.length > round); round++) {
      groups.forEach((g) => {
        if (out.length < max && g.items[round]) out.push(g.items[round]);
      });
    }
    return out;
  };
  const pick = (kind, max) =>
    roundRobin(ranked.filter((i) => i.kind === kind), max)
      .map((i) => ({
        ...i,
        typeLabel: typeLabelHe(i.item.type),
        riskLabel: RISK_LABELS_HE[i.item.risk],
        regionLabel: REGION_NAMES_HE[i.item.region] || i.item.region,
        costText: Number.isFinite(i.item.expenseRatioPct) ? `דמי ניהול שנתיים: ${i.item.expenseRatioPct.toFixed(2)}%` : i.item.costNoteHe || 'דמי הניהול אינם ידועים בקטלוג',
        isSample: i.item.dataStatus !== 'verified',
        fit: fitFor(i.item, review),
        simulation: simulateIdea(i.item, review, deposit.amount)
      }));

  return {
    available: true,
    exposure: {
      investedTotal: ex.investedTotal,
      fixedIncomePct: ex.fixedIncomePct,
      israelPct: ex.israelPct,
      usPct: ex.usPct,
      exUsPct: ex.exUsPct,
      singleStocksPct: ex.singleStocksPct,
      dollarPct: ex.dollarPct,
      topSector: ex.topSector,
      classPct: Object.fromEntries(['equity', 'bond', 'deposit', 'realEstate', 'commodity', 'crypto', 'mixed'].map((k) => [k, ex.classPct(k)]))
    },
    deposit,
    similar: pick('similar', IDEAS_CONFIG.maxSimilar),
    complement: pick('complement', IDEAS_CONFIG.maxComplement),
    depositText: deposit.amount ? `ההפקדה החודשית הרגילה שלך: כ-${ils(deposit.amount)}` : null
  };
}
