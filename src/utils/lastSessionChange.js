// "שינוי אתמול": what each holding, and the securities as a whole, gained
// or lost on its market's last COMPLETED session - not a calendar
// yesterday. On a Monday it is Friday; on the day after a holiday it is the
// session before the holiday; while a market is trading, its previous
// session.
//
// WHERE THE CLOSES COME FROM
//
// Every quote already carries the session it is from (dailyChangeTradeDate,
// see marketSession.js), its price and its change against the session
// before. So:
//
//   the quote's session is before today (the market has not opened today,
//   a weekend, a holiday): that session IS the last completed one, and its
//   close and the close before it come straight from the quote - price, and
//   price / (1 + change). No request at all.
//
//   the quote's session is today (trading now, or closed today): the last
//   completed session before today is the latest date before today in the
//   symbol's daily closes, and the one before it is the date before that.
//   Only these symbols need history (useLastSessionHistory.js).
//
// A US holding is valued in shekels at each session's own USD/ILS close
// (the latest rate on or before that date), so a day the dollar fell shows
// as a loss even when the price did not move. Without the rate history,
// today's rate stands in for both days and `fxApprox` says so.
//
// WHAT WAS HELD
//
// Per lot, over that session: a lot held through it moved from the close
// before to the close; one bought that day from its cost to the close; one
// sold that day (a closed slice, shared/transactionLedger.js) from the
// close before - or its cost, if bought the same day - to the sale price.
// A lot bought after the session, or sold before it, is not counted. The
// percent is that change over what was at stake: the previous close of
// what was held, plus the cost of what was bought that day.
//
// A holding with nothing to judge by (no session date, no history yet) is
// null - shown as "—", never as 0.
import { closeOnOrBefore } from './historicalPortfolioValue';
import { israelDateOf } from './moneyIn';
import { toNum } from './formatters';

const dateIn = (timeZone, now) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

// Today on each market's own calendar - a quote's session date is in it.
export const marketToday = (market, now = new Date()) => dateIn(market === 'american' ? 'America/New_York' : 'Asia/Jerusalem', now);

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s);

