import { buildValuationStory, combineVerdict, pickMultiple, pastRevenueGrowth } from './valuationStory';

const strip = (s) => s.replace(/[⁦-⁩]/g, '');

const data = {
  symbol: 'AAPL',
  name: 'Apple Inc.',
  currency: 'USD',
  price: 343.46,
  peers: [{ symbol: 'MSFT' }, { symbol: 'GOOG' }],
  multiples: [
    { metric: 'PE', current: 38.88, avg5y: 34.25, min5y: 21, max5y: 46, sectorMedian: 26.73, peerCount: 5, vsHistoryPct: 13.5, vsSectorPct: 45.5 },
    { metric: 'PS', current: 10.7, avg5y: 8.7, min5y: 5.4, max5y: 12.4, sectorMedian: 9.2, peerCount: 5, vsHistoryPct: 23, vsSectorPct: 16 }
  ],
  fiscalYears: [
    { periodEnd: '2022-09-30', revenue: 394e9 },
    { periodEnd: '2023-09-30', revenue: 383e9 },
    { periodEnd: '2024-09-30', revenue: 391e9 },
    { periodEnd: '2025-09-30', revenue: 416e9 }
  ]
};

const evaluation = {
  baseKey: 'base',
  labels: { bear: 'OVERVALUED', base: 'OVERVALUED', bull: 'OVERVALUED' },
  main: { ok: true, perShare: 156.91, price: 343.46 },
  results: { bear: { ok: true, perShare: 119.46 }, base: { ok: true, perShare: 156.91 }, bull: { ok: true, perShare: 175.77 } },
  impliedGrowth: 0.266
};

describe('valuation story', () => {
  test('one answer from the three checks, with how many agree', () => {
    const story = buildValuationStory(data, evaluation);
    expect(story.name).toBe('Apple');
    expect(story.checks.map((c) => c.tone)).toEqual(['normal', 'expensive', 'expensive']);
    expect(story.verdict.tone).toBe('expensive');
    expect(story.verdict.headline).toBe('המניה נראית יקרה כרגע');
    expect(story.verdict.line).toMatch(/^2 מתוך 3 הבדיקות/);
  });

  test('each check tells its real numbers in plain words', () => {
    const story = buildValuationStory(data, evaluation);
    const [history, peers, future] = story.checks.map((c) => strip([...c.story, c.takeaway].join(' ')));
    expect(history).toContain('$38.88 על כל $1 של רווח');
    expect(history).toContain('בממוצע $34.25');
    expect(peers).toContain('(MSFT, GOOG)');
    expect(peers).toContain('יקרה ב-45% מהחברות הדומות');
    expect(future).toContain('שווה בערך $156.91');
    expect(future).toContain('גבוה פי 2.2');
  });

  test('what the price assumes, against how fast the company has grown', () => {
    const story = buildValuationStory(data, evaluation);
    const text = strip(story.assumption.lines.join(' '));
    expect(text).toContain('בכ-26.6% בכל שנה');
    expect(text).toContain('ב-3 השנים האחרונות');
    expect(story.assumption.tone).toBe('expensive');
  });

  test('three futures against the price', () => {
    const story = buildValuationStory(data, evaluation);
    expect(story.futures.rows.map((r) => r.vsPrice)).toEqual(['below', 'below', 'below']);
    expect(story.futures.summary).toBe('גם אם הכל ילך מצוין, השווי שחישבנו נמוך מהמחיר של היום.');
  });

  test('missing data reads as such, never as a verdict', () => {
    const story = buildValuationStory({ symbol: 'XYZ', price: 10, currency: 'USD', multiples: [] }, null);
    expect(story.verdict.tone).toBe('na');
    expect(story.checks.every((c) => c.tone === 'na')).toBe(true);
    expect(story.assumption).toBeNull();
    expect(story.futures).toBeNull();
  });

  test('a company unsuited to the DCF says why', () => {
    const story = buildValuationStory(data, { unsuitable: 'אין לחברה תזרים חיובי' });
    expect(story.checks[2].tone).toBe('na');
    expect(story.checks[2].story[0]).toContain('אין לחברה תזרים חיובי');
  });

  test('helpers', () => {
    expect(combineVerdict(['cheap', 'expensive']).tone).toBe('mixed');
    expect(combineVerdict(['cheap', 'cheap', 'normal']).tone).toBe('cheap');
    expect(combineVerdict(['na', 'na']).tone).toBe('na');
    // P/E over 100 is not meaningful - the story falls back to the next.
    expect(pickMultiple([{ metric: 'PE', current: 300 }, { metric: 'PS', current: 4 }]).metric).toBe('PS');
    // Compared by sales, the answer warns that this is a weaker yardstick.
    const bySales = buildValuationStory({ ...data, multiples: [{ ...data.multiples[1] }] }, null);
    expect(bySales.verdict.note).toContain('אין כרגע רווח יציב');
    expect(buildValuationStory(data, evaluation).verdict.note).toBe('');
    expect(pastRevenueGrowth([{ periodEnd: '2024', revenue: 100 }, { periodEnd: '2025', revenue: 110 }]).rate).toBeCloseTo(0.1);
  });
});
