import {
  buildEquitySeries,
  buildSeriesFromHistoricalValues,
  computePeriodReturns,
  computeVolatilityPercent,
  computeBestWorstPeriod,
  computeTotalReturnPercent,
  computeAnnualizedReturnPercent,
  computeStatsFromSeries,
  computePortfolioStats,
  computeTimeWeightedReturnPercent,
  buildTwrIndexSeries,
  annualizeReturnPercent,
  CALENDAR_DAYS_PER_YEAR
} from './portfolioStats';
import { computeHistoricalPortfolioSeries } from './historicalPortfolioValue';
import { buildPortfolioCashFlows } from './portfolioCashFlows';

describe('buildEquitySeries', () => {
  test('sorts by date and normalizes to {date, value}', () => {
    const series = buildEquitySeries([
      { date: '2026-01-03', totalValueILS: 300 },
      { date: '2026-01-01', totalValueILS: 100 },
      { date: '2026-01-02', totalValueILS: 200 }
    ]);
    expect(series).toEqual([
      { date: '2026-01-01', value: 100 },
      { date: '2026-01-02', value: 200 },
      { date: '2026-01-03', value: 300 }
    ]);
  });

  test('drops rows with missing date or non-numeric value', () => {
    const series = buildEquitySeries([
      { date: '2026-01-01', totalValueILS: 100 },
      { date: null, totalValueILS: 200 },
      { date: '2026-01-02', totalValueILS: 'not-a-number' }
    ]);
    expect(series).toEqual([{ date: '2026-01-01', value: 100 }]);
  });

  test('handles non-array input gracefully', () => {
    expect(buildEquitySeries(null)).toEqual([]);
    expect(buildEquitySeries(undefined)).toEqual([]);
  });
});

// The dynamic performance curve's own shape (utils/historicalPortfolioValue.js
// returns {date, valueILS, isPartial}) - this is what performance is now
// computed from, instead of saved snapshots.
describe('buildSeriesFromHistoricalValues', () => {
  test('normalizes the historical-value shape and sorts by date', () => {
    const series = buildSeriesFromHistoricalValues([
      { date: '2026-01-08', valueILS: 1100, isPartial: false },
      { date: '2026-01-01', valueILS: 1000, isPartial: false }
    ]);
    expect(series).toEqual([
      { date: '2026-01-01', value: 1000 },
      { date: '2026-01-08', value: 1100 }
    ]);
  });

  test('drops dates the portfolio could not be valued on at all', () => {
    const series = buildSeriesFromHistoricalValues([
      { date: '2026-01-01', valueILS: null, isPartial: true },
      { date: '2026-01-08', valueILS: 0, isPartial: false },
      { date: '2026-01-15', valueILS: 1200, isPartial: false }
    ]);
    expect(series).toEqual([{ date: '2026-01-15', value: 1200 }]);
  });

  test('handles non-array input gracefully', () => {
    expect(buildSeriesFromHistoricalValues(null)).toEqual([]);
  });
});

describe('computePeriodReturns', () => {
  test('computes return and elapsed days between consecutive points', () => {
    const series = buildEquitySeries([
      { date: '2026-01-01', totalValueILS: 100 },
      { date: '2026-01-11', totalValueILS: 110 }
    ]);
    const returns = computePeriodReturns(series);
    expect(returns).toHaveLength(1);
    expect(returns[0].periodReturn).toBeCloseTo(0.1, 10);
    expect(returns[0].days).toBeCloseTo(10, 5);
  });

  test('a single point produces no returns', () => {
    const series = buildEquitySeries([{ date: '2026-01-01', totalValueILS: 100 }]);
    expect(computePeriodReturns(series)).toEqual([]);
  });
});

