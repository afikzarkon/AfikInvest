import './App.css';
import React, { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { formatPriceWithSign, normalizeIsraeliStocksFromStorage } from './utils/formatters';
import { calculatePortfolioSummary } from './utils/portfolioSummary';
import { applyAccountFieldEdit } from './utils/portfolioMath';
import { calculatePortfolioAnalysis } from './utils/portfolioAnalysis';
import { apiUrl } from './apiBase';
import { useAuth } from './hooks/useAuth';
import { usePortfolioData } from './hooks/usePortfolioData';
import { usePriceRefresh } from './hooks/usePriceRefresh';
import { useCpiIndex } from './hooks/useCpiIndex';
import { usePortfolioSnapshots } from './hooks/usePortfolioSnapshots';
import { useMonthlySnapshots } from './hooks/useMonthlySnapshots';
import { useAutoSnapshot } from './hooks/useAutoSnapshot';
import { buildItemizedMonthlyBreakdown } from './utils/monthlySnapshotBreakdown';
import { useRebalanceTargets } from './hooks/useRebalanceTargets';
import { useTransactions } from './hooks/useTransactions';
import { useAlerts } from './hooks/useAlerts';
import { usePreferences } from './hooks/usePreferences';
import { useTheme } from './hooks/useTheme';
import { monthKeyFromDate } from './utils/cpiTax';
import { useRoute } from './hooks/useRoute';
import HomeView from './components/HomeView';
import AuthView from './components/AuthView';
import ResetPasswordView from './components/ResetPasswordView';
import AppShell from './components/AppShell';
import ThemeToggleButton from './components/ThemeToggleButton';
import BetaNoticeModal from './components/BetaNoticeModal';
import AssetEntryModal from './components/AssetEntryModal';
import { buildSamplePortfolio } from './utils/samplePortfolio';
import { useAccount } from './hooks/useAccount';
import { setAuthToken } from './authToken';
import { putAccount } from './accountApi';
import AccountLinkView, { accountLinkFromUrl } from './components/AccountLinkView';
import LegalPage, { LEGAL_PATHS } from './components/LegalPage';
import { OnboardingModal, TermsGate, ProfilePrompt } from './components/OnboardingFlow';
import { PrivacyContext } from './components/PrivacyToggle';
import { useToast } from './components/ui/Toast';
import { profileCompletion } from './components/settings/ProfileSection';

// ONE CHUNK PER PAGE, fetched when that page is first opened.
//
// Everything below used to be in the initial bundle, so opening the app at
// the dashboard downloaded and parsed the analysis page, the research page
// and the monthly tracker as well - and with them recharts, which is the
// single largest dependency here and is used by exactly two screens that
// the landing page is not one of. That is what the app was waiting on
// before it could paint anything.
//
// The dashboard, the auth screen and the shell around them stay eager:
// they are what a cold visit actually renders, and deferring them would
// only add a round-trip to the critical path.
const PortfolioAnalysisView = lazy(() => import('./components/PortfolioAnalysisView'));
const MonthlyTrackerView = lazy(() => import('./components/MonthlyTrackerView'));
const TaxOffsetView = lazy(() => import('./components/TaxOffsetView'));
const IsraeliStocksPage = lazy(() => import('./components/pages/IsraeliStocksPage'));
const UsStocksPage = lazy(() => import('./components/pages/UsStocksPage'));
const ProvidentFundsPage = lazy(() => import('./components/pages/ProvidentFundsPage'));
const CashAndCheckingPage = lazy(() => import('./components/pages/CashAndCheckingPage'));
const BankSavingsPage = lazy(() => import('./components/pages/BankSavingsPage'));
const TransactionsView = lazy(() => import('./components/TransactionsView'));
const AlertsView = lazy(() => import('./components/AlertsView'));
const RecommendationsView = lazy(() => import('./components/RecommendationsView'));
const ValuationView = lazy(() => import('./components/ValuationView'));
const SettingsView = lazy(() => import('./components/settings/SettingsView'));

// /terms or /privacy when the page is one of them, else null.
function legalPathFromUrl() {
  if (typeof window === 'undefined') return null;
  const path = window.location.pathname.replace(/\/+$/, '');
  return LEGAL_PATHS.includes(path) ? path : null;
}

const ONBOARDING_KEY = 'afikinvest_onboarding';

// The headline total in the user's main currency (the investments setting):
// the ILS rate of USD or EUR, null for ILS or while unknown.
function useFxRate(currency) {
  const [rate, setRate] = useState(null);
  useEffect(() => {
    if (!currency || currency === 'ILS') {
      setRate(null);
      return undefined;
    }
    let cancelled = false;
    fetch(apiUrl(`/api/exchange-rate?currency=${currency}`))
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setRate(Number(d.rate) > 0 ? Number(d.rate) : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [currency]);
  return rate;
}

const RESET_PASSWORD_PATH = '/reset-password';

// The token from a password-reset email link (/reset-password?token=...),
// or null when this is not that page.
function resetTokenFromUrl() {
  if (typeof window === 'undefined' || window.location.pathname.replace(/\/+$/, '') !== RESET_PASSWORD_PATH) {
    return null;
  }
  return new URLSearchParams(window.location.search).get('token') || '';
}

const LEGACY_KEYS = [
  'israeliStocks',
  'americanStocks',
  'pensionFunds',
  'bankBalances',
  'cashFunds'
];

function legacyImportFlagKey(userId) {
  return `afikinvest_legacy_import_done_${userId}`;
}

function readLegacyPortfolioFromLocalStorage() {
  try {
    const parseArr = (key) => {
      const raw = localStorage.getItem(key);
      if (!raw) return [];
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : [];
    };
    const israeliRaw = localStorage.getItem('israeliStocks');
    const israeliParsed = israeliRaw ? JSON.parse(israeliRaw) : [];
    return {
      israeliStocks: normalizeIsraeliStocksFromStorage(
        Array.isArray(israeliParsed) ? israeliParsed : []
      ),
      americanStocks: parseArr('americanStocks'),
      pensionFunds: parseArr('pensionFunds'),
      bankBalances: parseArr('bankBalances'),
      cashFunds: parseArr('cashFunds')
    };
  } catch {
    return null;
  }
}

function portfolioHasAnyRows(p) {
  if (!p) return false;
  return (
    p.israeliStocks.length > 0 ||
    p.americanStocks.length > 0 ||
    p.pensionFunds.length > 0 ||
    p.bankBalances.length > 0 ||
    p.cashFunds.length > 0
  );
}

function clearLegacyPortfolioKeys() {
  LEGACY_KEYS.forEach((k) => localStorage.removeItem(k));
}

function App() {
  const { user, authLoading, authHeader, login, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const toast = useToast();
  // A page opened from an email link or the return from Google/Facebook
  // (AccountLinkView.js), and the public terms/privacy pages.
  const [accountLink, setAccountLink] = useState(accountLinkFromUrl);
  const [legalPath, setLegalPath] = useState(legalPathFromUrl);
  // The profile, picture and preferences the whole site reads (and the
  // privacy-mode flag behind every money amount).
  const accountState = useAccount(user);
  const { account, investments } = accountState;
  const fxRate = useFxRate(investments.mainCurrency);
  // The first-run steps, after a new account's first sign-in - kept for the
  // tab's lifetime, so a refresh does not lose them.
  const [onboardingPending, setOnboardingPending] = useState(() => {
    try {
      return sessionStorage.getItem(ONBOARDING_KEY) === '1';
    } catch {
      return false;
    }
  });
  // null unless the page was opened from a reset email.
  const [resetToken, setResetToken] = useState(resetTokenFromUrl);
  const [authNotice, setAuthNotice] = useState('');
  // Out of the address bar (and so out of history and Referer headers) as
  // soon as it has been read.
  useEffect(() => {
    if (resetToken && window.location.search) {
      window.history.replaceState({}, '', RESET_PASSWORD_PATH);
    }
  }, [resetToken]);
  const {
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
    resetPortfolio
  } = usePortfolioData(user, authHeader);

  // Which page is open is now the URL's business, not three booleans that
  // could each be true at once and had no answer for a refresh or the back
  // button. See hooks/useRoute.js.
  const { page: activePage, navigate } = useRoute();
  // The one entry form (AssetEntryModal.js): null while closed, otherwise
  // what it was opened with - {} from the "+" button, { assetClass, assetId,
  // action } from an account's ledger, { transaction } to edit a recorded
  // one. Price polling pauses while it is open, as it did for the old page.
  const [assetEntry, setAssetEntry] = useState(null);
  const isAddingNewStock = assetEntry !== null;
  const [isEditMode, setIsEditMode] = useState(false);
  const [showAmericanColumns, setShowAmericanColumns] = useState(true);
  const [editingField, setEditingField] = useState(null);
  const [expandedGroups, setExpandedGroups] = useState({});

  // The beta/security disclaimer (see BetaNoticeModal.js). Plain component
  // state, not localStorage: it is meant to be seen on every arrival -
  // each login and each refresh - so there is deliberately nothing here
  // that outlives the page.
  const [betaNoticeAcknowledged, setBetaNoticeAcknowledged] = useState(false);

  // True while the demo portfolio from the empty home screen is on screen
  // and not yet saved. It is loaded locally only: nothing reaches the server
  // unless the user chooses to save it, and until then the automatic
  // daily/monthly snapshots stay off so demo figures never land in their
  // history.
  const [isSamplePortfolio, setIsSamplePortfolio] = useState(false);

  const [legacyImportCompleted, setLegacyImportCompleted] = useState(false);
  const [legacyImportLoading, setLegacyImportLoading] = useState(false);
  const [legacyImportBanner, setLegacyImportBanner] = useState('');

  // Set once, the first time a full price-refresh cycle actually
  // completes (see usePriceRefresh.js) - gates useAutoSnapshot below so it
  // never captures a value from a stale/incomplete initial render.
  const [firstPriceCycleComplete, setFirstPriceCycleComplete] = useState(false);
  // Non-blocking by design: this never gates a render. The tables draw
  // immediately from the prices persisted with the portfolio, and these
  // flags only drive a progress indicator while fresher prices arrive in
  // the background (see usePriceRefresh.js).
  const {
    refreshing: pricesRefreshing,
    lastRefreshAt: pricesLastRefreshAt,
    hasLoadedLivePrices
  } = usePriceRefresh({
    israeliStocks,
    americanStocks,
    setIsraeliStocks,
    setAmericanStocks,
    isEditMode,
    editingField,
    isAddingNewStock,
    onFirstCycleComplete: () => setFirstPriceCycleComplete(true)
  });

  // כל חודשי המדד הרלוונטיים לתיק: תאריכי קניית מניות ישראליות +
  // תאריכי כל הפקדה בפנקס ההפקדות של כל קופת גמל. משמש לחישוב מס
  // רווח הון ריאלי מוצמד למדד (ראו utils/cpiTax.js).
  const relevantCpiMonths = [
    ...israeliStocks.map((s) => monthKeyFromDate(s.purchaseDate)),
    ...pensionFunds.flatMap((f) => (Array.isArray(f.deposits) ? f.deposits : []).map((d) => monthKeyFromDate(d.date))),
    ...bankSavingsFunds.flatMap((f) => (Array.isArray(f.deposits) ? f.deposits : []).map((d) => monthKeyFromDate(d.date)))
  ].filter(Boolean);

  const cpi = useCpiIndex(relevantCpiMonths);

  // Computed once here (not just inside the "show analysis" branch) so it
  // can also feed the snapshot-saving hook below, regardless of which
  // screen is currently visible. Cheap pure-JS reduce over the portfolio
  // arrays, so recomputing on relevant changes is fine.
  const analysis = useMemo(
    () => calculatePortfolioAnalysis(israeliStocks, americanStocks, pensionFunds, cashFunds, bankBalances, bankSavingsFunds),
    [israeliStocks, americanStocks, pensionFunds, cashFunds, bankBalances, bankSavingsFunds]
  );

  // Itemized (one entry per actual holding/account, not just a category
  // total) so the monthly-snapshot comparison/history can show per-stock
  // movement (see utils/monthlySnapshotBreakdown.js). Reused for the daily
  // snapshot too - it's a strict superset of the old flat-number shape
  // (category totals are just the sum of a category's items), and nothing
  // currently reads the daily snapshot's breakdown for anything but this.
  const snapshotBreakdown = useMemo(
    () => buildItemizedMonthlyBreakdown(analysis, pensionFunds, cashFunds, bankBalances, bankSavingsFunds),
    [analysis, pensionFunds, cashFunds, bankBalances, bankSavingsFunds]
  );

  const {
    snapshots,
    snapshotsLoaded,
    saveSnapshotNow,
    saveError: snapshotSaveError,
    lastSavedAt: lastSnapshotSavedAt
  } = usePortfolioSnapshots(user, authHeader);

  const {
    monthlySnapshots,
    monthlySnapshotsLoading,
    monthlySnapshotsLoaded,
    saveMonthlySnapshot,
    savingMonthly,
    saveMonthlyError,
    updateMonthlySnapshot,
    updatingMonth,
    updateMonthlyError,
    deleteMonthlySnapshot,
    deletingMonth,
    deleteMonthlyError,
    addManualMonthlySnapshot,
    addingManual,
    addManualError
  } = useMonthlySnapshots(user, authHeader);

  // Replaces the old manual "שמור מידע יומי עדכני" button entirely - see
  // useAutoSnapshot.js for the full mechanism. portfolioReady is folded
  // into the same gate as firstPriceCycleComplete so a snapshot is never
  // captured before the portfolio has actually finished loading either.
  useAutoSnapshot({
    firstCycleComplete: firstPriceCycleComplete && portfolioReady && !isSamplePortfolio,
    totalValueILS: analysis.summaryMetrics.overallTotalValueILS,
    breakdown: snapshotBreakdown,
    snapshots,
    saveSnapshotNow,
    monthlySnapshots,
    saveMonthlySnapshot,
    snapshotsLoaded,
    monthlySnapshotsLoaded
  });

  // Confirms before every save, since the comparison table is only
  // meaningful if the checkpoint is taken on a consistent day each month -
  // saving on the 3rd one month and the 27th the next would make a
  // "month-over-month" change look bigger/smaller than it really is.
  //
  // cashFlows (optional): { [category]: netAmount } declared by the user in
  // PortfolioAnalysisView.js's save form - net external deposits/purchases
  // (positive) or withdrawals/sales (negative) during this period, for
  // whatever the automatic contribution-adjustment can't see on its own
  // (see utils/monthlySnapshotComparison.js). Merged into snapshotBreakdown
  // under a reserved `cashFlows` key, right alongside the itemized
  // per-category data - no separate storage needed.
  //
  // asOfDate/breakdown come from the tracker's "נכון לתאריך" picker: the
  // figures for that day (see utils/snapshotAsOf.js), which the comparison
  // then measures from. Without them it is today's live figures, as before.
  // The total is the sum of the rows actually saved, so the two can never
  // disagree.
  const handleSaveMonthlySnapshot = (cashFlows, { asOfDate = null, breakdown = null } = {}) => {
    if (!portfolioReady) return;
    const day = asOfDate ? asOfDate.split('-').reverse().join('/') : 'היום';
    const ok = window.confirm(`השמירה החודשית תתעד את התיק כפי שהיה נכון ל-${day}. להמשיך?`);
    if (!ok) return;
    const rows = breakdown || snapshotBreakdown;
    const total = ['israeli', 'american', 'pension', 'cashFunds', 'bank', 'bankSavings'].reduce(
      (sum, key) => sum + (Array.isArray(rows[key]) ? rows[key].reduce((s, item) => s + (Number(item.value) || 0), 0) : 0),
      0
    );
    const withMeta = { ...rows, cashFlows: cashFlows || {}, ...(asOfDate ? { asOfDate } : {}) };
    saveMonthlySnapshot(breakdown ? total : analysis.summaryMetrics.overallTotalValueILS, withMeta);
  };


  const {
    targets: rebalanceTargets,
    loading: rebalanceTargetsLoading,
    saving: rebalanceSaving,
    saveError: rebalanceSaveError,
    saveTargets: saveRebalanceTargets
  } = useRebalanceTargets(user, authHeader);

  useEffect(() => {
    if (!user || !user.id) {
      setLegacyImportCompleted(false);
      return;
    }
    setLegacyImportCompleted(localStorage.getItem(legacyImportFlagKey(user.id)) === '1');
  }, [user]);






  // Every entry point opens the same form; see utils/assetEntry.js.
  const openAssetEntry = (initial = {}) => {
    setIsEditMode(false);
    setAssetEntry(initial);
  };
  const handleAddInfo = () => openAssetEntry({});

  // "+ רישום פעולה" on an account's ledger in the tables: the same form,
  // already pointed at that account.
  const TABLE_TO_ASSET_CLASS = { pension: 'pension', cash_fund: 'cashFunds', bank: 'bank', bank_savings: 'bankSavings' };
  const handleOpenLedgerEntry = (itemType, account) =>
    openAssetEntry({ assetClass: TABLE_TO_ASSET_CLASS[itemType] || itemType, assetId: account.id, action: 'DEPOSIT' });
  // A bookmarked/typed /add opens the form over the dashboard.
  useEffect(() => {
    if (activePage !== 'add') return;
    openAssetEntry({});
    navigate('home');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePage]);

  const handleLogout = async () => {
    await logout();
    resetPortfolio();
    setIsSamplePortfolio(false);
    navigate('home');
    setLegacyImportBanner('');
    // Signing back in is a new arrival, so the disclaimer is due again.
    setBetaNoticeAcknowledged(false);
    setOnboardingPending(false);
    try {
      sessionStorage.removeItem(ONBOARDING_KEY);
    } catch {
      /* ignore */
    }
  };

  // Every way of signing in ends here. meta.newUser: show the first-run
  // steps; meta.passwordWithheld: the address was verified, but competing
  // sign-ups left the account without a password to sign in with.
  const handleAuthenticated = (authenticatedUser, token, meta = {}) => {
    login(authenticatedUser, token);
    if (meta.newUser) {
      setOnboardingPending(true);
      try {
        sessionStorage.setItem(ONBOARDING_KEY, '1');
      } catch {
        /* ignore */
      }
    }
    if (meta.passwordWithheld) {
      toast.info('הכתובת אומתה. כדי להיכנס גם עם סיסמה, הגדירו אחת בהגדרות ← חשבון ואבטחה.');
    }
    try {
      const left = sessionStorage.getItem('afikinvest_backup_codes_left');
      if (left !== null) {
        sessionStorage.removeItem('afikinvest_backup_codes_left');
        toast.info(`נכנסתם עם קוד גיבוי. נותרו ${left} קודים - אפשר ליצור חדשים בהגדרות.`);
      }
    } catch {
      /* ignore */
    }
  };

  // A settings change that replaced the session (new password, 2FA on,
  // other devices signed out) or the user's flags (2FA off).
  const handleSessionChange = (changedUser, token) => {
    if (token) setAuthToken(token);
    if (changedUser) login(changedUser, token || undefined);
    accountState.refresh();
  };

  const closeOnboarding = () => {
    setOnboardingPending(false);
    try {
      sessionStorage.removeItem(ONBOARDING_KEY);
    } catch {
      /* ignore */
    }
    accountState.refresh();
  };

  const handleLoadSamplePortfolio = () => {
    replacePortfolio(buildSamplePortfolio());
    // Unsaved, so the save button offers to keep it - replacePortfolio
    // itself marks the portfolio as matching the server.
    setHasUnsavedChanges(true);
    setIsSamplePortfolio(true);
  };

  const handleSavePortfolio = async () => {
    if (await savePortfolio()) setIsSamplePortfolio(false);
  };

  // The ledger changes the portfolio ON THE SERVER (a sale reduces lots, a
  // withdrawal adds a ledger entry) in the same database transaction that
  // stores it. So unsaved edits go first - otherwise the server would apply
  // the transaction to a stale copy - and the copy the server returns then
  // replaces the one in memory.
  const {
    transactions,
    loading: transactionsLoading,
    preview: previewTransaction,
    record: recordTransaction,
    update: updateTransaction,
    remove: removeTransaction
  } = useTransactions(user, authHeader);

  const {
    alerts,
    unreadCount: unreadAlertCount,
    loading: alertsLoading,
    markRead: markAlertRead,
    markAllRead: markAllAlertsRead,
    loadCalendar,
    loadSettings: loadAlertSettings,
    saveSettings: saveAlertSettings,
    refreshNow: refreshAlertsNow
  } = useAlerts(user, authHeader);

  const { value: recommendationPrefs, save: saveRecommendationPrefs } = usePreferences(user, authHeader, 'recommendations');

  const adoptServerPortfolio = (portfolio) => {
    if (!portfolio) return;
    replacePortfolio({
      ...portfolio,
      israeliStocks: normalizeIsraeliStocksFromStorage(portfolio.israeliStocks || [])
    });
    setIsSamplePortfolio(false);
  };

  const saveBeforeLedgerChange = async () => {
    if (!hasUnsavedChanges) return true;
    return savePortfolio();
  };

  const handleRecordTransaction = async (tx) => {
    if (!(await saveBeforeLedgerChange())) return { ok: false, error: 'יש שינויים שלא נשמרו והשמירה נכשלה' };
    const result = await recordTransaction(tx);
    if (result.ok) adoptServerPortfolio(result.portfolio);
    return result;
  };

  // Editing a recorded transaction: undone and re-applied on the server in
  // one step (see server/transactionRoutes.js's PUT).
  const handleUpdateTransaction = async (id, tx) => {
    if (!(await saveBeforeLedgerChange())) return { ok: false, error: 'יש שינויים שלא נשמרו והשמירה נכשלה' };
    const result = await updateTransaction(id, tx);
    if (result.ok) adoptServerPortfolio(result.portfolio);
    return result;
  };

  // A statement value from the entry form - the same update the table's
  // "שווי נוכחי" edit makes (value + the date it is for).
  const ASSET_CLASS_TO_TABLE = { pension: 'pension', cashFunds: 'cash_fund', bank: 'bank' };
  const handleUpdateValueFromEntry = async ({ assetClass, assetId, value, date }) => {
    const list = { pension: pensionFunds, cashFunds, bank: bankBalances }[assetClass] || [];
    const account = list.find((a) => String(a.id) === String(assetId));
    if (!account || !Number.isFinite(value) || !date) return { ok: false, error: 'חסרים שווי או תאריך' };
    handleInlineEdit(account.id, 'currentValue', { value, date }, ASSET_CLASS_TO_TABLE[assetClass]);
    return { ok: true };
  };

  const handlePreviewTransaction = async (tx) => {
    if (!(await saveBeforeLedgerChange())) return { ok: false, error: 'יש שינויים שלא נשמרו והשמירה נכשלה' };
    return previewTransaction(tx);
  };

  const handleDeleteTransaction = async (id) => {
    if (!(await saveBeforeLedgerChange())) return { ok: false, error: 'יש שינויים שלא נשמרו והשמירה נכשלה' };
    const result = await removeTransaction(id);
    if (result.ok) adoptServerPortfolio(result.portfolio);
    return result;
  };

  const handleLegacyImportOnce = async () => {
    if (!user || legacyImportLoading) return;
    const snapshot = readLegacyPortfolioFromLocalStorage();
    if (!portfolioHasAnyRows(snapshot)) {
      window.alert('לא נמצאו נתונים ישנים בדפדפן (localStorage).');
      return;
    }
    const ok = window.confirm(
      'יובאו לתיק שלך בשרת הנתונים שנשמרו בעבר בדפדפן הזה.\n\n' +
        'אם כבר בנית תיק בשרת — הוא יוחלף במלואו בנתוני הייבוא.\n\n' +
        'להמשיך?'
    );
    if (!ok) return;

    setLegacyImportLoading(true);
    setLegacyImportBanner('');
    try {
      const r = await fetch(apiUrl('/api/portfolio'), {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({
          israeliStocks: snapshot.israeliStocks,
          americanStocks: snapshot.americanStocks,
          pensionFunds: snapshot.pensionFunds,
          bankBalances: snapshot.bankBalances,
          cashFunds: snapshot.cashFunds
        })
      });
      if (!r.ok) throw new Error('save failed');
      replacePortfolio(snapshot);
      clearLegacyPortfolioKeys();
      localStorage.setItem(legacyImportFlagKey(user.id), '1');
      setLegacyImportCompleted(true);
      setLegacyImportBanner('ייבוא מהדפדפן הושלם — הנתונים נשמרו בשרת.');
    } catch {
      window.alert('שמירת הייבוא נכשלה. נסה שוב או בדוק שהשרת רץ.');
    } finally {
      setLegacyImportLoading(false);
    }
  };

  const legacySnapshot = readLegacyPortfolioFromLocalStorage();
  const showLegacyImportButton =
    portfolioReady &&
    user &&
    !legacyImportCompleted &&
    portfolioHasAnyRows(legacySnapshot);

  // Single navigation entry point - SideNav, the dashboard's summary cards
  // and the pages' own back buttons all go through it.
  const handleNavigate = navigate;

  // פונקציה למחיקת מנייה
  const handleDelete = (id, exchange) => {
    if (exchange === 'israeli') {
      const updatedIsraeliStocks = israeliStocks.filter(stock => stock.id !== id);
      setIsraeliStocks(updatedIsraeliStocks);
      setHasUnsavedChanges(true);
    } else if (exchange === 'american') {
      const updatedAmericanStocks = americanStocks.filter(stock => stock.id !== id);
      setAmericanStocks(updatedAmericanStocks);
      setHasUnsavedChanges(true);
    } else if (exchange === 'pension') {
      const updatedPensionFunds = pensionFunds.filter(item => item.id !== id);
      setPensionFunds(updatedPensionFunds);
      setHasUnsavedChanges(true);
    } else if (exchange === 'bank') {
      const updatedBankBalances = bankBalances.filter(item => item.id !== id);
      setBankBalances(updatedBankBalances);
      setHasUnsavedChanges(true);
    } else if (exchange === 'cash_fund') {
      const updatedCashFunds = cashFunds.filter(item => item.id !== id);
      setCashFunds(updatedCashFunds);
      setHasUnsavedChanges(true);
    } else if (exchange === 'bank_savings') {
      const updatedBankSavingsFunds = bankSavingsFunds.filter(item => item.id !== id);
      setBankSavingsFunds(updatedBankSavingsFunds);
      setHasUnsavedChanges(true);
    }
  };


  // פונקציה לעריכה inline
  const handleInlineEdit = (id, field, value, exchange) => {
    console.log(`✏️ עריכה: ${field} = ${value} עבור מנייה ${id}`);
    if (exchange === 'israeli') {
      const updatedIsraeliStocks = israeliStocks.map(stock => 
        stock.id === id ? { ...stock, [field]: value } : stock
      );
      setIsraeliStocks(updatedIsraeliStocks);
      setHasUnsavedChanges(true);
    } else if (exchange === 'american') {
      const updatedAmericanStocks = americanStocks.map(stock => 
        stock.id === id ? { ...stock, [field]: value } : stock
      );
      setAmericanStocks(updatedAmericanStocks);
      setHasUnsavedChanges(true);
    } else if (exchange === 'pension') {
      const updatedPensionFunds = pensionFunds.map(item => {
        if (item.id !== id) return item;
        // כשמעדכנים את השווי הנוכחי, זו "סגירת תקופה": השווי הישן עובר
        // להיות "השווי הקודם" (עם התאריך הישן שלו). הפקדות שבוצעו בין
        // שני התאריכים מזוהות אוטומטית לפי הפנקס בזמן חישוב התשואה
        // (ראו calculatePensionPeriodReturn), לא כאן.
        // value מגיע כ-{ value, date } מדיאלוג העריכה ב-FinancialAccountsTables
        // (שמבקש את שניהם באותה פעולה, ראו applyLedgerValueEditPayload).
        return applyAccountFieldEdit(item, field, value);
      });
      setPensionFunds(updatedPensionFunds);
      setHasUnsavedChanges(true);
    } else if (exchange === 'bank') {
      // "שווי נוכחי" סוגר תקופה ו-deposits הוא הפנקס עצמו, ולכן שניהם
      // עוברים דרך applyAccountFieldEdit כמו בכל חשבון אחר - ראו ההערה
      // על exchange === 'pension' למעלה. שאר השדות מתעדכנים ישירות.
      const updatedBankBalances = bankBalances.map(item => {
        if (item.id !== id) return item;
        return applyAccountFieldEdit(item, field, value);
      });
      setBankBalances(updatedBankBalances);
      setHasUnsavedChanges(true);
    } else if (exchange === 'cash_fund') {
      const updatedCashFunds = cashFunds.map(item => {
        if (item.id !== id) return item;
        return applyAccountFieldEdit(item, field, value);
      });
      setCashFunds(updatedCashFunds);
      setHasUnsavedChanges(true);
    } else if (exchange === 'bank_savings') {
      const updatedBankSavingsFunds = bankSavingsFunds.map(item =>
        item.id === id ? applyAccountFieldEdit(item, field, value) : item
      );
      setBankSavingsFunds(updatedBankSavingsFunds);
      setHasUnsavedChanges(true);
    }
  };

  // פונקציה להתחלת עריכה inline
  const startInlineEdit = (id, field) => {
    setEditingField(`${id}-${field}`);
  };

  // פונקציה לסיום עריכה inline
  const finishInlineEdit = () => {
    setEditingField(null);
  };

  // פונקציה לטיפול בלחיצה על תא
  const handleCellClick = (id, field, exchange) => {
    if (isEditMode) {
      startInlineEdit(id, field);
    }
  };

  // פונקציה לטיפול בלחיצה על מקש Enter
  const handleKeyDown = (e, id, field, exchange) => {
    if (e.key === 'Enter') {
      finishInlineEdit();
    }
  };

  // Toggle expand/collapse of a grouped row (touches state, stays in App)
  const toggleGroup = (stockName, exchange) => {
    const key = `${exchange}-${stockName}`;
    setExpandedGroups(prev => ({
      ...prev,
      [key]: !prev[key]
    }));
  };


  // The terms and privacy pages read the same signed in or out.
  if (legalPath) {
    return (
      <div className="App">
        <LegalPage
          path={legalPath}
          onBack={() => {
            window.history.replaceState({}, '', '/');
            setLegalPath(null);
          }}
        />
      </div>
    );
  }

  if (authLoading) {
    return (
      <div className="App">
        <div className="auth-loading-wrap">
          <p className="auth-loading-text">טוען…</p>
        </div>
      </div>
    );
  }

  // Before the signed-in check: the link works whether or not this browser
  // has a session, and a reset revokes that session anyway.
  if (resetToken !== null) {
    const finishReset = async (notice) => {
      if (user) await handleLogout();
      window.history.replaceState({}, '', '/');
      setAuthNotice(notice);
      setResetToken(null);
    };
    return (
      <div className="App">
        <div className="auth-theme-toggle-wrap">
          <ThemeToggleButton theme={theme} onToggleTheme={toggleTheme} />
        </div>
        <ResetPasswordView token={resetToken} onDone={finishReset} />
      </div>
    );
  }

  // A link from an email, or the return from Google/Facebook: one call,
  // then the app (signed in, or at the step still missing).
  if (accountLink) {
    return (
      <div className="App">
        <div className="auth-theme-toggle-wrap">
          <ThemeToggleButton theme={theme} onToggleTheme={toggleTheme} />
        </div>
        <AccountLinkView
          link={accountLink}
          onAuthenticated={(u, token, meta) => {
            handleAuthenticated(u, token, meta);
            window.history.replaceState({}, '', '/');
            setAccountLink(null);
          }}
          onDone={() => {
            window.history.replaceState({}, '', '/');
            setAccountLink(null);
          }}
        />
      </div>
    );
  }

  if (!user) {
    // Links in emails open the right tab: ?mode=forgot, ?mode=register.
    const modeParam = new URLSearchParams(window.location.search).get('mode');
    const initialMode = ['forgot', 'register', 'login', 'magic'].includes(modeParam) ? modeParam : authNotice ? 'login' : 'register';
    return (
      <div className="App">
        <div className="auth-theme-toggle-wrap">
          <ThemeToggleButton theme={theme} onToggleTheme={toggleTheme} />
        </div>
        <AuthView key={authNotice} onAuthenticated={handleAuthenticated} initialMode={initialMode} initialNotice={authNotice} />
      </div>
    );
  }

  if (!portfolioReady) {
    return (
      <div className="App">
        <div className="auth-loading-wrap">
          <p className="auth-loading-text">טוען את תיק ההשקעות מהשרת…</p>
        </div>
      </div>
    );
  }

  const summary = calculatePortfolioSummary(
    israeliStocks,
    americanStocks,
    pensionFunds,
    cashFunds,
    bankBalances,
    { currentIndex: cpi.currentIndex, indexByMonth: cpi.indexByMonth },
    bankSavingsFunds
  );

  // The holdings themselves, plus the shared cell-editing machinery every
  // table uses. Bundled rather than listed per page: each asset page takes
  // the same set and renders the slice it is about, so a new one does not
  // mean re-threading twenty props by hand.
  const holdings = {
    israeliStocks,
    americanStocks,
    pensionFunds,
    cashFunds,
    bankBalances,
    bankSavingsFunds
  };

  const tableProps = {
    ...holdings,
    summary,
    cpi,
    isEditMode,
    setIsEditMode,
    showAmericanColumns,
    setShowAmericanColumns,
    expandedGroups,
    editingField,
    handleCellClick,
    handleInlineEdit,
    finishInlineEdit,
    handleKeyDown,
    handleDelete,
    toggleGroup,
    onOpenLedgerEntry: handleOpenLedgerEntry,
    onDeleteTransaction: handleDeleteTransaction,
    transactions,
    onUpdateTransaction: handleUpdateTransaction
  };

  // THE EXPORT IS ALWAYS THE WHOLE PORTFOLIO.
  //
  // Built here, once, and handed to every page. Each page used to pass
  // its own slice instead - the US page sent only americanStocks, the
  // three ledger pages sent no shares at all - so which button you
  // happened to press decided what the report contained. Exporting from
  // the provident-funds page produced a "portfolio report" with both
  // stock markets silently missing from it.
  //
  // A report that names itself after the portfolio has to be the
  // portfolio, so the page it was triggered from is not an input to it.
  const exportPortfolioData = { summary, ...holdings };

  // Save state, import state and the price-refresh indicator - everything
  // PortfolioActionsToolbar shows, on whichever page is showing it.
  const toolbarProps = {
    exportPortfolioData,
    showLegacyImportButton,
    legacyImportLoading,
    handleLegacyImportOnce,
    savePortfolio: handleSavePortfolio,
    hasUnsavedChanges,
    saveLoading,
    lastSavedAt,
    saveError,
    snapshotSaveError,
    lastSnapshotSavedAt,
    legacyImportBanner,
    handleAddInfo,
    pricesRefreshing,
    pricesLastRefreshAt,
    hasLoadedLivePrices
  };

  // One page per route. The shell is rendered once, around whichever page
  // the URL names, rather than repeated inside every branch.
  const renderPage = () => {
    switch (activePage) {
      case 'israeli-stocks':
        return <IsraeliStocksPage {...tableProps} {...toolbarProps} />;

      case 'us-stocks':
        return <UsStocksPage {...tableProps} {...toolbarProps} />;

      case 'provident-funds':
        return <ProvidentFundsPage {...tableProps} {...toolbarProps} />;

      case 'cash-and-checking':
        return <CashAndCheckingPage {...tableProps} {...toolbarProps} />;

      case 'bank-savings':
        return <BankSavingsPage {...tableProps} {...toolbarProps} />;

      case 'monthly-tracker':
        return (
          <MonthlyTrackerView
            {...holdings}
            transactions={transactions}
            liveBreakdown={snapshotBreakdown}
            formatPriceWithSign={formatPriceWithSign}
            monthlySnapshots={monthlySnapshots}
            monthlySnapshotsLoading={monthlySnapshotsLoading}
            onSaveMonthlySnapshot={handleSaveMonthlySnapshot}
            savingMonthly={savingMonthly}
            saveMonthlyError={saveMonthlyError}
            onUpdateMonthlySnapshot={updateMonthlySnapshot}
            updatingMonth={updatingMonth}
            updateMonthlyError={updateMonthlyError}
            onDeleteMonthlySnapshot={deleteMonthlySnapshot}
            deletingMonth={deletingMonth}
            deleteMonthlyError={deleteMonthlyError}
            onAddManualMonthlySnapshot={addManualMonthlySnapshot}
            addingManual={addingManual}
            addManualError={addManualError}
          />
        );

      case 'tax-offset':
        return (
          <TaxOffsetView
            israeliStocks={israeliStocks}
            americanStocks={americanStocks}
            pensionFunds={pensionFunds}
            bankSavingsFunds={bankSavingsFunds}
            cpi={cpi}
            formatPriceWithSign={formatPriceWithSign}
          />
        );

      case 'valuation':
        return <ValuationView americanStocks={americanStocks} />;

      case 'recommendations':
        return (
          <RecommendationsView
            {...holdings}
            analysis={analysis}
            rebalanceTargets={rebalanceTargets}
            cpi={cpi}
            transactions={transactions}
            savedPrefs={recommendationPrefs}
            onSavePrefs={saveRecommendationPrefs}
            formatPriceWithSign={formatPriceWithSign}
          />
        );

      case 'alerts':
        return (
          <AlertsView
            alerts={alerts}
            unreadCount={unreadAlertCount}
            alertsLoading={alertsLoading}
            onMarkRead={markAlertRead}
            onMarkAllRead={markAllAlertsRead}
            loadCalendar={loadCalendar}
            loadSettings={loadAlertSettings}
            saveSettings={saveAlertSettings}
            refreshNow={refreshAlertsNow}
            formatPriceWithSign={formatPriceWithSign}
          />
        );

      case 'settings':
      case 'security':
        return (
          <SettingsView
            user={user}
            initialSection={activePage === 'security' ? 'security' : null}
            accountState={accountState}
            theme={theme}
            onToggleTheme={toggleTheme}
            onSessionChange={handleSessionChange}
            onLogout={handleLogout}
          />
        );

      case 'transactions':
        return (
          <TransactionsView
            {...holdings}
            transactions={transactions}
            transactionsLoading={transactionsLoading}
            onNewTransaction={() => openAssetEntry({})}
            onEditTransaction={(tx) => openAssetEntry({ transaction: tx })}
            onDeleteTransaction={handleDeleteTransaction}
            cpi={cpi}
            formatPriceWithSign={formatPriceWithSign}
          />
        );

      case 'analytics':
        return (
          <PortfolioAnalysisView
            {...holdings}
            transactions={transactions}
            theme={theme}
            analysis={analysis}
            formatPriceWithSign={formatPriceWithSign}
            cpi={cpi}
            rebalanceTargets={rebalanceTargets}
            rebalanceTargetsLoading={rebalanceTargetsLoading}
            rebalanceSaving={rebalanceSaving}
            rebalanceSaveError={rebalanceSaveError}
            onSaveRebalanceTargets={saveRebalanceTargets}
          />
        );

      default:
        return (
          <HomeView
            {...holdings}
            {...toolbarProps}
            summary={summary}
            onNavigate={navigate}
            onLoadSamplePortfolio={handleLoadSamplePortfolio}
            isSamplePortfolio={isSamplePortfolio}
            mainCurrency={investments.mainCurrency || 'ILS'}
            fxRate={fxRate}
          />
        );
    }
  };

  const extra = (account && account.profile && account.profile.extra) || {};
  const needsTerms = Boolean(account && account.needsTerms);
  const showOnboarding = Boolean(account && onboardingPending && !needsTerms && !extra.onboardingDone && betaNoticeAcknowledged);
  const completion = account ? profileCompletion(account.profile, Boolean(accountState.avatar)) : 100;
  const showProfilePrompt = Boolean(account && activePage === 'home' && extra.onboardingDone && !extra.profilePromptDismissed && completion < 50);
  const dismissProfilePrompt = async () => {
    await putAccount('/api/account/profile/extra', { profilePromptDismissed: true });
    accountState.refresh();
  };

  return (
    <PrivacyContext.Provider value={{ hideAmounts: accountState.hideAmounts, toggle: () => accountState.setHideAmounts(!accountState.hideAmounts) }}>
      {/* Rendered outside the shell, over everything, and before the page
          is usable - it states what must not be typed into the system, so
          it has to arrive ahead of the screens that invite typing. */}
      {!betaNoticeAcknowledged && (
        <BetaNoticeModal onAcknowledge={() => setBetaNoticeAcknowledged(true)} />
      )}
      {/* A new Google/Facebook account accepts the terms before anything else. */}
      {needsTerms && betaNoticeAcknowledged ? <TermsGate onAccepted={() => accountState.refresh()} onLogout={handleLogout} /> : null}
      {showOnboarding ? (
        <OnboardingModal
          displayName={accountState.displayName}
          onClose={closeOnboarding}
          onAddInvestment={handleAddInfo}
          onLoadDemo={handleLoadSamplePortfolio}
          onCurrency={(mainCurrency) => accountState.saveInvestments({ ...investments, mainCurrency })}
        />
      ) : null}
      <AppShell
        activePage={activePage}
        onNavigate={handleNavigate}
        user={user}
        onLogout={handleLogout}
        theme={theme}
        onToggleTheme={toggleTheme}
        badges={{ alerts: unreadAlertCount }}
        displayName={accountState.displayName}
        avatar={accountState.avatar}
      >
        {showProfilePrompt ? <ProfilePrompt completion={completion} onComplete={() => navigate('settings')} onDismiss={dismissProfilePrompt} /> : null}
        {/* Only the lazily-loaded pages ever suspend; the dashboard is in the
            initial bundle and renders straight through this. */}
        <Suspense
          fallback={
            <div className="page-loading-wrap">
              <p className="auth-loading-text">טוען…</p>
            </div>
          }
        >
          {renderPage()}
        </Suspense>
      </AppShell>
      {/* The one entry form, over whichever page opened it. */}
      {assetEntry && (
        <AssetEntryModal
          initial={assetEntry}
          holdings={holdings}
          onClose={() => setAssetEntry(null)}
          onRecordTransaction={handleRecordTransaction}
          onUpdateTransaction={handleUpdateTransaction}
          onPreviewTransaction={handlePreviewTransaction}
          onUpdateValue={handleUpdateValueFromEntry}
          defaultFees={{ ILS: investments.defaultFeeIls, USD: investments.defaultFeeUsd }}
        />
      )}
    </PrivacyContext.Provider>
  );
}

export default App;