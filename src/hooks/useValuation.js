// Valuation data for one symbol (see server/valuationRoutes.js), cached per
// symbol for the session so switching back and forth does not refetch.
import { useEffect, useRef, useState } from 'react';
import { apiUrl } from '../apiBase';

export function useValuation(symbol) {
  const cache = useRef(new Map());
  const [state, setState] = useState({ data: null, loading: false, error: '', diagnostics: null });

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
        const r = await fetch(apiUrl(`/api/valuation/${encodeURIComponent(s)}`), { credentials: 'include' });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          const err = new Error(d.error || 'הטעינה נכשלה');
          err.diagnostics = d.diagnostics || null;
          throw err;
        }
        cache.current.set(s, d);
        if (!cancelled) setState({ data: d, loading: false, error: '' });
      } catch (err) {
        if (!cancelled) setState({ data: null, loading: false, error: err.message, diagnostics: err.diagnostics || null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  return state;
}
