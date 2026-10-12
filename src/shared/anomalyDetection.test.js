const {
  analyzeBars,
  detectAnomalies,
  consolidateSignals,
  buildAnomalyAlert,
  passesCooldown,
  looksLikeSplit
} = require('./anomalyDetection');

// 40 calm sessions (alternating +0.4% / -0.3%, ~1M volume), then `last`.
function calmBars(last) {
  const bars = [];
  let p = 100;
  for (let i = 0; i < 40; i += 1) {
    p *= 1 + (i % 2 ? 0.004 : -0.003);
    const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    bars.push({ date: d, close: p, volume: 1000000 + (i % 3) * 50000 });
  }
  if (last) bars.push(Object.assign({ date: '2026-02-15' }, last(p)));
  return bars;
}

describe('analyzeBars / detectAnomalies', () => {
  test('+8% on 3.4x volume fires every detector', () => {
    const { signals, metrics } = analyzeBars(calmBars((p) => ({ close: p * 1.08, volume: 3600000 })));
    const byKind = Object.fromEntries(signals.map((s) => [s.kind, s]));
    expect(byKind.PRICE_ZSCORE).toMatchObject({ severity: 'critical', direction: 'up' });
    expect(byKind.PRICE_PCT_MOVE).toMatchObject({ severity: 'warning' });
    expect(byKind.PRICE_VS_SMA).toMatchObject({ severity: 'warning' });
    expect(byKind.VOLUME_SPIKE).toMatchObject({ severity: 'critical' });
    expect(metrics.changePct).toBeCloseTo(8, 6);
    expect(metrics.volumeRatio).toBeCloseTo(3.43, 2);
  });

  test('a calm day fires nothing', () => {
    expect(detectAnomalies(calmBars())).toEqual([]);
  });

  test('volume alone: 2.5x is a warning', () => {
    const signals = detectAnomalies(calmBars((p) => ({ close: p * 1.001, volume: 2600000 })));
    expect(signals.map((s) => [s.kind, s.severity])).toEqual([['VOLUME_SPIKE', 'warning']]);
  });

  test('a -12% day is a critical % move (>= 2X)', () => {
    const s = detectAnomalies(calmBars((p) => ({ close: p * 0.88, volume: 1000000 }))).find((x) => x.kind === 'PRICE_PCT_MOVE');
    expect(s).toMatchObject({ severity: 'critical', direction: 'down' });
  });

  test('the % threshold is configurable', () => {
    const bars = calmBars((p) => ({ close: p * 1.03, volume: 1000000 }));
    expect(detectAnomalies(bars).some((s) => s.kind === 'PRICE_PCT_MOVE')).toBe(false);
    expect(detectAnomalies(bars, { pctMove: 2.5 }).some((s) => s.kind === 'PRICE_PCT_MOVE')).toBe(true);
  });

  test('too little history, or zero-volume data, does not judge', () => {
    expect(analyzeBars(calmBars().slice(0, 15)).signals).toEqual([]);
    const noVol = calmBars((p) => ({ close: p, volume: 9000000 })).map((b, i, a) => (i < a.length - 1 ? Object.assign({}, b, { volume: 0 }) : b));
    expect(detectAnomalies(noVol).some((s) => s.kind === 'VOLUME_SPIKE')).toBe(false);
  });

  test('today does not dilute its own baseline', () => {
    // If today were part of the baseline, a huge move would inflate sigma
    // and its own z-score would be capped near sqrt(n).
    const { metrics } = analyzeBars(calmBars((p) => ({ close: p * 1.5, volume: 1000000 })));
    expect(metrics.zScore).toBeGreaterThan(50);
  });
});

