// Automatic price refresh: keeps the TASE/Yahoo prices on the stock arrays
// up to date, unless the user is mid-edit or mid-add.
//
// This hook is the client half of the "the app must render instantly and
// fill in prices afterwards" requirement. Two things make that work:
//
// 1. Nothing here blocks rendering. The tables draw immediately from the
//    prices already persisted with the portfolio (the local snapshot), and
//    this hook only ever *replaces* those values once fresher ones arrive.
//    A refresh that fails, or is still in flight, leaves the last known
//    prices on screen - it never blanks them or holds up a paint.
//
// 2. The first refresh fires immediately on mount instead of waiting a
//    whole polling interval. Previously the first live prices could not
//    arrive until 10s after load no matter how fast the server answered.
//
// Both markets are fetched in ONE batched request each (see
// api/stockPrices.js), rather than one request per unique symbol, and the
// two batches run concurrently.
//
// The hook reports its progress (`refreshing`, `lastRefreshAt`,
// `hasLoadedLivePrices`) so the UI can show a loading indicator / skeleton
// over the price columns while the first cycle is still running, instead of
// silently showing stale numbers as if they were live.

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchAmericanStockPrices, fetchIsraeliStockPrices } from '../api/stockPrices';

// Matches the server's own quote cache TTL (see taseScraper.js's
// TASE_CACHE_TTL_MS). Polling faster than the cache refreshes - the
// previous 10s - could not produce a newer number; it just spent requests
// re-reading the same cached value six times per cache generation.
const POLLING_INTERVAL_MS = 60000;

// A price fetched longer ago than this is reported as not current. The
// server refreshes every minute and serves its last known price when a
// source fails, with the time that price was fetched (fetchedAt) - so a
// price this old means the source has been failing for a while, and the
// user should see when the number on screen is from rather than take it
// for live.
export const STALE_PRICE_MS = 15 * 60 * 1000;

// The holdings whose price is not current: fetched more than
// STALE_PRICE_MS ago, or never fetched in this session (the price on
// screen is the one saved with the portfolio). One entry per symbol,
// { symbol, name, fetchedAt } - fetchedAt null when unknown.
export function findStalePrices(stocks, now = Date.now()) {
  const bySymbol = new Map();
  stocks.forEach((stock) => {
    if (!stock || !stock.stockName || bySymbol.has(stock.stockName)) return;
    const fetchedAt = stock.priceFetchedAt ? Date.parse(stock.priceFetchedAt) : NaN;
    const fresh = Number.isFinite(fetchedAt) && now - fetchedAt < STALE_PRICE_MS;
    bySymbol.set(
      stock.stockName,
      fresh
        ? null
        : {
            symbol: stock.stockName,
            name: String(stock.officialName || '').trim() || stock.stockName,
            fetchedAt: Number.isFinite(fetchedAt) ? stock.priceFetchedAt : null
          }
    );
  });
  return [...bySymbol.values()].filter(Boolean);
}

// Collects the distinct symbols to request, so each unique symbol is only
// asked for once no matter how many purchase lots reference it.
function uniqueSymbols(stocks) {
  return [...new Set(stocks.map((stock) => stock.stockName).filter(Boolean))];
}

// Fetches fresh prices for every unique Israeli security in one batched
// request and applies them to every lot sharing that security id. Lots
// whose security didn't come back with a usable price keep their existing
// values rather than being zeroed.
export async function refreshIsraeliStocks(israeliStocks, setIsraeliStocks) {
  if (israeliStocks.length === 0) return;

  const ids = uniqueSymbols(israeliStocks);
  const quotes = await fetchIsraeliStockPrices(ids);
  if (!quotes || Object.keys(quotes).length === 0) return;

  setIsraeliStocks((current) =>
    current.map((stock) => {
      const quote = quotes[stock.stockName];
      if (!quote || quote.currentPrice === null || quote.currentPrice === undefined) return stock;
      return {
        ...stock,
        // Convert from agorot to shekels - the server returns TASE's own
        // agorot convention (see server/taseQuoteApi.js).
        currentPrice: quote.currentPrice / 100,
        dailyChangePercent: quote.changePercent,
        // Which session that change is from - see utils/marketSession.js.
        dailyChangeTradeDate: quote.tradeDate || null,
        // When the server fetched it - see findStalePrices.
        priceFetchedAt: quote.fetchedAt
      };
    })
  );
}

