// News on my holdings: headlines (Yahoo Finance) and SEC 8-K filings for the
// user's US holdings, from GET /api/news (server/newsRoutes.js).
//
// The server caches each symbol for ~12 minutes, so reloading is cheap.
// authHeader() is a fresh function every render, so it is deliberately left
// out of effect dependencies (see useAlerts.js).

import { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '../apiBase';

const EMPTY = { items: [], symbols: [], unsupported: [], secConfigured: true, errors: [], truncated: false };

// refreshKey: anything that should trigger a refetch when it changes (e.g.
// the list of held US symbols).
export function useNews(user, authHeader, { hours = 72, refreshKey = '' } = {}) {
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(
    async () => {
      const r = await fetch(apiUrl(`/api/news?hours=${encodeURIComponent(hours)}`), {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...authHeader() }
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || r.statusText || 'שגיאה');
      return Object.assign({}, EMPTY, body);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hours]
  );

  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!user) {
      setData(EMPTY);
      setLoaded(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    load()
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError('');
        setLoaded(true);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message && err.message !== 'שגיאה' ? err.message : 'טעינת החדשות נכשלה');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user, load, refreshKey, tick]);

  return { ...data, loading, error, loaded, reload };
}

export default useNews;