describe('consolidateSignals', () => {
  const price = { kind: 'PRICE_PCT_MOVE', severity: 'warning', direction: 'down' };
  const volume = { kind: 'VOLUME_SPIKE', severity: 'warning', direction: null };

  test('price + volume -> combined, one step up', () => {
    expect(consolidateSignals([price, volume])).toEqual({ type: 'COMBINED_ANOMALY', severity: 'critical', direction: 'down' });
  });

  test('portfolio weight moves severity down for tiny and up for large positions', () => {
    expect(consolidateSignals([price], { weightPct: 0.4 }).severity).toBe('info');
    expect(consolidateSignals([price], { weightPct: 20 }).severity).toBe('critical');
    expect(consolidateSignals([volume], { weightPct: 5 })).toEqual({ type: 'VOLUME_ANOMALY', severity: 'warning', direction: null });
  });
});

describe('buildAnomalyAlert', () => {
  const instrument = { symbol: 'NVDA', market: 'US', name: 'NVIDIA', currency: 'USD' };

  test('produces the agreed JSON shape with one merged alert', () => {
    const { signals, metrics } = analyzeBars(calmBars((p) => ({ close: p * 0.929, volume: 2800000 })));
    const alert = buildAnomalyAlert({
      userId: 42,
      instrument,
      signals,
      metrics,
      position: { quantity: 40, weightPct: 12.4, valueILS: 61210.5, dayPnlILS: -4620.1 }
    });
    expect(alert).toMatchObject({
      userId: 42,
      type: 'COMBINED_ANOMALY',
      severity: 'critical',
      sessionDate: '2026-02-15',
      instrument,
      position: { quantity: 40, weightPct: 12.4 },
      recommendation: { action: 'REVIEW' },
      dedupKey: '42:NVDA:COMBINED_ANOMALY:2026-02-15'
    });
    expect(alert.title).toBe('NVDA ירדה 7.1% במחזור פי 2.7 מהממוצע');
    expect(alert.message).toMatch(/₪4,620/);
    expect(alert.signals.length).toBeGreaterThanOrEqual(2);
  });

  test('an up-move in an over-weight position suggests trimming to target', () => {
    const { signals, metrics } = analyzeBars(calmBars((p) => ({ close: p * 1.09, volume: 1000000 })));
    const alert = buildAnomalyAlert({ userId: 1, instrument, signals, metrics, position: { weightPct: 22 }, targetWeightPct: 15 });
    expect(alert.recommendation.action).toBe('CONSIDER_REBALANCE');
  });

  test('a split-shaped move is a data check, not a crash', () => {
    const { signals, metrics } = analyzeBars(calmBars((p) => ({ close: p / 2, volume: 1100000 })));
    expect(looksLikeSplit(metrics)).toBe(true);
    const alert = buildAnomalyAlert({ userId: 1, instrument, signals, metrics, position: {} });
    expect(alert).toMatchObject({ type: 'DATA_CHECK', severity: 'info' });
  });

  test('nothing fired -> no alert', () => {
    const { signals, metrics } = analyzeBars(calmBars());
    expect(buildAnomalyAlert({ userId: 1, instrument, signals, metrics })).toBeNull();
  });
});

describe('passesCooldown (24h per user, symbol, type)', () => {
  const now = new Date('2026-02-16T12:00:00Z');
  const alert = { type: 'PRICE_ANOMALY', severity: 'warning' };

  test('blocks a repeat within 24h', () => {
    expect(passesCooldown(alert, [{ type: 'PRICE_ANOMALY', severity: 'warning', createdAt: '2026-02-15T20:00:00Z' }], { now })).toBe(false);
  });
  test('allows it after 24h', () => {
    expect(passesCooldown(alert, [{ type: 'PRICE_ANOMALY', severity: 'warning', createdAt: '2026-02-15T11:00:00Z' }], { now })).toBe(true);
  });
  test('allows an escalation', () => {
    expect(passesCooldown({ type: 'PRICE_ANOMALY', severity: 'critical' }, [{ type: 'PRICE_ANOMALY', severity: 'warning', createdAt: '2026-02-16T10:00:00Z' }], { now })).toBe(true);
  });
  test('a different alert type is independent', () => {
    expect(passesCooldown(alert, [{ type: 'VOLUME_ANOMALY', severity: 'critical', createdAt: '2026-02-16T10:00:00Z' }], { now })).toBe(true);
  });
});
