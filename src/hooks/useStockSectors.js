// Resolves sector/industry for a list of US stock tickers, batched into a
// single request. Public data (see server/sectorRoutes.js) — no auth needed.
//
// The caching and the deferral both live in useSymbolReferenceData.js,
// which this shares with the analyst and dividend hooks; see that file for
// why the cache is module-level and why the request waits for idle.
import { createSymbolStore, useSymbolReferenceData } from './useSymbolReferenceData';

const store = createSymbolStore({ endpoint: '/api/stock-sectors', responseKey: 'sectors' });

// symbols: string[] (raw tickers, e.g. from americanStocks.map(s => s.stockName))
export function useStockSectors(symbols) {
  const { data, loading } = useSymbolReferenceData(store, symbols);
  return { sectorBySymbol: data, loading };
}

// The same lookup outside a component (the PDF export), sharing the cache:
// after the analysis page has been opened it costs nothing. Never rejects,
// and gives up after `timeoutMs` - a report without US sectors (they show
// as unclassified) is better than an export button that hangs.
export function loadStockSectors(symbols, { timeoutMs = 8000 } = {}) {
  const wanted = [...new Set((symbols || []).map((s) => String(s || '').trim().toUpperCase()).filter(Boolean))];
  if (wanted.length === 0) return Promise.resolve({});
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(store.snapshot(wanted)), timeoutMs);
  });
  const loaded = store.ensure(wanted).catch(() => store.snapshot(wanted));
  return Promise.race([loaded, timeout]).finally(() => clearTimeout(timer));
}

export const __sectorStore = store;
