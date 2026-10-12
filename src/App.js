import './App.css';
import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { formatPriceWithSign, normalizeIsraeliStocksFromStorage } from './utils/formatters';
import { calculatePortfolioSummary } from './utils/portfolioSummary';
import { applyLedgerValueEditPayload } from './utils/portfolioMath';
import { calculatePortfolioAnalysis } from './utils/portfolioAnalysis';
import {
  fetchCurrentPrice,
  fetchIsraeliStockPrice,
  fetchHistoricalExchangeRate,
  fetchIsraeliSecurityMeta
} from './api/stockPrices';
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
import { useTheme } from './hooks/useTheme';
import { monthKeyFromDate } from './utils/cpiTax';
import { useRoute } from './hooks/useRoute';
import { findExistingAccount, applyLiquidAccountTransaction } from './utils/assetEntry';
import HomeView from './components/HomeView';
import AuthView from './components/AuthView';
import AppShell from './components/AppShell';
import ThemeToggleButton from './components/ThemeToggleButton';
import BetaNoticeModal from './components/BetaNoticeModal';

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
const StockFormView = lazy(() => import('./components/StockFormView'));
const PortfolioAnalysisView = lazy(() => import('./components/PortfolioAnalysisView'));
const MonthlyTrackerView = lazy(() => import('./components/MonthlyTrackerView'));
const TaxOffsetView = lazy(() => import('./components/TaxOffsetView'));
const IsraeliStocksPage = lazy(() => import('./components/pages/IsraeliStocksPage'));
const UsStocksPage = lazy(() => import('./components/pages/UsStocksPage'));
const ProvidentFundsPage = lazy(() => import('./components/pages/ProvidentFundsPage'));
const CashAndCheckingPage = lazy(() => import('./components/pages/CashAndCheckingPage'));
const BankSavingsPage = lazy(() => import('./components/pages/BankSavingsPage'));

const LEGACY_KEYS = [
  'israeliStocks',
  'americanStocks',
  'pensionFunds',
  'bankBalances',
  'cashFunds'
];

