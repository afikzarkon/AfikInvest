import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PageToolbar from './PageToolbar';
import BetaBanner from './BetaBanner';
import { useHistoricalPortfolioValue } from '../hooks/useHistoricalPortfolioValue';
import { expandHoldingsWithClosedLots } from '../shared/transactionLedger';
import {
  compareMonthlySnapshots,
  normalizeCategoryItems,
  isLegacyRollup,
  MONTHLY_CATEGORY_KEYS,
  MONTHLY_CATEGORY_LABELS_HE,
  AUTO_DERIVED_CATEGORIES,
  MANUAL_ENTRY_CATEGORIES,
  snapshotAsOfDate
} from '../utils/monthlySnapshotComparison';
import {
  asOfRange,
  composeAsOfBreakdown,
  defaultAsOfDate,
  isValidAsOfDate,
  pensionStatementsAtDate,
  STATEMENT_TOLERANCE_DAYS
} from '../utils/snapshotAsOf';
import {
  computePortfolioInceptionDate,
  formatMonthLabel,
  todayISO
} from '../utils/portfolioDates';

// /monthly-tracker - the monthly checkpoint system, on its own page.
//
// This was the largest single section of the analytics page, and the only
// one that is a workflow rather than a read-out: saving this month, editing
// a past month, backfilling one that was never saved, and comparing two.
// Sharing a page with a dozen charts meant every one of those tasks began
// with a long scroll past them, and this page's state was interleaved with
// the charts' state inside one 2,200-line component.
//
// The behaviour is unchanged - the same drafts, the same auto-fill, the
// same cash-flow declarations.

// Net external cash flow declared per category (positive = net deposit,
// negative = net withdrawal), for the LIQUID categories only - current
// accounts, money-market funds and bank savings.
//
// Stocks and provident funds are deliberately absent: their flows are
// already recorded, dated, in the main tables (a purchase lot's own date
// and cost; a provident fund's deposit ledger) and are read straight from
// there. Offering a second, manual place to declare the same flow created
// two sources for one number with nothing to say which was right, and
// invited double-counting - the declared amount and the ledger entry would
// both be netted out.
//
// The liquid accounts have a ledger too (every deposit/withdrawal entered
// through the add form), and when it has entries in a period those are
// what the comparison uses. The declaration here is the fallback for a
// period the ledger says nothing about - see compareMonthlySnapshots.
//
// Kept as strings while being edited (like every other numeric input in
// this form), parsed into numbers (dropping blank/zero entries) just
// before being sent.
const emptyCashFlows = () => MANUAL_ENTRY_CATEGORIES.reduce((acc, key) => ({ ...acc, [key]: '' }), {});
const parseCashFlows = (draft) =>
  MANUAL_ENTRY_CATEGORIES.reduce((acc, key) => {
    const v = parseFloat(draft[key]);
    if (Number.isFinite(v) && v !== 0) acc[key] = v;
    return acc;
  }, {});

// The declared flows a saved month carries on categories that NO LONGER
// HAVE A FIELD - stocks and provident funds, declared back when that was
// possible.
//
// These have to survive an edit untouched. Opening a month to correct an
// unrelated figure must not quietly delete data that was recorded at the
// time and that the comparison for that month still depends on; the figure
// it produces would change for a reason the user never asked for. There's
// no UI to re-enter them either, so a drop would be unrecoverable.
const extractLegacyCashFlows = (savedCashFlows) => {
  if (!savedCashFlows || typeof savedCashFlows !== 'object') return {};
  return Object.entries(savedCashFlows).reduce((acc, [key, value]) => {
    if (MANUAL_ENTRY_CATEGORIES.includes(key)) return acc;
    if (Number.isFinite(value) && value !== 0) acc[key] = value;
    return acc;
  }, {});
};

const EMPTY_TRANSACTIONS = [];