describe('computeVolatilityPercent', () => {
  test('needs at least two return periods (3 points) to compute anything', () => {
    const oneReturn = computePeriodReturns(
      buildEquitySeries([
        { date: '2026-01-01', totalValueILS: 100 },
        { date: '2026-01-02', totalValueILS: 105 }
      ])
    );
    expect(computeVolatilityPercent(oneReturn)).toBeNull();
  });

  test('a perfectly steady growth series has ~0 volatility', () => {
    const flatReturns = computePeriodReturns(
      buildEquitySeries([
        { date: '2026-01-01', totalValueILS: 100 },
        { date: '2026-01-02', totalValueILS: 101 },
        { date: '2026-01-03', totalValueILS: 102.01 },
        { date: '2026-01-04', totalValueILS: 103.0301 }
      ])
    );
    // constant 1%/day growth => ~0 stdev of daily-equivalent returns
    expect(computeVolatilityPercent(flatReturns)).toBeCloseTo(0, 2);
  });

  test('a genuinely volatile series produces a positive volatility figure', () => {
    const bumpyReturns = computePeriodReturns(
      buildEquitySeries([
        { date: '2026-01-01', totalValueILS: 100 },
        { date: '2026-01-02', totalValueILS: 120 },
        { date: '2026-01-03', totalValueILS: 90 },
        { date: '2026-01-04', totalValueILS: 115 }
      ])
    );
    expect(computeVolatilityPercent(bumpyReturns)).toBeGreaterThan(0);
  });

  // The audited definition: sample stdev of ln(1 + r) / sqrt(days),
  // annualized by sqrt(365). Pinned numerically so a change to either half
  // of that formula is caught rather than silently shifting every
  // volatility figure the app displays.
  test('annualizes the per-day standard deviation of log returns by sqrt(365)', () => {
    // Daily points: +10%, -10%, +10%.
    const returns = computePeriodReturns(
      buildEquitySeries([
        { date: '2026-01-01', totalValueILS: 100 },
        { date: '2026-01-02', totalValueILS: 110 },
        { date: '2026-01-03', totalValueILS: 99 },
        { date: '2026-01-04', totalValueILS: 108.9 }
      ])
    );
    const z = [Math.log(1.1), Math.log(0.9), Math.log(1.1)];
    const mean = z.reduce((s, v) => s + v, 0) / 3;
    const variance = z.reduce((s, v) => s + (v - mean) ** 2, 0) / 2;
    const expected = Math.sqrt(variance) * Math.sqrt(CALENDAR_DAYS_PER_YEAR) * 100;

    expect(computeVolatilityPercent(returns)).toBeCloseTo(expected, 6);
  });

  // The bug this replaced: compounding a week down to a daily-equivalent
  // return divided its spread by 7, not sqrt(7). The same weekly returns
  // must annualize to the weekly spread x sqrt(52) or so - not a third of it.
  test('weekly points annualize to about the weekly spread x sqrt(52)', () => {
    const values = [100, 102, 99.96, 102.96, 100.9, 103.92, 101.84, 104.9];
    const points = values.map((v, i) => ({ date: new Date(Date.UTC(2026, 0, 1 + i * 7)).toISOString().slice(0, 10), totalValueILS: v }));
    const returns = computePeriodReturns(buildEquitySeries(points));
    const logs = returns.map((r) => Math.log(1 + r.periodReturn));
    const m = logs.reduce((s, v) => s + v, 0) / logs.length;
    const weeklySd = Math.sqrt(logs.reduce((s, v) => s + (v - m) ** 2, 0) / (logs.length - 1));
    expect(computeVolatilityPercent(returns)).toBeCloseTo(weeklySd * Math.sqrt(365 / 7) * 100, 6);
    expect(computeVolatilityPercent(returns)).toBeGreaterThan(10);
  });

  // Compounding a long gap down to a daily-equivalent return smooths away
  // the movement inside it. This is why the inputs must come from a
  // regularly-sampled price series and not from whenever the app happened
  // to be opened - the assertion documents the direction of that bias.
  test('irregular, widely-spaced sampling understates volatility versus daily sampling', () => {
    const daily = computePeriodReturns(
      buildEquitySeries([
        { date: '2026-01-01', totalValueILS: 100 },
        { date: '2026-01-02', totalValueILS: 110 },
        { date: '2026-01-03', totalValueILS: 99 },
        { date: '2026-01-04', totalValueILS: 108.9 }
      ])
    );
    const sparse = computePeriodReturns(
      buildEquitySeries([
        { date: '2026-01-01', totalValueILS: 100 },
        { date: '2026-02-01', totalValueILS: 110 },
        { date: '2026-03-01', totalValueILS: 99 },
        { date: '2026-04-01', totalValueILS: 108.9 }
      ])
    );
    expect(computeVolatilityPercent(sparse)).toBeLessThan(computeVolatilityPercent(daily));
  });
});

