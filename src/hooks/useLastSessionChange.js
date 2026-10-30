// The "שינוי אתמול" figures for the dashboard and the holdings tables (see
// utils/lastSessionChange.js).
//
// Each held symbol's daily closes, and for US holdings the USD/ILS
// history, come from the same cached history endpoints
// the analysis page uses, at most once a day per symbol: the closes are
// kept in this browser under today's date, since a past session's close
// never changes.
import { useEffect, useMemo, useState } from 'react';
import { apiUrl } from '../apiBase';
import { expandHoldingsWithClosedLots } from '../shared/transactionLedger';
import { computeLastSessionChange, marketToday, symbolsNeedingHistory } from '../utils/lastSessionChange';

const STORAGE_KEY = 'afikinvest_lastSessionHistory';
// Enough calendar days to hold two sessions across any holiday stretch.
const LOOKBACK_DAYS = 20;

const emptyCache = (day) => ({ day, israeli: {}, american: {}, fx: null });

function readCache(day) {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (raw && raw.day === day) return { ...emptyCache(day), ...raw };
  } catch {
    // Unreadable or blocked storage: start empty.
  }
  return emptyCache(day);
}

function writeCache(cache) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Full or blocked storage: the figures still show, they are just
    // fetched again next time.
  }
}

async function postJson(path, body) {
  const r = await fetch(apiUrl(path), { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} failed`);
  return r.json();
}

export function useLastSessionChange({ israeliStocks, americanStocks, transactions, enabled = true }) {
  const holdings = useMemo(() => ({ israeliStocks: israeliStocks || [], americanStocks: americanStocks || [] }), [israeliStocks, americanStocks]);
  const lots = useMemo(() => expandHoldingsWithClosedLots(holdings, transactions || []), [holdings, transactions]);
  // The cache day: a new Israeli or New York date starts a new one.
  const day = `${marketToday('israeli')}|${marketToday('american')}`;
  const [history, setHistory] = useState(() => readCache(day));

  const need = useMemo(() => symbolsNeedingHistory({ holdings, lots }), [holdings, lots]);
  const wantsFx = holdings.americanStocks.length > 0 || need.american.length > 0;
  const needKey = `${day}#${need.israeli.join(',')}#${need.american.join(',')}#${wantsFx}`;

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const cache = readCache(day);
    const missingIl = need.israeli.filter((s) => !cache.israeli[s]);
    const missingUs = need.american.filter((s) => !cache.american[s]);
    const missingFx = wantsFx && !cache.fx;
    if (!missingIl.length && !missingUs.length && !missingFx) {
      setHistory(cache);
      return undefined;
    }
    const from = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
    (async () => {
      const [il, us, fx] = await Promise.all([
        missingIl.length ? postJson('/api/israeli-stocks-history', { symbols: missingIl, from }).catch(() => null) : null,
        missingUs.length ? postJson('/api/american-stocks-history', { symbols: missingUs, from }).catch(() => null) : null,
        missingFx ? fetch(apiUrl(`/api/exchange-rate-history?from=${from}`), { credentials: 'include' }).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null
      ]);
      if (cancelled) return;
      const next = { ...cache, israeli: { ...cache.israeli }, american: { ...cache.american } };
      // Only what came back non-empty is kept, so a failed fetch is tried
      // again on the next visit rather than remembered as "no closes".
      const keep = (target, res) =>
        Object.entries((res && res.history) || {}).forEach(([sym, closes]) => {
          if (Array.isArray(closes) && closes.length) target[sym] = closes;
        });
      keep(next.israeli, il);
      keep(next.american, us);
      if (fx && Array.isArray(fx.history) && fx.history.length) next.fx = fx.history;
      writeCache(next);
      setHistory(next);
    })();
    return () => {
      cancelled = true;
    };
    // needKey stands for day, need and wantsFx.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needKey, enabled]);

  return useMemo(
    () => computeLastSessionChange({ holdings, lots, transactions: transactions || [], history: history.day === day ? history : emptyCache(day) }),
    [holdings, lots, transactions, history, day]
  );
}