function MonthlyTrackerView({
  formatPriceWithSign,
  israeliStocks = [],
  americanStocks = [],
  pensionFunds = [],
  cashFunds = [],
  bankBalances = [],
  bankSavingsFunds = [],
  // Recorded sales: a past month is valued with the units that were still
  // held then, even if they have been sold since.
  transactions = EMPTY_TRANSACTIONS,
  // Today's itemized figures (App.js's snapshotBreakdown) - what a
  // checkpoint valid for TODAY holds. Earlier dates are rebuilt from history.
  liveBreakdown = null,
  monthlySnapshots = [],
  monthlySnapshotsLoading = false,
  onSaveMonthlySnapshot,
  savingMonthly = false,
  saveMonthlyError = '',
  onUpdateMonthlySnapshot,
  updatingMonth = null,
  updateMonthlyError = '',
  onDeleteMonthlySnapshot,
  deletingMonth = null,
  deleteMonthlyError = '',
  onAddManualMonthlySnapshot,
  addingManual = false,
  addManualError = ''
}) {
  const todayDate = useMemo(() => todayISO(), []);
  const historyStocks = useMemo(
    () => expandHoldingsWithClosedLots({ israeliStocks, americanStocks }, transactions),
    [israeliStocks, americanStocks, transactions]
  );
  const portfolioInceptionDate = useMemo(
    () =>
      computePortfolioInceptionDate({
        israeliStocks: historyStocks.israeliStocks,
        americanStocks: historyStocks.americanStocks,
        pensionFunds,
        bankSavingsFunds
      }),
    [historyStocks, pensionFunds, bankSavingsFunds]
  );

  // The auto-fill below values a chosen month from real historical closes,
  // so this page loads the same history the performance chart does - over
  // the portfolio's whole life, since any past month may be picked.
  //
  // Only breakdownAtDate is used here; the series itself belongs to the
  // analytics page. `loading` is what lets the page say a month cannot be
  // filled YET, rather than letting auto-fill report it as having no data.
  const { loading: historyLoading, breakdownAtDate: historicalBreakdownAtDate } =
    useHistoricalPortfolioValue({
      fromDate: portfolioInceptionDate,
      toDate: todayDate,
      israeliStocks: historyStocks.israeliStocks,
      americanStocks: historyStocks.americanStocks,
      pensionFunds,
      cashFunds,
      bankBalances,
      bankSavingsFunds
    });

  // Monthly checkpoint comparison (see hooks/useMonthlySnapshots.js /
  // utils/monthlySnapshotComparison.js). monthlySnapshots comes back
  // sorted ascending by month from the server - '' selection means "use
  // the default", so the comparison keeps tracking the two most recent
  // months automatically as new ones get saved, unless the user has
  // explicitly picked something else.
  const [selectedBaseMonth, setSelectedBaseMonth] = useState('');
  const [selectedCompareMonth, setSelectedCompareMonth] = useState('');
  const defaultCompareMonth = monthlySnapshots.length ? monthlySnapshots[monthlySnapshots.length - 1].month : '';
  const defaultBaseMonth = monthlySnapshots.length >= 2 ? monthlySnapshots[monthlySnapshots.length - 2].month : '';
  const effectiveBaseMonth = selectedBaseMonth || defaultBaseMonth;
  const effectiveCompareMonth = selectedCompareMonth || defaultCompareMonth;
  const baseMonthlySnapshot = monthlySnapshots.find((s) => s.month === effectiveBaseMonth) || null;
  const compareMonthlySnapshot = monthlySnapshots.find((s) => s.month === effectiveCompareMonth) || null;
  // liveHoldings feeds the contribution adjustment (Modified Dietz) inside
  // compareMonthlySnapshots - it nets out deposits/purchases that fell
  // within the compared period (drawn from the *current* portfolio state,
  // since snapshots themselves never recorded a history of flows) so a
  // mid-period deposit isn't misread as investment growth. See that
  // function's own comment for the categories/limitations.
  const monthlyLiveHoldings = useMemo(
    () => ({
      israeliStocks: historyStocks.israeliStocks,
      americanStocks: historyStocks.americanStocks,
      pensionFunds,
      cashFunds,
      bankBalances,
      bankSavingsFunds,
      transactions
    }),
    [historyStocks, pensionFunds, cashFunds, bankBalances, bankSavingsFunds, transactions]
  );
  const monthlyComparisonRows = useMemo(
    () => compareMonthlySnapshots(baseMonthlySnapshot, compareMonthlySnapshot, monthlyLiveHoldings, monthlySnapshots),
    [baseMonthlySnapshot, compareMonthlySnapshot, monthlyLiveHoldings, monthlySnapshots]
  );
  // Israel's month, as the server files it (see utils/portfolioDates.js).
  const currentMonthKey = todayDate.slice(0, 7);
  const currentMonthAlreadySaved = monthlySnapshots.some((s) => s.month === currentMonthKey);

  // "פתח פירוט מלא" / "קבץ לפי קטגוריות" - shared by the comparison table
  // and the history list below it, so toggling it once shows/hides
  // per-item detail (individual stocks/funds/accounts) everywhere in this
  // section consistently.
  const [detailedView, setDetailedView] = useState(false);

  // Editing a past monthly save - mirrors the Home page's inline-edit
  // editingMonth is which saved month (if any) is open for editing, and
  // editDraftBreakdown is a local copy of just that month's itemized
  // breakdown while it's being edited.
  //
  // EVERY DRAFT ROW CARRIES A STABLE rowId, and that - not its label or its
  // saved key - is what React keys the DOM by.
  //
  // This is the fix for the typing bug. The rows used to be keyed by
  // item.key, while renaming a row rewrote item.key to whatever had been
  // typed so far. So every keystroke changed the key React identified the
  // row by, React concluded the old row was gone and a new one had
  // appeared, and it destroyed and rebuilt the <input> - which is why the
  // caret jumped out of the field after a single character. A rowId that
  // is assigned once and never changes makes the row the same row for the
  // whole edit, so the input is preserved and typing is continuous.
  //
  // Values are held as RAW STRINGS while editing, too. Parsing on each
  // keystroke turned a half-typed "-" or "1." or an emptied field into
  // NaN, which then poisoned the category subtotal and the card total.
  // They're parsed once, at save.
  const [editingMonth, setEditingMonth] = useState(null);
  const [editDraftBreakdown, setEditDraftBreakdown] = useState(null);
  const [editDraftCashFlows, setEditDraftCashFlows] = useState(emptyCashFlows);
  // Carried through the edit untouched - see extractLegacyCashFlows.
  const [editLegacyCashFlows, setEditLegacyCashFlows] = useState({});
  // The date the edited figures are valid for. Correcting a figure doesn't
  // move it; re-filling the month automatically does - to the date the
  // auto-fill valued it at. null for a month saved before checkpoints
  // carried a date, which stays undated rather than being given a guess.
  const [editDraftAsOfDate, setEditDraftAsOfDate] = useState(null);

  const draftRowIdRef = useRef(0);
  const nextDraftRowId = () => {
    draftRowIdRef.current += 1;
    return `row-${draftRowIdRef.current}`;
  };

  // A saved { key, label, value } item -> an editable draft row.
  const toDraftRow = (item) => ({
    rowId: nextDraftRowId(),
    // Preserved so a row that is never renamed keeps matching the same
    // holding when two months are compared item-by-item.
    savedKey: item.key,
    label: item.label,
    valueText: Number.isFinite(item.value) ? String(item.value) : ''
  });

  const buildDraftFromBreakdown = (breakdown) =>
    MONTHLY_CATEGORY_KEYS.reduce((acc, key) => {
      acc[key] = normalizeCategoryItems(breakdown?.[key], key).map(toDraftRow);
      return acc;
    }, {});

  // Draft row -> the { key, label, value } shape a snapshot stores. A
  // renamed row takes its new label as its key; an untouched one keeps the
  // key it was saved under.
  const fromDraftRow = (row) => {
    const label = row.label.trim();
    const value = parseFloat(row.valueText);
    return {
      key: label && label !== row.savedKey ? label : row.savedKey || label,
      label,
      value: Number.isFinite(value) ? value : 0
    };
  };

  const draftCategoryTotal = (rows) =>
    (rows || []).reduce((sum, row) => {
      const value = parseFloat(row.valueText);
      return sum + (Number.isFinite(value) ? value : 0);
    }, 0);

  const startEditingMonth = (snapshot) => {
    const savedCashFlows = snapshot.breakdown?.cashFlows;
    setEditingMonth(snapshot.month);
    setEditDraftAsOfDate(snapshot.asOfDate || snapshot.breakdown?.asOfDate || null);
    setEditDraftBreakdown(buildDraftFromBreakdown(snapshot.breakdown));
    // Only the categories that still have an input become editable...
    setEditDraftCashFlows(
      MANUAL_ENTRY_CATEGORIES.reduce((acc, key) => {
        const v = savedCashFlows?.[key];
        acc[key] = Number.isFinite(v) ? String(v) : '';
        return acc;
      }, {})
    );
    // ...and whatever a legacy month declared on the others rides along
    // unchanged.
    setEditLegacyCashFlows(extractLegacyCashFlows(savedCashFlows));
  };

  const cancelEditingMonth = () => {
    setEditingMonth(null);
    setEditDraftBreakdown(null);
    setEditDraftCashFlows(emptyCashFlows());
    setEditLegacyCashFlows({});
    setEditDraftAsOfDate(null);
  };

  // Both editors update one field of one row, addressed by its stable
  // rowId - nothing about the row's identity changes as a result, so
  // nothing remounts.
  const updateDraftRow = (categoryKey, rowId, patch) => {
    setEditDraftBreakdown((prev) => ({
      ...prev,
      [categoryKey]: prev[categoryKey].map((row) => (row.rowId === rowId ? { ...row, ...patch } : row))
    }));
  };

  const handleEditItemValueChange = (categoryKey, rowId, rawValue) => {
    updateDraftRow(categoryKey, rowId, { valueText: rawValue });
  };

  const handleEditItemLabelChange = (categoryKey, rowId, rawLabel) => {
    updateDraftRow(categoryKey, rowId, { label: rawLabel });
  };

  // Free row management inside a saved month: a checkpoint may need a row
  // the portfolio no longer has (an account since closed), or be missing
  // one that existed at the time. Editing values alone couldn't express
  // either.
  const addEditItemRow = (categoryKey) => {
    setEditDraftBreakdown((prev) => ({
      ...prev,
      [categoryKey]: [...prev[categoryKey], { rowId: nextDraftRowId(), savedKey: '', label: '', valueText: '' }]
    }));
  };

  const removeEditItemRow = (categoryKey, rowId) => {
    setEditDraftBreakdown((prev) => ({
      ...prev,
      [categoryKey]: prev[categoryKey].filter((row) => row.rowId !== rowId)
    }));
  };

  // AUTOMATIC FILL - the point of the monthly tracker no longer being a
  // typing exercise.
  //
  // Every row is derived from data the user already maintains in the main
  // tables: stocks from the real historical closing price on that month's
  // last trading day for the lots actually held then, and provident funds /
  // money-market funds / current accounts from their own value+deposit
  // ledgers (see utils/historicalPortfolioValue.js's
  // computeHistoricalBreakdownAtDate). Nothing here is typed in by hand.
  //
  // It returns null when the historical prices for that date haven't been
  // fetched yet, so the caller can say so instead of writing a row of
  // zeroes over the user's data.
  //
  // EVERYTHING IS VALUED ON THE CHECKPOINT'S AS-OF DATE - the day its
  // figures are true for, picked by the user (see utils/snapshotAsOf.js):
  // today's live figures for today, the historical breakdown for any earlier
  // day, and in both cases the checking/money-market balances synced from
  // their deposit/withdrawal ledgers up to that day.
  const accountHoldings = useMemo(
    () => ({ cashFunds, bankBalances, bankSavingsFunds }),
    [cashFunds, bankBalances, bankSavingsFunds]
  );
  const buildBreakdownAt = useCallback(
    (asOfDate) =>
      composeAsOfBreakdown({
        asOfDate,
        today: todayDate,
        liveBreakdown,
        historicalBreakdownAtDate,
        holdings: accountHoldings
      }),
    [todayDate, liveBreakdown, historicalBreakdownAtDate, accountHoldings]
  );

  const [autoFillMessage, setAutoFillMessage] = useState('');
  const NO_HISTORY_YET = 'אין עדיין נתונים היסטוריים לתאריך הזה - נסו שוב לאחר שהנתונים ההיסטוריים נטענו.';

  const handleAutoFillEditedMonth = () => {
    const asOfDate = editDraftAsOfDate || defaultAsOfDate(editingMonth, todayDate);
    const breakdown = buildBreakdownAt(asOfDate);
    if (!breakdown) {
      setAutoFillMessage(NO_HISTORY_YET);
      return;
    }
    setAutoFillMessage('');
    // Rebuilt through the same draft factory as every other row, so
    // auto-filled rows are editable afterwards exactly like typed ones.
    setEditDraftBreakdown(buildDraftFromBreakdown(breakdown));
    // The figures now describe the date they were valued at.
    setEditDraftAsOfDate(asOfDate);
  };

  const handleEditCashFlowChange = (categoryKey, rawValue) => {
    setEditDraftCashFlows((prev) => ({ ...prev, [categoryKey]: rawValue }));
  };

  const draftTotal = editDraftBreakdown
    ? MONTHLY_CATEGORY_KEYS.reduce((sum, key) => sum + draftCategoryTotal(editDraftBreakdown[key]), 0)
    : 0;

  const handleSaveEditedMonth = async () => {
    if (!editingMonth || !editDraftBreakdown || !onUpdateMonthlySnapshot) return;
    // Draft rows become stored items here, once - not on every keystroke.
    // A row left completely blank is dropped rather than saved as a
    // nameless zero.
    const breakdown = MONTHLY_CATEGORY_KEYS.reduce((acc, key) => {
      acc[key] = editDraftBreakdown[key].map(fromDraftRow).filter((item) => item.key);
      return acc;
    }, {});
    // Legacy first, so an edited liquid category always wins over whatever
    // was stored for it - the two key sets are otherwise disjoint.
    breakdown.cashFlows = { ...editLegacyCashFlows, ...parseCashFlows(editDraftCashFlows) };
    if (editDraftAsOfDate) breakdown.asOfDate = editDraftAsOfDate;
    const ok = await onUpdateMonthlySnapshot(editingMonth, draftTotal, breakdown);
    if (ok) cancelEditingMonth();
  };

  // The history section shows just one month at a time (defaulting to the
  // most recently saved one), picked via a dropdown - not a running list of
  // every saved month, which got long and repetitive once itemized detail
  // was added. '' means "use the default", same convention as the
  // comparison dropdowns above.
  const [selectedHistoryMonth, setSelectedHistoryMonth] = useState('');
  const defaultHistoryMonth = monthlySnapshots.length ? monthlySnapshots[monthlySnapshots.length - 1].month : '';
  const effectiveHistoryMonth = selectedHistoryMonth || defaultHistoryMonth;
  const historySnapshot = monthlySnapshots.find((s) => s.month === effectiveHistoryMonth) || null;

  const handleDeleteMonth = async (month) => {
    if (!onDeleteMonthlySnapshot) return;
    const ok = window.confirm(`למחוק לצמיתות את השמירה החודשית של ${formatMonthLabel(month)}? לא ניתן לשחזר לאחר המחיקה.`);
    if (!ok) return;
    const deleted = await onDeleteMonthlySnapshot(month);
    if (deleted) {
      // the deleted month may have been selected anywhere - drop back to
      // the (recomputed) defaults rather than pointing at a gone month
      if (editingMonth === month) cancelEditingMonth();
      if (selectedHistoryMonth === month) setSelectedHistoryMonth('');
      if (selectedBaseMonth === month) setSelectedBaseMonth('');
      if (selectedCompareMonth === month) setSelectedCompareMonth('');
    }
  };

  // "➕ הוספה ידנית" - backfills a past month the user never saved.
  //
  // Only the LIQUID categories are typed in here. Stocks and provident
  // funds are derived from the month's historical closes and the deposit
  // ledgers (manualAddAutoBreakdown below) and shown read-only: the app can
  // work those out exactly, so asking the user to remember and retype them
  // could only ever introduce a number that disagrees with the main tables.
  const [showManualAddForm, setShowManualAddForm] = useState(false);
  const [manualAddMonth, setManualAddMonth] = useState('');
  const [manualAddAsOfDate, setManualAddAsOfDate] = useState('');
  const emptyManualItems = () => MANUAL_ENTRY_CATEGORIES.reduce((acc, key) => ({ ...acc, [key]: [] }), {});
  const [manualAddItems, setManualAddItems] = useState(emptyManualItems);
  const [manualAddCashFlows, setManualAddCashFlows] = useState(emptyCashFlows);
  const manualAddIdRef = useRef(0);

  const openManualAddForm = () => {
    setShowManualAddForm(true);
    setManualAddMonth('');
    setManualAddAsOfDate('');
    setManualAddItems(emptyManualItems());
    setManualAddCashFlows(emptyCashFlows());
    setAutoFillMessage('');
  };

  const handleManualAddCashFlowChange = (categoryKey, rawValue) => {
    setManualAddCashFlows((prev) => ({ ...prev, [categoryKey]: rawValue }));
  };

  const addManualItemRow = (catKey) => {
    manualAddIdRef.current += 1;
    const id = manualAddIdRef.current;
    setManualAddItems((prev) => ({ ...prev, [catKey]: [...prev[catKey], { id, label: '', value: '' }] }));
  };

  const removeManualItemRow = (catKey, id) => {
    setManualAddItems((prev) => ({ ...prev, [catKey]: prev[catKey].filter((it) => it.id !== id) }));
  };

  const updateManualItemRow = (catKey, id, field, value) => {
    setManualAddItems((prev) => ({
      ...prev,
      [catKey]: prev[catKey].map((it) => (it.id === id ? { ...it, [field]: value } : it))
    }));
  };

  // The derived half of the backfill form: recomputed whenever the chosen
  // month changes, never stored in state, so it can't drift from the main
  // tables it comes from.
  const handleManualAddMonthChange = (month) => {
    setManualAddMonth(month);
    // A new month starts at its default as-of date (its last day, or today).
    setManualAddAsOfDate(defaultAsOfDate(month, todayDate) || '');
  };
  const manualAddAutoBreakdown = useMemo(
    () => (manualAddMonth && isValidAsOfDate(manualAddMonth, manualAddAsOfDate, todayDate) ? buildBreakdownAt(manualAddAsOfDate) : null),
    [manualAddMonth, manualAddAsOfDate, todayDate, buildBreakdownAt]
  );

  const manualAddAutoTotal = AUTO_DERIVED_CATEGORIES.reduce(
    (sum, key) =>
      sum + ((manualAddAutoBreakdown?.[key] || []).reduce((s, item) => s + (item.value || 0), 0)),
    0
  );

  // Prefills the liquid rows from the account ledgers, as a starting point
  // the user can then correct - unlike the derived categories above, these
  // stay editable.
  const fillManualItemsFrom = (breakdown) =>
    setManualAddItems(
      MANUAL_ENTRY_CATEGORIES.reduce((acc, key) => {
        acc[key] = (breakdown[key] || []).map((item) => {
          manualAddIdRef.current += 1;
          return { id: manualAddIdRef.current, label: item.label, value: String(item.value) };
        });
        return acc;
      }, {})
    );

  const handleAutoFillManualAdd = () => {
    if (!manualAddAutoBreakdown) {
      setAutoFillMessage(NO_HISTORY_YET);
      return;
    }
    setAutoFillMessage('');
    fillManualItemsFrom(manualAddAutoBreakdown);
  };

  // The liquid rows sync THEMSELVES whenever the as-of date (or the data
  // behind it) changes - computed from the ledgers up to that day, still
  // editable afterwards. Keyed so a re-render with the same date doesn't
  // wipe out a correction the user has typed.
  const lastAutoSyncKeyRef = useRef('');
  useEffect(() => {
    if (!showManualAddForm || !manualAddAutoBreakdown) return;
    const key = `${manualAddMonth}|${manualAddAsOfDate}`;
    if (lastAutoSyncKeyRef.current === key) return;
    lastAutoSyncKeyRef.current = key;
    fillManualItemsFrom(manualAddAutoBreakdown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showManualAddForm, manualAddMonth, manualAddAsOfDate, manualAddAutoBreakdown]);

  const manualAddMonthAlreadySaved = !!manualAddMonth && monthlySnapshots.some((s) => s.month === manualAddMonth);
  const manualAddManualTotal = MANUAL_ENTRY_CATEGORIES.reduce((sum, key) => {
    const catSum = manualAddItems[key].reduce((s, it) => {
      const v = parseFloat(it.value);
      return s + (Number.isFinite(v) ? v : 0);
    }, 0);
    return sum + catSum;
  }, 0);
  const manualAddTotal = manualAddAutoTotal + manualAddManualTotal;

  const handleSubmitManualAdd = async () => {
    if (!onAddManualMonthlySnapshot || !manualAddMonth || manualAddMonthAlreadySaved) return;
    if (!isValidAsOfDate(manualAddMonth, manualAddAsOfDate, todayDate)) return;
    const breakdown = {};
    // Derived categories go in exactly as computed.
    AUTO_DERIVED_CATEGORIES.forEach((key) => {
      breakdown[key] = (manualAddAutoBreakdown?.[key] || []).map((item) => ({ ...item }));
    });
    MANUAL_ENTRY_CATEGORIES.forEach((key) => {
      breakdown[key] = manualAddItems[key]
        .map((it) => ({ key: it.label.trim(), label: it.label.trim(), value: parseFloat(it.value) }))
        .filter((it) => it.key && Number.isFinite(it.value));
    });
    breakdown.cashFlows = parseCashFlows(manualAddCashFlows);
    // Valid for the date the user picked, which is the date every row above
    // was valued at - not "some time that month".
    breakdown.asOfDate = manualAddAsOfDate;
    const ok = await onAddManualMonthlySnapshot(manualAddMonth, manualAddTotal, breakdown);
    if (ok) setShowManualAddForm(false);
  };

  // Cash flows declared right before saving/updating *today's* month (the
  // "שמור שמירה חודשית"/"עדכן שמירה חודשית" button above the comparison
  // table - not to be confused with editingMonth's "ערוך" flow, which
  // corrects an already-saved past month).
  const [saveCashFlows, setSaveCashFlows] = useState(emptyCashFlows);
  const [saveAsOfDate, setSaveAsOfDate] = useState(todayDate);
  const [saveAsOfMessage, setSaveAsOfMessage] = useState('');
  const handleSaveCashFlowChange = (categoryKey, rawValue) => {
    setSaveCashFlows((prev) => ({ ...prev, [categoryKey]: rawValue }));
  };
  const handleSaveMonthlySnapshotClick = () => {
    // Re-saving this month REPLACES its stored row, so any flow it was
    // saved with on a category that no longer has a field would be lost
    // with it - the same silent drop the edit flow guards against. Carried
    // through here too, under whatever is declared in the form now.
    const existing = monthlySnapshots.find((snap) => snap.month === currentMonthKey);
    const legacy = extractLegacyCashFlows(existing?.breakdown?.cashFlows);
    if (!isValidAsOfDate(currentMonthKey, saveAsOfDate, todayDate)) {
      setSaveAsOfMessage('תאריך "נכון ל" חייב להיות בתוך החודש הנוכחי ולא בעתיד.');
      return;
    }
    // The figures for the chosen day: today's live ones, or the day's
    // historical ones - never today's figures labelled with another date.
    const breakdown = buildBreakdownAt(saveAsOfDate);
    if (!breakdown) {
      setSaveAsOfMessage(NO_HISTORY_YET);
      return;
    }
    setSaveAsOfMessage('');
    onSaveMonthlySnapshot({ ...legacy, ...parseCashFlows(saveCashFlows) }, { asOfDate: saveAsOfDate, breakdown });
    setSaveCashFlows(emptyCashFlows());
  };

  // "נכון ל-12/10/2026" - the date a checkpoint's figures are valid for.
  // Months saved before checkpoints carried one say so instead of showing
  // the month-end stand-in the comparison falls back to.
  const formatAsOf = (snapshot) => {
    const date = snapshot && (snapshot.asOfDate || snapshot.breakdown?.asOfDate);
    if (!date) return 'תאריך מדויק לא נשמר (מחושב לסוף החודש)';
    const [y, m, d] = date.split('-');
    return `נכון ל-${d}/${m}/${y}`;
  };
  const formatDay = (iso) => {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  };

  const renderAsOfInput = (idPrefix, month, value, onChange) => {
    const range = month ? asOfRange(month, todayDate) : null;
    return (
      <div className="rebalance-input-item" style={{ maxWidth: 220 }}>
        <label htmlFor={`${idPrefix}-as-of`}>הנתונים נכונים לתאריך</label>
        <input
          id={`${idPrefix}-as-of`}
          type="date"
          className="monthly-select"
          min={range ? range.min : undefined}
          max={range ? range.max : undefined}
          value={value || ''}
          disabled={!range}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  };

  // For each provident fund: is the figure on this date backed by a
  // statement FOR this date, or carried across from an earlier/later one?
  const STATEMENT_TEXT = {
    match: (s) => `תואם - דוח מ-${formatDay(s.statementDate)}`,
    earlier: (s) =>
      `דוח מוקדם יותר (${formatDay(s.statementDate)}, ${Math.abs(s.days)} ימים לפני) - השווי הועבר קדימה עם ההפקדות מאז, בלי תשואה שאחרי הדוח`,
    later: (s) =>
      `דוח מאוחר יותר (${formatDay(s.statementDate)}, ${s.days} ימים אחרי) - השווי חושב אחורה בניכוי ההפקדות, וכולל תשואה שאחרי התאריך`,
    none: () => 'אין דוח שווי רשום - השווי הוא סכום ההפקדות בלבד'
  };
  const renderPensionStatements = (asOfDate) => {
    if (!asOfDate || pensionFunds.length === 0) return null;
    const statuses = pensionStatementsAtDate(pensionFunds, asOfDate);
    const offCount = statuses.filter((s) => s.status !== 'match').length;
    return (
      <div className="monthly-manual-category" role="status">
        <div className="monthly-manual-category-header">
          <span>
            קופות גמל מול תאריך {formatDay(asOfDate)}
            {offCount > 0 ? ` · ${offCount} לא תואמות` : ' · כולן תואמות'}
          </span>
        </div>
        {statuses.map((s) => (
          <div
            key={s.key}
            className={`monthly-history-item-row${s.status === 'match' ? '' : ' monthly-item-placeholder'}`}
          >
            <span className="monthly-item-label">
              {s.status === 'match' ? '✓' : '⚠'} {s.name}
            </span>
            <span>{STATEMENT_TEXT[s.status](s)}</span>
          </div>
        ))}
        {offCount > 0 && (
          <p className="monthly-cashflow-hint">
            דוח נחשב תואם אם הוא עד {STATEMENT_TOLERANCE_DAYS} ימים מהתאריך. לעדכון: עדכנו את שווי הקופה בטבלה לפי
            הדוח הרלוונטי, ואז שמרו שוב.
          </p>
        )}
      </div>
    );
  };

  const formatMoneyCell = (v) => (v != null ? `${formatPriceWithSign(v)} ₪` : '—');
  const formatPercentCell = (v) => (v != null ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}%` : '—');
  const percentCellClass = (v) => (v == null ? '' : v >= 0 ? 'profit-positive' : 'profit-negative');

  // Shared compact grid of one small labeled number input per LIQUID
  // category - reused by the save/edit/manual-add forms alike (see
  // emptyCashFlows' own comment for why stocks and provident funds have no
  // field here).
  const renderCashFlowInputs = (values, onChange, idPrefix) => (
    <div className="monthly-cashflow-inputs">
      <p className="monthly-cashflow-hint">
        תזרים חיצוני נטו בתקופה (₪, אופציונלי) - הפקדה = מספר חיובי, משיכה = מספר שלילי. הפקדות ומשיכות שנרשמו
        בפנקס של החשבון (דרך "הוספה") נלקחות ממנו אוטומטית לפי התאריך שלהן, ובמקרה כזה הסכום שמוזן כאן לא נספר
        פעמיים. השדה נועד לתקופה שבה לא נרשמה בפנקס שום תנועה. עבור מניות וקופות גמל, ההפקדות והרכישות תמיד נלקחות
        מהטבלאות הראשיות.
      </p>
      <div className="monthly-cashflow-grid">
        {MANUAL_ENTRY_CATEGORIES.map((key) => (
          <div key={key} className="monthly-cashflow-item">
            <label htmlFor={`${idPrefix}-cashflow-${key}`}>{MONTHLY_CATEGORY_LABELS_HE[key]}</label>
            <input
              id={`${idPrefix}-cashflow-${key}`}
              type="number"
              step="0.01"
              placeholder="0"
              value={values[key]}
              onChange={(e) => onChange(key, e.target.value)}
            />
          </div>
        ))}
      </div>
    </div>
  );


  return (
    <div className="App">
      <div className="analysis-container">
        <div className="analysis-content">
          <PageToolbar
            title="מעקב חודשי"
            subtitle="צילום מצב של התיק בסוף כל חודש - שמירה, עריכה והשוואה בין חודשים"
          />

          {/* Checkpoints are typed in by hand here, so this is a screen
              that invites real figures. */}
          <BetaBanner tone="data" />

          {historyLoading && (
            <p className="history-empty-note">טוען נתונים היסטוריים למילוי אוטומטי…</p>
          )}

        <div className="analysis-section">
          <h2 className="section-title">מעקב חודשי</h2>

          <div className="monthly-toolbar">
            <span className="monthly-status-text">
              {currentMonthAlreadySaved
                ? `החודש (${formatMonthLabel(currentMonthKey)}) נשמר`
                : `החודש (${formatMonthLabel(currentMonthKey)}) עדיין לא נשמר`}
            </span>
            <div className="monthly-toolbar-buttons">
              <button
                type="button"
                className="monthly-toolbar-btn"
                onClick={handleSaveMonthlySnapshotClick}
                disabled={savingMonthly}
              >
                {savingMonthly ? 'שומר…' : currentMonthAlreadySaved ? 'עדכן שמירה חודשית' : 'שמור שמירה חודשית'}
              </button>
              {onAddManualMonthlySnapshot && (
                <button
                  type="button"
                  className="monthly-toolbar-btn"
                  onClick={showManualAddForm ? () => setShowManualAddForm(false) : openManualAddForm}
                >
                  ➕ הוספה ידנית
                </button>
              )}
              {monthlySnapshots.length > 0 && (
                <button type="button" className="monthly-toolbar-btn" onClick={() => setDetailedView((v) => !v)}>
                  {detailedView ? 'קבץ לפי קטגוריות' : 'פתח פירוט מלא'}
                </button>
              )}
            </div>
          </div>
          {renderAsOfInput('save', currentMonthKey, saveAsOfDate, (v) => {
            setSaveAsOfDate(v);
            setSaveAsOfMessage('');
          })}
          {saveAsOfMessage && <p className="history-empty-note">{saveAsOfMessage}</p>}
          {renderPensionStatements(saveAsOfDate)}
          {renderCashFlowInputs(saveCashFlows, handleSaveCashFlowChange, 'save')}
          {saveMonthlyError && <p className="history-empty-note">{saveMonthlyError}</p>}
          {addManualError && <p className="history-empty-note">{addManualError}</p>}

          {showManualAddForm && (
            <div className="monthly-manual-form">
              <div className="rebalance-input-item" style={{ maxWidth: 220 }}>
                <label htmlFor="manual-add-month">חודש</label>
                <input
                  id="manual-add-month"
                  type="month"
                  className="monthly-select"
                  max={currentMonthKey}
                  value={manualAddMonth}
                  onChange={(e) => handleManualAddMonthChange(e.target.value)}
                />
              </div>
              {manualAddMonth && renderAsOfInput('manual-add', manualAddMonth, manualAddAsOfDate, setManualAddAsOfDate)}
              {manualAddMonth && renderPensionStatements(manualAddAsOfDate)}
              {manualAddMonthAlreadySaved && (
                <p className="history-empty-note">
                  כבר קיימת שמירה לחודש זה - ניתן לערוך אותה למטה בהיסטוריית השמירות
                </p>
              )}

              {/* Derived, not typed: stocks priced from the month's own
                  historical closes for the lots held then, provident funds
                  from their recorded values + deposit ledger. Read-only on
                  purpose - there is nothing here the user could correct
                  that wouldn't be a correction to the main tables instead. */}
              <div className="monthly-manual-auto-section">
                <h4 className="monthly-manual-auto-title">נתונים שנמשכים אוטומטית מהטבלאות הראשיות</h4>
                {!manualAddMonth ? (
                  <p className="history-empty-note">בחרו חודש כדי לראות את הנתונים שיימשכו אוטומטית.</p>
                ) : !manualAddAutoBreakdown ? (
                  <p className="history-empty-note">{NO_HISTORY_YET}</p>
                ) : (
                  AUTO_DERIVED_CATEGORIES.map((catKey) => {
                    const rows = manualAddAutoBreakdown[catKey] || [];
                    const catTotal = rows.reduce((sum, item) => sum + (item.value || 0), 0);
                    return (
                      <div key={catKey} className="monthly-manual-category">
                        <div className="monthly-manual-category-header">
                          <span>
                            {MONTHLY_CATEGORY_LABELS_HE[catKey]}
                            <span className="monthly-auto-derived-badge"> · נגזר אוטומטית</span>
                          </span>
                          <span>{formatMoneyCell(catTotal)}</span>
                        </div>
                        {rows.length === 0 ? (
                          <div className="monthly-history-item-row monthly-item-placeholder">
                            לא הוחזקו נכסים בקטגוריה זו בחודש שנבחר
                          </div>
                        ) : (
                          rows.map((item) => (
                            <div key={item.key} className="monthly-history-item-row">
                              <span className="monthly-item-label">↳ {item.label}</span>
                              <span>{formatMoneyCell(item.value)}</span>
                            </div>
                          ))
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              {/* Typed: only the accounts with no traded price to look up. */}
              <div className="monthly-manual-entry-section">
                <h4 className="monthly-manual-auto-title">נתונים להזנה ידנית (נכסים נזילים)</h4>
                <div className="monthly-toolbar-buttons" style={{ marginBottom: 8 }}>
                  <button
                    type="button"
                    className="monthly-toolbar-btn"
                    onClick={handleAutoFillManualAdd}
                    disabled={!manualAddMonth}
                  >
                    ⚡ מלא מהפנקסים
                  </button>
                  <span className="monthly-status-text">
                    ממלא את השורות שלמטה מתוך פנקסי ההפקדות והעדכונים של החשבונות - נקודת פתיחה שניתן לתקן.
                  </span>
                </div>
                {autoFillMessage && <p className="history-empty-note">{autoFillMessage}</p>}

                {MANUAL_ENTRY_CATEGORIES.map((catKey) => (
                  <div key={catKey} className="monthly-manual-category">
                    <div className="monthly-manual-category-header">
                      <span>{MONTHLY_CATEGORY_LABELS_HE[catKey]}</span>
                      <button
                        type="button"
                        className="monthly-toolbar-btn"
                        onClick={() => addManualItemRow(catKey)}
                      >
                        + הוסף פריט
                      </button>
                    </div>
                    {manualAddItems[catKey].map((item) => (
                      <div key={item.id} className="monthly-manual-item-row">
                        <input
                          type="text"
                          className="edit-input"
                          placeholder='שם (למשל עו"ש)'
                          value={item.label}
                          onChange={(e) => updateManualItemRow(catKey, item.id, 'label', e.target.value)}
                        />
                        <input
                          type="number"
                          className="edit-input"
                          placeholder="שווי (₪)"
                          value={item.value}
                          step="0.01"
                          onChange={(e) => updateManualItemRow(catKey, item.id, 'value', e.target.value)}
                        />
                        <button
                          type="button"
                          className="monthly-toolbar-btn danger"
                          onClick={() => removeManualItemRow(catKey, item.id)}
                        >
                          הסר
                        </button>
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              {renderCashFlowInputs(manualAddCashFlows, handleManualAddCashFlowChange, 'manual-add')}

              <div className="date-item" style={{ marginTop: 12 }}>
                <span className="date-label">סה"כ: {formatMoneyCell(manualAddTotal)}</span>
                <div className="monthly-toolbar-buttons">
                  <button
                    type="button"
                    className="monthly-toolbar-btn"
                    onClick={handleSubmitManualAdd}
                    disabled={addingManual || !manualAddMonth || manualAddMonthAlreadySaved}
                  >
                    {addingManual ? 'שומר…' : 'שמור'}
                  </button>
                  <button type="button" className="monthly-toolbar-btn" onClick={() => setShowManualAddForm(false)}>
                    ביטול
                  </button>
                </div>
              </div>
            </div>
          )}

          {monthlySnapshotsLoading && monthlySnapshots.length === 0 ? (
            <p className="history-empty-note">טוען שמירות חודשיות…</p>
          ) : monthlySnapshots.length === 0 ? (
            <p className="history-empty-note">
              עדיין אין שמירות חודשיות. לחצו על "שמור שמירה חודשית" למעלה כדי לשמור את החודש הנוכחי, או על "הוספה
              ידנית" כדי למלא חודש עבר.
            </p>
          ) : (
            <>
              {monthlySnapshots.length >= 2 && (
                <>
                  <h3 style={{ marginTop: 8 }}>השוואה בין חודשים</h3>
                  <div className="rebalance-inputs-grid">
                    <div className="rebalance-input-item">
                      <label htmlFor="monthly-compare-base">חודש בסיס</label>
                      <select
                        id="monthly-compare-base"
                        className="monthly-select"
                        value={effectiveBaseMonth}
                        onChange={(e) => setSelectedBaseMonth(e.target.value)}
                      >
                        {monthlySnapshots.map((s) => (
                          <option key={s.month} value={s.month}>
                            {formatMonthLabel(s.month)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="rebalance-input-item">
                      <label htmlFor="monthly-compare-target">חודש להשוואה</label>
                      <select
                        id="monthly-compare-target"
                        className="monthly-select"
                        value={effectiveCompareMonth}
                        onChange={(e) => setSelectedCompareMonth(e.target.value)}
                      >
                        {monthlySnapshots.map((s) => (
                          <option key={s.month} value={s.month}>
                            {formatMonthLabel(s.month)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {baseMonthlySnapshot && compareMonthlySnapshot && (() => {
                    const from = snapshotAsOfDate(baseMonthlySnapshot);
                    const to = snapshotAsOfDate(compareMonthlySnapshot);
                    const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
                    return (
                      <p className="monthly-status-text" role="note">
                        התקופה הנמדדת: {formatDay(from)} ← {formatDay(to)} ({days} ימים). הפקדות ומשיכות שבין שני התאריכים
                        מנוטרלות מהתשואה.
                      </p>
                    );
                  })()}
                  <div className="stocks-table-container">
                    <table className="analysis-table">
                      <thead>
                        <tr>
                          <th>קטגוריה{detailedView ? ' / נכס' : ''}</th>
                          <th>
                            {formatMonthLabel(effectiveBaseMonth)}
                            <div className="monthly-cashflow-note">{formatAsOf(baseMonthlySnapshot)}</div>
                          </th>
                          <th>
                            {formatMonthLabel(effectiveCompareMonth)}
                            <div className="monthly-cashflow-note">{formatAsOf(compareMonthlySnapshot)}</div>
                          </th>
                          <th title="כשיש היסטוריית הפקדות/רכישות לקטגוריה, השינוי מנוטרל מהשפעת כסף חדש שנכנס באמצע התקופה - הוא לא נספר כתשואה">
                            שינוי (מנוטרל הפקדות)
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {monthlyComparisonRows.map((row) => (
                          <React.Fragment key={row.key}>
                            <tr className={row.key === 'total' ? 'monthly-total-row' : 'monthly-category-row'}>
                              <td>{row.label}</td>
                              <td>{formatMoneyCell(row.baseValue)}</td>
                              <td>{formatMoneyCell(row.compareValue)}</td>
                              <td
                                className={percentCellClass(row.changePercent)}
                                title={
                                  row.contributionAdjusted
                                    ? `לפני נטרול הפקדות/רכישות: ${formatPercentCell(row.rawChangePercent)}${row.partiallyAdjusted ? ' (מבוסס רק על קטגוריות עם היסטוריית הפקדות מתועדת)' : ''}`
                                    : undefined
                                }
                              >
                                {formatPercentCell(row.changePercent)}
                                {row.netCashFlow ? (
                                  <div className="monthly-cashflow-note">
                                    {row.netCashFlow > 0 ? '+' : ''}
                                    {formatMoneyCell(row.netCashFlow)} {row.netCashFlow > 0 ? 'הופקדו/נרכשו בתקופה' : 'נמשכו בתקופה'}
                                  </div>
                                ) : null}
                              </td>
                            </tr>
                            {detailedView && row.key !== 'total' && isLegacyRollup(row.items, row.key) && (
                              <tr className="monthly-item-row">
                                <td className="monthly-item-label" colSpan={4}>
                                  אין פירוט פריטים זמין להשוואה זו (אחד החודשים נשמר לפני שנוסף פירוט מלא)
                                </td>
                              </tr>
                            )}
                            {detailedView &&
                              !isLegacyRollup(row.items, row.key) &&
                              row.items.map((item) => (
                                <tr key={item.key} className="monthly-item-row">
                                  <td className="monthly-item-label">↳ {item.label}</td>
                                  <td>{formatMoneyCell(item.baseValue)}</td>
                                  <td>{formatMoneyCell(item.compareValue)}</td>
                                  <td
                                    className={percentCellClass(item.changePercent)}
                                    title={
                                      item.contributionAdjusted
                                        ? `לפני נטרול הפקדות/רכישות: ${formatPercentCell(item.rawChangePercent)}`
                                        : undefined
                                    }
                                  >
                                    {formatPercentCell(item.changePercent)}
                                    {item.netCashFlow ? (
                                      <div className="monthly-cashflow-note">
                                        {item.netCashFlow > 0 ? '+' : ''}
                                        {formatMoneyCell(item.netCashFlow)}
                                      </div>
                                    ) : null}
                                  </td>
                                </tr>
                              ))}
                          </React.Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              <h3 style={{ marginTop: 20 }}>היסטוריית שמירות</h3>
              <div className="rebalance-inputs-grid" style={{ marginBottom: 12 }}>
                <div className="rebalance-input-item">
                  <label htmlFor="monthly-history-select">בחר חודש להצגה</label>
                  <select
                    id="monthly-history-select"
                    className="monthly-select"
                    value={effectiveHistoryMonth}
                    onChange={(e) => setSelectedHistoryMonth(e.target.value)}
                  >
                    {monthlySnapshots.map((s) => (
                      <option key={s.month} value={s.month}>
                        {formatMonthLabel(s.month)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {updateMonthlyError && <p className="history-empty-note">{updateMonthlyError}</p>}
              {deleteMonthlyError && <p className="history-empty-note">{deleteMonthlyError}</p>}

              {historySnapshot &&
                (() => {
                  const isEditingThis = editingMonth === historySnapshot.month;
                  return (
                    <div className="monthly-history-list">
                      <div className="monthly-history-card">
                        <div className="date-item">
                          <span className="date-label">
                            {formatMonthLabel(historySnapshot.month)} — סה"כ{' '}
                            {formatMoneyCell(isEditingThis ? draftTotal : historySnapshot.totalValueILS)}
                            <span className="monthly-cashflow-note">
                              {' '}
                              ·{' '}
                              {formatAsOf(
                                isEditingThis ? { asOfDate: editDraftAsOfDate } : historySnapshot
                              )}
                            </span>
                          </span>
                          <div className="monthly-toolbar-buttons">
                            {isEditingThis ? (
                              <>
                                <button
                                  type="button"
                                  className="monthly-toolbar-btn"
                                  onClick={handleAutoFillEditedMonth}
                                >
                                  ⚡ מלא אוטומטית מהטבלאות
                                </button>
                                <button
                                  type="button"
                                  className="monthly-toolbar-btn"
                                  onClick={handleSaveEditedMonth}
                                  disabled={updatingMonth === historySnapshot.month}
                                >
                                  {updatingMonth === historySnapshot.month ? 'שומר…' : 'שמור עריכה'}
                                </button>
                                <button type="button" className="monthly-toolbar-btn" onClick={cancelEditingMonth}>
                                  ביטול
                                </button>
                              </>
                            ) : (
                              <>
                                {onUpdateMonthlySnapshot && (
                                  <button
                                    type="button"
                                    className="monthly-toolbar-btn"
                                    onClick={() => startEditingMonth(historySnapshot)}
                                  >
                                    ערוך
                                  </button>
                                )}
                                {onDeleteMonthlySnapshot && (
                                  <button
                                    type="button"
                                    className="monthly-toolbar-btn danger"
                                    onClick={() => handleDeleteMonth(historySnapshot.month)}
                                    disabled={deletingMonth === historySnapshot.month}
                                  >
                                    {deletingMonth === historySnapshot.month ? 'מוחק…' : 'מחק'}
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </div>

                        {MONTHLY_CATEGORY_KEYS.map((catKey) => {
                          const savedItems = normalizeCategoryItems(historySnapshot.breakdown?.[catKey], catKey);
                          const draftRows = isEditingThis ? editDraftBreakdown[catKey] : [];
                          if (!isEditingThis && savedItems.length === 0) return null;
                          const catTotal = isEditingThis
                            ? draftCategoryTotal(draftRows)
                            : savedItems.reduce((sum, it) => sum + (it.value || 0), 0);
                          const showPlaceholder = !isEditingThis && isLegacyRollup(savedItems, catKey);
                          const isAutoDerived = AUTO_DERIVED_CATEGORIES.includes(catKey);
                          return (
                            <div key={catKey} className="monthly-history-category">
                              <div className="monthly-history-category-header">
                                <span>
                                  {MONTHLY_CATEGORY_LABELS_HE[catKey]}
                                  {isEditingThis && isAutoDerived && (
                                    <span className="monthly-auto-derived-badge"> · נגזר אוטומטית</span>
                                  )}
                                </span>
                                <span className="monthly-history-category-actions">
                                  {formatMoneyCell(catTotal)}
                                  {isEditingThis && (
                                    <button
                                      type="button"
                                      className="monthly-toolbar-btn"
                                      onClick={() => addEditItemRow(catKey)}
                                    >
                                      + הוסף שורה
                                    </button>
                                  )}
                                </span>
                              </div>
                              {/* Rows are always shown while editing, whatever the
                                  detail toggle says - otherwise there would be
                                  nothing to add a row to or remove one from. */}
                              {(detailedView || isEditingThis) && showPlaceholder && (
                                <div className="monthly-history-item-row monthly-item-placeholder">
                                  אין פירוט פריטים לשמירה זו (נשמרה לפני שנוסף פירוט מלא)
                                </div>
                              )}
                              {!isEditingThis &&
                                detailedView &&
                                !showPlaceholder &&
                                savedItems.map((item) => (
                                  <div key={item.key} className="monthly-history-item-row">
                                    <span className="monthly-item-label">↳ {item.label}</span>
                                    <span>{formatMoneyCell(item.value)}</span>
                                  </div>
                                ))}
                              {/* While editing, both fields are plain always-on
                                  inputs keyed by the row's own stable rowId. No
                                  click-to-edit cell to open and close, and nothing
                                  about a row's identity changes as it's typed into,
                                  so the inputs are never remounted mid-keystroke. */}
                              {isEditingThis &&
                                draftRows.map((row) => (
                                  <div key={row.rowId} className="monthly-history-item-row">
                                    <input
                                      type="text"
                                      className="edit-input monthly-item-label-input"
                                      value={row.label}
                                      placeholder="שם הפריט"
                                      aria-label={`שם הפריט ב${MONTHLY_CATEGORY_LABELS_HE[catKey]}`}
                                      onChange={(e) => handleEditItemLabelChange(catKey, row.rowId, e.target.value)}
                                    />
                                    <input
                                      type="number"
                                      className="edit-input"
                                      value={row.valueText}
                                      step="0.01"
                                      placeholder="שווי (₪)"
                                      aria-label={`שווי הפריט ב${MONTHLY_CATEGORY_LABELS_HE[catKey]}`}
                                      onChange={(e) => handleEditItemValueChange(catKey, row.rowId, e.target.value)}
                                    />
                                    <button
                                      type="button"
                                      className="monthly-toolbar-btn danger"
                                      onClick={() => removeEditItemRow(catKey, row.rowId)}
                                    >
                                      הסר
                                    </button>
                                  </div>
                                ))}
                            </div>
                          );
                        })}
                        {isEditingThis && autoFillMessage && (
                          <p className="history-empty-note">{autoFillMessage}</p>
                        )}
                        {isEditingThis &&
                          renderAsOfInput('edit', historySnapshot.month, editDraftAsOfDate, setEditDraftAsOfDate)}
                        {isEditingThis && (
                          <p className="monthly-cashflow-hint">
                            שינוי התאריך לא משנה את הסכומים לבד - לחצו "מלא אוטומטית" כדי לחשב אותם מחדש לתאריך שנבחר.
                          </p>
                        )}
                        {isEditingThis && renderPensionStatements(editDraftAsOfDate || defaultAsOfDate(historySnapshot.month, todayDate))}
                        {isEditingThis && renderCashFlowInputs(editDraftCashFlows, handleEditCashFlowChange, 'edit')}
                      </div>
                    </div>
                  );
                })()}
            </>
          )}
        </div>

        </div>
      </div>
    </div>
  );
}

export default MonthlyTrackerView;