describe('computeBestWorstPeriod', () => {
  test('picks the largest positive and largest negative period returns', () => {
    const returns = computePeriodReturns(
      buildEquitySeries([
        { date: '2026-01-01', totalValueILS: 100 },
        { date: '2026-01-02', totalValueILS: 130 }, // +30%
        { date: '2026-01-03', totalValueILS: 100 }, // -23.1%
        { date: '2026-01-04', totalValueILS: 105 } // +5%
      ])
    );
    const { best, worst } = computeBestWorstPeriod(returns);
    expect(best.date).toBe('2026-01-02');
    expect(worst.date).toBe('2026-01-03');
  });

  test('empty input returns nulls', () => {
    expect(computeBestWorstPeriod([])).toEqual({ best: null, worst: null });
  });
});

describe('computeTotalReturnPercent / computeAnnualizedReturnPercent', () => {
  test('total return is first-to-last, regardless of the path taken between', () => {
    const series = [
      { date: '2024-01-01', value: 1000 },
      { date: '2024-06-01', value: 500 },
      { date: '2025-01-01', value: 1200 }
    ];
    expect(computeTotalReturnPercent(series)).toBeCloseTo(20, 5);
  });

  test('annualized return compounds the total return over the elapsed years', () => {
    // Exactly two years (2024 is a leap year: 366 + 365 = 731 days),
    // doubling in value -> sqrt(2) - 1 per year.
    const series = [
      { date: '2024-01-01', value: 1000 },
      { date: '2026-01-01', value: 2000 }
    ];
    const years = 731 / 365;
    expect(computeAnnualizedReturnPercent(series)).toBeCloseTo((Math.pow(2, 1 / years) - 1) * 100, 4);
  });

  test('annualizing is withheld for a period under a month, where it would just extrapolate noise', () => {
    const series = [
      { date: '2026-01-01', value: 1000 },
      { date: '2026-01-08', value: 1020 }
    ];
    expect(computeTotalReturnPercent(series)).toBeCloseTo(2, 5);
    expect(computeAnnualizedReturnPercent(series)).toBeNull();
  });

  test('both are null when there is nothing meaningful to divide by', () => {
    expect(computeTotalReturnPercent([{ date: '2026-01-01', value: 100 }])).toBeNull();
    expect(computeTotalReturnPercent([{ date: '2026-01-01', value: 0 }, { date: '2026-01-02', value: 5 }])).toBeNull();
    expect(computeAnnualizedReturnPercent([])).toBeNull();
  });
});

