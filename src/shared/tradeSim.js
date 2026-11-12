// Ported from day-trader-skill (MIT, Jake Schincariol)
//
// Trade simulator: the exit plan (trader-exit/exit.py), the Time Machine
// (trader-timemachine/timemachine.py) and position sizing
// (trader-budget/size.py), as pure functions with no I/O. Long side only.
//
// The Time Machine replays the rest of a session N times. Each replayed bar is
// drawn whole from the stock's own 5-minute bars at the same time of day
// (+- `window` bars) over its previous full sessions, scaled to the current
// price, with the stop checked before the target in every bar (a bar that
// touches both counts as the stop - the conservative call). It also re-runs
// the same rule on every past session ("history").
//
// The random draws come from a port of CPython's Mersenne Twister
// (random.Random(seed), randint, choice), so the same plan, data and seed give
// the same numbers as the Python tool, bit for bit (see tradeSim.test.js,
// which reproduces the Python test-suite's numbers on its TSLA fixture).
//
// CommonJS without spread/class syntax/for-of/array destructuring - see
// sharedModules.test.js for why.

// A module-level handle: resolving the global `Math` in a hot loop is very
// slow under Jest's sandboxed globals.
const M = Math;

const SESSION_BARS = 78; // 9:30 to 16:00 in 5-minute bars
const INTERVAL_SEC = 300;
const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;
const EARLY_MIN = 13 * 60;
const MIN_SESSIONS = 20;
const BAND_Q = [0.05, 0.25, 0.5, 0.75, 0.95];
const HIST_BINS = 24;
const COIN_FLIP = 0.05;
const STRONG = 0.15;
const MANY_NEITHER = 0.4;
const ATR_BARS = 14;
const MIN_RISK_PCT = 0.05; // a risk under 0.05% of the price is inside the spread's noise
const MAX_SIMS = 10000;
const DEFAULT_SEED = 19;
const DEFAULT_OR_MINUTES = 15;

// NYSE 1:00 p.m. early closes (from the Python pack, NYSE calendar read 2026-10-13).
const NYSE_EARLY_CLOSE = {
  '2026-11-27': 'day after Thanksgiving',
  '2026-12-24': 'Christmas Eve',
  '2027-11-26': 'day after Thanksgiving'
};

const DISCLAIMER =
  'סימולציה על בסיס 60 הימים האחרונים של המניה עצמה - לא תחזית ולא ייעוץ השקעות. ' +
  'דוחות, חדשות ועצירות מסחר יכולים לעשות מה שהחודשיים האחרונים לא עשו. ' +
  'סטופ הוא תכנית, לא הבטחה: פער מחיר או שוק מהיר יכולים לבצע אותו במחיר גרוע יותר.';

function tradeSimError(code, message) {
  const err = new Error(message);
  err.code = code;
  err.isTradeSimError = true;
  return err;
}

// ---------------------------------------------------------------- CPython's random

const MT_N = 624;
const MT_M = 397;

// random.Random(seed) for a non-negative integer seed (up to 2^53), with the
// draws this module needs: randbelow, randint, choice and random().
function createPyRandom(seed) {
  const mt = new Uint32Array(MT_N);
  let mti = MT_N + 1;

  function initGenrand(s) {
    mt[0] = s >>> 0;
    for (let i = 1; i < MT_N; i++) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = (M.imul(1812433253, prev) + i) >>> 0;
    }
    mti = MT_N;
  }

  function initByArray(key) {
    initGenrand(19650218);
    let i = 1;
    let j = 0;
    let k = M.max(MT_N, key.length);
    for (; k; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ M.imul(prev, 1664525)) >>> 0) + key[j] + j;
      i++;
      j++;
      if (i >= MT_N) {
        mt[0] = mt[MT_N - 1];
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (k = MT_N - 1; k; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ M.imul(prev, 1566083941)) >>> 0) - i;
      i++;
      if (i >= MT_N) {
        mt[0] = mt[MT_N - 1];
        i = 1;
      }
    }
    mt[0] = 0x80000000;
  }

  function genrandUint32() {
    let y;
    if (mti >= MT_N) {
      let kk = 0;
      for (; kk < MT_N - MT_M; kk++) {
        y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
        mt[kk] = mt[kk + MT_M] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      for (; kk < MT_N - 1; kk++) {
        y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
        mt[kk] = mt[kk + (MT_M - MT_N)] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      y = (mt[MT_N - 1] & 0x80000000) | (mt[0] & 0x7fffffff);
      mt[MT_N - 1] = mt[MT_M - 1] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      mti = 0;
    }
    y = mt[mti++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  // Python seeds an int from its absolute value split into 32-bit words.
  const n = M.floor(M.abs(Number(seed) || 0));
  const key = [];
  let rest = n;
  do {
    key.push(rest % 4294967296);
    rest = M.floor(rest / 4294967296);
  } while (rest > 0);
  initByArray(key);

  // _randbelow_with_getrandbits, for 0 < m < 2^32.
  function randbelow(m) {
    const k = 32 - M.clz32(m);
    let r = genrandUint32() >>> (32 - k);
    while (r >= m) r = genrandUint32() >>> (32 - k);
    return r;
  }

  return {
    randbelow,
    randint: (a, b) => a + randbelow(b - a + 1),
    choice: (seq) => seq[randbelow(seq.length)],
    random: () => {
      const a = genrandUint32() >>> 5;
      const b = genrandUint32() >>> 6;
      return (a * 67108864 + b) / 9007199254740992;
    },
    uint32: genrandUint32
  };
}

// ---------------------------------------------------------------- number helpers

// Python's round(x, n): correctly rounded on the exact binary value, exact
// halves (like 0.125) to even.
function pyRound(x, n) {
  if (!Number.isFinite(x)) return x;
  const digits = n || 0;
  const exact = M.abs(x).toFixed(100);
  const point = exact.indexOf('.');
  const tail = exact.slice(point + 1 + digits);
  if (tail.charAt(0) === '5' && /^50*$/.test(tail)) {
    const scale = M.pow(10, digits);
    const down = M.floor(M.abs(x) * scale);
    const even = down % 2 === 0 ? down : down + 1;
    return (x < 0 ? -even : even) / scale;
  }
  return Number(x.toFixed(digits));
}

// Neumaier-compensated mean (Python's statistics.mean is exact).
function exactMean(xs) {
  let sum = 0;
  let c = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    const t = sum + x;
    if (M.abs(sum) >= M.abs(x)) c += sum - t + x;
    else c += x - t + sum;
    sum = t;
  }
  return (sum + c) / xs.length;
}

// A positive decimal (number or string) times 10^scale, as an integer, rounded
// 'floor' or 'halfUp' on its decimal digits (like Python's Decimal(repr(x))).
function toScaled(value, scale, mode) {
  const s = typeof value === 'number' ? String(value) : String(value == null ? '' : value).trim().replace(/^\$/, '').replace(/,/g, '');
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (!m[1] && !m[2])) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return toScaled(value.toFixed(12), scale, mode);
    }
    return NaN;
  }
  const intPart = m[1] || '0';
  const frac = m[2] || '';
  if (frac.length <= scale) return Number(intPart + frac.padEnd(scale, '0'));
  const base = Number(intPart + frac.slice(0, scale));
  if (mode === 'halfUp' && frac.charAt(scale) >= '5') return base + 1;
  return base;
}

