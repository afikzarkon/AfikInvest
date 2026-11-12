/** @jest-environment node */
// Reproduces trader-scanner's Python tests (tests/test_scanner.py) for the
// daily scan, on the same recorded fixtures (src/server/fixtures/scanner).
const fs = require('fs');
const path = require('path');
const svc = require('./scannerService');

const FIX = path.join(__dirname, 'fixtures', 'scanner');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const DAILY = JSON.parse(read('daily-spark-2026-10-19.json'));
const LIVE_TEXT = read('spark-3mo-live-2026-10-20.json');
const at = (ny) => svc.easternToUtc(ny);
const ts = (ny) => at(ny) / 1000;

describe('universe (Nasdaq Trader symbol directories)', () => {
  const texts = {};
  svc.NASDAQ_FILES.forEach((f) => {
    texts[f] = read(path.join('symdir', f));
  });
  const uni = svc.buildUniverse(texts);
  const rows = {};
  svc.NASDAQ_FILES.forEach((f) => {
    svc.parseSymbolDirectory(texts[f]).rows.forEach((r) => {
      rows[r.Symbol || r['ACT Symbol']] = r;
    });
  });

  test('the kept list', () => {
    expect(uni.symbols.map((s) => s.symbol)).toEqual([
      'A', 'AACG', 'AACI', 'AAPL', 'AME', 'AMX', 'ARLP', 'BEP', 'BF.B', 'BRK.B', 'IRS', 'KO', 'OBAI', 'ORGO', 'PFBC', 'PRT', 'TSLA'
    ]);
    expect(uni.counts.rows).toBe(36);
    expect(uni.created).toBe('2026-10-19 10:01');
    const tsla = uni.symbols.find((s) => s.symbol === 'TSLA');
    expect(tsla.securityName).toBe('Tesla, Inc. - Common Stock');
    expect(tsla.name).toBe('Tesla, Inc.');
  });

  test('one case per rule', () => {
    const cases = {
      ZAZZT: 'test issue', ZZZTX: 'test issue',
      AAAP: 'ETF', SPY: 'ETF',
      'ABR$D': 'not a plain ticker',
      'AAC.U': 'unit / warrant / right suffix', 'AAC.W': 'unit / warrant / right suffix',
      AACIW: 'warrant',
      HAVAR: 'unit or right',
      ATMP: 'note',
      GJH: 'coupon', EAI: 'coupon',
      CDZIP: 'depositary',
      AACIU: 'unit', ARCIU: 'unit',
      AACPR: 'right', GENVR: 'right',
      BHK: 'bond',
      CHTRP: 'preferred',
      AAPL: 'keep', AACI: 'keep', AACG: 'keep',
      PFBC: 'keep', OBAI: 'keep',
      AMX: 'keep', IRS: 'keep',
      ARLP: 'keep', BEP: 'keep', PRT: 'keep',
      'BRK.B': 'keep', 'BF.B': 'keep',
      AME: 'keep', ORGO: 'keep'
    };
    Object.entries(cases).forEach(([sym, want]) => {
      expect([sym, svc.classifySymbolRow(rows[sym])]).toEqual([sym, want]);
    });
  });

  test('NextShares and a non-directory', () => {
    expect(svc.classifySymbolRow({ Symbol: 'ZXYZ', 'Security Name': 'Some Fund - NextShares', 'Test Issue': 'N', ETF: 'N', NextShares: 'Y' })).toBe('NextShares');
    expect(() => svc.parseSymbolDirectory('<html>maintenance</html>')).toThrow(svc.ScanError);
  });
});

