// The raw, dated data the automatic DCF is derived from (see
// server/dcfSnapshot.js), cached per symbol for the session.
import { useEffect, useRef, useState } from 'react';
import { apiUrl } from '../apiBase';

export function useDcfSnapshot(symbol) {
  const cache = useRef(new Map());
  const [state, setState] = useState({ snapshot: null, loading: false, error: '' });

  useEffect(() => {
    const s = String(symbol || '').trim().toUpperCase();
    if (!s) {
      setState({ snapshot: null, loading: false, error: '' });
      return undefined;
    }
    if (cache.current.has(s)) {
      setState({ snapshot: cache.current.get(s), loading: false, error: '' });
      return undefined;
    }
    let cancelled = false;
    setState({ snapshot: null, loading: true, error: '' });
    (async () => {
      try {
        const r = await fetch(apiUrl(`/api/valuation/${encodeURIComponent(s)}/dcf`), { credentials: 'include' });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'הטעינה נכשלה');
        cache.current.set(s, d);
        if (!cancelled) setState({ snapshot: d, loading: false, error: '' });
      } catch (err) {
        if (!cancelled) setState({ snapshot: null, loading: false, error: err.message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  return state;
}