function decimalParts(value, maxScale) {
  const s = typeof value === 'number' ? String(value) : String(value == null ? '' : value).trim();
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (!m[1] && !m[2])) return null;
  const frac = (m[2] || '').replace(/0+$/, '');
  const scale = M.min(frac.length, maxScale);
  return { int: toScaled(s, scale, 'halfUp'), scale };
}

function floorDiv(num, den) {
  let q = M.floor(num / den);
  if (q * den > num) q -= 1;
  else if ((q + 1) * den <= num) q += 1;
  return q;
}

function halfUpDiv(num, den) {
  const q = floorDiv(num, den);
  return 2 * (num - q * den) >= den ? q + 1 : q;
}

const fromCents = (c) => c / 100;

function roundCent(x) {
  return M.floor(Number(x) * 100 + 0.5 + 1e-9) / 100;
}

function sharesFor(usd, perShare) {
  const u = M.round(Number(usd) * 100);
  const p = M.round(Number(perShare) * 100);
  if (p <= 0 || u <= 0) return 0;
  return M.floor(u / p);
}

function pct(sorted, q) {
  return sorted[M.min(sorted.length - 1, M.trunc(q * sorted.length))];
}

// ---------------------------------------------------------------- New York time

function nthSundayUtc(year, month, n) {
  const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return 1 + ((7 - first) % 7) + 7 * (n - 1);
}

// Hours from UTC for New York: -4 in daylight time, -5 otherwise (US rule since 2007).
function easternOffset(utcMs) {
  const y = new Date(utcMs).getUTCFullYear();
  const start = Date.UTC(y, 2, nthSundayUtc(y, 2, 2), 7);
  const end = Date.UTC(y, 10, nthSundayUtc(y, 10, 1), 6);
  return utcMs >= start && utcMs < end ? -4 : -5;
}

function easternParts(utcMs) {
  const local = new Date(utcMs + easternOffset(utcMs) * 3600000);
  return {
    date: local.toISOString().slice(0, 10),
    minutes: local.getUTCHours() * 60 + local.getUTCMinutes()
  };
}

const pad2 = (n) => (n < 10 ? '0' : '') + n;
const clock24 = (minutes) => `${pad2(M.floor(minutes / 60))}:${pad2(minutes % 60)}`;
function clock12(minutes) {
  const h = M.floor(minutes / 60);
  return `${h % 12 || 12}:${pad2(minutes % 60)} ${h < 12 ? 'AM' : 'PM'}`;
}

// '10:15 AM', '10:15am', '15:55', '3:55' (a bare 1 to 8 o'clock means p.m.) -> minutes after midnight.
function parseClock(text) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*(?:([AaPp])\.?\s*[Mm]\.?)?\s*$/.exec(String(text == null ? '' : text));
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2]);
  const ap = (m[3] || '').toLowerCase();
  if (mi > 59 || h > 23 || (ap && !(h >= 1 && h <= 12))) return null;
  if (ap === 'p' && h !== 12) h += 12;
  else if (ap === 'a' && h === 12) h = 0;
  else if (!ap && h >= 1 && h <= 8) h += 12;
  return h * 60 + mi;
}

// ---------------------------------------------------------------- data

// Yahoo chart result (range=60d interval=5m) -> regular-session 5-minute bars,
// oldest first. Dropped: bars with a missing price, bars off the 5-minute grid
// (the live tick), bars outside 9:30-16:00 New York, and bars not complete yet
// (now < start + 5 min, where now is the earlier of nowMs and the data's own
// regularMarketTime).
function parseChart(result, nowMs) {
  const res = result || {};
  const meta = res.meta || {};
  const stamps = Array.isArray(res.timestamp) ? res.timestamp : [];
  const q = (((res.indicators || {}).quote || [])[0]) || {};
  const cols = ['open', 'high', 'low', 'close', 'volume'].map((k) => (Array.isArray(q[k]) ? q[k] : []));
  let asOf = nowMs;
  const rmt = meta.regularMarketTime;
  if (typeof rmt === 'number' && Number.isFinite(rmt) && rmt * 1000 < asOf) asOf = rmt * 1000;
  const dropped = { noPrice: 0, offGrid: 0, notComplete: 0, outsideHours: 0 };
  const byTs = new Map();
  for (let i = 0; i < stamps.length; i++) {
    const o = cols[0][i];
    const h = cols[1][i];
    const l = cols[2][i];
    const c = cols[3][i];
    const v = cols[4][i];
    let ts = stamps[i];
    if (ts == null || o == null || h == null || l == null || c == null) {
      dropped.noPrice++;
      continue;
    }
    ts = M.trunc(Number(ts));
    if (ts % INTERVAL_SEC) {
      dropped.offGrid++;
      continue;
    }
    const local = easternParts(ts * 1000);
    const mins = local.minutes - OPEN_MIN;
    if (mins < 0 || mins >= SESSION_BARS * 5) {
      dropped.outsideHours++;
      continue;
    }
    if ((ts + INTERVAL_SEC) * 1000 > asOf) {
      dropped.notComplete++;
      continue;
    }
    byTs.set(ts, {
      date: local.date,
      slot: M.floor(mins / 5),
      start: clock24(local.minutes),
      o: Number(o),
      h: Number(h),
      l: Number(l),
      c: Number(c),
      v: Number(v) || 0
    });
  }
  const keys = Array.from(byTs.keys()).sort((a, b) => a - b);
  return { meta, bars: keys.map((k) => byTs.get(k)), dropped, asOfMs: asOf };
}

// { date: { slot: bar } }
function splitSessions(bars) {
  const days = {};
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (!days[b.date]) days[b.date] = {};
    days[b.date][b.slot] = b;
  }
  return days;
}

// Full sessions (all 78 bars) strictly before `before`, oldest first, and the
// short ones that were left out (half days, gaps).
function fullSessions(days, before) {
  const full = [];
  const short = [];
  const dates = Object.keys(days).sort();
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    if (d >= before) continue;
    const s = days[d];
    const n = Object.keys(s).length;
    if (n === SESSION_BARS) {
      const list = [];
      for (let j = 0; j < SESSION_BARS; j++) list.push(s[j]);
      full.push({ date: d, bars: list });
    } else {
      short.push({ date: d, bars: n });
    }
  }
  return { full, short };
}

// pool[i] = every past session's bar i as [o, h, l, c] / bar i-1's close, in date order.
function buildPool(sessions) {
  const pool = [];
  for (let i = 0; i < SESSION_BARS; i++) pool.push([]);
  for (let s = 0; s < sessions.length; s++) {
    const D = sessions[s].bars;
    for (let i = 1; i < SESSION_BARS; i++) {
      const pc = D[i - 1].c;
      pool[i].push([D[i].o / pc, D[i].h / pc, D[i].l / pc, D[i].c / pc]);
    }
  }
  return pool;
}