// Same idea for American symbols (via Yahoo), plus the shared USD/ILS rate,
// which comes back on the same response.
export async function refreshAmericanStocks(americanStocks, setAmericanStocks) {
  if (americanStocks.length === 0) return;

  const symbols = uniqueSymbols(americanStocks);
  const { quotes, exchangeRate } = await fetchAmericanStockPrices(symbols);
  if ((!quotes || Object.keys(quotes).length === 0) && exchangeRate == null) return;

  setAmericanStocks((current) =>
    current.map((stock) => {
      const quote = quotes ? quotes[stock.stockName] : null;
      const currentExchangeRate = exchangeRate || stock.currentExchangeRate || stock.exchangeRate;
      if (!quote || quote.currentPrice === null || quote.currentPrice === undefined) {
        // No quote for this ticker - still apply the newer FX rate, which
        // is what the previous per-symbol implementation did too.
        return { ...stock, currentExchangeRate };
      }
      return {
        ...stock,
        currentPrice: quote.currentPrice,
        dailyChangePercent: quote.changePercent,
        dailyChangeTradeDate: quote.tradeDate || null,
        priceFetchedAt: quote.fetchedAt,
        currentExchangeRate
      };
    })
  );
}

export function usePriceRefresh({
  israeliStocks,
  americanStocks,
  setIsraeliStocks,
  setAmericanStocks,
  isEditMode,
  editingField,
  isAddingNewStock,
  // Fired once, the first time a full refresh cycle actually completes
  // (both branches settled) - not on raw mount, where prices are still
  // whatever was last persisted rather than freshly confirmed live. Used
  // by useAutoSnapshot.js to know it's safe to capture a snapshot value
  // without risking the "stale/incomplete render" problem that got the
  // old always-on auto-save reverted (see usePortfolioSnapshots.js).
  onFirstCycleComplete
}) {
  const hasCompletedFirstCycleRef = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshAt, setLastRefreshAt] = useState(null);
  const [hasLoadedLivePrices, setHasLoadedLivePrices] = useState(false);

  // The current arrays live in a ref so the refresh callback can read them
  // without being re-created (and without restarting the interval) on every
  // price tick it causes itself. The setters take an updater function, so
  // the applied update is always against the latest state regardless.
  const stocksRef = useRef({ israeliStocks, americanStocks });
  stocksRef.current = { israeliStocks, americanStocks };

  const pausedRef = useRef(false);
  pausedRef.current = Boolean(isEditMode || editingField || isAddingNewStock);

  const onFirstCycleCompleteRef = useRef(onFirstCycleComplete);
  onFirstCycleCompleteRef.current = onFirstCycleComplete;

  const runRefreshCycle = useCallback(async () => {
    // Don't refresh while the user is editing or adding a stock - an
    // incoming price update would fight with what they're typing.
    if (pausedRef.current) return;

    const { israeliStocks: israeli, americanStocks: american } = stocksRef.current;
    if (israeli.length === 0 && american.length === 0) return;

    setRefreshing(true);
    // Israeli (TASE) and American (Yahoo) refreshes are fully independent -
    // neither's result depends on the other's - so they run concurrently.
    // allSettled (not all) so a failure in one branch never prevents the
    // other from updating.
    await Promise.allSettled([
      refreshIsraeliStocks(israeli, setIsraeliStocks),
      refreshAmericanStocks(american, setAmericanStocks)
    ]);
    setRefreshing(false);
    setLastRefreshAt(new Date());
    setHasLoadedLivePrices(true);

    if (!hasCompletedFirstCycleRef.current) {
      hasCompletedFirstCycleRef.current = true;
      if (onFirstCycleCompleteRef.current) onFirstCycleCompleteRef.current();
    }
  }, [setIsraeliStocks, setAmericanStocks]);

  // Immediate first refresh as soon as there is anything to refresh, then
  // on an interval. Keyed on the *count* of holdings rather than the arrays
  // themselves so the effect isn't torn down and rebuilt by its own updates.
  const holdingsKey = `${israeliStocks.length}:${americanStocks.length}`;
  useEffect(() => {
    if (israeliStocks.length === 0 && americanStocks.length === 0) return undefined;
    runRefreshCycle();
    const interval = setInterval(runRefreshCycle, POLLING_INTERVAL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holdingsKey, runRefreshCycle]);

  // Only meaningful once a cycle has run: before that every price is the
  // saved one by definition, and the toolbar already says so.
  const stalePrices = hasLoadedLivePrices ? findStalePrices([...israeliStocks, ...americanStocks]) : [];

  return { refreshing, lastRefreshAt, hasLoadedLivePrices, stalePrices, refreshNow: runRefreshCycle };
}
