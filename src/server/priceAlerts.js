// Ported from day-trader-skill (MIT, Jake Schincariol) - trader-alerts/alerts.py
//
// The scheduled check behind user price alerts (job 'price-alerts.check'):
//
//   1. read every ACTIVE rule of every user,
//   2. group them by security, so each security costs ONE quote per run no
//      matter how many users watch it,
//   3. skip a security whose market is closed (a short grace period after
//      the close allows one final check on the closing price),
//   4. test each rule (shared/priceAlertRules.js) and, when one hits, store
//      a normal Smart Alert (type PRICE_TARGET) - so it shows in the alert
//      list and the unread badge - and mark the rule triggered so it rings
//      once.
//
// Quotes come in through `quotes.getQuote(market, symbol)` -> { price,
// prevClose, tradeDate, fetchedAt } so tests run offline; production uses
// createPriceQuotes() below, which reuses the app's existing quote paths
// (yahooQuotes.getYahooPayload: Finnhub when configured, else Yahoo; TASE's
// own securitydata API). alerts.py's Stooq fallback is not ported: the app
// already falls back between quote sources (fallbackChain.js), and Stooq
// answered 404 when alerts.py was written.
const { evaluatePriceAlert, buildPriceAlert } = require('../shared/priceAlertRules');

// ----- market sessions -----------------------------------------------------

// NYSE holidays and 1:00 p.m. early closes, from alerts.py (nyse.com
// hours-calendars, read 2026-10-13). Outside these years only weekends are
// known; the quote's tradeDate check below still catches a holiday.
const NYSE_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07',
  '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06',
  '2027-11-25', '2027-12-24'
]);
const NYSE_EARLY_CLOSE = new Set(['2026-11-27', '2026-12-24', '2027-11-26']);

// TASE: continuous trading from ~09:59; the day ends with the closing
// auction around 17:25-17:35 Monday-Thursday and earlier on Friday (the
// Monday-Friday week started 2026-01-05; before that Sunday-Thursday).
// Times are deliberately generous - a check outside the real session just
// reads the last price, and the tradeDate check rejects a day with no trade
// (TASE holidays are not listed here).
const SESSIONS = {
  US: {
    timeZone: 'America/New_York',
    session(date, weekday) {
      if (weekday === 0 || weekday === 6 || NYSE_HOLIDAYS.has(date)) return null;
      return { open: 9 * 60 + 30, close: NYSE_EARLY_CLOSE.has(date) ? 13 * 60 : 16 * 60 };
    }
  },
  TASE: {
    timeZone: 'Asia/Jerusalem',
    session(date, weekday) {
      if (date >= '2026-01-05') {
        if (weekday === 0 || weekday === 6) return null;
        return { open: 9 * 60 + 45, close: weekday === 5 ? 14 * 60 : 17 * 60 + 35 };
      }
      if (weekday === 5 || weekday === 6) return null;
      return { open: 9 * 60 + 45, close: 17 * 60 + 35 };
    }
  }
};

function zonedParts(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23'
  }).formatToParts(instant);
  const get = (type) => parts.find((p) => p.type === type).value;
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
    weekday: weekdays[get('weekday')]
  };
}

// { date, open, inGrace, reason } for a market at an instant. `inGrace` is
// the first `graceMinutes` after the close: one more check on the closing
// price is allowed then.
function marketSessionState(market, now = new Date(), { graceMinutes = 20 } = {}) {
  const def = SESSIONS[market];
  if (!def) return { date: null, open: false, inGrace: false, reason: 'unknown market' };
  const { date, minutes, weekday } = zonedParts(now, def.timeZone);
  const s = def.session(date, weekday);
  if (!s) return { date, open: false, inGrace: false, reason: 'closed today' };
  if (minutes < s.open) return { date, open: false, inGrace: false, reason: 'before the open' };
  if (minutes < s.close) return { date, open: true, inGrace: false, reason: 'regular session' };
  if (minutes < s.close + graceMinutes) return { date, open: false, inGrace: true, reason: 'final check after the close' };
  return { date, open: false, inGrace: false, reason: 'after the close' };
}