describe('time', () => {
  test('DST rule and New York dates', () => {
    expect(svc.easternOffset(Date.UTC(2026, 2, 8, 6, 59))).toBe(-5);
    expect(svc.easternOffset(Date.UTC(2026, 2, 8, 7, 0))).toBe(-4);
    expect(svc.easternOffset(Date.UTC(2026, 10, 1, 5, 59))).toBe(-4);
    expect(svc.easternOffset(Date.UTC(2026, 10, 1, 6, 0))).toBe(-5);
    expect(svc.toEastern(1792416600 * 1000)).toMatchObject({ date: '2026-10-19', minutes: 9 * 60 + 30 });
    expect(at('2026-10-19 10:15')).toBe(Date.UTC(2026, 9, 19, 14, 15));
    expect(at('2026-12-01 10:15')).toBe(Date.UTC(2026, 11, 1, 15, 15));
    expect(svc.isTradingDay('2026-11-26')).toBe(false);
    expect(svc.isTradingDay('2026-11-14')).toBe(false);
    expect(svc.sessionCloseMinutes('2026-11-27')).toBe(13 * 60);
  });
});

describe('spark', () => {
  test('a real spark answer', () => {
    const wanted = {};
    ['AAPL', 'TSLA', 'BRK.B', 'ZZZZQX'].forEach((s) => {
      wanted[svc.toYahoo(s)] = s;
    });
    const data = svc.parseSpark(LIVE_TEXT, wanted);
    expect(Object.keys(data)).toHaveLength(19);
    expect(data.ZZZZQX).toBeUndefined();
    expect(data['BRK.B']).toBeDefined();
    const t = data.TSLA;
    expect(t.t).toHaveLength(65);
    expect(t.c[t.c.length - 1]).toBe(368.06);
    expect(t.meta.regularMarketVolume).toBe(38651173);
    expect(data.AMC.meta.regularMarketPrice).toBe(2.98);
    let closes = svc.dailyCloses(t, at('2026-10-20 09:14'));
    expect(closes[closes.length - 1]).toMatchObject({ date: '2026-10-19', close: 368.06 });
    closes = svc.dailyCloses(t, at('2026-10-19 12:00'));
    expect(closes[closes.length - 1].date).toBe('2026-10-16');
  });

  test('spark errors and urls', () => {
    const tooMany = '{"spark":{"result":null,"error":{"code":"Bad Request","description":"Number of symbols needs to be less than or equal to 20"}}}';
    expect(() => svc.parseSpark(tooMany)).toThrow(/less than or equal to 20/);
    expect(svc.parseSpark('{"spark":{"result":[],"error":null}}')).toEqual({});
    expect(() => svc.parseSpark('{"chart":{}}')).toThrow(svc.ScanError);
    expect(svc.sparkPath(['BRK.B', 'tsla'], '3mo', '1d')).toBe('/v7/finance/spark?symbols=BRK-B,TSLA&range=3mo&interval=1d');
  });
});

