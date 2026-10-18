import { toneOfPct, readMultiple, combineTones, multiplesSummary, describeGap } from './valuationInsights';

test('within 15% of the reference is "as usual"', () => {
  expect(toneOfPct(-57)).toBe('cheap');
  expect(toneOfPct(10)).toBe('normal');
  expect(toneOfPct(45)).toBe('expensive');
  expect(toneOfPct(null)).toBe('na');
});

test('a P/E from tiny or swinging earnings is not read', () => {
  expect(readMultiple({ metric: 'PE', current: 911, min5y: 46, max5y: 988, vsHistoryPct: 394 })).toMatchObject({ meaningful: false, reason: 'unstable-earnings' });
  expect(readMultiple({ metric: 'PE', current: 40, min5y: 5, max5y: 60, vsHistoryPct: 0 })).toMatchObject({ meaningful: false });
  expect(readMultiple({ metric: 'PS', current: 300, min5y: 5, max5y: 400, vsHistoryPct: 0 }).meaningful).toBe(true);
  expect(readMultiple({ metric: 'PE', current: null }).reason).toBe('missing');
});

test('peers count only with at least two of them', () => {
  expect(readMultiple({ metric: 'PS', current: 6, vsHistoryPct: 0, peerCount: 1, vsSectorPct: -50 }).peers).toBe('na');
  expect(readMultiple({ metric: 'PS', current: 6, vsHistoryPct: 0, peerCount: 5, vsSectorPct: -50 }).peers).toBe('cheap');
});

test('readings combine to the side most multiples fall on', () => {
  expect(combineTones(['cheap', 'cheap', 'na'])).toBe('cheap');
  expect(combineTones(['cheap', 'expensive'])).toBe('mixed');
  expect(combineTones(['normal', 'normal'])).toBe('normal');
  expect(combineTones(['na'])).toBe('na');
  expect(
    multiplesSummary([
      { metric: 'PE', current: 911, min5y: 46, max5y: 988, vsHistoryPct: 394 },
      { metric: 'PS', current: 24, vsHistoryPct: 45, peerCount: 5, vsSectorPct: 48 },
      { metric: 'PFCF', current: 68, vsHistoryPct: 53, peerCount: 5, vsSectorPct: 71 }
    ])
  ).toEqual({ history: 'expensive', peers: 'expensive' });
});

test('gaps read as percentages, and as "times" past doubling', () => {
  expect(describeGap(-57)).toBe('זול ב-57%');
  expect(describeGap(45)).toBe('יקר ב-45%');
  expect(describeGap(394)).toBe('יקר פי 4.9');
});
