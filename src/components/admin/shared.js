import React, { useCallback, useEffect, useState } from 'react';

// Small pieces the admin panel's tabs share.

export function formatWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
}

// Loads with `loader` on mount and on reload(); { data, error, loading, reload }.
export function useLoad(loader) {
  const [state, setState] = useState({ data: null, error: '', loading: true });
  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await loader();
      setState({ data, error: '', loading: false });
    } catch (err) {
      setState((s) => ({ ...s, error: err.message, loading: false }));
    }
    // The loader is a stable module function or a callback the tab owns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  return { ...state, reload };
}

// Runs one action at a time; { busy, error, run }. run resolves to true
// when the action succeeded.
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = useCallback(async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

export function ErrorNote({ children }) {
  return children ? (
    <p className="admin-error" role="alert">
      {children}
    </p>
  ) : null;
}

export function Loading() {
  return <p className="history-empty-note">טוען…</p>;
}