describe('daily setups (closes through Fri Oct 16 2026)', () => {
  const EXPECT = {
    BLK: ['breakout_20d'],
    CI: ['breakout_20d'],
    XOM: ['breakout_20d'],
    HD: ['breakout_20d'],
    KO: ['breakout_20d'],
    CCL: ['bull_flag'],
    RCL: ['bull_flag'],
    F: ['reclaim_ma20'],
    JPM: ['reclaim_ma20'],
    GE: ['reclaim_ma20'],
    BAC: ['oversold'],
    PLUG: ['oversold'],
    MS: ['oversold'],
    RIVN: ['oversold'],
    PNC: ['oversold_bounce']
  };
  const data = svc.parseSpark(DAILY);
  const syms = Object.keys(data).sort();

  test('setups before the open', () => {
    expect(syms).toHaveLength(19);
    const { hits, counts, lastDate } = svc.scanDaily(data, syms, at('2026-10-19 09:00'), { minPrice: 0, minVolume: 0 });
    const got = {};
    hits.forEach((h) => {
      got[h.symbol] = h.setups;
    });
    expect(got).toEqual(EXPECT);
    expect(lastDate).toBe('2026-10-16');
    expect(counts).toEqual({ requested: 19, fetched: 19, illiquid: 0, short: 0, scanned: 19, hits: 15 });
    const blk = hits.find((h) => h.symbol === 'BLK');
    expect([blk.close, blk.rsi, blk.closeDate]).toEqual([1134.38, 63.7, '2026-10-16']);
    expect(blk.high20).toBe(1120.78);
    expect(blk.distHigh20Pct).toBeCloseTo((1134.38 / 1120.78 - 1) * 100, 1);
    const pnc = hits.find((h) => h.symbol === 'PNC');
    expect([pnc.rsiPrev, pnc.rsi]).toEqual([27.1, 34]);
    expect(pnc.changePct).toBeCloseTo((217.39 / 214.94 - 1) * 100, 1);
    expect(svc.countBySetup(hits)).toEqual({ breakout_20d: 5, bull_flag: 2, reclaim_ma20: 3, oversold: 4, oversold_bounce: 1, drawdown_30: 0, pullback_ma200: 0 });
    // most dollars traded first
    for (let i = 1; i < hits.length; i += 1) {
      expect(hits[i - 1].close * (hits[i - 1].volume || 0)).toBeGreaterThanOrEqual(hits[i].close * (hits[i].volume || 0));
    }
  });

  test('the in-progress bar is dropped', () => {
    const before = svc.scanDaily(data, syms, at('2026-10-19 09:00'), { minPrice: 0, minVolume: 0 });
    const during = svc.scanDaily(data, syms, at('2026-10-19 10:50'), { minPrice: 0, minVolume: 0 });
    expect(during).toEqual(before);
    let bars = svc.dailyCloses(data.TSLA, at('2026-10-19 15:59'));
    expect(bars[bars.length - 1]).toMatchObject({ date: '2026-10-16', close: 354.7200012207031 });
    bars = svc.dailyCloses(data.TSLA, at('2026-10-19 16:00'));
    expect(bars[bars.length - 1]).toMatchObject({ date: '2026-10-19', close: 365.7950134277344 });
  });

  test('a half-day bar completes at 1:00 PM', () => {
    const s = { t: [ts('2026-11-25 09:30'), ts('2026-11-27 09:30')], c: [10, 11], meta: {} };
    expect(svc.dailyCloses(s, at('2026-11-27 12:59'))).toHaveLength(1);
    expect(svc.dailyCloses(s, at('2026-11-27 13:00'))).toHaveLength(2);
  });

  test('liquidity filter (scan.py defaults: $5, 1,000,000 shares)', () => {
    const { hits, counts } = svc.scanDaily(data, syms, at('2026-10-19 10:50'), { minPrice: 5, minVolume: 1000000 });
    expect(hits.map((h) => h.symbol).sort()).toEqual(['BAC', 'CCL', 'F', 'JPM', 'KO', 'RIVN', 'XOM']);
    expect(counts.illiquid).toBe(8);
    expect(counts.scanned).toBe(11);
  });

  test('short and empty charts', () => {
    const s = {
      t: Array.from({ length: 10 }, (_, i) => ts(`2026-10-${String(i + 1).padStart(2, '0')} 09:30`)),
      c: Array(10).fill(10),
      meta: { regularMarketPrice: 10, regularMarketVolume: 5000000 }
    };
    const { hits, counts, lastDate } = svc.scanDaily({ X: s, E: { t: [], c: [], meta: {} } }, ['X', 'E', 'GONE'], at('2026-10-20 09:00'), {
      minPrice: 5,
      minVolume: 1000000
    });
    expect(hits).toEqual([]);
    expect([counts.fetched, counts.short, counts.illiquid, counts.scanned]).toEqual([2, 1, 1, 0]);
    expect(lastDate).toBeNull();
  });

  test('RSI matches the reel math', () => {
    expect(svc.rsi(Array(10).fill(1))).toBeNull();
    expect(svc.rsi(Array.from({ length: 39 }, (_, i) => i + 1))).toBe(100);
    const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
    expect(svc.rsi(closes)).toBeCloseTo(70.46, 1);
  });

  test('volume vs average when the series carries volumes', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 50 + (i === 39 ? 5 : 0));
    const s = {
      t: closes.map((_, i) => ts(`2026-0${8 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, '0')} 09:30`)),
      c: closes,
      v: closes.map((_, i) => (i === 39 ? 3000000 : 1000000)),
      meta: { regularMarketPrice: 55, regularMarketVolume: 3000000 }
    };
    const r = svc.evaluateSymbol(s, at('2026-10-20 09:00'), { minPrice: 5, minVolume: 0 });
    expect(r.hit.setups).toContain('breakout_20d');
    expect(r.hit.avgVolume).toBe(1000000);
    expect(r.hit.volumeRatio).toBe(3);
  });
});