// ----- the check -------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// force: check even when the market is closed (manual runs, tests).
async function runPriceAlertCheck({ features, quotes, now = new Date(), force = false, graceMinutes = 20, pauseMs = 0, logger = console }) {
  const rules = await features.listActivePriceAlertsAll();
  const groups = new Map();
  rules.forEach((rule) => {
    const key = `${rule.market}:${rule.symbol}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rule);
  });
  const summary = { rules: rules.length, symbols: groups.size, checked: 0, triggered: 0, alertsCreated: 0, skipped: [], failures: [] };
  const nowIso = now.toISOString();
  let first = true;

  for (const [key, group] of groups.entries()) {
    const { market, symbol } = group[0];
    const session = marketSessionState(market, now, { graceMinutes });
    if (!force && !session.open && !session.inGrace) {
      summary.skipped.push({ key, reason: session.reason });
      continue;
    }
    if (!first && pauseMs) await sleep(pauseMs);
    first = false;

    let quote;
    try {
      quote = await quotes.getQuote(market, symbol);
    } catch (err) {
      summary.failures.push({ key, error: String((err && err.message) || err) });
      continue;
    }
    if (!quote || !Number.isFinite(quote.price) || quote.price <= 0) {
      summary.failures.push({ key, error: 'no price' });
      continue;
    }
    // A quote from an earlier session (a holiday the calendar does not
    // know, a halted security) says nothing about today: a percent rule
    // would re-read yesterday's move.
    if (!force && quote.tradeDate && session.date && quote.tradeDate !== session.date) {
      summary.skipped.push({ key, reason: `no trade today (last ${quote.tradeDate})` });
      continue;
    }
    summary.checked += 1;
    await features.recordPriceAlertChecks(group.map((r) => r.id), quote.price, nowIso);

    for (const rule of group) {
      const { hit } = evaluatePriceAlert(rule, quote);
      if (!hit) continue;
      try {
        // Alert first (idempotent through its dedup key), then the status:
        // a crash in between re-tries the insert harmlessly next run.
        const alert = buildPriceAlert(rule, quote, { now });
        const created = await features.insertAlert(Object.assign({}, alert, { createdAt: nowIso }));
        if (created) summary.alertsCreated += 1;
        if (await features.markPriceAlertTriggered(rule.id, { price: quote.price, prevClose: quote.prevClose, at: nowIso })) {
          summary.triggered += 1;
        }
      } catch (err) {
        logger.error('[price-alerts] trigger failed', { id: rule.id, error: err && err.message });
        summary.failures.push({ key, id: rule.id, error: String((err && err.message) || err) });
      }
    }
  }
  return summary;
}

// ----- production quotes -------------------------------------------------------

// A previous close from a price and its percent change (both sources report
// the change against the previous close, not the close itself).
function prevCloseFrom(price, changePercent) {
  if (changePercent === null || changePercent === undefined) return null;
  const cp = Number(changePercent);
  if (!Number.isFinite(price) || !Number.isFinite(cp) || cp <= -100) return null;
  return price / (1 + cp / 100);
}

// getQuote(market, symbol) -> { price, prevClose, tradeDate, fetchedAt, source }
// in the trading currency (TASE agorot -> shekels). Throws when the source
// fails; returns { price: null } when it answered but has no price.
//
// getYahooPayload is stale-while-revalidate: an old copy comes back at once
// while a refresh runs. A price alert wants the fresh one, so an old copy is
// waited on (briefly) for the refresh to land.
function createPriceQuotes({ maxAgeMs = 3 * 60 * 1000, waitMs = 1500, waitTries = 4 } = {}) {
  const { getYahooPayload } = require('./yahooQuotes');
  const { fetchTaseQuoteFromApi } = require('./taseQuoteApi');
  const isFresh = (q) => q && q.fetchedAt && Date.now() - Date.parse(q.fetchedAt) <= maxAgeMs && !q.stale;

  async function usQuote(symbol) {
    let q = await getYahooPayload(symbol);
    for (let i = 0; i < waitTries && !isFresh(q); i += 1) {
      await sleep(waitMs);
      q = await getYahooPayload(symbol);
    }
    if (!isFresh(q)) throw new Error('no fresh quote');
    const price = Number(q.currentPrice);
    if (!Number.isFinite(price) || price <= 0) return { price: null };
    return { price, prevClose: prevCloseFrom(price, q.changePercent), tradeDate: q.tradeDate || null, fetchedAt: q.fetchedAt, source: q.source || 'yahoo' };
  }

  async function taseQuote(securityId) {
    const q = await fetchTaseQuoteFromApi(securityId);
    const agorot = Number(q.currentPrice);
    if (q.currentPrice === null || !Number.isFinite(agorot) || agorot <= 0) return { price: null };
    const price = agorot / 100;
    return { price, prevClose: prevCloseFrom(price, q.changePercent), tradeDate: q.tradeDate || null, fetchedAt: new Date().toISOString(), source: 'tase-api' };
  }

  return {
    async getQuote(market, symbol) {
      if (market === 'US') return usQuote(symbol);
      if (market === 'TASE') return taseQuote(symbol);
      throw new Error(`unsupported market ${market}`);
    }
  };
}

// { 'price-alerts.check': (payload) => summary }. payload.force checks even
// with the market closed. `quotes` defaults to the production quotes,
// created on first use.
function createPriceAlertJobHandlers({ features, quotes = null, now = () => new Date(), pauseMs = 300 } = {}) {
  let q = quotes;
  return {
    'price-alerts.check': (payload = {}) => {
      if (!q) q = createPriceQuotes();
      return runPriceAlertCheck({ features, quotes: q, now: now(), force: Boolean(payload && payload.force), pauseMs });
    }
  };
}

module.exports = {
  marketSessionState,
  runPriceAlertCheck,
  createPriceQuotes,
  createPriceAlertJobHandlers,
  prevCloseFrom,
  NYSE_HOLIDAYS,
  NYSE_EARLY_CLOSE
};
