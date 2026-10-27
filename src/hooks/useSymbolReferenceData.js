// The shared machinery behind useStockSectors, useAnalystRecommendations
// and useDividendData.
//
// All three ask the same question in the same shape - POST a list of US
// tickers, get back an object keyed by ticker - and all three had the same
// two problems.
//
// FIRST: the cache lived in a ref, so it died with the component. The
// analysis page is the only screen that uses any of them, so every visit
// to it re-requested sector classifications and analyst consensus that had
// been fetched minutes earlier and cannot meaningfully have changed.
// Navigating away and back paid the full cost again. The store below is
// module-level, so it outlives the page.
//
// SECOND: all three fired the moment the page mounted, alongside the three
// historical-price requests the performance chart actually needs. None of
// them feeds anything above the fold - sectors draw a chart halfway down,
// analyst coverage and dividends are near the bottom - but they competed
// for the same connections, and on the server for the same rate-limited
// Yahoo queue, as the data the page opens on. They are now deferred until
// the browser is idle, so the chart the user came for is not queued behind
// the tables they may never scroll to.

import { useEffect, useRef, useState } from 'react';
import { apiUrl } from '../apiBase';

// Long enough that moving around the app is free, short enough that a
// session left open all day still refreshes. None of this data moves
// faster than the server's own cache (6-24h), so a client TTL below that
// would only ever re-ask a question the server answers from memory.
const CLIENT_TTL_MS = 30 * 60 * 1000;

// Runs `fn` once the browser has nothing more important to do. The timeout
// is the guarantee: on a busy page idle callbacks can be starved
// indefinitely, and "eventually" is not the same as "never".
function whenIdle(fn, timeout = 1500) {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(fn, { timeout });
    return () => window.cancelIdleCallback(id);
  }
  // Safari and jsdom have no requestIdleCallback. A macrotask after paint
  // is the same idea with coarser timing.
  const id = setTimeout(fn, 0);
  return () => clearTimeout(id);
}

// One store per endpoint, created at module scope by each hook below.
export function createSymbolStore({ endpoint, responseKey }) {
  const bySymbol = new Map(); // symbol -> { data, ts }
  const inFlight = new Map(); // symbol -> Promise<Record<symbol, data>>

  const isFresh = (entry) => entry && Date.now() - entry.ts < CLIENT_TTL_MS;

  const snapshot = (symbols) => {
    const out = {};
    symbols.forEach((s) => {
      const entry = bySymbol.get(s);
      if (isFresh(entry)) out[s] = entry.data;
    });
    return out;
  };

  const request = async (symbols, extraBody) => {
    const r = await fetch(apiUrl(endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols, ...(extraBody || {}) })
    });
    if (!r.ok) throw new Error('load failed');
    const body = await r.json();
    const data = body[responseKey] || {};
    Object.keys(data).forEach((s) => bySymbol.set(s, { data: data[s], ts: Date.now() }));
    return data;
  };

  // Resolves with everything known for `symbols`, whatever it took to get
  // there: cached values are returned as-is, symbols another caller is
  // already fetching are AWAITED rather than re-requested, and only what
  // nobody has asked for yet becomes a new request.
  //
  // Joining the in-flight promise is what makes two sections mounting at
  // the same moment cost one request AND both get the answer. An earlier
  // version skipped in-flight symbols when deciding what to fetch but
  // never waited for them, so the second caller quietly got nothing.
  const ensure = async (symbols, extraBody) => {
    const pending = new Set();
    const toFetch = [];
    symbols.forEach((s) => {
      if (isFresh(bySymbol.get(s))) return;
      if (inFlight.has(s)) pending.add(inFlight.get(s));
      else toFetch.push(s);
    });

    if (toFetch.length > 0) {
      const promise = request(toFetch, extraBody);
      toFetch.forEach((s) => inFlight.set(s, promise));
      pending.add(
        promise.finally(() => {
          toFetch.forEach((s) => inFlight.delete(s));
        })
      );
    }

    // allSettled, not all: one endpoint failing must not discard what the
    // other in-flight batches did resolve.
    await Promise.allSettled([...pending]);
    return snapshot(symbols);
  };

  const hasAll = (symbols) => symbols.every((s) => isFresh(bySymbol.get(s)));

  return {
    snapshot,
    ensure,
    hasAll,
    // Test seams. Nothing in the app calls these.
    missing: (symbols) => symbols.filter((s) => !isFresh(bySymbol.get(s))),
    _clear: () => {
      bySymbol.clear();
      inFlight.clear();
    }
  };
}

// `symbols` is rebuilt by the caller on every render, so everything keys
// off the sorted, de-duplicated contents rather than the array identity.
export function useSymbolReferenceData(store, symbols, extraBody) {
  const uniqueSymbols = [
    ...new Set((symbols || []).map((s) => String(s || '').trim().toUpperCase()).filter(Boolean))
  ];
  const symbolsKey = uniqueSymbols.slice().sort().join(',');

  // Seeded from the store, so a remount with everything already cached
  // renders the data on its first paint instead of flashing empty.
  const [data, setData] = useState(() => store.snapshot(uniqueSymbols));
  const [loading, setLoading] = useState(false);
  const extraBodyRef = useRef(extraBody);
  extraBodyRef.current = extraBody;

  useEffect(() => {
    const wanted = symbolsKey ? symbolsKey.split(',') : [];
    if (wanted.length === 0) return undefined;

    // Whatever is already cached shows immediately.
    const cached = store.snapshot(wanted);
    if (Object.keys(cached).length > 0) setData((prev) => ({ ...prev, ...cached }));
    if (store.hasAll(wanted)) return undefined;

    let cancelled = false;
    setLoading(true);
    const cancelIdle = whenIdle(() => {
      store
        .ensure(wanted, extraBodyRef.current)
        .then((fetched) => {
          if (!cancelled) setData((prev) => ({ ...prev, ...fetched }));
        })
        .catch(() => {
          // Best-effort: a missing sector or price target shows as "not
          // available" in its own row, and never as a broken page.
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    });

    return () => {
      cancelled = true;
      cancelIdle();
    };
  }, [store, symbolsKey]);

  return { data, loading };
}
