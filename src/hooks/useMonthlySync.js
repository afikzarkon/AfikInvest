// The monthly sync status and the reports it produced (see
// server/monthlySyncRoutes.js). Downloads go through fetch so the bearer
// token is sent even when cookies are not (cross-site deployments); the
// server either streams the PDF or redirects to a short-lived signed URL.
import { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '../apiBase';

export function useMonthlySync(user, authHeader) {
  const [month, setMonth] = useState('');
  const [status, setStatus] = useState(null);
  const [reports, setReports] = useState([]);
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

  const reload = useCallback(
    async (forMonth) => {
      try {
        const q = forMonth ? `?month=${encodeURIComponent(forMonth)}` : '';
        const [s, r] = await Promise.all([request(`/api/monthly-sync${q}`), request('/api/reports')]);
        setStatus(s);
        setMonth(s.month);
        setReports(r.reports || []);
        setError('');
      } catch (err) {
        setError(err.message);
      }
    },
    [request]
  );

  useEffect(() => {
    if (!user) {
      setStatus(null);
      setReports([]);
      return;
    }
    reload();
  }, [user, reload]);

  const selectMonth = useCallback((m) => reload(m), [reload]);

  const setExcluded = useCallback(
    async (keys) => {
      const s = await request(`/api/monthly-sync/${month}/excluded`, { method: 'PUT', body: JSON.stringify({ keys }) });
      setStatus(s);
    },
    [request, month]
  );

  const complete = useCallback(async () => {
    const d = await request(`/api/monthly-sync/${month}/complete`, { method: 'POST' });
    setStatus(d.status);
    return d;
  }, [request, month]);

  const regenerate = useCallback(async () => {
    const d = await request(`/api/monthly-sync/${month}/regenerate`, { method: 'POST' });
    await reload(month);
    return d;
  }, [request, month, reload]);

  const download = useCallback(
    async (report) => {
      const r = await fetch(apiUrl(`/api/reports/${encodeURIComponent(report.id)}/download`), {
        credentials: 'include',
        headers: { ...authHeader() }
      });
      if (!r.ok) throw new Error('ההורדה נכשלה');
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `stockview-report-${report.month}-v${report.version}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  return { month, status, reports, error, reload, selectMonth, setExcluded, complete, regenerate, download };
}
