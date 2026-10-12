// Portfolio data: the 5 holdings arrays, loading them when a user logs in,
// and saving them back to the server.
// Extracted from App.js — behavior is unchanged, only the location moved.

import { useEffect, useRef, useState } from 'react';
import { apiUrl } from '../apiBase';
import { normalizeIsraeliStocksFromStorage } from '../utils/formatters';

export function usePortfolioData(user, authHeader) {
  const [israeliStocks, setIsraeliStocks] = useState([]);
  const [americanStocks, setAmericanStocks] = useState([]);
  const [pensionFunds, setPensionFunds] = useState([]);
  const [bankBalances, setBankBalances] = useState([]);
  const [cashFunds, setCashFunds] = useState([]);
  const [bankSavingsFunds, setBankSavingsFunds] = useState([]);
  const [portfolioReady, setPortfolioReady] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [saveLoading, setSaveLoading] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [lastSavedAt, setLastSavedAt] = useState(null);

  const userRef = useRef(null);
  userRef.current = user;

  // Reserved for a future debounced-autosave timer. Currently only ever
  // cleared, never scheduled — kept as-is from the original App.js so
  // behavior doesn't change, but it's effectively unused right now.
  const persistTimerRef = useRef(null);
  const clearPendingSaveTimer = () => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
  };

  // Load the portfolio for the logged-in user (server-backed, no cross-user
  // or LocalStorage sharing).
  useEffect(() => {
    if (!user) {
      setPortfolioReady(false);
      setHasUnsavedChanges(false);
      setSaveError('');
      setLastSavedAt(null);
      return;
    }

    let cancelled = false;
    setPortfolioReady(false);
    (async () => {
      try {
        const r = await fetch(apiUrl('/api/portfolio'), {
          credentials: 'include',
          headers: { ...authHeader() }
        });
        if (!r.ok) throw new Error('load failed');
        const d = await r.json();
        if (cancelled) return;
        setIsraeliStocks(normalizeIsraeliStocksFromStorage(d.israeliStocks || []));
        setAmericanStocks(Array.isArray(d.americanStocks) ? d.americanStocks : []);
        setPensionFunds(Array.isArray(d.pensionFunds) ? d.pensionFunds : []);
        setBankBalances(Array.isArray(d.bankBalances) ? d.bankBalances : []);
        setCashFunds(Array.isArray(d.cashFunds) ? d.cashFunds : []);
        setBankSavingsFunds(Array.isArray(d.bankSavingsFunds) ? d.bankSavingsFunds : []);
        setHasUnsavedChanges(false);
        setSaveError('');
        setLastSavedAt(new Date());
      } catch {
        if (!cancelled) {
          setIsraeliStocks([]);
          setAmericanStocks([]);
          setPensionFunds([]);
          setBankBalances([]);
          setCashFunds([]);
          setBankSavingsFunds([]);
          setHasUnsavedChanges(false);
          setSaveError('');
          setLastSavedAt(null);
        }
      } finally {
        if (!cancelled) setPortfolioReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const buildCurrentPortfolioSnapshot = () => ({
    israeliStocks,
    americanStocks,
    pensionFunds,
    bankBalances,
    cashFunds,
    bankSavingsFunds
  });

  // Resolves true once the server has the portfolio, false otherwise.
  const savePortfolio = async () => {
    if (!userRef.current) return false;
    if (saveLoading) return false;
    setSaveError('');
    setSaveLoading(true);
    clearPendingSaveTimer();
    try {
      const body = JSON.stringify(buildCurrentPortfolioSnapshot());
      const r = await fetch(apiUrl('/api/portfolio'), {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body
      });
      if (!r.ok) {
        const msg = await r.text().catch(() => '');
        throw new Error(msg || r.statusText || 'save failed');
      }
      setHasUnsavedChanges(false);
      setLastSavedAt(new Date());
      return true;
    } catch (e) {
      setSaveError('שמירה נכשלה. בדוק התחברות/רשת ונסה שוב.');
      console.warn('שמירת תיק — שגיאה', e);
      return false;
    } finally {
      setSaveLoading(false);
    }
  };

  // Bulk-replace the portfolio (used by the one-time legacy localStorage import)
  const replacePortfolio = (snapshot) => {
    setIsraeliStocks(snapshot.israeliStocks);
    setAmericanStocks(snapshot.americanStocks);
    setPensionFunds(snapshot.pensionFunds);
    setBankBalances(snapshot.bankBalances);
    setCashFunds(snapshot.cashFunds);
    setBankSavingsFunds(Array.isArray(snapshot.bankSavingsFunds) ? snapshot.bankSavingsFunds : []);
    setHasUnsavedChanges(false);
    setSaveError('');
    setLastSavedAt(new Date());
  };

  // Clears all portfolio state — used on logout
  const resetPortfolio = () => {
    clearPendingSaveTimer();
    setIsraeliStocks([]);
    setAmericanStocks([]);
    setPensionFunds([]);
    setBankBalances([]);
    setCashFunds([]);
    setBankSavingsFunds([]);
    setPortfolioReady(false);
    setHasUnsavedChanges(false);
    setSaveError('');
    setLastSavedAt(null);
  };

  return {
    israeliStocks,
    setIsraeliStocks,
    americanStocks,
    setAmericanStocks,
    pensionFunds,
    setPensionFunds,
    bankBalances,
    setBankBalances,
    cashFunds,
    setCashFunds,
    bankSavingsFunds,
    setBankSavingsFunds,
    portfolioReady,
    hasUnsavedChanges,
    setHasUnsavedChanges,
    saveLoading,
    saveError,
    lastSavedAt,
    savePortfolio,
    replacePortfolio,
    resetPortfolio,
    clearPendingSaveTimer
  };
}