// ---------------------------------------------------------------- the simulation

// Monte Carlo replays of bars k+1..last from `entry`. Long side. Same draws and
// order as the Python tool's simulate().
function simulate(pool, opts) {
  const entry = opts.entry;
  const stop = opts.stop;
  const target = opts.target;
  const k = opts.k;
  const last = opts.last;
  const replays = opts.replays == null ? MAX_SIMS : opts.replays;
  const seed = opts.seed == null ? DEFAULT_SEED : opts.seed;
  const window = opts.window == null ? 2 : opts.window;
  const samplePaths = opts.samplePaths || 0;
  const bandPaths = opts.bandPaths || 0;
  const risk = entry - stop;
  const rTarget = pyRound((target - entry) / risk, 4);

  let rng = createPyRandom(seed);
  const slotOf = (i) => {
    if (window === 0) return i;
    const j = i + rng.randint(-window, window);
    return j < 1 ? 1 : j > SESSION_BARS - 1 ? SESSION_BARS - 1 : j;
  };

  const outcomes = new Array(replays);
  const closes = new Float64Array(replays);
  const paths = [];
  let nTarget = 0;
  let nStop = 0;
  for (let n = 0; n < replays; n++) {
    let p = entry;
    let outcome = null;
    const keep = n < samplePaths;
    const path = keep ? [entry] : null;
    for (let i = k + 1; i <= last; i++) {
      const bar = rng.choice(pool[slotOf(i)]);
      const hi = p * bar[1];
      const lo = p * bar[2];
      const cl = p * bar[3];
      if (outcome === null) {
        if (lo <= stop) outcome = 'stop';
        else if (hi >= target) outcome = 'target';
      }
      p = cl;
      if (keep) path.push(pyRound(p, 2));
    }
    if (outcome === 'target') nTarget++;
    else if (outcome === 'stop') nStop++;
    outcomes[n] = outcome || 'close';
    closes[n] = p;
    if (keep) paths.push(path);
  }
  const nClose = replays - nTarget - nStop;
  let green = 0;
  const Rs = new Array(replays);
  for (let n = 0; n < replays; n++) {
    const o = outcomes[n];
    if (o === 'target' || (o === 'close' && closes[n] > entry)) green++;
    Rs[n] = o === 'target' ? rTarget : o === 'stop' ? -1.0 : (closes[n] - entry) / risk;
  }
  const srt = Array.from(closes).sort((a, b) => a - b);

  let bands = null;
  if (bandPaths > 0) {
    // percentile bands per bar for a fan chart: a second run, same seed
    rng = createPyRandom(seed);
    const cols = [];
    for (let j = 0; j <= last - k; j++) cols.push(new Float64Array(bandPaths));
    for (let n = 0; n < bandPaths; n++) {
      let p = entry;
      cols[0][n] = entry;
      for (let i = k + 1; i <= last; i++) {
        const bar = rng.choice(pool[slotOf(i)]);
        p = p * bar[3];
        cols[i - k][n] = p;
      }
    }
    bands = cols.map((col) => {
      const sorted = Array.from(col).sort((a, b) => a - b);
      return BAND_Q.map((qq) => pyRound(pct(sorted, qq), 2));
    });
  }

  const lo = pct(srt, 0.01);
  const hi = pct(srt, 0.99);
  const W = (hi - lo) / HIST_BINS;
  const bins = new Array(HIST_BINS).fill(0);
  for (let i = 0; i < srt.length; i++) {
    const b = W > 0 ? M.trunc((srt[i] - lo) / W) : 0;
    if (b >= 0 && b < HIST_BINS) bins[b]++;
  }
  return {
    replays,
    seed,
    window,
    barsLeft: last - k,
    pTarget: pyRound(nTarget / replays, 4),
    pStop: pyRound(nStop / replays, 4),
    pNeither: pyRound(nClose / replays, 4),
    pGreen: pyRound(green / replays, 4),
    medianClose: pyRound(pct(srt, 0.5), 2),
    p5Close: pyRound(pct(srt, 0.05), 2),
    p25Close: pyRound(pct(srt, 0.25), 2),
    p75Close: pyRound(pct(srt, 0.75), 2),
    p95Close: pyRound(pct(srt, 0.95), 2),
    avgR: pyRound(exactMean(Rs), 3),
    rAtTarget: rTarget,
    hist: { lo: pyRound(lo, 2), hi: pyRound(hi, 2), bins },
    bands,
    samplePaths: paths
  };
}

// ---------------------------------------------------------------- stop rules and the history replay

// Round a long's stop to the cent, down (away from the entry).
function centsAway(x) {
  return M.floor(pyRound(x * 100, 4)) / 100;
}

// [high, low] of the first n bars of a session given as {slot: bar} or a list.
function openingRange(D, n) {
  let h = -Infinity;
  let l = Infinity;
  for (let i = 0; i < n; i++) {
    if (D[i].h > h) h = D[i].h;
    if (D[i].l < l) l = D[i].l;
  }
  return [h, l];
}

// ATR of the last n bars (all of them if fewer); the first bar uses its own range.
function atrOf(bars, n) {
  const want = n || ATR_BARS;
  const trs = [];
  let prev = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    let tr = b.h - b.l;
    if (prev !== null) tr = M.max(tr, M.abs(b.h - prev), M.abs(b.l - prev));
    trs.push(tr);
    prev = b.c;
  }
  const use = trs.slice(-want);
  if (!use.length) return { atr: null, bars: 0 };
  return { atr: use.reduce((s, x) => s + x, 0) / use.length, bars: use.length };
}

function ruleStop(rule, oh, ol, entry, sessionBarsToEntry) {
  const r = rule.stopRule;
  if (r === 'or_mid') return centsAway((oh + ol) / 2);
  if (r === 'or_low') return centsAway(ol);
  if (r === 'atr') {
    const a = atrOf(sessionBarsToEntry, ATR_BARS);
    return a.atr == null ? null : centsAway(entry - rule.atrMult * a.atr);
  }
  return centsAway(entry * (1 - rule.stopPct / 100));
}