describe('computeStatsFromSeries', () => {
  test('reports hasHistory=false and null stats with fewer than 2 points', () => {
    const stats = computeStatsFromSeries([{ date: '2026-01-01', value: 100 }]);
    expect(stats.hasHistory).toBe(false);
    expect(stats.hasEnoughForRiskStats).toBe(false);
    expect(stats.totalReturnPercent).toBeNull();
    expect(stats.volatilityPercent).toBeNull();
  });

  test('computes the return since inception once there are 2+ points, before risk stats are meaningful', () => {
    const stats = computeStatsFromSeries([
      { date: '2026-01-01', value: 100 },
      { date: '2026-01-15', value: 110 }
    ]);
    expect(stats.hasHistory).toBe(true);
    expect(stats.hasEnoughForRiskStats).toBe(false); // needs >= 5 points
    expect(stats.totalReturnPercent).toBeCloseTo(10, 5);
    expect(stats.volatilityPercent).toBeNull();
  });

  test('fills in every field once enough points exist', () => {
    const stats = computeStatsFromSeries([
      { date: '2026-01-01', value: 100 },
      { date: '2026-01-05', value: 120 },
      { date: '2026-01-10', value: 90 },
      { date: '2026-01-15', value: 115 },
      { date: '2026-01-20', value: 130 }
    ]);
    expect(stats.hasEnoughForRiskStats).toBe(true);
    expect(stats.snapshotsCount).toBe(5);
    expect(stats.firstDate).toBe('2026-01-01');
    expect(stats.lastDate).toBe('2026-01-20');
    expect(typeof stats.volatilityPercent).toBe('number');
    expect(stats.bestPeriod).not.toBeNull();
    expect(stats.worstPeriod).not.toBeNull();
  });

  // The removed metrics: max drawdown and the Sharpe ratio are gone from
  // the analysis module entirely, so nothing may still be computing or
  // reporting them.
  test('no longer reports max drawdown or a Sharpe ratio', () => {
    const stats = computeStatsFromSeries([
      { date: '2026-01-01', value: 100 },
      { date: '2026-01-05', value: 120 },
      { date: '2026-01-10', value: 90 }
    ]);
    expect(stats).not.toHaveProperty('maxDrawdownPercent');
    expect(stats).not.toHaveProperty('drawdownPeakDate');
    expect(stats).not.toHaveProperty('drawdownTroughDate');
    expect(stats).not.toHaveProperty('sharpeRatio');
  });

  test('the return since inception is read off the same series the chart draws', () => {
    const historical = [
      { date: '2024-01-01', valueILS: 50000, isPartial: false },
      { date: '2024-07-01', valueILS: 62000, isPartial: false },
      { date: '2025-01-01', valueILS: 75000, isPartial: false }
    ];
    const stats = computeStatsFromSeries(buildSeriesFromHistoricalValues(historical));
    expect(stats.firstDate).toBe('2024-01-01');
    expect(stats.totalReturnPercent).toBeCloseTo(50, 5);
    expect(stats.series[stats.series.length - 1].value).toBe(75000);
  });
});

describe('computePortfolioStats (saved-snapshot entry point)', () => {
  test('still works on raw snapshot rows, for the checkpoint side of the app', () => {
    const stats = computePortfolioStats([
      { date: '2026-01-01', totalValueILS: 100 },
      { date: '2026-01-15', totalValueILS: 110 }
    ]);
    expect(stats.hasHistory).toBe(true);
    expect(stats.totalReturnPercent).toBeCloseTo(10, 5);
  });
});

// The requirement: a "return" must reflect what the assets did, not how
// much money was paid into them.
describe('computeTimeWeightedReturnPercent', () => {
  test('a pure deposit produces 0% return, not the apparent growth in value', () => {
    // 100k -> 150k, but 50k of that was deposited. Nothing was earned.
    const series = [
      { date: '2024-01-01', value: 100000 },
      { date: '2024-02-01', value: 150000 }
    ];
    const flows = [{ date: '2024-01-15', amount: 50000 }];
    expect(computeTimeWeightedReturnPercent(series, flows)).toBeCloseTo(0, 6);
    // The un-neutralized figure is the misleading one this replaces.
    expect(computeTotalReturnPercent(series)).toBeCloseTo(50, 6);
  });

  test('a withdrawal does not read as a loss', () => {
    const series = [
      { date: '2024-01-01', value: 100000 },
      { date: '2024-02-01', value: 80000 }
    ];
    const flows = [{ date: '2024-01-15', amount: -20000 }];
    expect(computeTimeWeightedReturnPercent(series, flows)).toBeCloseTo(0, 6);
    expect(computeTotalReturnPercent(series)).toBeCloseTo(-20, 6);
  });

  test('with no cash flows at all it agrees with the plain value change', () => {
    const series = [
      { date: '2024-01-01', value: 100 },
      { date: '2024-02-01', value: 110 },
      { date: '2024-03-01', value: 121 }
    ];
    expect(computeTimeWeightedReturnPercent(series, [])).toBeCloseTo(21, 6);
    expect(computeTotalReturnPercent(series)).toBeCloseTo(21, 6);
  });

  test('separates real growth from a contribution made in the same period', () => {
    // 100k grows 10% to 110k, and 50k is deposited at the very end of the
    // period (so it earned nothing within it).
    const series = [
      { date: '2024-01-01', value: 100000 },
      { date: '2024-02-01', value: 160000 }
    ];
    const flows = [{ date: '2024-02-01', amount: 50000 }];
    expect(computeTimeWeightedReturnPercent(series, flows)).toBeCloseTo(10, 6);
  });

  // Chaining is what makes it time-weighted: the size of the contribution
  // must not change the measured performance.
  test('the same market performance yields the same return regardless of how much was contributed', () => {
    const build = (deposit) => [
      { date: '2024-01-01', value: 10000 },
      { date: '2024-02-01', value: 11000 + deposit },
      { date: '2024-03-01', value: (11000 + deposit) * 1.05 }
    ];
    const small = computeTimeWeightedReturnPercent(build(1000), [{ date: '2024-02-01', amount: 1000 }]);
    const large = computeTimeWeightedReturnPercent(build(900000), [{ date: '2024-02-01', amount: 900000 }]);
    expect(small).toBeCloseTo(large, 6);
    // 10% then 5% chained.
    expect(small).toBeCloseTo((1.1 * 1.05 - 1) * 100, 6);
  });

  test('a portfolio funded from empty reports the growth after funding, not the funding itself', () => {
    const series = [
      { date: '2024-01-01', value: 0 },
      { date: '2024-02-01', value: 10000 },
      { date: '2024-03-01', value: 11000 }
    ];
    const flows = [{ date: '2024-01-15', amount: 10000 }];
    expect(computeTimeWeightedReturnPercent(series, flows)).toBeCloseTo(10, 6);
  });

  test('needs at least two points to mean anything', () => {
    expect(computeTimeWeightedReturnPercent([{ date: '2024-01-01', value: 100 }], [])).toBeNull();
    expect(computeTimeWeightedReturnPercent([], [])).toBeNull();
    expect(computeTimeWeightedReturnPercent(null, [])).toBeNull();
  });
});