function legacyImportFlagKey(userId) {
  return `stockview_legacy_import_done_${userId}`;
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

// The add form's blank state.
const EMPTY_FORM = {
  itemType: 'stock',
  stockName: '',
  officialName: '',
  securityType: '',
  securitySubType: '',
  branch: '',
  isFund: false,
  isForeignETF: false,
  securityId: '',
  purchaseDate: '',
  purchasePrice: '',
  initialInvestment: '',
  currentValue: '',
  previousValue: '',
  currentValueDate: '',
  previousValueDate: '',
  quantity: '',
  exchange: 'israeli',
  exchangeRate: '',
  investmentTrack: '',
  interestRate: '',
  isLinkedToIndex: false
};

function App() {
  const { user, authLoading, authHeader, login, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
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
  const [isAddingNewStock, setIsAddingNewStock] = useState(false);
  const [formData, setFormData] = useState({
    itemType: 'stock',
    stockName: '',
    // Resolved from the TASE security lookup when a holding is picked in
    // the search box (see handleSelectIsraeliStock) - the official name
    // plus the classification fields that make the foreign-asset/sector
    // columns automatic. Israeli holdings only; blank for everything else.
    officialName: '',
    securityType: '',
    securitySubType: '',
    branch: '',
    isFund: false,
    isForeignETF: false,
    securityId: '',
    purchaseDate: '',
    purchasePrice: '',
    initialInvestment: '',
    currentValue: '',
    previousValue: '',
    currentValueDate: '',
    previousValueDate: '',
    quantity: '',
    exchange: 'israeli',
    exchangeRate: '',
    investmentTrack: '',
    interestRate: '',
    isLinkedToIndex: false
  });
  // State for fillHistoricalExchangeRate (auto-filling the exchange-rate
  // field from the real USD/ILS rate on the purchase date) - the manual
  // input only ever shows once exchangeRateNotFound is true, i.e. the
  // automatic lookup genuinely came back empty for that date.
  const [exchangeRateFetching, setExchangeRateFetching] = useState(false);
  const [exchangeRateNotFound, setExchangeRateNotFound] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [editingStock, setEditingStock] = useState(null);
  const [showAmericanColumns, setShowAmericanColumns] = useState(true);
  const [editingField, setEditingField] = useState(null);
  const [expandedGroups, setExpandedGroups] = useState({});

  // The beta/security disclaimer (see BetaNoticeModal.js). Plain component
  // state, not localStorage: it is meant to be seen on every arrival -
  // each login and each refresh - so there is deliberately nothing here
  // that outlives the page.
  const [betaNoticeAcknowledged, setBetaNoticeAcknowledged] = useState(false);

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
    firstCycleComplete: firstPriceCycleComplete && portfolioReady,
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
  const handleSaveMonthlySnapshot = (cashFlows) => {
    if (!portfolioReady) return;
    const ok = window.confirm(
      'שימו לב: על מנת שהנתונים יהיו רלוונטיים ומדויקים עבור המעקב, מומלץ לבצע את השמירה תמיד בתאריך קבוע בחודש (לדוגמה, ב-10 לחודש).'
    );
    if (!ok) return;
    const breakdownWithCashFlows = { ...snapshotBreakdown, cashFlows: cashFlows || {} };
    saveMonthlySnapshot(analysis.summaryMetrics.overallTotalValueILS, breakdownWithCashFlows);
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






  const handleAddInfo = () => {
    setIsEditMode(false);
    setEditingStock(null);
    setIsAddingNewStock(true);
    navigate('add');
  };

  // "+ רישום הפקדה/משיכה" on an account's ledger in the tables. Opens the
  // same add form, already pointed at that account - recording a
  // transaction from the table and from the toolbar is one form and one
  // submit path (see utils/assetEntry.js), not two that could drift.
  const handleRecordTransaction = (itemType, account) => {
    setIsEditMode(false);
    setEditingStock(null);
    setFormData({
      ...EMPTY_FORM,
      itemType,
      stockName: account.fundName || '',
      securityId: account.securityId || '',
      // A bank-savings deposit form requires these; an existing fund keeps
      // its own regardless, so they are only there to let the form submit.
      investmentTrack: account.investmentTrack || '',
      interestRate: account.interestRate != null ? String(account.interestRate) : '',
      isLinkedToIndex: !!account.isLinkedToIndex
    });
    setIsAddingNewStock(true);
    navigate('add');
  };

  const handleLogout = async () => {
    await logout();
    resetPortfolio();
    navigate('home');
    setLegacyImportBanner('');
    // Signing back in is a new arrival, so the disclaimer is due again.
    setBetaNoticeAcknowledged(false);
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

  // Auto-fills the exchange-rate field from the real USD/ILS rate on the
  // stock's purchase date, instead of requiring the user to look it up and
  // type it in - the manual input only appears at all once this genuinely
  // can't find a rate (exchangeRateNotFound), not as a default option.
  const fillHistoricalExchangeRate = async (dateStr) => {
    setExchangeRateFetching(true);
    setExchangeRateNotFound(false);
    try {
      const rate = await fetchHistoricalExchangeRate(dateStr);
      if (rate !== null) {
        // Yahoo returns full floating-point precision (e.g.
        // 3.8533899784088135) - rounded to 4 decimals to match this
        // field's own step, so a later manual edit (or the browser's
        // native number-input validation on submit) doesn't choke on a
        // "3.8533899784088135 isn't a multiple of step 0.0001" mismatch.
        setFormData(prev => ({ ...prev, exchangeRate: rate.toFixed(4) }));
      } else {
        setExchangeRateNotFound(true);
      }
    } finally {
      setExchangeRateFetching(false);
    }
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value,
      // A manual edit of the raw TASE id field invalidates any name
      // already resolved via the search box below it (see
      // handleSelectIsraeliStock) - the two would otherwise silently drift
      // out of sync (an id that no longer matches the displayed name).
      // A manual edit of the raw id invalidates the whole resolved
      // identity, classification included - not just the name.
      ...(name === 'stockName'
        ? { officialName: '', securityType: '', securitySubType: '', branch: '', isFund: false, isForeignETF: false }
        : {})
    }));
  };

  // Called when the user picks a suggestion from StockFormView's Israeli-
  // stock name search (see useIsraeliStockSearch.js) - fills both the
  // numeric TASE id (stockName, unchanged everywhere else it's used - the
  // scraper, price refresh, distribution grouping all still key off it)
  // and the newly-resolved official company name in one update, instead of
  // two separate handleInputChange calls that could otherwise render a
  // stock with only one of the two set if something went wrong in between.
  // Also pulls the security's full classification metadata from the
  // exchange (instrument type, branch, foreign-ETF flag) and parks it on
  // formData, so the holding is stored already classified. That is what
  // makes the "נכס זר?" column unnecessary and the sector column automatic
  // (see utils/israeliEtfClassifier.js): the answers come from the
  // exchange's own description of the security instead of from the user.
  // Best-effort - a failed lookup just leaves the holding with the name and
  // id, which still classifies by name alone.
  const handleSelectIsraeliStock = async (result) => {
    setFormData(prev => ({
      ...prev,
      stockName: result.securityId,
      officialName: result.officialName,
      securityType: result.securityType || '',
      branch: result.branch || '',
      isFund: result.isFund === true,
      isForeignETF: result.isForeignETF === true
    }));

    const meta = await fetchIsraeliSecurityMeta(result.securityId);
    if (!meta) return;
    setFormData(prev =>
      // Guard against a slow lookup landing after the user has already
      // moved on to a different security.
      prev.stockName !== result.securityId
        ? prev
        : {
            ...prev,
            officialName: meta.officialName || prev.officialName,
            securityType: meta.securityType || '',
            securitySubType: meta.securitySubType || '',
            branch: meta.branch || '',
            isFund: meta.isFund === true,
            isForeignETF: meta.isForeignETF === true
          }
    );
  };

  // Triggers fillHistoricalExchangeRate whenever the combination that
  // makes it meaningful becomes true (stock + American exchange + a
  // purchase date) - a useEffect rather than hand-wiring the fetch into
  // handleInputChange's purchaseDate/exchange branches specifically, so it
  // fires no matter which order the user fills the two fields in (date
  // first, then exchange - or the other way around), instead of only
  // covering the two orderings that were explicitly coded for. lastFetchKeyRef
  // avoids re-fetching for the exact same date if the user just toggles
  // exchange back and forth without actually changing the date.
  const lastAutoFetchKeyRef = useRef(null);
  useEffect(() => {
    if (formData.itemType !== 'stock' || formData.exchange !== 'american' || !formData.purchaseDate) {
      lastAutoFetchKeyRef.current = null;
      return;
    }
    if (lastAutoFetchKeyRef.current === formData.purchaseDate) return;
    lastAutoFetchKeyRef.current = formData.purchaseDate;
    fillHistoricalExchangeRate(formData.purchaseDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.itemType, formData.exchange, formData.purchaseDate]);

  // Explicit manual trigger (a button next to the field) alongside the
  // automatic effect above - always available as a reliable fallback if
  // the automatic fetch didn't land for any reason (a network hiccup, or
  // the user changing the date faster than the request could resolve).
  const handlePullExchangeRate = () => {
    if (formData.purchaseDate) fillHistoricalExchangeRate(formData.purchaseDate);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    console.log('🚀 handleSubmit נקרא!');
    console.log('📝 נתוני הטופס:', formData);
    
    // קבלת מחיר נוכחי ואחוז שינוי יומי מ-API
    let currentPrice = 0;
    let dailyChangePercent = 0;
    // The session that change is from (see utils/marketSession.js).
    let dailyChangeTradeDate = null;
    // Classification metadata resolved from the exchange for an Israeli
    // holding whose id was typed rather than picked from the search box.
    let israeliMeta = null;
    
    if (formData.exchange === 'american') {
      const priceData = await fetchCurrentPrice(formData.stockName.trim());
      if (priceData) {
        currentPrice = priceData.currentPrice || 0;
        dailyChangePercent = priceData.changePercent || 0;
        dailyChangeTradeDate = priceData.tradeDate || null;
      }
    } else if (formData.exchange === 'israeli') {
      const stockId = formData.stockName.trim();
      // Price and classification metadata are independent lookups, so they
      // run concurrently rather than one after the other.
      const [priceData, meta] = await Promise.all([
        fetchIsraeliStockPrice(stockId),
        // Only needed when the id was typed directly instead of picked from
        // the search box (which already resolved it, see
        // handleSelectIsraeliStock) - this is the path that used to leave a
        // holding with nothing but a number.
        formData.officialName ? Promise.resolve(null) : fetchIsraeliSecurityMeta(stockId)
      ]);
      if (priceData && priceData.currentPrice !== null) {
        const normalizedPrice = priceData.currentPrice / 100; // המרה מאגורות לשקלים
        currentPrice = normalizedPrice;
        dailyChangePercent = priceData.changePercent || 0;
        dailyChangeTradeDate = priceData.tradeDate || null;
      }
      if (meta) israeliMeta = meta;
      // אם לא מתקבל מחיר, המחיר נשאר 0 (כפי שהוגדר בתחילת הפונקציה)
    }
    
    // יצירת ושמירת אובייקט לפי סוג פריט
    if (formData.itemType === 'stock') {
      const stockData = {
        id: Date.now(),
        stockName: formData.stockName,
        // Only meaningful (and only ever set) for Israeli stocks, resolved
        // via the search box in StockFormView - '' for anything picked
        // via the raw-id fallback path, same as legacy holdings that
        // predate this field, so display code must treat it as optional.
        officialName:
          formData.exchange === 'israeli'
            ? formData.officialName || (israeliMeta && israeliMeta.officialName) || ''
            : '',
        purchaseDate: formData.purchaseDate,
        purchasePrice: parseFloat(formData.purchasePrice),
        quantity: parseInt(formData.quantity),
        exchangeRate: formData.exchange === 'american' ? parseFloat(formData.exchangeRate) : null,
        currentPrice: currentPrice,
        dailyChangePercent: dailyChangePercent,
        dailyChangeTradeDate,
        // Classification fields, Israeli holdings only - what makes the
        // foreign-asset and sector columns automatic (see
        // utils/israeliEtfClassifier.js). All optional: a holding saved
        // before this existed simply classifies by name alone, which is
        // why nothing downstream may assume they're present.
        ...(formData.exchange === 'israeli'
          ? {
              securityType: formData.securityType || (israeliMeta && israeliMeta.securityType) || '',
              securitySubType:
                formData.securitySubType || (israeliMeta && israeliMeta.securitySubType) || '',
              branch: formData.branch || (israeliMeta && israeliMeta.branch) || '',
              isFund: formData.isFund === true || Boolean(israeliMeta && israeliMeta.isFund),
              isForeignETF:
                formData.isForeignETF === true || Boolean(israeliMeta && israeliMeta.isForeignETF)
            }
          : {})
      };
      console.log('💾 שומר מנייה/כספית חדשה:', stockData);
      if (formData.exchange === 'israeli') {
        const updatedIsraeliStocks = [...israeliStocks, stockData];
        setIsraeliStocks(updatedIsraeliStocks);
        setHasUnsavedChanges(true);
      } else {
        const updatedAmericanStocks = [...americanStocks, stockData];
        setAmericanStocks(updatedAmericanStocks);
        setHasUnsavedChanges(true);
      }
    } else if (formData.itemType === 'cash_fund') {
      // בדיוק כמו קופת גמל: מתקבצים אוטומטית לפי מפתח זהה (כאן - מספר
      // נייר הערך, לא השם, כי השם אופציונלי) בלי לבחור "חדש/קיים". סכום
      // שלילי = משיכה (ראו הערת ה-help בטופס) - הנוסחאות ב-portfolioMath.js
      // agnostic לסימן.
      const depositAmount = parseFloat(formData.purchasePrice) || 0;
      const depositDate = formData.purchaseDate;
      const trimmedSecurityId = (formData.securityId || '').trim();
      // Same rule the form previews (see utils/assetEntry.js).
      const existingFund = findExistingAccount('cash_fund', formData, { cashFunds });

      if (existingFund) {
        const updatedCashFunds = cashFunds.map((fund) =>
          fund.id === existingFund.id ? applyLiquidAccountTransaction(fund, depositAmount, depositDate) : fund
        );
        setCashFunds(updatedCashFunds);
        setHasUnsavedChanges(true);
      } else {
        const cashItem = {
          id: Date.now(),
          fundName: (formData.stockName || '').trim(),
          securityId: trimmedSecurityId,
          currentValue: depositAmount,
          currentValueDate: depositDate,
          previousValue: 0,
          previousValueDate: '',
          deposits: [{ date: depositDate, amount: depositAmount }],
          amount: depositAmount
        };
        const updatedCashFunds = [...cashFunds, cashItem];
        setCashFunds(updatedCashFunds);
        setHasUnsavedChanges(true);
      }
    } else if (formData.itemType === 'pension') {
      // בדיוק כמו מניות: מתקבצים אוטומטית לפי שם זהה, בלי לבחור "חדש/קיים".
      const depositAmount = parseFloat(formData.initialInvestment) || 0;
      const depositDate = formData.purchaseDate;
      const trimmedName = (formData.stockName || '').trim();
      // Same rule the form previews (see utils/assetEntry.js) - whitespace and
      // letter case don't make a second fund.
      const existingFund = findExistingAccount('pension', formData, { pensionFunds });

      if (existingFund) {
        // קופה קיימת עם אותו שם בדיוק: מוסיפים שורה חדשה לפנקס ההפקדות
        // שלה בלבד. currentValue/previousValue של הקופה
        // הקיימת לא משתנים (אלה מתעדכנים בנפרד דרך הטבלה, לא כאן).
        const updatedPensionFunds = pensionFunds.map((fund) =>
          fund.id === existingFund.id
            ? { ...fund, deposits: [...(Array.isArray(fund.deposits) ? fund.deposits : []), { date: depositDate, amount: depositAmount }] }
            : fund
        );
        setPensionFunds(updatedPensionFunds);
        setHasUnsavedChanges(true);
      } else {
        // שם חדש: פותחים קופה חדשה. "שווי נוכחי" מתחיל שווה לסכום
        // ההפקדה (עדיין לא הספיק לצמוח/לרדת) - בדיוק כמו שמחיר מניה
        // מתחיל שווה למחיר הקנייה עד לעדכון הראשון. אפשר (וכדאי) לעדכן
        // את זה בהמשך דרך הטבלה כשיש שווי אמיתי ועדכני.
        const pensionItem = {
          id: Date.now(),
          fundName: trimmedName,
          currentValue: depositAmount,
          currentValueDate: depositDate,
          previousValue: 0,
          previousValueDate: '',
          deposits: [{ date: depositDate, amount: depositAmount }],
          amount: depositAmount
        };
        const updatedPensionFunds = [...pensionFunds, pensionItem];
        setPensionFunds(updatedPensionFunds);
        setHasUnsavedChanges(true);
      }
    } else if (formData.itemType === 'bank') {
      // עו"ש - חשבון יחיד (אין שדה שם בטופס): הפקדה/משיכה מצטרפת תמיד
      // לחשבון הקיים (הראשון במערך) אם יש כזה, כמו הפקדה נוספת לקופת
      // גמל קיימת. סכום שלילי = משיכה.
      const depositAmount = parseFloat(formData.purchasePrice) || 0;
      const depositDate = formData.purchaseDate;
      const existingAccount = bankBalances[0];

      if (existingAccount) {
        // The balance moves with the movement - see applyLiquidAccountTransaction.
        const updatedBankBalances = bankBalances.map((account, index) =>
          index === 0 ? applyLiquidAccountTransaction(account, depositAmount, depositDate) : account
        );
        setBankBalances(updatedBankBalances);
        setHasUnsavedChanges(true);
      } else {
        const bankItem = {
          id: Date.now(),
          updateDate: depositDate,
          currentValue: depositAmount,
          currentValueDate: depositDate,
          previousValue: 0,
          previousValueDate: '',
          deposits: [{ date: depositDate, amount: depositAmount }],
          amount: depositAmount
        };
        const updatedBankBalances = [...bankBalances, bankItem];
        setBankBalances(updatedBankBalances);
        setHasUnsavedChanges(true);
      }
    } else if (formData.itemType === 'bank_savings') {
      // בדיוק כמו קופת גמל: מתקבצים אוטומטית לפי שם זהה, בלי לבחור "חדש/קיים".
      const depositAmount = parseFloat(formData.initialInvestment) || 0;
      const depositDate = formData.purchaseDate;
      const trimmedName = (formData.stockName || '').trim();
      const existingFund = findExistingAccount('bank_savings', formData, { bankSavingsFunds });

      if (existingFund) {
        // קופה קיימת עם אותו שם בדיוק: מוסיפים שורה חדשה לפנקס ההפקדות
        // שלה בלבד. מסלול ההשקעה/ריבית/צמידות למדד של הקופה הקיימת לא
        // משתנים כאן (אלה מתעדכנים בנפרד דרך הטבלה).
        const updatedBankSavingsFunds = bankSavingsFunds.map((fund) =>
          fund.id === existingFund.id
            ? { ...fund, deposits: [...(Array.isArray(fund.deposits) ? fund.deposits : []), { date: depositDate, amount: depositAmount }] }
            : fund
        );
        setBankSavingsFunds(updatedBankSavingsFunds);
        setHasUnsavedChanges(true);
      } else {
        const bankSavingsItem = {
          id: Date.now(),
          fundName: trimmedName,
          investmentTrack: formData.investmentTrack,
          interestRate: parseFloat(formData.interestRate) || 0,
          isLinkedToIndex: !!formData.isLinkedToIndex,
          deposits: [{ date: depositDate, amount: depositAmount }]
        };
        const updatedBankSavingsFunds = [...bankSavingsFunds, bankSavingsItem];
        setBankSavingsFunds(updatedBankSavingsFunds);
        setHasUnsavedChanges(true);
      }
    }

    navigate('home');
    setIsAddingNewStock(false);
    
    // איפוס הטופס
    setFormData({
      itemType: 'stock',
      stockName: '',
      officialName: '',
      securityType: '',
      securitySubType: '',
      branch: '',
      isFund: false,
      isForeignETF: false,
      securityId: '',
      purchaseDate: '',
      purchasePrice: '',
      initialInvestment: '',
      currentValue: '',
      previousValue: '',
    currentValueDate: '',
    previousValueDate: '',
      quantity: '',
      exchange: 'israeli',
      exchangeRate: '',
      investmentTrack: '',
      interestRate: '',
      isLinkedToIndex: false
    });
  };

  const handleBackToHome = () => {
    navigate('home');
  };

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


  // פונקציה לשמירת עריכה
  const handleSaveEdit = async () => {
    if (!formData.stockName || !formData.purchasePrice || !formData.quantity || !formData.purchaseDate) {
      alert('אנא מלא את כל השדות');
      return;
    }
    
    if (!editingStock) {
      alert('שגיאה: לא נמצאה מנייה לעריכה');
      return;
    }
    
    let currentPrice = editingStock.currentPrice;
    let dailyChangePercent = editingStock.dailyChangePercent;
    let dailyChangeTradeDate = editingStock.dailyChangeTradeDate || null;

    if (formData.exchange === 'american') {
      const priceData = await fetchCurrentPrice(formData.stockName.trim());
      if (priceData) {
        currentPrice = priceData.currentPrice || 0;
        dailyChangePercent = priceData.changePercent || 0;
        dailyChangeTradeDate = priceData.tradeDate || null;
      }
    } else if (formData.exchange === 'israeli') {
      // מנייה ישראלית - שומרים את המחיר הנוכחי ואחוז השינוי הקיימים
      // currentPrice ו-dailyChangePercent כבר מוגדרים מהערכים הקיימים
    }
    
    const updatedStock = {
      ...editingStock,
      stockName: formData.stockName,
      purchasePrice: parseFloat(formData.purchasePrice),
      quantity: parseInt(formData.quantity),
      purchaseDate: formData.purchaseDate,
      currentPrice: currentPrice,
      dailyChangePercent: dailyChangePercent,
      dailyChangeTradeDate
    };
    
    if (formData.exchange === 'israeli') {
      const updatedIsraeliStocks = israeliStocks.map(stock => 
        stock.id === editingStock.id ? updatedStock : stock
      );
      setIsraeliStocks(updatedIsraeliStocks);
      setHasUnsavedChanges(true);
    } else {
      const updatedAmericanStocks = americanStocks.map(stock => 
        stock.id === editingStock.id ? updatedStock : stock
      );
      setAmericanStocks(updatedAmericanStocks);
      setHasUnsavedChanges(true);
    }
    
    setIsEditMode(false);
    setEditingStock(null);
    setFormData({
      stockName: '',
      officialName: '',
      securityType: '',
      securitySubType: '',
      branch: '',
      isFund: false,
      isForeignETF: false,
      securityId: '',
      purchasePrice: '',
      initialInvestment: '',
      currentValue: '',
      previousValue: '',
    currentValueDate: '',
    previousValueDate: '',
      quantity: '',
      purchaseDate: '',
      exchange: 'israeli',
      exchangeRate: '',
      investmentTrack: '',
      interestRate: '',
      isLinkedToIndex: false
    });
  };

  // פונקציה לביטול עריכה
  const handleCancelEdit = () => {
    setIsEditMode(false);
    setEditingStock(null);
    setFormData({
      stockName: '',
      officialName: '',
      securityType: '',
      securitySubType: '',
      branch: '',
      isFund: false,
      isForeignETF: false,
      securityId: '',
      purchasePrice: '',
      initialInvestment: '',
      currentValue: '',
      previousValue: '',
    currentValueDate: '',
    previousValueDate: '',
      quantity: '',
      purchaseDate: '',
      exchange: 'israeli',
      exchangeRate: '',
      investmentTrack: '',
      interestRate: '',
      isLinkedToIndex: false
    });
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
        if (field === 'currentValue') {
          return applyLedgerValueEditPayload(item, value);
        }
        return { ...item, [field]: value };
      });
      setPensionFunds(updatedPensionFunds);
      setHasUnsavedChanges(true);
    } else if (exchange === 'bank') {
      // "שווי נוכחי" עובר דרך applyLedgerValueEditPayload בדיוק כמו קופת
      // גמל - ראו ההערה על exchange === 'pension' למעלה. שאר השדות
      // מתעדכנים ישירות.
      const updatedBankBalances = bankBalances.map(item => {
        if (item.id !== id) return item;
        if (field === 'currentValue') {
          return applyLedgerValueEditPayload(item, value);
        }
        return { ...item, [field]: value };
      });
      setBankBalances(updatedBankBalances);
      setHasUnsavedChanges(true);
    } else if (exchange === 'cash_fund') {
      const updatedCashFunds = cashFunds.map(item => {
        if (item.id !== id) return item;
        if (field === 'currentValue') {
          return applyLedgerValueEditPayload(item, value);
        }
        return { ...item, [field]: value };
      });
      setCashFunds(updatedCashFunds);
      setHasUnsavedChanges(true);
    } else if (exchange === 'bank_savings') {
      const updatedBankSavingsFunds = bankSavingsFunds.map(item =>
        item.id === id ? { ...item, [field]: value } : item
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


  if (authLoading) {
    return (
      <div className="App">
        <div className="auth-loading-wrap">
          <p className="auth-loading-text">טוען…</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="App">
        <div className="auth-theme-toggle-wrap">
          <ThemeToggleButton theme={theme} onToggleTheme={toggleTheme} />
        </div>
        <AuthView onAuthenticated={login} />
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
    onRecordTransaction: handleRecordTransaction
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
    savePortfolio,
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
      case 'add':
        return (
          <StockFormView
            isEditMode={isEditMode}
            formData={formData}
            holdings={holdings}
            handleSubmit={handleSubmit}
            handleInputChange={handleInputChange}
            handleBackToHome={handleBackToHome}
            handleSaveEdit={handleSaveEdit}
            handleCancelEdit={handleCancelEdit}
            exchangeRateFetching={exchangeRateFetching}
            exchangeRateNotFound={exchangeRateNotFound}
            onPullExchangeRate={handlePullExchangeRate}
            onSelectIsraeliStock={handleSelectIsraeliStock}
          />
        );

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

      case 'analytics':
        return (
          <PortfolioAnalysisView
            {...holdings}
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
          />
        );
    }
  };

  return (
    <>
      {/* Rendered outside the shell, over everything, and before the page
          is usable - it states what must not be typed into the system, so
          it has to arrive ahead of the screens that invite typing. */}
      {!betaNoticeAcknowledged && (
        <BetaNoticeModal onAcknowledge={() => setBetaNoticeAcknowledged(true)} />
      )}
      <AppShell
        activePage={activePage}
        onNavigate={handleNavigate}
        user={user}
        onLogout={handleLogout}
        theme={theme}
        onToggleTheme={toggleTheme}
      >
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
    </>
  );
}

export default App;