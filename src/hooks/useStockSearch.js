// Ticker/company autocomplete for the "חקר מניות" search box (see
// server/stockResearchRoutes.js's GET /api/stock-search). Debounced so
// typing doesn't fire a request per keystroke.

import { useEffect, useState } from 'react';
import { apiUrl } from '../apiBase';

const DEBOUNCE_MS = 300;

// query: string (raw search text, not yet trimmed/validated by the caller).
export function useStockSearch(query) {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timeoutId = setTimeout(() => {
      setLoading(true);
      (async () => {
        try {
          const r = await fetch(apiUrl(`/api/stock-search?q=${encodeURIComponent(trimmed)}`));
          if (!r.ok) throw new Error('search failed');
          const d = await r.json();
          if (!cancelled) setResults(Array.isArray(d.results) ? d.results : []);
        } catch {
          if (!cancelled) setResults([]);
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [query]);

  return { results, loading };
}