describe('computeStatsFromSeries with cash flows', () => {
  const series = [
    { date: '2024-01-01', value: 100000 },
    { date: '2024-07-01', value: 150000 }
  ];
  const flows = [{ date: '2024-03-01', amount: 50000 }];

  test('reports the neutralized figure as the headline return, and keeps the raw one alongside it', () => {
    const stats = computeStatsFromSeries(series, flows);
    expect(stats.totalReturnPercent).toBeCloseTo(stats.timeWeightedReturnPercent, 10);
    expect(stats.totalReturnPercent).toBeLessThan(10);
    expect(stats.naiveReturnPercent).toBeCloseTo(50, 6);
    expect(stats.netCashFlow).toBe(50000);
    expect(stats.isCashFlowNeutralized).toBe(true);
  });

  test('annualizes the neutralized figure, not the raw value change', () => {
    const stats = computeStatsFromSeries(series, flows);
    const expected = annualizeReturnPercent(series, stats.totalReturnPercent);
    expect(stats.annualizedReturnPercent).toBeCloseTo(expected, 10);
    expect(stats.annualizedReturnPercent).not.toBeCloseTo(
      annualizeReturnPercent(series, stats.naiveReturnPercent),
      3
    );
  });

  test('without cash flows the two figures agree and nothing claims to be neutralized', () => {
    const stats = computeStatsFromSeries(series, []);
    expect(stats.totalReturnPercent).toBeCloseTo(50, 6);
    expect(stats.naiveReturnPercent).toBeCloseTo(50, 6);
    expect(stats.netCashFlow).toBe(0);
  });
});

// THE DATE-RANGE BUG. Narrowing the chart to a window used to leave the
// reported contributions summed over the portfolio's entire history, so a
// 2022-2024 view claimed deposits made in 2019 had "entered during the
// period" - under a return figure that had correctly ignored them.
describe('the reported contributions belong to the selected range only', () => {
  const series = [
    { date: '2022-01-01', value: 100000 },
    { date: '2024-01-01', value: 130000 }
  ];

  test('a deposit made before the range is not counted as money that entered during it', () => {
    const stats = computeStatsFromSeries(series, [
      { date: '2019-06-01', amount: 80000 },
      { date: '2023-01-01', amount: 20000 }
    ]);
    expect(stats.netCashFlow).toBe(20000);
  });

  test('a deposit made after the range is not counted either', () => {
    const stats = computeStatsFromSeries(series, [
      { date: '2023-01-01', amount: 20000 },
      { date: '2025-03-01', amount: 50000 }
    ]);
    expect(stats.netCashFlow).toBe(20000);
  });

  // The first point values the portfolio as it stood that day, opening
  // purchase included - so money dated on it did enter within the window.
  test('a deposit dated on the first point counts, being inside the window', () => {
    const stats = computeStatsFromSeries(series, [{ date: '2022-01-01', amount: 100000 }]);
    expect(stats.netCashFlow).toBe(100000);
  });

  test('widening the range brings the earlier deposit back in', () => {
    const wide = [{ date: '2019-01-01', value: 10000 }, ...series];
    const stats = computeStatsFromSeries(wide, [
      { date: '2019-06-01', amount: 80000 },
      { date: '2023-01-01', amount: 20000 }
    ]);
    expect(stats.netCashFlow).toBe(100000);
  });
});