describe('network (no real requests)', () => {
  const body = LIVE_TEXT;
  function fakeGet(codes, calls) {
    const queue = codes.slice();
    return async (url) => {
      calls.push(url.split('/v')[0]);
      const status = queue.length ? queue.shift() : 200;
      return { status, body: status === 200 ? body : '' };
    };
  }

  test('429 falls back to query1, then waits once', async () => {
    const calls = [];
    const sleeps = [];
    const text = await svc.yahooGet('/v7/finance/spark?symbols=TSLA&range=3mo&interval=1d', {
      httpGet: fakeGet([429, 429, 200], calls),
      sleep: async (ms) => sleeps.push(ms)
    });
    expect(text).toBe(body);
    expect(calls).toEqual(['https://query2.finance.yahoo.com', 'https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']);
    expect(sleeps).toEqual([svc.BACKOFF_MS]);
  });

  test('5xx goes to query1 without waiting; a 404 is final', async () => {
    let calls = [];
    const sleeps = [];
    await svc.yahooGet('/x', { httpGet: fakeGet([503, 200], calls), sleep: async (ms) => sleeps.push(ms) });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([]);
    calls = [];
    await expect(svc.yahooGet('/v8/finance/chart/NOPE', { httpGet: fakeGet([404], calls), sleep: async () => {} })).rejects.toThrow(svc.ScanError);
    expect(calls).toHaveLength(1);
  });

  test('429 for good is reported per symbol', async () => {
    const calls = [];
    const syms = ['AAPL', 'TSLA', 'NVDA', 'BRK.B', 'AMC', 'ZZZZQX', 'MSFT', 'AMZN', 'META', 'GOOGL', 'PLTR', 'AMD', 'INTC', 'F', 'BAC', 'KO', 'PLUG', 'SOFI', 'RIVN', 'LCID'];
    const ok = await svc.fetchSparkBatch(syms, { httpGet: fakeGet([200], calls), sleep: async () => {} });
    expect(Object.keys(ok.data)).toHaveLength(19);
    expect(ok.failed).toEqual({ ZZZZQX: 'no data from Yahoo' });
    const bad = await svc.fetchSparkBatch(['X00', 'X01'], { httpGet: fakeGet([429, 429, 429, 429], calls), sleep: async () => {} });
    expect(bad.data).toEqual({});
    expect(bad.failed.X00).toMatch(/HTTP 429/);
  });

  test('fetchUniverse reads both directories', async () => {
    const httpGet = async (url) => ({ status: 200, body: read(path.join('symdir', url.split('/').pop())) });
    const u = await svc.fetchUniverse({ httpGet, sleep: async () => {} });
    expect(u.symbols).toHaveLength(17);
    await expect(svc.fetchUniverse({ httpGet: async () => ({ status: 503, body: '' }), sleep: async () => {} })).rejects.toThrow(/HTTP 503/);
  });
});

