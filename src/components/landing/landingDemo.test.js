import { buildLandingDemo } from './landingDemo';

describe('buildLandingDemo', () => {
  const demo = buildLandingDemo(new Date('2026-10-21T09:00:00Z'));

  it('computes every figure the page shows, none of them missing', () => {
    expect(demo.summary.capitalTotalILS).toBeGreaterThan(0);
    expect(Number.isFinite(demo.totalProfitPercent)).toBe(true);
    expect(Number.isFinite(demo.summary.dailyProfitILS)).toBe(true);
    expect(demo.summary.dailyProfitILS).not.toBe(0);
    expect(demo.lastSession).not.toBeNull();
    expect(Number.isFinite(demo.lastSession.changeILS)).toBe(true);
    expect(demo.session).toBe('2026-10-20');
    expect(Number.isFinite(demo.mwr.annualPercent)).toBe(true);
  });

  it('splits the whole portfolio, shares adding up to 100%', () => {
    const total = demo.allocation.reduce((s, a) => s + a.share, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('gives each demo holding its own yesterday from the same engine', () => {
    demo.holdings.forEach((h) => {
      expect(h.value).toBeGreaterThan(0);
      expect(h.yesterday).not.toBeNull();
    });
  });
});
