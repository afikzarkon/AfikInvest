import { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '../apiBase';

// The site-wide banner and maintenance mode an admin sets
// (GET /api/system/status, server/systemRoutes.js). Read on load, every
// minute and when the tab comes back into view - signed in or not, so the
// sign-in screen shows them too.
//
// Maintenance itself is enforced by the server (503 for all but admins);
// this only lets the page say so instead of failing call by call.
const POLL_MS = 60 * 1000;
const EMPTY = { banner: null, maintenance: { enabled: false, message: '' } };

export function useSystemStatus() {
  const [status, setStatus] = useState(EMPTY);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(apiUrl('/api/system/status'), { credentials: 'include' });
      if (!r.ok) return;
      const d = await r.json();
      setStatus({
        banner: d.banner && d.banner.text ? d.banner : null,
        maintenance: { enabled: Boolean(d.maintenance && d.maintenance.enabled), message: (d.maintenance && d.maintenance.message) || '' }
      });
    } catch {
      /* offline - keep what we have */
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  return { ...status, refresh };
}

export default useSystemStatus;