// What the benchmark comparison is drawn from. The raw value series cannot
// be used: an index only moves on market returns, so a deposit plotted
// against one reads as outperformance it never earned.
describe('buildTwrIndexSeries', () => {
  test('a pure deposit leaves the index flat, though the value rose 50%', () => {
    const indexed = buildTwrIndexSeries(
      [
        { date: '2024-01-01', value: 100000 },
        { date: '2024-07-01', value: 150000 }
      ],
      [{ date: '2024-03-01', amount: 50000 }]
    );
    expect(indexed[0].value).toBe(100);
    expect(indexed[indexed.length - 1].value).toBeCloseTo(100, 4);
  });

  test('real growth still moves it, with no flows to neutralize', () => {
    const indexed = buildTwrIndexSeries(
      [
        { date: '2024-01-01', value: 100000 },
        { date: '2024-07-01', value: 120000 }
      ],
      []
    );
    expect(indexed[indexed.length - 1].value).toBeCloseTo(120, 6);
  });

  test('its last point agrees with the headline time-weighted return', () => {
    const series = [
      { date: '2024-01-01', value: 50000 },
      { date: '2024-04-01', value: 62000 },
      { date: '2024-08-01', value: 90000 }
    ];
    const flows = [{ date: '2024-05-01', amount: 20000 }];
    const indexed = buildTwrIndexSeries(series, flows);
    const twr = computeTimeWeightedReturnPercent(series, flows);
    expect(indexed[indexed.length - 1].value - 100).toBeCloseTo(twr, 6);
  });

  test('keeps one point per date, starting at the base', () => {
    const series = [
      { date: '2024-01-01', value: 1000 },
      { date: '2024-02-01', value: 1100 },
      { date: '2024-03-01', value: 1200 }
    ];
    const indexed = buildTwrIndexSeries(series, []);
    expect(indexed.map((p) => p.date)).toEqual(['2024-01-01', '2024-02-01', '2024-03-01']);
    expect(indexed[0].value).toBe(100);
  });

  test('has nothing to index when there is no series', () => {
    expect(buildTwrIndexSeries([], [])).toEqual([]);
    expect(buildTwrIndexSeries(null, [])).toEqual([]);
  });
});

