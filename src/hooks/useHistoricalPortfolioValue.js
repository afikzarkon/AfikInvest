// Fetches the raw historical-price data (Israeli/American closes + USD/ILS
// FX history) needed to compute a historical portfolio value series over a
// date range (see utils/historicalPortfolioValue.js), and exposes both the
// resulting series and a helper for the itemized breakdown on any single
// date inside it.
//
// This is now the engine behind the main "ביצועי התיק לאורך זמן" section,
// not just an optional extra: performance is computed on the fly from real
// closing prices for whatever the portfolio actually held on each date,
// rather than read back from value snapshots the app had to have saved in
// advance. It also backs the monthly tracker's auto-fill, which needs the
// same data for one specific month-end.
//
// Two-stage on purpose: the network fetch is keyed by the *set* of symbols
// plus the date range (a stable string, so a price-refresh tick that
// produces a new array reference with the same symbols doesn't re-fetch) -
// but the final series computation is a useMemo depending on the live
// holdings arrays directly, so a quantity edit is reflected immediately
// without a network round-trip.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiUrl } from '../apiBase';
import {
  computeHistoricalBreakdownAtDate,
  computeHistoricalPortfolioSeries
} from '../utils/historicalPortfolioValue';

function uniqueSymbols(stocks) {
  return [...new Set((stocks || []).map((s) => s.stockName).filter(Boolean))];
}

async function postJson(path, body) {
  const r = await fetch(apiUrl(path), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`${path} failed`);
  return r.json();
}

const EMPTY_PRICE_DATA = { taseHistoricalCloses: {}, yahooHistoricalCloses: {}, fxHistoricalCloses: [] };

export function useHistoricalPortfolioValue({
  fromDate,
  toDate,
  israeliStocks,
  americanStocks,
  // Non-traded accounts are optional: pass them to have the series cover
  // the whole portfolio, omit them for a stocks-only series.
  pensionFunds = [],
  cashFunds = [],
  bankBalances = [],
  bankSavingsFunds = [],
  // Valuation basis for the ledger-backed accounts, passed through to
  // computePortfolioValueAtDate.
  //
  // A PERFORMANCE series wants this on: an account is worth 0 until the
  // app has any evidence it existed, so a balance recorded last month is
  // not asserted to have been there for the previous three years. A
  // point-in-time reconstruction (the monthly tracker's auto-fill) wants
  // it off, so a long-held account still reports its best-reconstructed
  // balance for a month that predates the first recording.
  //
  // With it on, the caller MUST build its cash flows with
  // includeLedgerOpeningBalances - see buildPortfolioCashFlows.
  anchorLedgerAccountsToFirstRecord = false,
  // The USD/ILS history is fetched automatically when there are American
  // holdings to price. This asks for it anyway - a USD benchmark has to be
  // converted to shekels before it can be compared with an ILS portfolio
  // (see benchmarkPointsInILS), and that is needed even for an
  // Israeli-only portfolio being measured against the S&P 500.
  needsFxHistory = false,
  // One rate for every date instead of each date's own, which makes the
  // American side a pure dollar return expressed in shekels. Null keeps
  // the historical rates. See computePortfolioValueAtDate.
  americanExchangeRate = null
}) {
  const [priceData, setPriceData] = useState(EMPTY_PRICE_DATA);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const israeliKey = useMemo(() => uniqueSymbols(israeliStocks).sort().join(','), [israeliStocks]);
  const americanKey = useMemo(() => uniqueSymbols(americanStocks).sort().join(','), [americanStocks]);

  useEffect(() => {
    if (!fromDate || !toDate) {
      setPriceData(EMPTY_PRICE_DATA);
      return undefined;
    }
    const israeliSymbols = israeliKey ? israeliKey.split(',') : [];
    const americanSymbols = americanKey ? americanKey.split(',') : [];
    const wantsFx = americanSymbols.length > 0 || needsFxHistory;
    let cancelled = false;
    setLoading(true);
    setError('');

    (async () => {
      try {
        const [israeliRes, americanRes, fxRes] = await Promise.all([
          israeliSymbols.length
            ? postJson('/api/israeli-stocks-history', { symbols: israeliSymbols, from: fromDate })
            : Promise.resolve({ history: {} }),
          americanSymbols.length
            ? postJson('/api/american-stocks-history', { symbols: americanSymbols, from: fromDate })
            : Promise.resolve({ history: {} }),
          wantsFx
            ? fetch(apiUrl(`/api/exchange-rate-history?from=${encodeURIComponent(fromDate)}`), {
                credentials: 'include'
              }).then((r) => r.json())
            : Promise.resolve({ history: [] })
        ]);
        if (cancelled) return;
        setPriceData({
          taseHistoricalCloses: israeliRes.history || {},
          yahooHistoricalCloses: americanRes.history || {},
          fxHistoricalCloses: fxRes.history || []
        });
      } catch {
        if (!cancelled) {
          setError('לא ניתן היה לטעון נתוני מחירים היסטוריים כרגע');
          setPriceData(EMPTY_PRICE_DATA);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fromDate, toDate, israeliKey, americanKey, needsFxHistory]);

  const holdings = useMemo(
    () => ({ israeliStocks, americanStocks, pensionFunds, cashFunds, bankBalances, bankSavingsFunds }),
    [israeliStocks, americanStocks, pensionFunds, cashFunds, bankBalances, bankSavingsFunds]
  );

  const series = useMemo(
    () =>
      fromDate && toDate
        ? computeHistoricalPortfolioSeries(fromDate, toDate, holdings, priceData, {
            anchorLedgerAccountsToFirstRecord,
            americanExchangeRate
          })
        : [],
    [fromDate, toDate, holdings, priceData, anchorLedgerAccountsToFirstRecord, americanExchangeRate]
  );

  // The itemized breakdown on one date inside the fetched range - used by
  // the monthly tracker to fill a month's rows automatically.
  const breakdownAtDate = useCallback(
    (date) => computeHistoricalBreakdownAtDate(date, holdings, priceData),
    [holdings, priceData]
  );

  return { series, loading, error, breakdownAtDate, priceData };
}
