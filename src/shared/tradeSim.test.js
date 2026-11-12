/**
 * @jest-environment node
 */
// Ported from day-trader-skill (MIT, Jake Schincariol): the numbers below are
// the Python pack's own test expectations (tests/test_timemachine.py,
// test_exit.py, test_budget.py) on the same recorded TSLA data and seed.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const ts = require('./tradeSim');

const FIXTURE = path.join(__dirname, '..', 'server', 'fixtures', 'trade-sim', 'TSLA-60d5m.json.gz');
const TEXT = zlib.gunzipSync(fs.readFileSync(FIXTURE)).toString('utf8');
const fresh = () => JSON.parse(TEXT).chart.result[0];
const RESULT = fresh();
// Yahoo v8 chart, range=60d interval=5m, fetched 2026-10-19 10:49 ET; "now" = 10:50 ET (14:50Z)
const NOW = Date.UTC(2026, 9, 19, 14, 50);

const PLAN = { symbol: 'TSLA', date: '2026-10-19', entry: 364.18, stop: 358.32, target: 370.04, entryBar: 8, setup: 'orb', stopRule: 'or_mid' };
const machine = (over, opts, result, now) => ts.timeMachine(result || RESULT, Object.assign({}, PLAN, over || {}), now || NOW, opts);

// json.dumps(x) exactly as Python writes it, for the fingerprints below.
function pyDumps(x) {
  if (Array.isArray(x)) return `[${x.map(pyDumps).join(', ')}]`;
  if (typeof x === 'number') return Number.isInteger(x) ? x.toFixed(1) : String(x);
  if (typeof x === 'string') return JSON.stringify(x);
  return `{${Object.keys(x).map((k) => `${JSON.stringify(k)}: ${pyDumps(x[k])}`).join(', ')}}`;
}
const sha = (x) => crypto.createHash('sha256').update(pyDumps(x)).digest('hex').slice(0, 16);

// Fingerprints of the Python reel's refs/sim-out.json (seed 19), from test_timemachine.py.
const SIM_BANDS = 'b9b7c006a733c68b';
const SIM_PATHS = '90f313ef40c576a0';
const SIM_TRADES = '0058bef72b0dcdee';
const SIM_HIST = {
  lo: 351.75,
  hi: 377.39,
  bins: [107, 109, 128, 199, 252, 331, 465, 571, 689, 694, 757, 811, 761, 732, 686, 558, 503, 452, 327, 244, 160, 125, 102, 78]
};

// Shift every bar of the fixture by keep(ts) -> false to drop it.
function keepBars(result, keep) {
  const q = result.indicators.quote[0];
  const idx = result.timestamp.map((t, i) => i).filter((i) => keep(result.timestamp[i]));
  result.timestamp = idx.map((i) => result.timestamp[i]);
  Object.keys(q).forEach((k) => {
    q[k] = idx.map((i) => q[k][i]);
  });
  return result;
}
const etDate = (t) => ts.easternParts(t * 1000).date;

describe('CPython random port', () => {
  test('random.Random(19) draws match Python', () => {
    const r = ts.createPyRandom(19);
    const draws = [];
    for (let i = 0; i < 8; i++) draws.push(r.randint(-2, 2));
    expect(draws).toEqual([-2, 2, -2, 2, -1, 1, 0, 2]);
    expect(r.randbelow(59)).toBe(18);
  });

  test('pyRound rounds like Python (ties to even on exact halves)', () => {
    expect(ts.pyRound(0.125, 2)).toBe(0.12);
    expect(ts.pyRound(0.375, 2)).toBe(0.38);
    expect(ts.pyRound(2.675, 2)).toBe(2.67); // 2.67499999... in binary
    expect(ts.pyRound(364.1759948730469, 2)).toBe(364.18);
  });
});

