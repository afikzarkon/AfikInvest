// Fetches historical daily closes for a benchmark index (S&P 500 / TA-125)
// starting from a given date, to compare against the portfolio's equity
// curve. This is public market data (see server/benchmarkRoutes.js) — no
// auth needed, unlike usePortfolioSnapshots.

import { useEffect, useState } from 'react';
import { apiUrl } from '../apiBase';

// benchmarkKey: 'sp500' | 'ta125' | null (null/undefined = don't fetch).
// fromDate: 'YYYY-MM-DD', typically the portfolio's first snapshot date.
export function useBenchmarkHistory(benchmarkKey, fromDate) {
  const [points, setPoints] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!benchmarkKey || !fromDate) {
      setPoints([]);
      setError('');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    (async () => {
      try {
        const r = await fetch(apiUrl(`/api/benchmark-history/${benchmarkKey}?from=${fromDate}`));
        if (!r.ok) throw new Error('load failed');
        const d = await r.json();
        if (!cancelled) setPoints(Array.isArray(d.points) ? d.points : []);
      } catch {
        if (!cancelled) {
          setPoints([]);
          setError('לא ניתן היה לטעון את נתוני מדד הייחוס כרגע');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [benchmarkKey, fromDate]);

  return { points, loading, error };
}
