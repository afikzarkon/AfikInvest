// Smart Alerts on the client: the user's alerts and unread count (polled,
// so the sidebar badge stays current without a reload), read state, the
// event calendar, the alert settings, and an on-demand refresh of the
// user's own holdings. See server/alertRoutes.js.
//
// authHeader() is a fresh function every render, so it is deliberately left
// out of effect dependencies (see usePortfolioSnapshots.js).

import { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '../apiBase';

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