describe('Time Machine on the reel (bit for bit with the Python tool)', () => {
  let doc;
  beforeAll(() => {
    doc = machine({}, { samplePaths: 160, bandPaths: 2000 });
  });

  test('the odds', () => {
    const m = doc.mc;
    expect([m.replays, m.seed, m.window, m.until]).toEqual([10000, 19, 2, '16:00']);
    expect([m.poolSessions, m.barsLeft, m.poolFrom, m.poolTo]).toEqual([59, 69, '2026-07-27', '2026-10-16']);
    expect([m.pTarget, m.pStop, m.pNeither, m.pGreen]).toEqual([0.2938, 0.2548, 0.4514, 0.5168]);
    expect([m.medianClose, m.p5Close, m.p95Close, m.avgR, m.rAtTarget]).toEqual([364.36, 355.54, 373.54, 0.034, 1.0]);
  });

  test('bands, sample paths and histogram fingerprints', () => {
    const m = doc.mc;
    expect(sha(m.bands)).toBe(SIM_BANDS);
    expect(m.samplePaths).toHaveLength(160);
    expect(sha(m.samplePaths)).toBe(SIM_PATHS);
    expect(m.hist).toEqual(SIM_HIST);
    expect(m.bands[m.bands.length - 1]).toEqual([355.42, 360.91, 364.46, 368.12, 373.65]);
    expect(m.bands[0]).toEqual([364.18, 364.18, 364.18, 364.18, 364.18]);
    expect([m.bandTimes[0], m.bandTimes[m.bandTimes.length - 1], m.bandTimes.length]).toEqual(['10:15', '16:00', 70]);
  });

  test('the history replay', () => {
    const h = doc.history;
    expect([h.sessions, h.triggered, h.target, h.stop, h.close, h.green, h.avgR]).toEqual([59, 33, 13, 15, 5, 15, -0.062]);
    expect(sha(h.trades.map((t) => ({ date: t.date, entry: t.entry, outcome: t.outcome, R: t.R })))).toBe(SIM_TRADES);
    const first = h.trades[0];
    expect([first.date, first.entry, first.stop, first.target, first.outcome]).toEqual(['2026-07-28', 307.97, 304.89, 311.05, 'target']);
  });

  test('the verdict says coin flip, with the many-neither note', () => {
    expect(doc.verdictCode).toBe('coin_flip');
    expect(doc.verdict).toContain('29.4%');
    expect(doc.verdict).toContain('25.5%');
    const lv = ts.lean(doc.mc);
    expect([Number(lv.share.toFixed(3)), lv.even]).toEqual([0.536, 0.5]);
    expect(doc.verdictNotes).toHaveLength(1);
    expect(doc.verdictNotes[0]).toContain('45.1%');
    expect(doc.warnings).toEqual([]);
  });

  test('the in-progress tick and bar are dropped', () => {
    const parsed = ts.parseChart(RESULT, NOW);
    expect(parsed.dropped).toEqual({ noPrice: 0, offGrid: 1, notComplete: 1, outsideHours: 0 });
    const last = parsed.bars[parsed.bars.length - 1];
    expect([last.date, last.start, last.slot]).toEqual(['2026-10-19', '10:40', 14]);
    const entry = parsed.bars.find((b) => b.date === '2026-10-19' && b.slot === 8);
    expect([entry.start, entry.c]).toEqual(['10:10', 364.1759948730469]);
  });
});

