// The transactions ledger (see shared/transactionLedger.js and
// server/transactionRoutes.js): loads the user's transactions, and records
// or deletes one.
//
// record/remove return the portfolio the SERVER now holds, because the
// server applies the transaction to its stored copy (reducing lots, adding
// a deposit entry, ...) atomically with saving the ledger row. The caller
// must therefore save any unsaved edits first and replace its own copy with
// the one returned - App.js#handleRecordTransaction does both.
//
// authHeader() is a fresh function every render, so it is deliberately left
// out of effect dependencies (see usePortfolioSnapshots.js for the infinite
// loop that including it once caused).

import { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '../apiBase';

async function readError(r) {
  try {
    const d = await r.json();
    return d && d.error ? d.error : r.statusText;
  } catch {
    return r.statusText || 'שגיאה';
  }
}

export function useTransactions(user, authHeader) {
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user) {
      setTransactions([]);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const r = await fetch(apiUrl('/api/transactions'), {
          credentials: 'include',
          headers: { ...authHeader() }
        });
        if (!r.ok) throw new Error(await readError(r));
        const d = await r.json();
        if (!cancelled) {
          setTransactions(Array.isArray(d.transactions) ? d.transactions : []);
          setError('');
        }
      } catch {
        if (!cancelled) setError('טעינת העסקאות נכשלה');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const post = useCallback(
    async (path, body) => {
      const r = await fetch(apiUrl(path), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify(body)
      });
      if (!r.ok) return { ok: false, error: await readError(r) };
      return { ok: true, ...(await r.json()) };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const preview = useCallback((tx) => post('/api/transactions/preview', tx), [post]);

  const record = useCallback(
    async (tx) => {
      try {
        const result = await post('/api/transactions', tx);
        if (result.ok) {
          setTransactions((prev) =>
            [...prev, result.transaction].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
          );
        }
        return result;
      } catch {
        return { ok: false, error: 'שגיאת רשת' };
      }
    },
    [post]
  );

  const remove = useCallback(
    async (id) => {
      try {
        const r = await fetch(apiUrl(`/api/transactions/${encodeURIComponent(id)}`), {
          method: 'DELETE',
          credentials: 'include',
          headers: { ...authHeader() }
        });
        if (!r.ok) return { ok: false, error: await readError(r) };
        const d = await r.json();
        setTransactions((prev) => prev.filter((t) => t.id !== id));
        return { ok: true, portfolio: d.portfolio };
      } catch {
        return { ok: false, error: 'שגיאת רשת' };
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  return { transactions, loading, error, preview, record, remove };
}
