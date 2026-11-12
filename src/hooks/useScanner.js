// The daily market scanner on the client: the latest stored scan run and its
// hits (server/scannerRoutes.js). The scan itself runs once a day on the
// server after the US close, so this reads once per filter change - no polling.
//
// authHeader() is a fresh function every render, so it is deliberately left
// out of effect dependencies (see usePortfolioSnapshots.js).

import { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '../apiBase';

export function useScanner(user, authHeader, { minPrice = '', minVolume = '' } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(
    async () => {
      const q = new URLSearchParams();
      if (minPrice !== '' && minPrice !== null && minPrice !== undefined) q.set('minPrice', String(minPrice));
      if (minVolume !== '' && minVolume !== null && minVolume !== undefined) q.set('minVolume', String(minVolume));
      const qs = q.toString();
      const r = await fetch(apiUrl(`/api/scanner${qs ? `?${qs}` : ''}`), {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(authHeader ? authHeader() : {}) }
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || 'טעינת הסורק נכשלה');
      return body;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [minPrice, minVolume]
  );

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await load());
      setError('');
    } catch (err) {
      setError(err.message || 'טעינת הסורק נכשלה');
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    if (!user) {
      setData(null);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    load()
      .then((body) => {
        if (!cancelled) {
          setData(body);
          setError('');
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'טעינת הסורק נכשלה');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user, load]);

  return { data, loading, error, reload };
}
