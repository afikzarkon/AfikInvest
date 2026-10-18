import { useCallback, useEffect, useRef, useState } from 'react';
import { apiUrl } from '../apiBase';
import { FLAG_DEFINITIONS, defaultFlagStates, flagVisibleTo } from '../shared/featureFlags';

// The feature flags as they stand for the signed-in user, read from the
// server at run time (GET /api/features, server/adminRoutes.js).
//
// Read on sign-in, again every minute and whenever the tab comes back into
// view - so an admin switching a feature off reaches open sessions within
// a minute, without a deploy or a reload.
//
// Until the first answer (and if the server cannot be reached) each defined
// flag stands at its default, so the pages that are normally there do not
// flash away and back on every load. This only decides what is SHOWN:
// the server enforces the flags on its own APIs, and the admin role on the
// admin API, whatever this returns.
const POLL_MS = 60 * 1000;

// The pages a flag can hide - App.js holds them back until the flags load.
const GATED_ROUTES = FLAG_DEFINITIONS.filter((f) => f.route).map((f) => f.route);

function defaultEnabled() {
  const states = defaultFlagStates();
  return Object.keys(states).filter((key) => flagVisibleTo(states[key], false));
}

export function useFeatureFlags(user, authHeader) {
  const [state, setState] = useState(() => ({ flags: defaultEnabled(), isAdmin: false, loaded: false }));
  const headerRef = useRef(authHeader);
  headerRef.current = authHeader;
  const userId = user ? user.id : null;

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(apiUrl('/api/features'), {
        credentials: 'include',
        headers: { ...(headerRef.current ? headerRef.current() : {}) }
      });
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      setState({ flags: Array.isArray(d.flags) ? d.flags : [], isAdmin: Boolean(d.isAdmin), loaded: true });
    } catch {
      // Unreachable: keep what we have, but stop waiting for it - the
      // pages held back for the first answer render on the defaults.
      setState((prev) => (prev.loaded ? prev : { ...prev, loaded: true }));
    }
  }, []);

  useEffect(() => {
    if (!userId) {
      setState({ flags: defaultEnabled(), isAdmin: false, loaded: false });
      return undefined;
    }
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
  }, [userId, refresh]);

  const isEnabled = useCallback((key) => state.flags.includes(key), [state.flags]);

  // The pages whose flag is off for this user.
  const hiddenRoutes = FLAG_DEFINITIONS.filter((f) => f.route && !state.flags.includes(f.key)).map((f) => f.route);

  return { ...state, isEnabled, hiddenRoutes, gatedRoutes: GATED_ROUTES, refresh };
}

export default useFeatureFlags;
