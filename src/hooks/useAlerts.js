// Smart Alerts on the client: the user's alerts and unread count (polled,
// so the sidebar badge stays current without a reload), read state, the
// event calendar, the alert settings, and an on-demand refresh of the
// user's own holdings. See server/alertRoutes.js.
//
// authHeader() is a fresh function every render, so it is deliberately left
// out of effect dependencies (see usePortfolioSnapshots.js).

import { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '../apiBase';
import { getAuthToken } from '../authToken';

const POLL_MS = 5 * 60 * 1000;

export function useAlerts(user, authHeader) {
  const [alerts, setAlerts] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const request = useCallback(
    async (path, options = {}) => {
      const r = await fetch(apiUrl(path), {
        credentials: 'include',
        ...options,
        headers: { 'Content-Type': 'application/json', ...authHeader(), ...(options.headers || {}) }
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || r.statusText || 'שגיאה');
      return body;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const reload = useCallback(async () => {
    try {
      const d = await request('/api/alerts?limit=200');
      setAlerts(Array.isArray(d.alerts) ? d.alerts : []);
      setUnreadCount(Number(d.unreadCount) || 0);
      setError('');
    } catch {
      setError('טעינת ההתראות נכשלה');
    }
  }, [request]);

  useEffect(() => {
    if (!user) {
      setAlerts([]);
      setUnreadCount(0);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    reload().finally(() => {
      if (!cancelled) setLoading(false);
    });
    const timer = setInterval(() => {
      if (!cancelled) reload();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [user, reload]);

  const markRead = useCallback(
    async (id) => {
      try {
        await request(`/api/alerts/${encodeURIComponent(id)}/read`, { method: 'POST' });
        setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, readAt: new Date().toISOString() } : a)));
        setUnreadCount((n) => Math.max(0, n - 1));
      } catch {
        // Already read or gone - the next poll reconciles.
      }
    },
    [request]
  );

  const markAllRead = useCallback(async () => {
    try {
      await request('/api/alerts/read-all', { method: 'POST' });
      const now = new Date().toISOString();
      setAlerts((prev) => prev.map((a) => (a.readAt ? a : { ...a, readAt: now })));
      setUnreadCount(0);
    } catch {
      setError('הסימון נכשל');
    }
  }, [request]);

  const loadCalendar = useCallback((from, to) => {
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    return request(`/api/calendar?${q.toString()}`);
  }, [request]);

  const loadSettings = useCallback(() => request('/api/alert-settings'), [request]);

  const saveSettings = useCallback(
    (settings) => request('/api/alert-settings', { method: 'PUT', body: JSON.stringify(settings) }),
    [request]
  );

  const refreshNow = useCallback(async () => {
    const result = await request('/api/alerts/refresh', { method: 'POST' });
    await reload();
    return result;
  }, [request, reload]);

  return { alerts, unreadCount, loading, error, reload, markRead, markAllRead, loadCalendar, loadSettings, saveSettings, refreshNow };
}

// The session's bearer header, for callers that have no authHeader of their
// own (AlertsView uses usePriceAlerts without App.js passing one).
function defaultAuthHeader() {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// User price alerts (server/alertRoutes.js /api/price-alerts): the rules,
// loaded when `enabled` turns true, and create / edit / re-arm / delete.
// Every mutation throws an Error with the server's Hebrew message.
export function usePriceAlerts(enabled, authHeader = defaultAuthHeader) {
  const [rules, setRules] = useState([]);
  const [max, setMax] = useState(50);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');

  const request = useCallback(
    async (path, options = {}) => {
      const r = await fetch(apiUrl(path), {
        credentials: 'include',
        ...options,
        headers: { 'Content-Type': 'application/json', ...authHeader(), ...(options.headers || {}) }
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || r.statusText || 'שגיאה');
      return body;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const d = await request('/api/price-alerts');
      setRules(Array.isArray(d.rules) ? d.rules : []);
      if (Number(d.max) > 0) setMax(Number(d.max));
      setError('');
    } catch {
      setError('טעינת התראות המחיר נכשלה');
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [request]);

  useEffect(() => {
    if (enabled && !loaded) reload();
  }, [enabled, loaded, reload]);

  const replace = (rule) => setRules((prev) => prev.map((r) => (r.id === rule.id ? rule : r)));

  const create = useCallback(
    async (input) => {
      const d = await request('/api/price-alerts', { method: 'POST', body: JSON.stringify(input) });
      setRules((prev) => [d.rule, ...prev]);
      return d;
    },
    [request]
  );

  const update = useCallback(
    async (id, patch) => {
      const d = await request(`/api/price-alerts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      replace(d.rule);
      return d;
    },
    [request]
  );

  const rearm = useCallback((id) => update(id, { status: 'active' }), [update]);

  const remove = useCallback(
    async (id) => {
      await request(`/api/price-alerts/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setRules((prev) => prev.filter((r) => r.id !== id));
    },
    [request]
  );

  return { rules, max, loading, loaded, error, reload, create, update, rearm, remove };
}
