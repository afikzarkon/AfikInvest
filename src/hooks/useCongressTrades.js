// Congress stock trades on the client: House PTR filings from the last
// `days` days with their parsed trades, which of their tickers the user
// holds, and a rate-limited manual refresh. See server/congressRoutes.js.
//
// authHeader() is a fresh function every render, so it is deliberately left
// out of effect dependencies (see usePortfolioSnapshots.js).
import { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '../apiBase';

export function useCongressTrades(user, authHeader, { days = 90 } = {}) {
  const [data, setData] = useState({ filings: [], heldTickers: [], lastScanAt: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const request = useCallback(
    async (path, options = {}) => {
      const r = await fetch(apiUrl(path), {
        credentials: 'include',
        ...options,
        headers: { 'Content-Type': 'application/json', ...(authHeader ? authHeader() : {}), ...(options.headers || {}) }
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || r.statusText || 'שגיאה');
      return body;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const d = await request(`/api/congress?days=${encodeURIComponent(days)}`);
      setData({
        filings: Array.isArray(d.filings) ? d.filings : [],
        heldTickers: Array.isArray(d.heldTickers) ? d.heldTickers : [],
        lastScanAt: d.lastScanAt || null
      });
      setError('');
    } catch {
      setError('טעינת דיווחי הקונגרס נכשלה');
    } finally {
      setLoading(false);
    }
  }, [request, days]);

  useEffect(() => {
    if (!user) {
      setData({ filings: [], heldTickers: [], lastScanAt: null });
      return;
    }
    reload();
  }, [user, reload]);

  const refreshNow = useCallback(async () => {
    const result = await request('/api/congress/refresh', { method: 'POST' });
    await reload();
    return result;
  }, [request, reload]);

  return { ...data, loading, error, reload, refreshNow };
}
