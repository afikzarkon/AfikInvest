// Trade simulator on the client: posts a plan to /api/trade-sim
// (server/tradeSimRoutes.js) and keeps the latest result. Nothing is stored;
// the simulation is seeded on the server, so the same plan on the same data
// gives the same numbers.
//
// authHeader() is a fresh function every render, so it is deliberately left
// out of the callback's dependencies (see useAlerts.js).

import { useCallback, useRef, useState } from 'react';
import { apiUrl } from '../apiBase';

export function useTradeSim(user, authHeader) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const seq = useRef(0);

  const run = useCallback(
    async (body) => {
      if (!user) {
        setError('נדרשת התחברות');
        return null;
      }
      const mine = ++seq.current;
      setLoading(true);
      setError('');
      try {
        const r = await fetch(apiUrl('/api/trade-sim'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...(authHeader ? authHeader() : {}) },
          body: JSON.stringify(body)
        });
        const data = await r.json().catch(() => ({}));
        if (mine !== seq.current) return null;
        if (!r.ok) {
          setResult(null);
          setError(data.error || 'הסימולציה נכשלה');
          return null;
        }
        setResult(data);
        return data;
      } catch {
        if (mine === seq.current) setError('אין חיבור לשרת, נסו שוב');
        return null;
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user]
  );

  const clear = useCallback(() => {
    seq.current += 1;
    setResult(null);
    setError('');
    setLoading(false);
  }, []);

  return { result, loading, error, run, clear };
}