describe('streaming scan', () => {
  const data = svc.parseSpark(DAILY);
  const universe = Object.keys(data).sort().map((symbol) => ({ symbol, name: `${symbol} Inc.` }));
  universe.push({ symbol: 'GONE', name: 'Gone' });

  test('batches of 20 with a pause, names carried, hits sorted', async () => {
    const batches = [];
    const sleeps = [];
    const big = [...universe, ...Array.from({ length: 25 }, (_, i) => ({ symbol: `Z${i}`, name: null }))];
    const r = await svc.runDailyScan({
      universe: big,
      fetchSpark: async (batch) => {
        batches.push(batch.length);
        const out = { data: {}, failed: {} };
        batch.forEach((s) => {
          if (data[s]) out.data[s] = data[s];
          else out.failed[s] = 'no data';
        });
        return out;
      },
      now: at('2026-10-19 09:00'),
      minPrice: 0,
      minVolume: 0,
      sleep: async (ms) => sleeps.push(ms)
    });
    expect(batches).toEqual([20, 20, 5]);
    expect(sleeps).toEqual([svc.PAUSE_MS, svc.PAUSE_MS]);
    expect(r.partial).toBe(false);
    expect(r.counts).toMatchObject({ requested: 45, attempted: 45, fetched: 19, failed: 26, scanned: 19, hits: 15, requests: 3 });
    expect(r.asOf).toBe('2026-10-16');
    expect(r.hits.find((h) => h.symbol === 'KO').name).toBe('KO Inc.');
    expect(r.bySetup.breakout_20d).toBe(5);
  });

  test('stops at the time budget and says partial', async () => {
    let t = 0;
    const r = await svc.runDailyScan({
      universe: Array.from({ length: 100 }, (_, i) => ({ symbol: `S${i}` })),
      fetchSpark: async () => {
        t += 1000;
        return { data: {}, failed: {} };
      },
      now: at('2026-10-19 17:00'),
      timeBudgetMs: 2500,
      pauseMs: 0,
      clock: () => t
    });
    expect(r.partial).toBe(true);
    expect(r.counts.requests).toBe(3);
    expect(r.counts.attempted).toBe(60);
  });

  test('a throwing fetcher fails only its batch', async () => {
    const r = await svc.runDailyScan({
      universe,
      fetchSpark: async (batch) => {
        if (batch.includes('BAC')) throw new Error('boom');
        return { data: {}, failed: {} };
      },
      now: at('2026-10-19 17:00'),
      pauseMs: 0
    });
    expect(r.counts.failed).toBe(20);
    expect(r.counts.fetched).toBe(0);
  });
});

describe('long-term setups (AfikInvest additions)', () => {
  const series = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  test('drawdown_30: 30%+ under the 52-week closing high', () => {
    // 200 sessions at 100, then a slide to 65.
    const c = series(230, (i) => (i < 200 ? 100 : 100 - (i - 199) * (35 / 30)));
    const { setups, numbers } = svc.findSetups(c);
    expect(setups).toContain('drawdown_30');
    expect(numbers.high52).toBe(100);
    expect(numbers.drawdownPct).toBeLessThanOrEqual(-30);
  });
  test('pullback_ma200: under a still-rising 200-day average', () => {
    // A steady climb for 240 sessions (to ~110), then five closes at 80.
    const c = series(245, (i) => (i < 240 ? 50 + i * 0.25 : 80));
    const { setups, numbers } = svc.findSetups(c);
    expect(setups).toContain('pullback_ma200');
    expect(numbers.ma200).toBeGreaterThan(numbers.ma200Prev);
  });
  test('no pullback when the 200-day average is falling (a downtrend)', () => {
    const c = series(245, (i) => 150 - i * 0.3);
    expect(svc.findSetups(c).setups).not.toContain('pullback_ma200');
  });
  test('three months of closes leave the long-term numbers empty', () => {
    const n = svc.longTermNumbers(series(63, () => 10));
    expect(n).toEqual({ high52: null, drawdownPct: null, ma200: null, ma200Prev: null });
  });
});
