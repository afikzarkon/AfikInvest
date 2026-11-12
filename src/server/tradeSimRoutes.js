// Ported from day-trader-skill (MIT, Jake Schincariol)
//
// Trade simulator API (per user, long side only):
//   POST /api/trade-sim
//     body { symbol (US ticker), entry?, entryTime? ('HH:MM' bar close, New
//            York, used when no session is in progress; default 10:00),
//            stop: { type: 'pct'|'price'|'atr'|'or_low'|'or_mid', value? },
//            target: { type: 'r'|'price', value },
//            account, maxLossPerTrade, positionCapPct?, cashBufferPct?,
//            maxOrderUsd?, sims? (100..10000, default 10000), seed? (default 19) }
//     -> { plan, odds, closeDistribution, history, sizing, verdict, coverage, ... }
//        (see runTradeSim in shared/tradeSim.js). 400 with a Hebrew reason when
//        the plan is refused (stop at/above the entry, target at/below it, a
//        stop tighter than the spread, too little data...).
// Bars: 60 days of 5-minute bars from Yahoo, cached per symbol for 5 minutes
// (server/tradeSimData.js). The simulation itself is pure and seeded, so the
// same plan on the same data gives the same numbers.
const { requireAuth } = require('./requireAuth');
const { createRateLimiter } = require('./rateLimit');
const { runTradeSim, STOP_TYPES, TARGET_TYPES, MAX_SIMS } = require('../shared/tradeSim');
const { fetchYahooIntraday5m, createBarCache } = require('./tradeSimData');

const US_SYMBOL_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;

const isNum = (v) => v !== null && v !== '' && v !== undefined && Number.isFinite(Number(v));

// Shape checks only; the plan's own rules (and their Hebrew reasons) live in shared/tradeSim.js.
function validateBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const symbol = String(b.symbol || '').trim().toUpperCase();
  if (!US_SYMBOL_RE.test(symbol)) return { error: 'נדרש סימול של מניה אמריקאית, למשל AAPL' };
  const stop = b.stop && typeof b.stop === 'object' ? b.stop : null;
  if (!stop || STOP_TYPES.indexOf(String(stop.type)) < 0) return { error: 'יש לבחור סוג סטופ' };
  if (['pct', 'price', 'atr'].indexOf(String(stop.type)) >= 0 && !(isNum(stop.value) && Number(stop.value) > 0)) {
    return { error: 'יש להזין ערך חיובי לסטופ' };
  }
  const target = b.target && typeof b.target === 'object' ? b.target : null;
  if (!target || TARGET_TYPES.indexOf(String(target.type)) < 0 || !(isNum(target.value) && Number(target.value) > 0)) {
    return { error: 'יש לבחור יעד (מכפיל R או מחיר) עם ערך חיובי' };
  }
  if (!(isNum(b.account) && Number(b.account) > 0)) return { error: 'יש להזין גודל חשבון חיובי' };
  if (!(isNum(b.maxLossPerTrade) && Number(b.maxLossPerTrade) > 0)) return { error: 'יש להזין הפסד מרבי לעסקה חיובי' };
  if (b.entry != null && b.entry !== '' && !(isNum(b.entry) && Number(b.entry) > 0)) return { error: 'מחיר הכניסה חייב להיות מספר חיובי' };
  const optional = ['positionCapPct', 'cashBufferPct', 'maxOrderUsd', 'sims', 'seed'];
  for (let i = 0; i < optional.length; i++) {
    const v = b[optional[i]];
    if (v != null && v !== '' && !isNum(v)) return { error: `ערך לא תקין: ${optional[i]}` };
  }
  const opt = (v) => (v == null || v === '' ? undefined : Number(v));
  return {
    input: {
      symbol,
      entry: b.entry == null || b.entry === '' ? undefined : Number(b.entry),
      entryTime: b.entryTime == null || b.entryTime === '' ? undefined : String(b.entryTime),
      stop: { type: String(stop.type), value: stop.value == null || stop.value === '' ? undefined : Number(stop.value) },
      target: { type: String(target.type), value: Number(target.value) },
      account: Number(b.account),
      maxLossPerTrade: Number(b.maxLossPerTrade),
      positionCapPct: opt(b.positionCapPct),
      cashBufferPct: opt(b.cashBufferPct),
      maxOrderUsd: opt(b.maxOrderUsd),
      sims: b.sims == null || b.sims === '' ? MAX_SIMS : Math.min(MAX_SIMS, Math.floor(Number(b.sims))),
      seed: opt(b.seed)
    }
  };
}

function mountTradeSimRoutes(app, { fetchBars = fetchYahooIntraday5m, now = () => Date.now(), cacheTtlMs = 5 * 60 * 1000 } = {}) {
  const bars = createBarCache({ fetcher: fetchBars, ttlMs: cacheTtlMs, now });
  const limiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 10,
    message: 'אפשר להריץ עד 10 סימולציות בדקה',
    keyFn: (req) => `trade-sim:${req.user.id}`
  });

  app.post('/api/trade-sim', requireAuth, limiter, async (req, res) => {
    const checked = validateBody(req.body);
    if (checked.error) return res.status(400).json({ error: checked.error });
    const input = checked.input;
    let chart;
    try {
      chart = await bars.get(input.symbol);
    } catch (err) {
      if (err && err.code === 'not_found') return res.status(404).json({ error: `לא נמצאו נתוני מסחר תוך-יומיים עבור ${input.symbol}` });
      console.error('[trade-sim] bars failed', input.symbol, err && err.message);
      return res.status(502).json({ error: 'שירות הנתונים לא זמין כרגע, נסו שוב בעוד דקה' });
    }
    try {
      const started = process.hrtime.bigint();
      const result = runTradeSim(chart.data, input, now());
      const computeMs = Number(process.hrtime.bigint() - started) / 1e6;
      result.coverage.fetchedAt = new Date(chart.fetchedAt).toISOString();
      result.coverage.cached = chart.cached;
      result.computeMs = Math.round(computeMs);
      return res.json(result);
    } catch (err) {
      if (err && err.isTradeSimError) return res.status(400).json({ error: err.message, code: err.code });
      console.error('[trade-sim] failed', err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });
}

module.exports = { mountTradeSimRoutes, validateBody };