// The plan's rule on every past full session, long side.
//   rule.entry 'orb'  (the Python tool): entry = the first bar after the
//                     opening range to close above it, up to the `last` bar.
//   rule.entry 'time': entry = the close of bar `rule.entryBar`, the same time
//                     of day as the plan's entry.
// Then stop first, then target, bar by bar, else the close at `last`.
function historyReplay(sessions, rule, last) {
  const n = M.floor(rule.orMinutes / 5);
  const trades = [];
  for (let s = 0; s < sessions.length; s++) {
    const d = sessions[s].date;
    const D = sessions[s].bars;
    const or = openingRange(D, n);
    const oh = or[0];
    const ol = or[1];
    let kk = null;
    if (rule.entry === 'time') {
      kk = rule.entryBar < last ? rule.entryBar : null;
    } else {
      for (let i = n; i <= last; i++) {
        if (D[i].c > oh) {
          kk = i;
          break;
        }
      }
    }
    if (kk === null) continue;
    const e = pyRound(D[kk].c, 2);
    const st = ruleStop(rule, oh, ol, e, D.slice(0, kk + 1));
    if (st === null) continue;
    const risk = e - st;
    if (risk <= 0) continue;
    const t = pyRound(e + rule.targetR * risk, 2);
    let oc = null;
    for (let i = kk + 1; i <= last; i++) {
      const b = D[i];
      if (b.l <= st) {
        oc = 'stop';
        break;
      }
      if (b.h >= t) {
        oc = 'target';
        break;
      }
    }
    const cl = D[last].c;
    const R = oc === 'target' ? (t - e) / risk : oc === 'stop' ? -1.0 : (cl - e) / risk;
    trades.push({
      date: d,
      time: clock12(OPEN_MIN + 5 * (kk + 1)),
      entry: e,
      stop: st,
      target: t,
      outcome: oc || 'close',
      R: pyRound(R, 2)
    });
  }
  const count = (f) => trades.filter(f).length;
  return {
    sessions: sessions.length,
    triggered: trades.length,
    target: count((x) => x.outcome === 'target'),
    stop: count((x) => x.outcome === 'stop'),
    close: count((x) => x.outcome === 'close'),
    green: count((x) => x.R > 0),
    avgR: trades.length ? pyRound(exactMean(trades.map((x) => x.R)), 3) : null,
    rule,
    trades
  };
}

// The rule the ORB history replay uses (Python resolve_rule, long side):
// the plan's opening range, its stop rule (or_mid, or_low, or 'pct' = the
// plan's stop distance as a percent of the entry) and its target R. 'auto'
// works the stop rule out from the plan day's own opening range.
function resolveOrbRule(plan, entryDay) {
  const n = M.floor(plan.orMinutes / 5);
  const rule = {
    setup: 'orb',
    entry: 'orb',
    orMinutes: plan.orMinutes,
    stopRule: plan.stopRule || 'auto',
    targetR: plan.targetR,
    stopPct: pyRound((100 * plan.riskPerShare) / plan.entry, 4)
  };
  if (rule.stopRule === 'auto') {
    rule.stopRule = 'pct';
    let have = !!entryDay;
    for (let i = 0; have && i < n; i++) if (!entryDay[i]) have = false;
    if (have) {
      const or = openingRange(entryDay, n);
      if (M.abs(centsAway((or[0] + or[1]) / 2) - plan.stop) < 0.005) rule.stopRule = 'or_mid';
      else if (M.abs(centsAway(or[1]) - plan.stop) < 0.005) rule.stopRule = 'or_low';
    }
  } else if (rule.stopRule !== 'or_mid' && rule.stopRule !== 'or_low') {
    rule.stopRule = 'pct';
  }
  if (rule.stopRule !== 'pct') delete rule.stopPct;
  return rule;
}

// ---------------------------------------------------------------- the verdict

function lean(mc) {
  const pt = mc.pTarget;
  const ps = mc.pStop;
  if (pt + ps <= 0) return null;
  const r = mc.rAtTarget || 1.0;
  const share = pt / (pt + ps);
  const even = 1.0 / (1.0 + r);
  return { gap: share - even, share, even };
}

const fmtPct1 = (x) => (100 * x).toFixed(1);

// One honest line from the numbers. code is language-neutral (same thresholds as the Python tool).
function verdict(mc) {
  const until = clock12(parseClock(mc.until || '16:00'));
  const lv = lean(mc);
  if (!lv) {
    return { code: 'none', text: `אף סימולציה לא הגיעה ליעד או לסטופ עד ${until}: המחיר בשעה זו מכריע בכולן.` };
  }
  const r = mc.rAtTarget || 1.0;
  const oneR = M.abs(r - 1.0) < 0.005;
  const d = lv.gap;
  let code;
  let head;
  if (M.abs(d) < COIN_FLIP) {
    code = oneR ? 'coin_flip' : 'break_even';
    head = oneR ? 'קרוב להטלת מטבע' : 'קרוב לנקודת האיזון';
  } else if (M.abs(d) < STRONG) {
    code = d > 0 ? 'lean_target' : 'lean_stop';
    head = d > 0 ? 'נוטה לטובת היעד' : 'נוטה לטובת הסטופ';
  } else {
    code = d > 0 ? 'strong_target' : 'strong_stop';
    head = d > 0 ? 'נוטה בבירור לטובת היעד' : 'נוטה בבירור לטובת הסטופ';
  }
  const odds = `יעד ראשון ${fmtPct1(mc.pTarget)}% מול סטופ ראשון ${fmtPct1(mc.pStop)}%`;
  if (oneR) return { code, text: `${head}: ${odds}.` };
  return {
    code,
    text:
      `${head}: ביעד של ${pyRound(r, 2)}R היעד צריך להגיע ראשון ב-${M.round(100 * lv.even)}% מהסימולציות ` +
      `שפגעו באחד הצדדים כדי להיות באיזון; בפועל ${M.round(100 * lv.share)}% (${odds}).`
  };
}

function verdictNotes(mc) {
  const notes = [];
  const until = clock12(parseClock(mc.until || '16:00'));
  const lv = lean(mc);
  if ((mc.pNeither || 0) > MANY_NEITHER && lv) {
    notes.push(`${fmtPct1(mc.pNeither)}% מהסימולציות לא פגעו באף צד עד ${until}; המחיר בשעה זו מכריע בהן.`);
  }
  const avg = mc.avgR;
  if (lv && M.abs(lv.gap) >= COIN_FLIP && avg != null && avg !== 0 && (avg > 0) !== (lv.gap > 0)) {
    notes.push(`ה-R הממוצע הוא ${avg > 0 ? '+' : ''}${avg.toFixed(3)} בכל זאת: הסימולציות שלא פגעו באף צד מושכות לכיוון השני.`);
  }
  return notes;
}

// ---------------------------------------------------------------- the Time Machine (Python time_machine, long side)

// plan: { symbol, date (YYYY-MM-DD), entry, stop, target, entryBar, setup?,
//         stopRule?, orMinutes? }. The entry bar k is the bar whose CLOSE is the
// entry (bar 8 = 10:10-10:15, closing 10:15 AM).
function normalizeTimeMachinePlan(raw) {
  const entry = Number(raw.entry);
  const stop = Number(raw.stop);
  const target = Number(raw.target);
  if (!(stop > 0 && entry > 0 && target > 0)) throw tradeSimError('bad_plan', 'נדרשים מחיר כניסה, סטופ ויעד חיוביים');
  if (!(stop < entry && entry < target)) throw tradeSimError('bad_plan', 'בעסקת קנייה נדרש סטופ < כניסה < יעד');
  const k = Number(raw.entryBar);
  if (!Number.isInteger(k) || k < 0 || k > SESSION_BARS - 2) {
    throw tradeSimError('bad_entry_time', 'הכניסה צריכה להיסגר בין 9:35 ל-15:55 (שעון ניו יורק) כדי שיישארו נרות לסימולציה');
  }
  const orMinutes = raw.orMinutes == null ? DEFAULT_OR_MINUTES : Number(raw.orMinutes);
  const risk = entry - stop;
  return {
    symbol: String(raw.symbol || '').toUpperCase(),
    date: String(raw.date),
    setup: String(raw.setup || 'orb'),
    entry,
    stop,
    target,
    entryBar: k,
    entryTime: clock12(OPEN_MIN + 5 * (k + 1)),
    riskPerShare: pyRound(risk, 2),
    targetR: pyRound((target - entry) / risk, 2),
    orMinutes,
    stopRule: raw.stopRule || 'auto',
    atrMult: raw.atrMult
  };
}