describe('Time Machine: other plans on the fixture', () => {
  test('2R near break-even (stop 362.00, target 368.54)', () => {
    const doc = machine({ stop: 362.0, target: 368.54, stopRule: 'pct' });
    const m = doc.mc;
    expect([m.rAtTarget, m.pTarget, m.pStop, m.avgR]).toEqual([2.0, 0.3345, 0.6238, 0.068]);
    expect(doc.verdictCode).toBe('break_even');
    expect(doc.verdictNotes).toEqual([]);
  });

  test('2R with a clear lean toward the stop (target 375.90)', () => {
    const doc = machine({ target: 375.9 });
    const m = doc.mc;
    expect([m.rAtTarget, m.pTarget, m.pStop, m.pNeither, m.avgR]).toEqual([2.0, 0.0397, 0.2558, 0.7045, 0.042]);
    expect(doc.verdictCode).toBe('strong_stop');
    expect(doc.verdictNotes).toHaveLength(2);
    expect(doc.verdictNotes[0]).toContain('70.5%');
    expect(doc.verdictNotes[1]).toContain('+0.042');
  });

  test('same seed same numbers, another seed other numbers', () => {
    const a = machine({}, { replays: 2000, seed: 5 }).mc;
    const b = machine({}, { replays: 2000, seed: 5 }).mc;
    expect(a).toEqual(b);
    const c = machine({}, { seed: 7 }).mc;
    expect([c.pTarget, c.pStop, c.medianClose]).not.toEqual([0.2938, 0.2548, 364.36]);
    expect(c.pTarget + c.pStop + c.pNeither).toBeCloseTo(1, 6);
  });

  test('10,000 replays run well under the CPU budget', () => {
    const t0 = process.hrtime.bigint();
    machine({}, { replays: 10000 });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    // eslint-disable-next-line no-console
    console.log(`[tradeSim] 10,000 replays + history: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(2000);
  });

  test('until cuts the replay; window 0 changes the draws', () => {
    const m = machine({}, { until: '15:55', replays: 500 }).mc;
    expect([m.until, m.barsLeft]).toEqual(['15:55', 68]);
    expect(machine({}, { until: '3:55 PM', replays: 500 }).mc).toEqual(m);
    expect(() => machine({}, { until: '16:05', replays: 10 })).toThrow(/לא אחרי/);
    expect(() => machine({}, { until: '10:15 AM', replays: 10 })).toThrow(/לא נשאר/);
    const w0 = machine({}, { replays: 500, window: 0 }).mc;
    expect(w0.window).toBe(0);
    const w2 = machine({}, { replays: 500 }).mc;
    expect([w0.pTarget, w0.pStop, w0.medianClose]).not.toEqual([w2.pTarget, w2.pStop, w2.medianClose]);
  });

  test('a half day is left out of the pool and the history', () => {
    const cut = keepBars(fresh(), (t) => !(etDate(t) === '2026-09-04' && ts.easternParts(t * 1000).minutes >= 13 * 60));
    const doc = machine({}, { replays: 300 }, cut);
    expect(doc.mc.poolSessions).toBe(58);
    expect(doc.data.shortSessionsLeftOut).toEqual([{ date: '2026-09-04', bars: 42 }]);
    expect(doc.history.trades.map((t) => t.date)).not.toContain('2026-09-04');
  });

  test('fewer than 20 sessions is refused, 20 is enough', () => {
    expect(() => machine({}, {}, keepBars(fresh(), (t) => etDate(t) >= '2026-09-22'))).toThrow(/רק 19 ימי מסחר/);
    expect(machine({}, { replays: 200 }, keepBars(fresh(), (t) => etDate(t) >= '2026-09-21')).mc.poolSessions).toBe(20);
  });

  test('a missing price is dropped (that day now has a gap)', () => {
    const hole = fresh();
    hole.indicators.quote[0].close[5] = null;
    const doc = machine({}, { replays: 200 }, hole);
    expect(doc.data.dropped.noPrice).toBe(1);
    expect(doc.mc.poolSessions).toBe(58);
  });

  test('the entry must be in the data, the data must be the plan\'s ticker', () => {
    expect(() => machine({ date: '2026-10-20' })).toThrow(/לא בנתונים/);
    expect(() => machine({}, {}, null, Date.UTC(2026, 9, 19, 14, 12))).toThrow(/לא בנתונים/);
    expect(() => machine({ symbol: 'AAPL' })).toThrow(/TSLA/);
  });

  test('an entry outside its bar is flagged', () => {
    const doc = machine({ entry: 368.0, stop: 362.0, target: 374.0 }, { replays: 200 });
    expect(doc.warnings[0]).toContain('מחוץ לטווח הנר');
  });

  test('daylight saving: 9:30 is 13:30Z before Nov 1 and 14:30Z after', () => {
    expect(ts.easternOffset(1793367000 * 1000)).toBe(-4);
    expect(ts.easternOffset(1793629800 * 1000)).toBe(-5);
    const res = {
      meta: { symbol: 'X' },
      timestamp: [1793367000, 1793629800, 1793626200, 1793649600],
      indicators: { quote: [{ open: [1, 1, 1, 1], high: [1, 1, 1, 1], low: [1, 1, 1, 1], close: [1, 1, 1, 1], volume: [0, 0, 0, 0] }] }
    };
    const parsed = ts.parseChart(res, Date.UTC(2026, 10, 3));
    expect(parsed.bars.map((b) => [b.date, b.start, b.slot])).toEqual([
      ['2026-10-30', '09:30', 0],
      ['2026-11-02', '09:30', 0],
      ['2026-11-02', '15:00', 66]
    ]);
    expect(parsed.dropped.outsideHours).toBe(1);
  });

  test('the stop rule is worked out when not given; stops round down to the cent', () => {
    expect(machine({ stopRule: 'auto' }, { replays: 100 }).history.rule.stopRule).toBe('or_mid');
    const low = machine({ stopRule: 'auto', stop: 354.47, target: 373.89 }, { replays: 100 }).history.rule;
    expect([low.stopRule, low.targetR]).toEqual(['or_low', 1.0]);
    const atr = machine({ stopRule: 'atr', stop: 360.0, target: 372.54 }, { replays: 100 }).history.rule;
    expect([atr.stopRule, atr.stopPct, atr.targetR]).toEqual(['pct', 1.1478, 2.0]);
    expect(ts.centsAway(358.325)).toBe(358.32);
    expect(ts.centsAway(354.4700012207031)).toBe(354.47);
    expect(ts.centsAway(354.46999999999997)).toBe(354.47);
  });

  test('verdict thresholds (1R and 2R)', () => {
    expect(ts.verdict({ pTarget: 0.3, pStop: 0.26 }).code).toBe('coin_flip');
    expect(ts.verdict({ pTarget: 0.4, pStop: 0.3 }).code).toBe('lean_target');
    expect(ts.verdict({ pTarget: 0.2, pStop: 0.3 }).code).toBe('lean_stop');
    expect(ts.verdict({ pTarget: 0.6, pStop: 0.3 }).code).toBe('strong_target');
    expect(ts.verdict({ pTarget: 0.1, pStop: 0.6, rAtTarget: 1 }).code).toBe('strong_stop');
    expect(ts.verdict({ pTarget: 0, pStop: 0, until: '15:55' })).toEqual({ code: 'none', text: expect.stringContaining('3:55 PM') });
    const mc = { pTarget: 0.241, pStop: 0.505, pNeither: 0.254, rAtTarget: 2.0, avgR: 0.095 };
    expect(ts.verdict(mc).code).toBe('break_even');
    expect(ts.verdict(mc).text).toContain('33%');
    expect(ts.verdict(mc).text).toContain('32%');
    expect(ts.verdictNotes(mc)).toEqual([]);
    const leanStop = Object.assign({}, mc, { pTarget: 0.15, pStop: 0.55 });
    expect(ts.verdict(leanStop).code).toBe('lean_stop');
    expect(ts.verdictNotes(leanStop)[0]).toContain('+0.095');
    expect(ts.verdict(Object.assign({}, mc, { pTarget: 0.4, pStop: 0.4 })).code).toBe('strong_target');
  });
});

describe('exit plan (trader-exit numbers)', () => {
  const c = (entry, stop, target, extra) => ts.planExit(Object.assign({ entry, stop, target: target || { type: 'r', value: 2 }, openingRange: { high: 362.18, low: 354.47 } }, extra || {}));

  test('the reel: opening-range midpoint, 1R', () => {
    const p = c(364.18, { type: 'or_mid' }, { type: 'r', value: 1 });
    expect([p.stop, p.risk, p.target, p.rewardRisk]).toEqual([358.32, 5.86, 370.04, 1]);
    expect(p.stopDetail).toContain('מעוגל למטה');
    expect(c(364.18, { type: 'or_mid' }).target).toBe(375.9);
  });

  test('raw Yahoo floats give the same cents', () => {
    const p = ts.planExit({ entry: 364.1759948730469, stop: { type: 'or_mid' }, target: { type: 'r', value: 1 }, openingRange: { high: 362.17999267578125, low: 354.4700012207031 } });
    expect([p.entry, p.stop, p.target]).toEqual([364.18, 358.32, 370.04]);
  });

  test('other stops', () => {
    let p = c(364.18, { type: 'or_low' });
    expect([p.stop, p.risk, p.target]).toEqual([354.47, 9.71, 383.6]);
    expect(c(364.18, { type: 'price', value: 358.329 }).stop).toBe(358.32);
    p = c(364.18, { type: 'pct', value: 1 });
    expect([p.stop, p.risk, p.target]).toEqual([360.53, 3.65, 371.48]);
    p = c(364.18, { type: 'atr', value: 1.5 }, null, { atr: { value: 3.2181, bars: 9 } });
    expect(p.stop).toBe(359.35); // 364.18 - 4.82715 = 359.35285
    expect(p.stopLabel).toContain('ATR(9)');
  });

  test('targets round half up; price targets get their R', () => {
    expect(ts.planExit({ entry: 100, stop: { type: 'price', value: 99.01 }, target: { type: 'r', value: 1.5 } }).target).toBe(101.49);
    const p = c(364.18, { type: 'or_mid' }, { type: 'price', value: 372 });
    expect([p.rewardRisk, p.targetR]).toEqual([1.33, 1.33]);
  });

  test('refusals say why (Hebrew) and carry a code', () => {
    const cases = [
      [{ type: 'price', value: 364.18 }, null, 'stop_above_entry'],
      [{ type: 'price', value: 365 }, null, 'stop_above_entry'],
      [{ type: 'or_mid' }, { type: 'price', value: 364 }, 'target_below_entry'],
      [{ type: 'price', value: 364.01 }, null, 'stop_too_tight'],
      [{ type: 'pct', value: 0.04 }, null, 'stop_too_tight']
    ];
    cases.forEach(([stop, target, code]) => {
      let err;
      try {
        c(364.18, stop, target);
      } catch (e) {
        err = e;
      }
      expect(err && err.code).toBe(code);
      expect(err.message).toMatch(/[֐-׿]/);
    });
    expect(() => c(364.18, { type: 'price', value: 364.01 })).toThrow(/spread/);
    // 0.05% of 364.18 is 0.182: a $0.19 risk is allowed, $0.18 is not
    expect(c(364.18, { type: 'price', value: 363.99 }).risk).toBe(0.19);
    expect(() => c(364.18, { type: 'price', value: 364.0 })).toThrow();
    expect(() => c(358.0, { type: 'or_mid' })).toThrow(/מעליה/);
    expect(() => c(364.18, { type: 'pct', value: 100 })).toThrow();
    expect(() => c(364.18, { type: 'nope' })).toThrow();
    expect(() => c(364.18, { type: 'or_mid' }, { type: 'r', value: 0 })).toThrow();
    expect(() => ts.planExit({ entry: 364.18, stop: { type: 'or_mid' }, target: { type: 'r', value: 1 } })).toThrow(/טווח הפתיחה/);
    expect(() => c(364.18, { type: 'or_mid' }, null, { openingRange: { high: 354.47, low: 362.18 } })).toThrow();
    expect(() => c(364.18, { type: 'atr', value: 1.5 })).toThrow(/ATR/);
  });

  test('ATR of the session bars', () => {
    const day = ts.splitSessions(ts.parseChart(RESULT, NOW).bars)['2026-10-19'];
    const bars = [];
    for (let i = 0; i <= 8; i++) bars.push(day[i]);
    const a = ts.atrOf(bars);
    expect(a.bars).toBe(9);
    expect(a.atr).toBeCloseTo(3.2182, 4);
  });
});

describe('position sizing (trader-budget numbers)', () => {
  const base = { entry: 364.18, stop: 358.32, target: 370.04, account: 5000, maxLossPerTrade: 50, positionCapPct: 75, cashBufferPct: 10, maxOrderUsd: 4000 };
  const size = (over) => ts.sizePosition(Object.assign({}, base, over || {}));

  test('TSLA is 8 shares, bound by the max loss', () => {
    const s = size();
    expect([s.qty, s.boundBy, s.riskPerShare, s.cost, s.maxLossAtStop, s.rewardRisk, s.cashBuffer]).toEqual([8, 'maxLoss', 5.86, 2913.44, 46.88, 1, 500]);
    expect(s.limits.map((l) => [l.name, l.shares])).toEqual([
      ['maxLoss', 8],
      ['positionCap', 10],
      ['maxOrder', 10],
      ['cash', 12]
    ]);
    expect(s.limits.filter((l) => l.binds).map((l) => l.name)).toEqual(['maxLoss']);
    expect(s.refusal).toBeNull();
  });

  test('each limit can bind', () => {
    expect(size({ maxOrderUsd: 1000 }).boundBy).toBe('maxOrder');
    expect([size({ positionCapPct: 20 }).qty, size({ positionCapPct: 20 }).boundBy]).toEqual([2, 'positionCap']);
    const cash = size({ cash: 1200 });
    expect([cash.qty, cash.boundBy, cash.cashAvailable]).toEqual([1, 'cash', 700]);
    expect([size({ maxLossPerTrade: 100 }).qty, size({ maxLossPerTrade: 100 }).boundBy]).toEqual([10, 'positionCap']);
    const limit = size({ entry: 364.0 });
    expect([limit.riskPerShare, limit.qty, limit.maxLossAtStop]).toEqual([5.68, 8, 45.44]);
  });

  test('zero shares (the stop is too far for the max loss) is a plain refusal', () => {
    const s = size({ stop: 300 });
    expect(s.qty).toBe(0);
    expect(s.refusalCode).toBe('stop_too_far');
    expect(s.refusal).toContain('$50');
    expect(size({ entry: 4, stop: 3, target: 5, maxLossPerTrade: 1, minOrderUsd: 5 }).refusalCode).toBe('under_min_order');
  });

  test('bad inputs', () => {
    expect(() => size({ stop: 365 })).toThrow(/אינו מתחת/);
    expect(() => size({ target: 360 })).toThrow(/כבר קרתה/);
    expect(() => size({ account: 0 })).toThrow();
    expect(() => size({ maxLossPerTrade: -1 })).toThrow();
  });
});

describe('runTradeSim (what the API runs)', () => {
  const input = {
    symbol: 'TSLA',
    stop: { type: 'or_mid' },
    target: { type: 'r', value: 1 },
    account: 5000,
    maxLossPerTrade: 50
  };

  test('live session: entry at the last completed bar, opening-range stop, reproducible', () => {
    const a = ts.runTradeSim(RESULT, Object.assign({}, input, { sims: 2000 }), NOW);
    expect(a.mode).toBe('live');
    expect(a.entryTime).toBe('10:45 AM');
    expect(a.plan.openingRange).toMatchObject({ high: 362.17999267578125, low: 354.4700012207031 });
    expect(a.plan.stop).toBe(358.32);
    expect(a.odds.target + a.odds.stop + a.odds.open).toBeCloseTo(1, 6);
    expect(a.coverage).toMatchObject({ sessions: 59, from: '2026-07-27', to: '2026-10-16' });
    expect(a.history.rule).toBe('orb');
    expect(a.history.triggered).toBeGreaterThan(0);
    expect(a.sizing.qty).toBeGreaterThan(0);
    expect(a.disclaimer).toContain('לא תחזית');
    expect(ts.runTradeSim(RESULT, Object.assign({}, input, { sims: 2000 }), NOW)).toEqual(a);
  });

  test('the reel through runTradeSim: same plan, same numbers as the Python tool', () => {
    // At 10:15 ET the last completed bar is the 10:10 bar (k = 8), the reel's entry bar.
    const res = ts.runTradeSim(RESULT, Object.assign({}, input, { entry: 364.18 }), Date.UTC(2026, 9, 19, 14, 15));
    expect(res.entryTime).toBe('10:15 AM');
    expect([res.odds.target, res.odds.stop, res.odds.open, res.avgR]).toEqual([0.2938, 0.2548, 0.4514, 0.034]);
    expect([res.history.triggered, res.history.target, res.history.stop, res.history.avgR]).toEqual([33, 13, 15, -0.062]);
    expect([res.sizing.qty, res.sizing.boundBy, res.sizing.maxLossAtStop]).toEqual([8, 'maxLoss', 46.88]);
  });

  test('outside the session: a hypothetical next-session entry; OR stops refused', () => {
    const later = Date.UTC(2026, 9, 20, 3, 0); // 23:00 ET, the session is over
    const res = ts.runTradeSim(RESULT, Object.assign({}, input, { stop: { type: 'pct', value: 1.5 }, target: { type: 'r', value: 2 }, sims: 1000 }), later);
    expect(res.mode).toBe('next');
    expect(res.entryTime).toBe('10:00 AM');
    expect(res.history.rule).toBe('time');
    expect(res.history.triggered).toBe(59);
    expect(res.coverage.shortSessionsLeftOut).toEqual([{ date: '2026-10-19', bars: 15 }]);
    expect(() => ts.runTradeSim(RESULT, input, later)).toThrow(/טווח הפתיחה/);
    const atr = ts.runTradeSim(RESULT, Object.assign({}, input, { stop: { type: 'atr', value: 2 }, entryTime: '11:30', sims: 500 }), later);
    expect(atr.entryTime).toBe('11:30 AM');
    expect(atr.plan.atr.from).toBe('2026-10-19');
  });

  test('input checks', () => {
    expect(() => ts.runTradeSim(RESULT, Object.assign({}, input, { sims: 20000 }), NOW)).toThrow(/10,000/);
    expect(() => ts.runTradeSim(RESULT, Object.assign({}, input, { symbol: 'AAPL' }), NOW)).toThrow(/TSLA/);
    expect(() => ts.runTradeSim(RESULT, Object.assign({}, input, { entry: 300 }), NOW)).toThrow(/מעליה/);
  });

  test('10,000 sims end to end stays well under the CPU budget', () => {
    const t0 = process.hrtime.bigint();
    ts.runTradeSim(RESULT, input, NOW);
    expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(2000);
  });
});
