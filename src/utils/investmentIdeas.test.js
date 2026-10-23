import catalogData from '../data/investmentCatalog.json';
import { buildInvestmentIdeas, exposureOf, portfolioExposure, simulateIdea, CATALOG } from './investmentIdeas';
import { buildPortfolioReview } from './portfolioReview';
import { summarizeAllocation } from './portfolioReviewData';

const TODAY = '2026-10-21';

const usLot = (id, symbol, price, qty, purchaseDate = '2026-03-05') => ({
  id,
  stockName: symbol,
  purchaseDate,
  purchasePrice: price,
  quantity: qty,
  exchangeRate: 3.7,
  currentExchangeRate: 3.7,
  currentPrice: price
});

const ilLot = (id, symbol, name, price, qty, extra = {}) => ({
  id,
  stockName: symbol,
  officialName: name,
  purchaseDate: '2026-03-05',
  purchasePrice: price,
  quantity: qty,
  currentPrice: price,
  securityType: 'מניות',
  branch: 'בנקים',
  ...extra
});

// The current month is reviewed with live prices, so no history is needed.
const reviewOf = (holdings, sectorBySymbol = {}, extra = {}) =>
  buildPortfolioReview({ holdings, transactions: [], priceData: {}, sectorBySymbol, today: TODAY, ...extra });

const ideasOf = (holdings, sectorBySymbol, extra) => buildInvestmentIdeas(reviewOf(holdings, sectorBySymbol, extra));
const allIdeas = (r) => [...r.similar, ...r.complement];
const ids = (r) => allIdeas(r).map((i) => i.item.id);

const TECH = { AAPL: { sector: 'Technology' }, MSFT: { sector: 'Technology' }, NVDA: { sector: 'Technology' } };
const techHeavy = { americanStocks: [usLot(1, 'AAPL', 200, 50), usLot(2, 'MSFT', 400, 25), usLot(3, 'NVDA', 150, 60)] };

describe('the catalog', () => {
  const RISKS = ['low', 'medium', 'high'];
  const HORIZONS = ['short', 'medium', 'long'];

  it('every item has the fields a card needs, and at least one drawback', () => {
    const seen = new Set();
    catalogData.items.forEach((c) => {
      expect(seen.has(c.id)).toBe(false);
      seen.add(c.id);
      ['id', 'name', 'nameHe', 'type', 'assetClass', 'region', 'currency', 'risk', 'minHorizon', 'descriptionHe', 'taxNotesHe', 'dataStatus'].forEach((k) => {
        expect(c[k]).toBeTruthy();
      });
      expect(RISKS).toContain(c.risk);
      expect(HORIZONS).toContain(c.minHorizon);
      expect(c.prosHe.length).toBeGreaterThan(0);
      expect(c.consHe.length + c.risksHe.length).toBeGreaterThan(0);
      expect(c.expenseRatioPct === null || Number.isFinite(c.expenseRatioPct)).toBe(true);
      // A product without a known expense ratio says why in words instead.
      expect(c.expenseRatioPct !== null || Boolean(c.costNoteHe)).toBe(true);
    });
  });

  it('marks leverage and crypto as high risk', () => {
    catalogData.items.filter((c) => c.leveraged || c.crypto).forEach((c) => expect(c.risk).toBe('high'));
  });

  it('carries no past returns and no referral links', () => {
    const text = JSON.stringify(catalogData);
    expect(text).not.toMatch(/return|performance|ytd|cagr/i);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(new RegExp(['stock', 'view'].join(''), 'i'));
  });

  it('says the starter data still has to be verified', () => {
    expect(catalogData.notice).toContain('אימות');
    expect(catalogData.items.every((c) => c.dataStatus === 'sample')).toBe(true);
  });
});

describe('exposure', () => {
  it('reads a holding from the catalog when it is there, else from what the app knows', () => {
    expect(exposureOf({ market: 'american', symbol: 'BND', instrument: 'fund' }).assetClass).toBe('bond');
    expect(exposureOf({ market: 'american', symbol: 'AAPL', instrument: 'stock' })).toMatchObject({ assetClass: 'equity', region: 'us' });
    expect(exposureOf({ market: 'israeli', symbol: '1', label: 'קסם אג"ח ממשלתי', instrument: 'fund', region: 'israel' }).assetClass).toBe('bond');
    expect(exposureOf({ market: 'pension', instrument: 'providentFund', label: 'גמל להשקעה' }).assetClass).toBe('mixed');
    expect(exposureOf({ market: 'bank', instrument: 'cash' }).assetClass).toBe('cash');
  });

  it('counts a world fund partly toward the US and partly toward the rest', () => {
    const allocation = summarizeAllocation([{ id: 'a', market: 'american', symbol: 'VT', instrument: 'fund', sectorKey: 'ETF', currency: 'USD', region: 'abroad', account: 'american', value: 100 }]);
    const ex = portfolioExposure(allocation);
    expect(ex.usPct).toBeCloseTo(60, 6);
    expect(ex.exUsPct).toBeCloseTo(40, 6);
  });
});

