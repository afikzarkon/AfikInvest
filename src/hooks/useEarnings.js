// Earnings as filed with the SEC for one US symbol (see
// server/earningsRoutes.js), cached per symbol for the session so switching
// back and forth does not refetch.
//
// authHeader() is a fresh function every render, so it is deliberately left
// out of effect dependencies (see usePortfolioSnapshots.js).
import { useEffect, useRef, useState } from 'react';
import { apiUrl } from '../apiBase';

export function useEarnings(symbol, authHeader) {
  const cache = useRef(new Map());
  const [state, setState] = useState({ data: null, loading: false, error: '' });

  useEffect(() => {
    const s = String(symbol || '').trim().toUpperCase();
    if (!s) {
      setState({ data: null, loading: false, error: '' });
      return undefined;
    }
    if (cache.current.has(s)) {
      setState({ data: cache.current.get(s), loading: false, error: '' });
      return undefined;
    }
    let cancelled = false;
    setState({ data: null, loading: true, error: '' });
    (async () => {
      try {
        const r = await fetch(apiUrl(`/api/earnings/${encodeURIComponent(s)}`), {
          credentials: 'include',
          headers: { ...(authHeader ? authHeader() : {}) }
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'טעינת נתוני הדוחות נכשלה');
        if (d.secConfigured !== false) cache.current.set(s, d);
        if (!cancelled) setState({ data: d, loading: false, error: '' });
      } catch (err) {
        if (!cancelled) setState({ data: null, loading: false, error: err.message || 'טעינת נתוני הדוחות נכשלה' });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  return state;
}