function timeMachine(chartResult, rawPlan, nowMs, options) {
  const opts = options || {};
  const replays = opts.replays == null ? MAX_SIMS : opts.replays;
  const seed = opts.seed == null ? DEFAULT_SEED : opts.seed;
  const window = opts.window == null ? 2 : opts.window;
  if (!(replays >= 1 && replays <= 1000000)) throw tradeSimError('bad_sims', 'מספר הסימולציות חייב להיות בין 1 ל-1,000,000');
  if (!(window >= 0 && window <= 10)) throw tradeSimError('bad_window', 'החלון חייב להיות בין 0 ל-10 נרות');
  const plan = normalizeTimeMachinePlan(rawPlan);
  const sym = plan.symbol;
  const parsed = parseChart(chartResult, nowMs);
  const meta = parsed.meta;
  const bars = parsed.bars;
  const msym = String(meta.symbol || '').toUpperCase();
  if (msym && sym && msym !== sym.replace(/\./g, '-')) throw tradeSimError('symbol_mismatch', `הנתונים הם של ${msym} אבל התכנית היא ל-${sym}`);
  if (meta.dataGranularity && meta.dataGranularity !== '5m') throw tradeSimError('bad_interval', 'הסימולציה צריכה נרות של 5 דקות');
  if (!bars.length) throw tradeSimError('no_bars', `אין נרות 5 דקות שלמים עבור ${sym}`);
  const k = plan.entryBar;
  const early = !!(NYSE_EARLY_CLOSE[plan.date] || opts.earlyClose);
  const endMin = early ? EARLY_MIN : CLOSE_MIN;
  const untilMin = opts.until == null ? endMin : parseClock(opts.until);
  if (untilMin == null || (untilMin - OPEN_MIN) % 5 || untilMin > endMin) {
    throw tradeSimError('bad_until', `שעת הסיום חייבת להיות על רשת 5 הדקות ולא אחרי ${clock12(endMin)}${early ? ' (יום מסחר מקוצר)' : ''}`);
  }
  const last = (untilMin - OPEN_MIN) / 5 - 1;
  if (last <= k) throw tradeSimError('nothing_left', `לא נשאר מה לדמות אחרי הכניסה ב-${plan.entryTime}`);
  const days = splitSessions(bars);
  const entryDay = days[plan.date] || null;
  const warnings = [];
  if (!opts.hypothetical) {
    if (!entryDay || !entryDay[k]) {
      throw tradeSimError('entry_not_in_data', `הכניסה לא בנתונים: אין נר שלם שנסגר ב-${plan.entryTime} ב-${plan.date} עבור ${sym}`);
    }
    const eb = entryDay[k];
    if (!(eb.l - 0.01 <= plan.entry && plan.entry <= eb.h + 0.01)) {
      warnings.push(`מחיר הכניסה ${plan.entry.toFixed(2)} מחוץ לטווח הנר ${eb.l.toFixed(2)}-${eb.h.toFixed(2)}`);
    }
  }
  const fs = fullSessions(days, plan.date);
  const sessions = fs.full;
  if (sessions.length < MIN_SESSIONS) {
    throw tradeSimError(
      'too_few_sessions',
      `יש רק ${sessions.length} ימי מסחר מלאים של ${sym} בנתונים; הסימולציה צריכה לפחות ${MIN_SESSIONS}`
    );
  }
  const pool = buildPool(sessions);
  const mcCore = simulate(pool, {
    entry: plan.entry,
    stop: plan.stop,
    target: plan.target,
    k,
    last,
    replays,
    seed,
    window,
    samplePaths: opts.samplePaths || 0,
    bandPaths: opts.bandPaths || 0
  });
  const mc = Object.assign(mcCore, {
    until: clock24(untilMin),
    poolSessions: sessions.length,
    poolFrom: sessions[0].date,
    poolTo: sessions[sessions.length - 1].date
  });
  if (mc.bands) {
    mc.bandTimes = [];
    for (let j = k; j <= last; j++) mc.bandTimes.push(clock24(OPEN_MIN + 5 * (j + 1)));
  }
  let rule = null;
  if (opts.historyRule) rule = opts.historyRule;
  else if (plan.setup.toLowerCase() === 'orb') rule = resolveOrbRule(plan, entryDay);
  const history = rule
    ? historyReplay(sessions, rule, last)
    : { sessions: sessions.length, triggered: 0, rule: null, trades: [], note: 'ההרצה ההיסטורית מכירה רק פריצת טווח פתיחה (orb)' };
  const lastBar = bars[bars.length - 1];
  const v = verdict(mc);
  return {
    plan,
    data: {
      symbol: msym || sym,
      lastBar: `${lastBar.date} ${lastBar.start} ET`,
      dropped: parsed.dropped,
      shortSessionsLeftOut: fs.short
    },
    mc,
    history,
    verdict: v.text,
    verdictCode: v.code,
    verdictNotes: verdictNotes(mc),
    warnings
  };
}

// ---------------------------------------------------------------- the exit plan (exit.py compute, long side)

const STOP_TYPES = ['pct', 'price', 'atr', 'or_low', 'or_mid'];
const TARGET_TYPES = ['r', 'price'];
const MAX_PRICE = 100000;