describe('rules', () => {
  it('single tech stocks: a tech fund as "similar", with the numbers behind it', () => {
    const r = ideasOf(techHeavy, TECH);
    const tech = r.similar.find((i) => i.item.id === 'xlk');
    expect(tech).toBeTruthy();
    expect(tech.reasons[0]).toMatch(/100% מניירות הערך שלך ב-3 מניות בודדות בסקטור טכנולוגיה/);
  });

  it('no bonds, all in the US, one sector: bonds, the rest of the world and other sectors as complements', () => {
    const r = ideasOf(techHeavy, TECH);
    const c = r.complement.map((i) => i.item.id);
    expect(c[0]).toBe('bnd'); // the largest gap first; dollar portfolio -> dollar bonds first
    expect(c).toEqual(expect.arrayContaining(['vxus']));
    const bonds = r.complement.find((i) => i.item.id === 'bnd');
    expect(bonds.reasons[0]).toContain('אג"ח ופיקדונות הם 0.0% בלבד');
    expect(r.complement.length).toBeLessThanOrEqual(5);
  });

  it('a home-heavy shekel portfolio gets a world fund and shekel bonds first', () => {
    const r = ideasOf({ israeliStocks: [ilLot(1, '604611', 'לאומי', 40, 1000), ilLot(2, '662577', 'הפועלים', 40, 1000)] });
    const c = r.complement.map((i) => i.item.id);
    expect(c[0]).toBe('il-gov-bond-fund');
    expect(c).toContain('vt');
    expect(ids(r)).toContain('il-ta125-tracker');
  });

  it('never suggests what is already held', () => {
    const r = ideasOf({ americanStocks: [usLot(1, 'VOO', 500, 10), usLot(2, 'BND', 70, 100)] });
    expect(ids(r)).not.toContain('voo');
    expect(ids(r)).not.toContain('bnd');
    // holding BND fills the bond gap
    expect(r.complement.some((i) => i.rules.includes('noFixedIncome'))).toBe(false);
    // an S&P fund in New York -> the Tel Aviv / Irish versions
    expect(r.similar.map((i) => i.item.id)).toContain('il-sp500-tracker');
  });

  it('leverage and crypto stay out unless the user already holds that kind', () => {
    const plain = ideasOf(techHeavy, TECH);
    expect(ids(plain)).not.toContain('tqqq');
    expect(ids(plain)).not.toContain('ibit');
    const catalog = CATALOG.filter((c) => !c.crypto);
    expect(catalog.some((c) => c.leveraged)).toBe(true);
  });

  it('every idea shows at least one drawback and no performance figure', () => {
    const r = ideasOf(techHeavy, TECH);
    allIdeas(r).forEach((i) => {
      expect(i.item.consHe.length + i.item.risksHe.length).toBeGreaterThan(0);
      expect(i.costText).toBeTruthy();
      expect(i.isSample).toBe(true);
      expect(i.reasons.length).toBeGreaterThan(0);
    });
  });

  it('an empty portfolio gets no ideas, with a reason', () => {
    const r = buildInvestmentIdeas(reviewOf({}));
    expect(r.available).toBe(false);
    expect(r.reason).toBeTruthy();
  });
});

describe('simulation', () => {
  it('moves 10% of the next deposit into the idea and recomputes the diversification score', () => {
    // A monthly investor, so the next deposit is known.
    const lots = ['2026-07-05', '2026-08-05', '2026-09-05', '2026-10-05'].map((d, i) => usLot(10 + i, 'NVDA', 150, 20, d));
    const review = reviewOf({ americanStocks: lots, cashFunds: [] }, TECH);
    const r = buildInvestmentIdeas(review);
    expect(r.deposit.amount).toBeCloseTo(150 * 20 * 3.7, 6);
    const bond = r.complement.find((i) => i.item.id === 'bnd');
    expect(bond.simulation.amountILS).toBeCloseTo(r.deposit.amount * 0.1, 6);
    expect(bond.simulation.before.fixedIncomePct).toBe(0);
    expect(bond.simulation.after.fixedIncomePct).toBeGreaterThan(0);
    expect(bond.simulation.after.largestPct).toBeLessThan(bond.simulation.before.largestPct);
    expect(Number.isFinite(bond.simulation.after.diversificationScore)).toBe(true);
  });

  it('without a known deposit there is no simulation rather than a guessed one', () => {
    const review = reviewOf({ americanStocks: [usLot(1, 'AAPL', 200, 50, '2025-01-05')] }, TECH);
    expect(simulateIdea(CATALOG[0], review, null)).toBeNull();
  });
});

describe('fit', () => {
  it('flags a horizon shorter than the idea needs, from the goal', () => {
    const r = ideasOf(techHeavy, TECH, { goal: { targetAmount: 10000000, targetDate: '2027-06-01' } });
    const world = allIdeas(r).find((i) => i.item.minHorizon === 'long');
    expect(world.fit.horizonMismatch).toBe(true);
    expect(world.fit.notes.join(' ')).toContain('לפי היעד שלך');
  });
});
