// One per-user preference document (see server/preferenceRoutes.js), e.g.
// the recommendation engine's thresholds. `value` is null until loaded or
// when never saved - callers merge it over their own defaults.
import { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '../apiBase';

export function usePreferences(user, authHeader, namespace) {
  const [value, setValue] = useState(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!user) {
      setValue(null);
      setLoaded(false);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(apiUrl(`/api/preferences/${namespace}`), { credentials: 'include', headers: { ...authHeader() } });
        const d = r.ok ? await r.json() : { value: null };
        if (!cancelled) setValue(d.value || null);
      } catch {
        if (!cancelled) setValue(null);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, namespace]);

  const save = useCallback(
    async (next) => {
      const r = await fetch(apiUrl(`/api/preferences/${namespace}`), {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify(next)
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'השמירה נכשלה');
      setValue(d.value);
      return d.value;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [namespace]
  );

  return { value, loaded, save };
}