// END-TO-END: the reported bug, from holdings through to the displayed
// "Return Since Inception".
//
// A position's first valuation used to come from the market close on its
// purchase date while only the execution cost was recorded as a
// contribution. Mid-series that gap is netted out of the sub-period it
// falls in, so it surfaces as the gain it is - but at the START of a
// series there is no earlier point to measure from, so the curve simply
// began at the close-based value and the entire difference vanished.
describe('return since inception anchors to what was actually invested', () => {
  const holdings = {
    israeliStocks: [
      { stockName: '1159250', purchaseDate: '2026-01-24', purchasePrice: 13, quantity: 14 }
    ],
    americanStocks: []
  };
  // Closes in agorot: 232630 = 2,326.30 ILS on the purchase date,
  // 249160 = 2,491.60 ILS today.
  const priceData = {
    taseHistoricalCloses: {
      1159250: [
        { date: '2026-01-24', close: 232630 },
        { date: '2026-09-19', close: 249160 }
      ]
    }
  };

  const run = () => {
    const series = computeHistoricalPortfolioSeries('2026-01-24', '2026-09-19', holdings, priceData);
    const flows = buildPortfolioCashFlows(holdings);
    return { series, flows, stats: computeStatsFromSeries(buildSeriesFromHistoricalValues(series), flows) };
  };

  test('the curve starts at the cost basis, not at the close on the purchase date', () => {
    const { series } = run();
    expect(series[0].date).toBe('2026-01-24');
    expect(series[0].valueILS).toBeCloseTo(182, 6); // 13 x 14
    // The close-based figure that used to be the starting value.
    expect(series[0].valueILS).not.toBeCloseTo(14 * 2326.3, 0);
  });

  test('the contribution recorded is the money actually paid in', () => {
    const { flows } = run();
    expect(flows).toEqual([{ date: '2026-01-24', amount: 182 }]);
  });

  test('the curve ends at the current market value', () => {
    const { series } = run();
    expect(series[series.length - 1].valueILS).toBeCloseTo(34882.4, 4); // 14 x 2,491.60
  });

  test('the reported return reflects the full growth from invested capital', () => {
    const { stats } = run();
    // 34,882.40 / 182 - 1
    expect(stats.totalReturnPercent).toBeCloseTo(19066.15, 2);
    expect(stats.netCashFlow).toBe(182);
  });
});

// Purchases away from the series start already behaved correctly - the
// contribution is netted out of the sub-period it lands in, so the gap
// between execution and close surfaces as the gain it is. These pin that
// the day-0 anchoring neither broke that nor started double-counting it.
//
// Asserted as properties rather than against a hand-derived percentage:
// re-deriving the expected figure here would mean reimplementing Modified
// Dietz's own flow weighting in the test, which would pass whether or not
// either copy was right.
describe('a purchase away from the series start', () => {
  const priceData = {
    taseHistoricalCloses: {
      OLD: [{ date: '2025-01-01', close: 10000 }], // 100 ILS, never moves
      NEW: [{ date: '2026-03-15', close: 232630 }] // 2,326.30 ILS
    }
  };

  const runWithPurchasePrice = (price) => {
    const holdings = {
      israeliStocks: [
        { stockName: 'OLD', purchaseDate: '2025-01-01', purchasePrice: 100, quantity: 10 },
        { stockName: 'NEW', purchaseDate: '2026-03-15', purchasePrice: price, quantity: 14 }
      ],
      americanStocks: []
    };
    const series = computeHistoricalPortfolioSeries('2025-01-01', '2026-09-19', holdings, priceData);
    return {
      series,
      stats: computeStatsFromSeries(
        buildSeriesFromHistoricalValues(series),
        buildPortfolioCashFlows(holdings)
      )
    };
  };

  test('ends at the market value of everything held, whatever was paid for it', () => {
    const endValue = 1000 + 14 * 2326.3;
    expect(runWithPurchasePrice(13).series.slice(-1)[0].valueILS).toBeCloseTo(endValue, 4);
    expect(runWithPurchasePrice(2326.3).series.slice(-1)[0].valueILS).toBeCloseTo(endValue, 4);
  });

  // The control: bought exactly at the close, so there is no execution gap
  // and nothing in this portfolio ever moves. That has to read as flat.
  test('reports no return when nothing moved and the fill matched the close', () => {
    expect(runWithPurchasePrice(2326.3).stats.totalReturnPercent).toBeCloseTo(0, 6);
  });

  test('reports a gain when the fill was below the close, and only from that gap', () => {
    const cheap = runWithPurchasePrice(13).stats;
    const atClose = runWithPurchasePrice(2326.3).stats;
    expect(cheap.totalReturnPercent).toBeGreaterThan(0);
    expect(atClose.totalReturnPercent).toBeCloseTo(0, 6);
    // Both hold identical assets at identical prices; the entire
    // difference in reported return is the execution gap.
    expect(cheap.netCashFlow).toBe(1000 + 182);
    expect(atClose.netCashFlow).toBeCloseTo(1000 + 14 * 2326.3, 4);
  });

  test('a fill ABOVE the close reads as a loss, symmetrically', () => {
    expect(runWithPurchasePrice(2500).stats.totalReturnPercent).toBeLessThan(0);
  });
});