function fmtUsd(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function rLabel(r) {
  return `${r}R (${r} פעמים הסיכון)`;
}

// input: { entry, stop: {type, value}, target: {type, value},
//          openingRange?: {high, low}, atr?: {value, bars} }
// -> { entry, stop, target, risk, rewardRisk, targetR, stopLabel, targetLabel, stopDetail }
// Throws a TradeSim error (code + Hebrew message) on a refused plan.
function planExit(input) {
  const inp = input || {};
  const stopIn = inp.stop || {};
  const targetIn = inp.target || {};
  const eC = toScaled(inp.entry, 2, 'halfUp');
  if (!(eC > 0) || eC > MAX_PRICE * 100) throw tradeSimError('bad_entry', 'מחיר הכניסה חייב להיות מספר חיובי');
  const stopType = String(stopIn.type || '');
  if (STOP_TYPES.indexOf(stopType) < 0) throw tradeSimError('bad_stop_type', 'סוג סטופ לא מוכר (אחוז, מחיר, ATR, שפל טווח הפתיחה או אמצעו)');
  let stopC;
  let stopLabel;
  let detail = '';
  if (stopType === 'or_mid' || stopType === 'or_low') {
    const orng = inp.openingRange;
    if (!orng || orng.high == null || orng.low == null) {
      throw tradeSimError('no_opening_range', 'סטופ לפי טווח הפתיחה זמין רק כשיש נתוני מסחר של היום, אחרי 15 הדקות הראשונות');
    }
    const ohC = toScaled(orng.high, 2, 'halfUp');
    const olC = toScaled(orng.low, 2, 'halfUp');
    if (!(ohC > olC)) throw tradeSimError('bad_opening_range', 'הגבוה של טווח הפתיחה חייב להיות מעל השפל שלו');
    if (stopType === 'or_mid') {
      stopC = M.floor((ohC + olC) / 2);
      stopLabel = 'אמצע טווח הפתיחה';
      detail = `(${fmtUsd(ohC)} + ${fmtUsd(olC)}) / 2`;
      if ((ohC + olC) % 2) detail += ', מעוגל למטה';
    } else {
      stopC = olC;
      stopLabel = 'שפל טווח הפתיחה';
    }
  } else if (stopType === 'price') {
    const v = Number(stopIn.value);
    if (!(v > 0)) throw tradeSimError('bad_stop', 'מחיר הסטופ חייב להיות מספר חיובי');
    stopC = toScaled(stopIn.value, 2, 'floor');
    stopLabel = 'המחיר שלך';
  } else if (stopType === 'pct') {
    const v = Number(stopIn.value);
    if (!(v > 0) || v >= 100) throw tradeSimError('bad_stop', 'אחוז הסטופ חייב להיות בין 0 ל-100');
    const p = decimalParts(stopIn.value, 4);
    const den = 100 * M.pow(10, p.scale);
    stopC = floorDiv(eC * (den - p.int), den);
    stopLabel = `${v}% מתחת לכניסה`;
  } else {
    const v = Number(stopIn.value);
    if (!(v > 0) || v > 50) throw tradeSimError('bad_stop', 'מכפיל ה-ATR חייב להיות מספר חיובי');
    const atr = inp.atr || {};
    if (!(Number(atr.value) > 0)) throw tradeSimError('no_atr', 'סטופ לפי ATR צריך נרות של המניה');
    const kParts = decimalParts(stopIn.value, 2);
    const aS = toScaled(pyRound(Number(atr.value), 6), 6, 'halfUp');
    const den = M.pow(10, kParts.scale + 6);
    stopC = floorDiv(eC * den - kParts.int * aS * 100, den);
    stopLabel = `${v} x ATR(${atr.bars || ATR_BARS}) מתחת לכניסה`;
    detail = `ATR ${pyRound(Number(atr.value), 4)}`;
  }
  if (stopC >= eC) {
    throw tradeSimError('stop_above_entry', `הסטופ ${fmtUsd(stopC)} (${stopLabel}) נמצא בגובה הכניסה ${fmtUsd(eC)} או מעליה: בקנייה הסטופ חייב להיות מתחת לכניסה`);
  }
  if (stopC <= 0) throw tradeSimError('stop_not_positive', `הסטופ יוצא ${fmtUsd(stopC)}: בחרו סטופ מעל $0`);
  const riskC = eC - stopC;
  if (riskC * (100 / MIN_RISK_PCT) < eC) {
    throw tradeSimError(
      'stop_too_tight',
      `הסטופ רק ${fmtUsd(riskC)} מתחת לכניסה, פחות מ-0.05% מהמחיר: צמוד מדי כדי לשרוד את המרווח (spread) - תנודה רגילה תוציא אתכם. הרחיבו אותו.`
    );
  }
  const targetType = String(targetIn.type || 'r').toLowerCase();
  if (TARGET_TYPES.indexOf(targetType) < 0) throw tradeSimError('bad_target_type', 'סוג יעד לא מוכר (מכפיל R או מחיר)');
  let targetC;
  let targetLabel = null;
  let targetR = null;
  if (targetType === 'r') {
    const r = Number(targetIn.value == null ? 2 : targetIn.value);
    if (!(r > 0) || r > 50) throw tradeSimError('bad_target', 'מכפיל ה-R של היעד חייב להיות מעל 0, למשל 1R או 2R');
    const rp = decimalParts(targetIn.value == null ? 2 : targetIn.value, 2);
    const den = M.pow(10, rp.scale);
    targetC = halfUpDiv(eC * den + rp.int * riskC, den);
    targetR = rp.int / den;
    targetLabel = rLabel(targetR);
  } else {
    const v = Number(targetIn.value);
    if (!(v > 0)) throw tradeSimError('bad_target', 'מחיר היעד חייב להיות מספר חיובי');
    targetC = toScaled(targetIn.value, 2, 'halfUp');
  }
  if (targetC <= eC) {
    throw tradeSimError('target_below_entry', `היעד ${fmtUsd(targetC)} נמצא בגובה הכניסה ${fmtUsd(eC)} או מתחתיה: בקנייה היעד חייב להיות מעליה`);
  }
  const rr = halfUpDiv((targetC - eC) * 100, riskC) / 100;
  if (targetR === null) {
    targetR = rr;
    targetLabel = `המחיר שלך (${rr}R)`;
  }
  return {
    entry: fromCents(eC),
    stop: fromCents(stopC),
    target: fromCents(targetC),
    risk: fromCents(riskC),
    riskPct: pyRound((100 * riskC) / eC, 2),
    rewardRisk: rr,
    targetR,
    stopType,
    stopLabel,
    stopDetail: detail,
    targetType,
    targetLabel
  };
}

// ---------------------------------------------------------------- position sizing (size.py size_trade, long side)

const LIMIT_LABELS = {
  maxLoss: 'הפסד מרבי לעסקה',
  positionCap: 'תקרת פוזיציה',
  maxOrder: 'הזמנה מרבית',
  cash: 'מזומן אחרי כרית הביטחון'
};

const money = (x) => `$${Number(x).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(Number(x)) ? 0 : 2, maximumFractionDigits: 2 })}`;

// input: { entry, stop, target, account, maxLossPerTrade, positionCapPct=75,
//          cashBufferPct=10, maxOrderUsd?, cash?, minRewardRisk?, minOrderUsd? }
// -> { qty, boundBy, boundByLabel, limits, cost, maxLoss, refusal, ... }
// qty 0 (the stop is too far for the max loss) is a plain refusal, not a smaller order.
function sizePosition(input) {
  const inp = input || {};
  const entry = roundCent(inp.entry);
  const stop = roundCent(inp.stop);
  const target = roundCent(inp.target);
  if (!(entry > 0) || !(stop > 0) || !(target > 0)) throw tradeSimError('bad_plan', 'נדרשים כניסה, סטופ ויעד חיוביים');
  if (stop >= entry) throw tradeSimError('stop_above_entry', `הסטופ ${stop.toFixed(2)} אינו מתחת לכניסה ${entry.toFixed(2)}`);
  if (target <= entry) throw tradeSimError('target_below_entry', `היעד ${target.toFixed(2)} אינו מעל הכניסה ${entry.toFixed(2)}: התנועה כבר קרתה`);
  const budget = Number(inp.account);
  if (!(budget > 0)) throw tradeSimError('bad_account', 'גודל החשבון חייב להיות מספר חיובי');
  const bufPct = inp.cashBufferPct == null ? 10 : Number(inp.cashBufferPct);
  if (!(bufPct >= 0 && bufPct < 100)) throw tradeSimError('bad_buffer', 'כרית המזומן חייבת להיות בין 0 ל-100 אחוז');
  const capPct = inp.positionCapPct == null ? 75 : Number(inp.positionCapPct);
  if (!(capPct > 0 && capPct <= 100)) throw tradeSimError('bad_cap', 'תקרת הפוזיציה חייבת להיות בין 0 ל-100 אחוז');
  const maxLoss = Number(inp.maxLossPerTrade);
  if (!(maxLoss > 0)) throw tradeSimError('bad_max_loss', 'ההפסד המרבי לעסקה חייב להיות מספר חיובי');

  const riskC = M.round((entry - stop) * 100);
  const rewardC = M.round((target - entry) * 100);
  const risk = riskC / 100;
  const cashBuffer = pyRound((budget * bufPct) / 100, 2);
  let available = budget - cashBuffer;
  let cashNote = `${money(budget)} פחות כרית של ${money(cashBuffer)}`;
  if (inp.cash != null && Number(inp.cash) - cashBuffer < available - 0.005) {
    available = Number(inp.cash) - cashBuffer;
    cashNote = `מזומן ${money(inp.cash)} פחות כרית של ${money(cashBuffer)}`;
  }
  available = M.max(pyRound(available, 2), 0);

  const limits = [];
  limits.push({ name: 'maxLoss', label: LIMIT_LABELS.maxLoss, usd: maxLoss, shares: sharesFor(maxLoss, risk), how: `${money(maxLoss)} / ${risk.toFixed(2)} סיכון למניה` });
  const cap = pyRound((budget * capPct) / 100, 2);
  limits.push({ name: 'positionCap', label: LIMIT_LABELS.positionCap, usd: cap, shares: sharesFor(cap, entry), how: `${capPct}% מ-${money(budget)} = ${money(cap)} / ${entry.toFixed(2)}` });
  if (inp.maxOrderUsd != null && Number(inp.maxOrderUsd) > 0) {
    const mo = Number(inp.maxOrderUsd);
    limits.push({ name: 'maxOrder', label: LIMIT_LABELS.maxOrder, usd: mo, shares: sharesFor(mo, entry), how: `${money(mo)} / ${entry.toFixed(2)}` });
  }
  limits.push({ name: 'cash', label: LIMIT_LABELS.cash, usd: available, shares: sharesFor(available, entry), how: `${cashNote} = ${money(available)} / ${entry.toFixed(2)}` });

  let qty = Infinity;
  for (let i = 0; i < limits.length; i++) qty = M.min(qty, limits[i].shares);
  qty = M.max(0, qty);
  let bound = null;
  for (let i = 0; i < limits.length; i++) {
    limits[i].binds = false;
    if (bound === null && limits[i].shares === qty) {
      bound = limits[i];
      limits[i].binds = true;
    }
  }
  const cost = pyRound(qty * entry, 2);
  const lossAtStop = pyRound((qty * riskC) / 100, 2);
  let refusal = null;
  let refusalCode = null;
  if (qty === 0) {
    if (bound.name === 'maxLoss') {
      refusalCode = 'stop_too_far';
      refusal =
        `מניה אחת מסכנת ${money(risk)} (כניסה ${entry.toFixed(2)} פחות סטופ ${stop.toFixed(2)}), יותר מההפסד המרבי שלכם לעסקה (${money(maxLoss)}). ` +
        'אין הזמנה. דלגו על העסקה, או תכננו סטופ קרוב יותר.';
    } else {
      refusalCode = 'share_too_expensive';
      refusal = `מניה אחת עולה ${money(entry)}, יותר מהמגבלה "${bound.label}" (${bound.how}). אין הזמנה.`;
    }
  } else if (inp.minRewardRisk && rewardC < Number(inp.minRewardRisk) * riskC - 1e-9) {
    refusalCode = 'reward_risk_too_low';
    refusal = `יחס סיכוי:סיכון ${(rewardC / riskC).toFixed(2)} נמוך מהמינימום שלכם ${inp.minRewardRisk}. אין הזמנה.`;
  } else if (inp.minOrderUsd && cost < Number(inp.minOrderUsd) - 0.005) {
    refusalCode = 'under_min_order';
    refusal = `${qty} מניות הן ${money(cost)}, מתחת להזמנה המינימלית שלכם (${money(inp.minOrderUsd)}). אין הזמנה.`;
  }
  return {
    entry,
    stop,
    target,
    riskPerShare: risk,
    rewardRisk: pyRound(rewardC / riskC, 2),
    account: budget,
    cashBufferPct: bufPct,
    cashBuffer,
    cashAvailable: available,
    positionCapPct: capPct,
    maxLossPerTrade: maxLoss,
    limits,
    qty,
    boundBy: bound.name,
    boundByLabel: bound.label,
    cost,
    maxLossAtStop: lossAtStop,
    refusal,
    refusalCode
  };
}

// ---------------------------------------------------------------- the whole simulator for the web

function lastSessionBars(day, uptoSlot) {
  const out = [];
  const slots = Object.keys(day)
    .map(Number)
    .sort((a, b) => a - b);
  for (let i = 0; i < slots.length; i++) if (uptoSlot == null || slots[i] <= uptoSlot) out.push(day[slots[i]]);
  return out;
}

// chartResult: Yahoo v8 chart result (range=60d interval=5m).
// input: { symbol, entry?, entryTime? ('HH:MM' bar close ET, used when no
//          session is in progress), stop:{type,value}, target:{type,value},
//          account, maxLossPerTrade, positionCapPct?, cashBufferPct?,
//          maxOrderUsd?, sims?, seed? }
// Live mode (a US session is in progress): the entry is at the close of the
// last completed 5-minute bar (default price: that close) and the rest of
// today is replayed. Otherwise ("next" mode) a hypothetical entry at
// entryTime (default 10:00 AM) of the next session is replayed, from the last
// price, over every full session in the data.
function runTradeSim(chartResult, input, nowMs) {
  const inp = input || {};
  const symbol = String(inp.symbol || '').trim().toUpperCase();
  const sims = inp.sims == null ? MAX_SIMS : M.floor(Number(inp.sims));
  if (!(sims >= 100 && sims <= MAX_SIMS)) throw tradeSimError('bad_sims', `מספר הסימולציות חייב להיות בין 100 ל-${MAX_SIMS.toLocaleString('en-US')}`);
  const seed = inp.seed == null ? DEFAULT_SEED : M.floor(Number(inp.seed));
  if (!(seed >= 0 && seed <= 2147483647)) throw tradeSimError('bad_seed', 'ה-seed חייב להיות מספר שלם חיובי');

  const parsed = parseChart(chartResult, nowMs);
  const meta = parsed.meta;
  const msym = String(meta.symbol || '').toUpperCase();
  if (msym && msym !== symbol.replace(/\./g, '-')) throw tradeSimError('symbol_mismatch', `הנתונים הם של ${msym} ולא של ${symbol}`);
  if (!parsed.bars.length) throw tradeSimError('no_bars', `אין נרות 5 דקות עבור ${symbol} ב-60 הימים האחרונים`);
  const days = splitSessions(parsed.bars);
  const today = easternParts(nowMs).date;
  const early = !!NYSE_EARLY_CLOSE[today];
  const endBars = ((early ? EARLY_MIN : CLOSE_MIN) - OPEN_MIN) / 5;
  const todayDay = days[today];
  let todayLast = -1;
  if (todayDay) {
    const slots = Object.keys(todayDay).map(Number);
    todayLast = M.max.apply(null, slots);
  }
  const live = !!todayDay && todayLast <= endBars - 2 && easternParts(nowMs).minutes < OPEN_MIN + endBars * 5;
  const orBars = DEFAULT_OR_MINUTES / 5;
  const lastBar = parsed.bars[parsed.bars.length - 1];

  let k;
  let planDate;
  let defaultEntry;
  let openingRangeData = null;
  let atrData = null;
  if (live) {
    k = todayLast;
    planDate = today;
    defaultEntry = todayDay[k].c;
    let haveOr = k >= orBars - 1;
    for (let i = 0; haveOr && i < orBars; i++) if (!todayDay[i]) haveOr = false;
    if (haveOr) {
      const or = openingRange(todayDay, orBars);
      openingRangeData = { high: or[0], low: or[1], minutes: DEFAULT_OR_MINUTES };
    }
    const sessionBars = lastSessionBars(todayDay, k);
    if (sessionBars.length >= 3) {
      const a = atrOf(sessionBars, ATR_BARS);
      atrData = { value: a.atr, bars: a.bars, from: 'today' };
    }
  } else {
    const closeMin = inp.entryTime == null || inp.entryTime === '' ? 10 * 60 : parseClock(inp.entryTime);
    if (closeMin == null || (closeMin - OPEN_MIN) % 5) throw tradeSimError('bad_entry_time', 'שעת הכניסה חייבת להיות על רשת 5 הדקות, למשל 10:00');
    k = (closeMin - OPEN_MIN) / 5 - 1;
    if (!(k >= 0 && k <= SESSION_BARS - 2)) throw tradeSimError('bad_entry_time', 'שעת הכניסה צריכה להיות בין 9:35 ל-15:55 (שעון ניו יורק)');
    planDate = '9999-12-31';
    defaultEntry = Number(meta.regularMarketPrice) > 0 ? Number(meta.regularMarketPrice) : lastBar.c;
    const lastDay = days[lastBar.date];
    const a = atrOf(lastSessionBars(lastDay), ATR_BARS);
    if (a.bars >= 3) atrData = { value: a.atr, bars: a.bars, from: lastBar.date };
  }

  const entryIn = inp.entry == null || inp.entry === '' ? pyRound(defaultEntry, 2) : inp.entry;
  const plan = planExit({
    entry: entryIn,
    stop: inp.stop,
    target: inp.target,
    openingRange: openingRangeData,
    atr: atrData ? { value: atrData.value, bars: atrData.bars } : null
  });

  const orbStop = plan.stopType === 'or_mid' || plan.stopType === 'or_low';
  let historyRule;
  if (orbStop) {
    historyRule = { setup: 'orb', entry: 'orb', orMinutes: DEFAULT_OR_MINUTES, stopRule: plan.stopType, targetR: plan.targetR };
  } else if (plan.stopType === 'atr') {
    historyRule = { setup: 'time', entry: 'time', entryBar: k, orMinutes: DEFAULT_OR_MINUTES, stopRule: 'atr', atrMult: Number(inp.stop.value), targetR: plan.targetR };
  } else {
    historyRule = {
      setup: 'time',
      entry: 'time',
      entryBar: k,
      orMinutes: DEFAULT_OR_MINUTES,
      stopRule: 'pct',
      stopPct: pyRound((100 * plan.risk) / plan.entry, 4),
      targetR: plan.targetR
    };
  }

  const tm = timeMachine(
    chartResult,
    { symbol, date: planDate, entry: plan.entry, stop: plan.stop, target: plan.target, entryBar: k, setup: historyRule.setup },
    nowMs,
    { replays: sims, seed, earlyClose: live && early, hypothetical: !live, historyRule }
  );

  const sizing = sizePosition({
    entry: plan.entry,
    stop: plan.stop,
    target: plan.target,
    account: inp.account,
    maxLossPerTrade: inp.maxLossPerTrade,
    positionCapPct: inp.positionCapPct,
    cashBufferPct: inp.cashBufferPct,
    maxOrderUsd: inp.maxOrderUsd
  });

  const mc = tm.mc;
  const h = tm.history;
  const warnings = tm.warnings.slice();
  if (plan.rewardRisk < 1) warnings.push(`יחס סיכוי:סיכון ${plan.rewardRisk} - פחות מ-1: היעד קרוב יותר מהסטופ`);
  return {
    symbol,
    mode: live ? 'live' : 'next',
    entryTime: clock12(OPEN_MIN + 5 * (k + 1)),
    until: clock12(parseClock(mc.until)),
    plan: Object.assign({}, plan, { openingRange: openingRangeData, atr: atrData }),
    sims: mc.replays,
    seed: mc.seed,
    barsLeft: mc.barsLeft,
    odds: { target: mc.pTarget, stop: mc.pStop, open: mc.pNeither, green: mc.pGreen },
    closeDistribution: {
      p5: mc.p5Close,
      p25: mc.p25Close,
      median: mc.medianClose,
      p75: mc.p75Close,
      p95: mc.p95Close,
      hist: mc.hist
    },
    avgR: mc.avgR,
    rAtTarget: mc.rAtTarget,
    history: {
      rule: h.rule ? (h.rule.entry === 'orb' ? 'orb' : 'time') : null,
      sessions: h.sessions,
      triggered: h.triggered,
      target: h.target,
      stop: h.stop,
      open: h.close,
      green: h.green,
      avgR: h.avgR,
      trades: h.trades.slice(-15).reverse()
    },
    sizing,
    verdict: tm.verdict,
    verdictCode: tm.verdictCode,
    verdictNotes: tm.verdictNotes,
    warnings,
    coverage: {
      sessions: mc.poolSessions,
      from: mc.poolFrom,
      to: mc.poolTo,
      lastBar: tm.data.lastBar,
      shortSessionsLeftOut: tm.data.shortSessionsLeftOut,
      dropped: tm.data.dropped,
      bars: parsed.bars.length
    },
    disclaimer: DISCLAIMER
  };
}

module.exports = {
  SESSION_BARS,
  OPEN_MIN,
  MAX_SIMS,
  DEFAULT_SEED,
  MIN_SESSIONS,
  NYSE_EARLY_CLOSE,
  DISCLAIMER,
  STOP_TYPES,
  TARGET_TYPES,
  createPyRandom,
  pyRound,
  toScaled,
  easternOffset,
  easternParts,
  parseClock,
  clock12,
  parseChart,
  splitSessions,
  fullSessions,
  buildPool,
  simulate,
  centsAway,
  openingRange,
  atrOf,
  historyReplay,
  resolveOrbRule,
  lean,
  verdict,
  verdictNotes,
  timeMachine,
  planExit,
  sizePosition,
  runTradeSim
};