// The two closes of a symbol's last completed session: { date, close,
// prevDate, prevClose } (prices in the lot's own currency, shekels for
// TASE), or null.
export function lastCompletedCloses({ quote, closes, today }) {
  const tradeDate = quote && isDate(quote.tradeDate) ? quote.tradeDate.slice(0, 10) : null;
  if (!tradeDate) return null;
  if (tradeDate < today) {
    const close = toNum(quote.price);
    const pct = Number(quote.changePercent);
    if (!(close > 0) || !Number.isFinite(pct) || pct <= -100) return null;
    return { date: tradeDate, close, prevDate: null, prevClose: close / (1 + pct / 100) };
  }
  const past = (Array.isArray(closes) ? closes : [])
    .filter((c) => c && isDate(c.date) && c.date.slice(0, 10) < today && toNum(c.close) > 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (past.length < 2) return null;
  const last = past[past.length - 1];
  const prev = past[past.length - 2];
  return { date: last.date.slice(0, 10), close: toNum(last.close), prevDate: prev.date.slice(0, 10), prevClose: toNum(prev.close) };
}

// The USD/ILS on a session's date, and on the session before it.
function fxFor(session, fxCloses, fallbackRate) {
  const rates = Array.isArray(fxCloses) && fxCloses.length ? fxCloses : null;
  if (!rates) return { fx: fallbackRate, prevFx: fallbackRate, approx: true };
  const fx = closeOnOrBefore(session.date, rates);
  // The rate before the session: on its previous session's date when
  // known, else the latest rate dated before the session.
  let prevFx = session.prevDate ? closeOnOrBefore(session.prevDate, rates) : null;
  if (!prevFx) {
    const before = rates.filter((r) => r && r.date < session.date).sort((a, b) => (a.date < b.date ? -1 : 1));
    prevFx = before.length ? toNum(before[before.length - 1].close) : null;
  }
  if (!(fx > 0) || !(prevFx > 0)) return { fx: fallbackRate, prevFx: fallbackRate, approx: true };
  return { fx, prevFx, approx: false };
}

// One lot's change over the session, in shekels: { change, base } or null
// when the lot was not held during it.
function lotChange(lot, s, { market, saleByTx }) {
  const qty = toNum(lot.quantity);
  if (!(qty > 0)) return null;
  const bought = israelDateOf(lot.purchaseDate);
  const sold = lot.isClosedSlice ? israelDateOf(lot.soldDate) : null;
  if (!bought || bought > s.date) return null;
  if (sold && sold < s.date) return null;
  const costPerUnit = toNum(lot.purchasePrice) * (market === 'american' ? toNum(lot.exchangeRate) || s.fx : 1);
  // Bought on the session's day - or after the session before it, when
  // that date is known - it was not held at the previous close.
  const boughtDuring = bought === s.date || (s.prevDate && bought > s.prevDate);
  const startPerUnit = boughtDuring ? costPerUnit : s.prevClose * s.prevFx;
  let endPerUnit = s.close * s.fx;
  if (sold === s.date) {
    const sale = saleByTx.get(String(lot.soldTxId));
    if (!sale) return null;
    endPerUnit = toNum(sale.price) * (market === 'american' ? toNum(sale.fxRate) || s.fx : 1);
  }
  return { change: qty * (endPerUnit - startPerUnit), base: qty * startPerUnit };
}

// {
//   bySymbol: { 'israeli:<id>' | 'american:<TICKER>': result },
//   byLot: { [lot id]: result },
//   total: { changeILS, pct, dates: { israeli, american }, fxApprox } | null
// }
// result: { date, changeILS, pct, fxApprox }
//
// holdings: the open lots (their quotes); lots: the same expanded with the
// closed slices (shared/transactionLedger.js); history: { israeli: {id:
// closes}, american: {TICKER: closes}, fx: closes } - TASE closes in
// agorot, as the history endpoint returns them.
export function computeLastSessionChange({ holdings = {}, lots = holdings, transactions = [], history = {}, now = new Date() }) {
  const saleByTx = new Map((transactions || []).filter((t) => t && t.type === 'SELL').map((t) => [String(t.id), t]));
  const bySymbol = {};
  const byLot = {};
  let totalChange = 0;
  let totalBase = 0;
  let any = false;
  let fxApprox = false;
  const dates = { israeli: null, american: null };

  [
    ['israeli', holdings.israeliStocks, lots.israeliStocks],
    ['american', holdings.americanStocks, lots.americanStocks]
  ].forEach(([market, open, all]) => {
    const today = marketToday(market, now);
    const symbolOf = (l) => (market === 'american' ? String(l.stockName || '').trim().toUpperCase() : String(l.stockName || '').trim());
    const quotes = new Map();
    (open || []).forEach((l) => {
      const sym = symbolOf(l);
      if (sym && !quotes.has(sym)) quotes.set(sym, l);
    });
    const groups = new Map();
    (all || []).forEach((l) => {
      const sym = symbolOf(l);
      if (!sym) return;
      if (!groups.has(sym)) groups.set(sym, []);
      groups.get(sym).push(l);
    });

    groups.forEach((group, sym) => {
      // A symbol sold in full has no open lot - and no live quote - left;
      // its history still prices the session it was sold in.
      const q = quotes.get(sym);
      const quote = q ? { tradeDate: q.dailyChangeTradeDate, price: q.currentPrice, changePercent: q.dailyChangePercent } : { tradeDate: today };
      const rawCloses = (history[market] || {})[sym];
      const closes = market === 'israeli' && Array.isArray(rawCloses) ? rawCloses.map((c) => ({ date: c.date, close: toNum(c.close) / 100 })) : rawCloses;
      const closesOf = lastCompletedCloses({ quote, closes, today });
      if (!closesOf) return;
      const rate = q ? toNum(q.currentExchangeRate) || toNum(q.exchangeRate) : toNum(group[0].exchangeRate);
      const fx = market === 'american' ? fxFor(closesOf, history.fx, rate) : { fx: 1, prevFx: 1, approx: false };
      if (market === 'american' && !(fx.fx > 0)) return;
      const s = { ...closesOf, ...fx };

      let change = 0;
      let base = 0;
      let held = false;
      group.forEach((lot) => {
        const r = lotChange(lot, s, { market, saleByTx });
        if (!r) return;
        held = true;
        change += r.change;
        base += r.base;
        if (!lot.isClosedSlice) byLot[lot.id] = { date: s.date, changeILS: r.change, pct: r.base > 0 ? (r.change / r.base) * 100 : null, fxApprox: fx.approx };
      });
      if (!held) return;
      bySymbol[`${market}:${sym}`] = { date: s.date, changeILS: change, pct: base > 0 ? (change / base) * 100 : null, fxApprox: fx.approx };
      any = true;
      totalChange += change;
      totalBase += base;
      fxApprox = fxApprox || fx.approx;
      if (!dates[market] || s.date > dates[market]) dates[market] = s.date;
    });
  });

  return {
    bySymbol,
    byLot,
    total: any ? { changeILS: totalChange, pct: totalBase > 0 ? (totalChange / totalBase) * 100 : null, dates, fxApprox } : null
  };
}

// The symbols whose last completed session is not in their quote (it is
// from today), and so need daily closes. A symbol with no open lot is
// included only when a slice of it was sold within the last week.
export function symbolsNeedingHistory({ holdings = {}, lots = holdings, now = new Date() }) {
  const out = { israeli: [], american: [] };
  [
    ['israeli', holdings.israeliStocks, lots.israeliStocks],
    ['american', holdings.americanStocks, lots.americanStocks]
  ].forEach(([market, open, all]) => {
    const today = marketToday(market, now);
    const weekAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10);
    const norm = (l) => (market === 'american' ? String(l.stockName || '').trim().toUpperCase() : String(l.stockName || '').trim());
    const set = new Set();
    const openSyms = new Set();
    (open || []).forEach((l) => {
      const sym = norm(l);
      if (!sym) return;
      openSyms.add(sym);
      const t = isDate(l.dailyChangeTradeDate) ? l.dailyChangeTradeDate.slice(0, 10) : null;
      if (t && t >= today) set.add(sym);
    });
    (all || []).forEach((l) => {
      const sym = norm(l);
      if (sym && !openSyms.has(sym) && l.isClosedSlice && israelDateOf(l.soldDate) >= weekAgo) set.add(sym);
    });
    out[market] = [...set].sort();
  });
  return out;
}
