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
// NO CASH FLOWS ARE TYPED IN HERE.
//
// Every category's deposits and withdrawals are already recorded, dated,
// in its own table - a purchase lot's date and cost, a provident fund's,
// money-market fund's, current account's or bank savings fund's deposit
// ledger - and the comparison reads them from there. A second, manual place
// to declare the same flow (which this form used to have for the liquid
// accounts) was two sources for one number with nothing to say which was
// right, and invited double-counting.
//
// The flows a month was saved with by hand, back when there were fields,
// are still read (see compareMonthlySnapshots) and have to survive a
// re-save or an edit untouched: the comparison for that month depends on
// them, and there is no way to re-enter them.
const savedCashFlows = (cashFlows) => {
  if (!cashFlows || typeof cashFlows !== 'object') return {};
  return Object.entries(cashFlows).reduce((acc, [key, value]) => {
    if (Number.isFinite(value) && value !== 0) acc[key] = value;
    return acc;
  }, {});
};

const EMPTY_TRANSACTIONS = [];

// Keeps a sign in front of its number inside right-to-left text.
const LRM = '\u200E';

// "₪1.44M" / "₪812K" - for the timeline, where a full figure under every
// month would not fit; the full one is in each bar's tooltip and below.
const formatCompactMoney = (v) => {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e6) return `₪${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `₪${Math.round(v / 1e3)}K`;
  return `₪${Math.round(v)}`;
};

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

  // ONE SELECTED MONTH drives the page: the timeline picks it, the panel
  // below shows it, compares it, edits it and deletes it. There used to be
  // three separate dropdowns for this - a base month, a compare month and
  // a "history" month - which could point at three different months at
  // once, with the table and the card below it describing different
  // things.
  //
  // '' means "the default": the latest saved month, compared with the one
  // saved before it - so the page follows new saves until the user picks
  // something else. A month that has since been deleted falls back to the
  // default too.
  const [selectedMonth, setSelectedMonth] = useState('');
  const [selectedBaseMonth, setSelectedBaseMonth] = useState('');
  const hasMonth = (m) => Boolean(m) && monthlySnapshots.some((s) => s.month === m);
  const latestMonth = monthlySnapshots.length ? monthlySnapshots[monthlySnapshots.length - 1].month : '';
  const effectiveMonth = hasMonth(selectedMonth) ? selectedMonth : latestMonth;
  const selectedIndex = monthlySnapshots.findIndex((s) => s.month === effectiveMonth);
  const defaultBaseMonth = selectedIndex > 0 ? monthlySnapshots[selectedIndex - 1].month : '';
  const effectiveBaseMonth =
    hasMonth(selectedBaseMonth) && selectedBaseMonth !== effectiveMonth ? selectedBaseMonth : defaultBaseMonth;
  const selectedSnapshot = monthlySnapshots.find((s) => s.month === effectiveMonth) || null;
  const baseSnapshot = monthlySnapshots.find((s) => s.month === effectiveBaseMonth) || null;
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
    () => compareMonthlySnapshots(baseSnapshot, selectedSnapshot, monthlyLiveHoldings, monthlySnapshots),
    [baseSnapshot, selectedSnapshot, monthlyLiveHoldings, monthlySnapshots]
  );
  // Each saved month's change from the one before it, deposits netted out
  // - what the timeline shows under every month.
  const monthTrend = useMemo(
    () =>
      monthlySnapshots.map((snapshot, i) => {
        if (i === 0) return { month: snapshot.month, total: snapshot.totalValueILS, changePercent: null };
        const rows = compareMonthlySnapshots(monthlySnapshots[i - 1], snapshot, monthlyLiveHoldings, monthlySnapshots);
        const total = rows.find((r) => r.key === 'total');
        return { month: snapshot.month, total: snapshot.totalValueILS, changePercent: total ? total.changePercent : null };
      }),
    [monthlySnapshots, monthlyLiveHoldings]
  );
  const selectMonth = (month) => {
    if (editingMonth && editingMonth !== month) cancelEditingMonth();
    setSelectedMonth(month);
    setSelectedBaseMonth('');
  };
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
  // Carried through the edit untouched - see savedCashFlows.
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
    setEditingMonth(snapshot.month);
    setEditDraftAsOfDate(snapshot.asOfDate || snapshot.breakdown?.asOfDate || null);
    setEditDraftBreakdown(buildDraftFromBreakdown(snapshot.breakdown));
    setEditLegacyCashFlows(savedCashFlows(snapshot.breakdown?.cashFlows));
  };

  const cancelEditingMonth = () => {
    setEditingMonth(null);
    setEditDraftBreakdown(null);
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
    breakdown.cashFlows = editLegacyCashFlows;
    if (editDraftAsOfDate) breakdown.asOfDate = editDraftAsOfDate;
    const ok = await onUpdateMonthlySnapshot(editingMonth, draftTotal, breakdown);
    if (ok) cancelEditingMonth();
  };

  const handleDeleteMonth = async (month) => {
    if (!onDeleteMonthlySnapshot) return;
    const ok = window.confirm(`למחוק לצמיתות את השמירה החודשית של ${formatMonthLabel(month)}? לא ניתן לשחזר לאחר המחיקה.`);
    if (!ok) return;
    const deleted = await onDeleteMonthlySnapshot(month);
    if (deleted) {
      // the deleted month may have been selected anywhere - drop back to
      // the (recomputed) defaults rather than pointing at a gone month
      if (editingMonth === month) cancelEditingMonth();
      if (selectedMonth === month) setSelectedMonth('');
      if (selectedBaseMonth === month) setSelectedBaseMonth('');
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
  const manualAddIdRef = useRef(0);

  const openManualAddForm = () => {
    setShowManualAddForm(true);
    setManualAddMonth('');
    setManualAddAsOfDate('');
    setManualAddItems(emptyManualItems());
    setAutoFillMessage('');
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
    // Valid for the date the user picked, which is the date every row above
    // was valued at - not "some time that month".
    breakdown.asOfDate = manualAddAsOfDate;
    const ok = await onAddManualMonthlySnapshot(manualAddMonth, manualAddTotal, breakdown);
    if (ok) setShowManualAddForm(false);
  };

  // Saving/updating *today's* month (the "שמור שמירה חודשית" button above
  // the comparison table - not editingMonth's "ערוך" flow, which corrects
  // an already-saved past month).
  const [saveAsOfDate, setSaveAsOfDate] = useState(todayDate);
  const [saveAsOfMessage, setSaveAsOfMessage] = useState('');
  const handleSaveMonthlySnapshotClick = () => {
    // Re-saving this month REPLACES its stored row, so any flow it was
    // saved with by hand would be lost with it - the same silent drop the
    // edit flow guards against. Carried through here too.
    const existing = monthlySnapshots.find((snap) => snap.month === currentMonthKey);
    const legacy = savedCashFlows(existing?.breakdown?.cashFlows);
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
    onSaveMonthlySnapshot(legacy, { asOfDate: saveAsOfDate, breakdown });
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
  // Folded to one line that says whether anything needs attention. As a
  // list it was the longest thing on the page - seven warnings above the
  // figures they qualify - for a check most visits need only the verdict of.
  const renderPensionStatements = (asOfDate) => {
    if (!asOfDate || pensionFunds.length === 0) return null;
    const statuses = pensionStatementsAtDate(pensionFunds, asOfDate);
    const offCount = statuses.filter((s) => s.status !== 'match').length;
    return (
      <details className={`mt-statements ${offCount > 0 ? 'is-off' : 'is-ok'}`} role="status">
        <summary>
          <span className="mt-statements-icon" aria-hidden="true">
            {offCount > 0 ? '!' : '✓'}
          </span>
          קופות גמל מול תאריך {formatDay(asOfDate)}
          {offCount > 0 ? ` · ${offCount} לא תואמות` : ' · כולן תואמות'}
        </summary>
        <ul className="mt-statements-list">
          {statuses.map((s) => (
            <li key={s.key} className={s.status === 'match' ? '' : 'is-off'}>
              <span className="mt-statements-name">
                {s.status === 'match' ? '✓' : '⚠'} {s.name}
              </span>
              <span>{STATEMENT_TEXT[s.status](s)}</span>
            </li>
          ))}
        </ul>
        {offCount > 0 && (
          <p className="monthly-cashflow-hint">
            דוח נחשב תואם אם הוא עד {STATEMENT_TOLERANCE_DAYS} ימים מהתאריך. לעדכון: עדכנו את שווי הקופה בטבלה לפי
            הדוח הרלוונטי, ואז שמרו שוב.
          </p>
        )}
      </details>
    );
  };

  const formatMoneyCell = (v) => (v != null ? `${formatPriceWithSign(v)} ₪` : '—');
  const formatPercentCell = (v) => (v != null ? `${LRM}${v >= 0 ? '+' : ''}${v.toFixed(1)}%` : '—');
  const toneOf = (v) => (v == null ? 'flat' : v > 0.05 ? 'up' : v < -0.05 ? 'down' : 'flat');
  const percentCellClass = (v) => (v == null ? '' : v >= 0 ? 'profit-positive' : 'profit-negative');

  // Deposits and withdrawals are not typed in here: every account's come
  // from its own ledger, by date, in the comparison below.
  const ledgerFlowsNote = (
    <p className="monthly-cashflow-hint">
      הפקדות ומשיכות נלקחות אוטומטית מהטבלאות של כל חשבון (קרנות כספיות, עו"ש, קופות חיסכון, קופות גמל ומניות) לפי
      התאריך שלהן, ומנוטרלות מהתשואה.
    </p>
  );

  // The timeline's bars run from a floor rather than from zero: a
  // portfolio that moved 2% in a month would otherwise draw every bar at
  // the same height.
  const trendValues = monthTrend.map((t) => t.total).filter((v) => Number.isFinite(v));
  const trendMin = trendValues.length ? Math.min(...trendValues) : 0;
  const trendMax = trendValues.length ? Math.max(...trendValues) : 0;
  const barHeight = (v) => {
    if (!Number.isFinite(v) || trendMax <= 0) return 8;
    if (trendMax === trendMin) return 70;
    return 22 + ((v - trendMin) / (trendMax - trendMin)) * 78;
  };

  const totalRow = monthlyComparisonRows.find((r) => r.key === 'total') || null;
  const categoryRows = monthlyComparisonRows.filter((r) => r.key !== 'total');

  // The selected month's categories when there is nothing to compare it
  // with (the first month saved): values only.
  const standaloneCategories = selectedSnapshot
    ? MONTHLY_CATEGORY_KEYS.map((key) => {
        const items = normalizeCategoryItems(selectedSnapshot.breakdown?.[key], key);
        return {
          key,
          label: MONTHLY_CATEGORY_LABELS_HE[key],
          compareValue: items.length ? items.reduce((sum, it) => sum + (it.value || 0), 0) : null,
          baseValue: null,
          changePercent: null,
          netCashFlow: 0,
          items: items.map((it) => ({ ...it, compareValue: it.value, baseValue: null, changePercent: null })),
          legacy: isLegacyRollup(items, key)
        };
      }).filter((c) => c.compareValue != null)
    : [];

  const shownCategories = baseSnapshot
    ? categoryRows
        .filter((row) => row.baseValue != null || row.compareValue != null)
        .map((row) => ({ ...row, legacy: isLegacyRollup(row.items, row.key) }))
    : standaloneCategories;
  const selectedTotal = selectedSnapshot ? selectedSnapshot.totalValueILS : 0;

  // One category: its share of the month as a bar, its value, and its
  // change - with the money that came in or went out said in words.
  const renderCategory = (cat) => {
    const share = selectedTotal > 0 && cat.compareValue != null ? (cat.compareValue / selectedTotal) * 100 : 0;
    return (
      <li key={cat.key} className="mt-cat">
        <div className="mt-cat-main">
          <div className="mt-cat-head">
            <span className="mt-cat-name">{cat.label}</span>
            <span className="mt-cat-value">{formatMoneyCell(cat.compareValue)}</span>
          </div>
          <div className="mt-cat-bar" role="presentation">
            <span style={{ width: `${Math.max(0, Math.min(100, share))}%` }} />
          </div>
          <div className="mt-cat-meta">
            <span>{share > 0 ? `${share.toFixed(1)}% מהתיק` : 'לא הוחזק בחודש הזה'}</span>
            {cat.baseValue != null && <span>· קודם {formatMoneyCell(cat.baseValue)}</span>}
            {cat.netCashFlow ? (
              <span className="mt-cat-flow">
                · {cat.netCashFlow > 0 ? '+' : ''}
                {formatMoneyCell(cat.netCashFlow)} {cat.netCashFlow > 0 ? 'הופקדו/נרכשו בתקופה' : 'נמשכו בתקופה'}
              </span>
            ) : null}
          </div>
        </div>
        {baseSnapshot && (
          <span
            className={`mt-change is-${toneOf(cat.changePercent)}`}
            title={
              cat.contributionAdjusted
                ? `לפני נטרול הפקדות/רכישות: ${formatPercentCell(cat.rawChangePercent)}`
                : undefined
            }
          >
            {formatPercentCell(cat.changePercent)}
          </span>
        )}
        {detailedView && cat.legacy && (
          <p className="mt-items-note">
            {baseSnapshot
              ? 'אין פירוט פריטים זמין להשוואה זו (אחד החודשים נשמר לפני שנוסף פירוט מלא)'
              : 'אין פירוט פריטים לשמירה זו (נשמרה לפני שנוסף פירוט מלא)'}
          </p>
        )}
        {detailedView && !cat.legacy && cat.items.length > 0 && (
          <ul className="mt-items">
            {cat.items.map((item) => (
              <li key={item.key}>
                <span className="mt-item-label">{item.label}</span>
                <span className="mt-item-values">
                  {item.baseValue != null && baseSnapshot ? `${formatMoneyCell(item.baseValue)} ← ` : ''}
                  {formatMoneyCell(item.compareValue)}
                </span>
                {baseSnapshot && (
                  <span
                    className={percentCellClass(item.changePercent)}
                    title={
                      item.contributionAdjusted
                        ? `לפני נטרול הפקדות/רכישות: ${formatPercentCell(item.rawChangePercent)}`
                        : undefined
                    }
                  >
                    {formatPercentCell(item.changePercent)}
                    {item.netCashFlow ? ` (${item.netCashFlow > 0 ? '+' : ''}${formatMoneyCell(item.netCashFlow)})` : ''}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </li>
    );
  };

  // The editor for the selected month - unchanged in what it does, only
  // moved into the month's own panel.
  const renderEditor = () => (
    <>
      {MONTHLY_CATEGORY_KEYS.map((catKey) => {
        const draftRows = editDraftBreakdown[catKey];
        const catTotal = draftCategoryTotal(draftRows);
        const isAutoDerived = AUTO_DERIVED_CATEGORIES.includes(catKey);
        return (
          <div key={catKey} className="monthly-history-category">
            <div className="monthly-history-category-header">
              <span>
                {MONTHLY_CATEGORY_LABELS_HE[catKey]}
                {isAutoDerived && <span className="monthly-auto-derived-badge"> · נגזר אוטומטית</span>}
              </span>
              <span className="monthly-history-category-actions">
                {formatMoneyCell(catTotal)}
                <button type="button" className="monthly-toolbar-btn" onClick={() => addEditItemRow(catKey)}>
                  + הוסף שורה
                </button>
              </span>
            </div>
            {/* Both fields are plain always-on inputs keyed by the row's
                own stable rowId - nothing about a row's identity changes
                as it's typed into, so the inputs never remount. */}
            {draftRows.map((row) => (
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
      {autoFillMessage && <p className="history-empty-note">{autoFillMessage}</p>}
      {renderAsOfInput('edit', editingMonth, editDraftAsOfDate, setEditDraftAsOfDate)}
      <p className="monthly-cashflow-hint">
        שינוי התאריך לא משנה את הסכומים לבד - לחצו "מלא אוטומטית" כדי לחשב אותם מחדש לתאריך שנבחר.
      </p>
      {renderPensionStatements(editDraftAsOfDate || defaultAsOfDate(editingMonth, todayDate))}
    </>
  );

  return (
    <div className="App">
      <div className="analysis-container">
        <div className="analysis-content">
          <PageToolbar
            title="מעקב חודשי"
            subtitle="צילום מצב של התיק בכל חודש - איך הוא השתנה, ומה השתנה בו"
          />

          {/* Checkpoints are typed in by hand here, so this is a screen
              that invites real figures. */}
          <BetaBanner tone="data" />

          {historyLoading && <p className="history-empty-note">טוען נתונים היסטוריים למילוי אוטומטי…</p>}

          <div className="analysis-section">
            <h2 className="section-title">מעקב חודשי</h2>

            {/* THIS MONTH: the one thing the page asks the user to do,
                with the state of it said first. */}
            <div className={`mt-now ${currentMonthAlreadySaved ? 'is-saved' : 'is-pending'}`}>
              <div className="mt-now-status">
                <span className="mt-now-icon" aria-hidden="true">
                  {currentMonthAlreadySaved ? '✓' : '○'}
                </span>
                <div>
                  <p className="monthly-status-text mt-now-title">
                    {currentMonthAlreadySaved
                      ? `החודש (${formatMonthLabel(currentMonthKey)}) נשמר`
                      : `החודש (${formatMonthLabel(currentMonthKey)}) עדיין לא נשמר`}
                  </p>
                  <p className="mt-now-sub">
                    {currentMonthAlreadySaved
                      ? 'אפשר לעדכן את השמירה בכל רגע - היא תחליף את הקודמת'
                      : 'שמירה אחת בחודש מספיקה כדי לראות כאן איך התיק משתנה'}
                  </p>
                </div>
              </div>
              <div className="mt-now-actions">
                {renderAsOfInput('save', currentMonthKey, saveAsOfDate, (v) => {
                  setSaveAsOfDate(v);
                  setSaveAsOfMessage('');
                })}
                <button
                  type="button"
                  className="mt-primary-btn"
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
              </div>
              {saveAsOfMessage && <p className="history-empty-note">{saveAsOfMessage}</p>}
              {renderPensionStatements(saveAsOfDate)}
              {ledgerFlowsNote}
              {saveMonthlyError && <p className="history-empty-note">{saveMonthlyError}</p>}
              {addManualError && <p className="history-empty-note">{addManualError}</p>}
            </div>

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
                  <p className="history-empty-note">כבר קיימת שמירה לחודש זה - ניתן לבחור אותו בציר החודשים ולערוך אותו</p>
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
                        <button type="button" className="monthly-toolbar-btn" onClick={() => addManualItemRow(catKey)}>
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

                {ledgerFlowsNote}

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
                {/* THE TIMELINE: every saved month as a bar you can press.
                    The height is the portfolio's value, the badge under it
                    is the month's change with deposits netted out. Pressing
                    one shows that month below, compared with the month
                    before it. */}
                <h3 className="mt-heading">התיק לאורך החודשים</h3>
                <div className="mt-timeline" role="group" aria-label="בחירת חודש">
                  {monthTrend.map((t) => (
                    <button
                      key={t.month}
                      type="button"
                      className={`mt-month ${t.month === effectiveMonth ? 'is-selected' : ''}`}
                      aria-pressed={t.month === effectiveMonth}
                      onClick={() => selectMonth(t.month)}
                      title={`${formatMonthLabel(t.month)} - ${formatMoneyCell(t.total)}`}
                    >
                      <span className="mt-month-value">{formatCompactMoney(t.total)}</span>
                      <span className="mt-month-track" aria-hidden="true">
                        <span className="mt-month-bar" style={{ height: `${barHeight(t.total)}%` }} />
                      </span>
                      <span className="mt-month-label">{formatMonthLabel(t.month)}</span>
                      <span className={`mt-month-change is-${toneOf(t.changePercent)}`}>
                        {t.changePercent == null ? 'חודש ראשון' : formatPercentCell(t.changePercent)}
                      </span>
                    </button>
                  ))}
                </div>

                {updateMonthlyError && <p className="history-empty-note">{updateMonthlyError}</p>}
                {deleteMonthlyError && <p className="history-empty-note">{deleteMonthlyError}</p>}

                {/* THE SELECTED MONTH: what it was worth, how that compares
                    with the month before it, and what each part did. */}
                {selectedSnapshot &&
                  (() => {
                    const isEditingThis = editingMonth === selectedSnapshot.month;
                    const totalChange = totalRow ? totalRow.changePercent : null;
                    const valueChange =
                      totalRow && totalRow.baseValue != null && totalRow.compareValue != null
                        ? totalRow.compareValue - totalRow.baseValue
                        : null;
                    return (
                      <div className="monthly-history-card mt-panel">
                        <div className="mt-panel-head">
                          <div>
                            <h3 className="mt-panel-title">{formatMonthLabel(selectedSnapshot.month)}</h3>
                            <p className="mt-panel-asof">
                              {formatAsOf(isEditingThis ? { asOfDate: editDraftAsOfDate } : selectedSnapshot)}
                            </p>
                          </div>
                          <div className="monthly-toolbar-buttons">
                            {isEditingThis ? (
                              <>
                                <button type="button" className="monthly-toolbar-btn" onClick={handleAutoFillEditedMonth}>
                                  ⚡ מלא אוטומטית מהטבלאות
                                </button>
                                <button
                                  type="button"
                                  className="monthly-toolbar-btn"
                                  onClick={handleSaveEditedMonth}
                                  disabled={updatingMonth === selectedSnapshot.month}
                                >
                                  {updatingMonth === selectedSnapshot.month ? 'שומר…' : 'שמור עריכה'}
                                </button>
                                <button type="button" className="monthly-toolbar-btn" onClick={cancelEditingMonth}>
                                  ביטול
                                </button>
                              </>
                            ) : (
                              <>
                                <button type="button" className="monthly-toolbar-btn" onClick={() => setDetailedView((v) => !v)}>
                                  {detailedView ? 'קבץ לפי קטגוריות' : 'פתח פירוט מלא'}
                                </button>
                                {onUpdateMonthlySnapshot && (
                                  <button
                                    type="button"
                                    className="monthly-toolbar-btn"
                                    onClick={() => startEditingMonth(selectedSnapshot)}
                                  >
                                    ערוך
                                  </button>
                                )}
                                {onDeleteMonthlySnapshot && (
                                  <button
                                    type="button"
                                    className="monthly-toolbar-btn danger"
                                    onClick={() => handleDeleteMonth(selectedSnapshot.month)}
                                    disabled={deletingMonth === selectedSnapshot.month}
                                  >
                                    {deletingMonth === selectedSnapshot.month ? 'מוחק…' : 'מחק'}
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </div>

                        <div className="mt-panel-summary">
                          <div className="mt-panel-total">
                            <span className="mt-panel-total-label">שווי התיק</span>
                            <span className="mt-panel-total-value">
                              {formatMoneyCell(isEditingThis ? draftTotal : selectedSnapshot.totalValueILS)}
                            </span>
                          </div>
                          {!isEditingThis && baseSnapshot && totalRow && (
                            <div className={`mt-panel-change is-${toneOf(totalChange)}`}>
                              <span className="mt-panel-change-value">{formatPercentCell(totalChange)}</span>
                              <span className="mt-panel-change-text">
                                ביצועי התיק מאז {formatMonthLabel(baseSnapshot.month)}, בלי לספור הפקדות
                                {valueChange != null && (
                                  <>
                                    <br />
                                    השווי {valueChange >= 0 ? 'עלה' : 'ירד'} ב-{formatMoneyCell(Math.abs(valueChange))}
                                    {totalRow.netCashFlow
                                      ? `, מתוכם ${formatMoneyCell(Math.abs(totalRow.netCashFlow))} ${
                                          totalRow.netCashFlow > 0 ? 'הפקדות' : 'משיכות'
                                        }`
                                      : ''}
                                  </>
                                )}
                              </span>
                            </div>
                          )}
                        </div>

                        {!isEditingThis && monthlySnapshots.length >= 2 && (
                          <div className="mt-compare">
                            <label htmlFor="monthly-compare-base">השוואה מול</label>
                            <select
                              id="monthly-compare-base"
                              className="monthly-select"
                              value={effectiveBaseMonth}
                              onChange={(e) => setSelectedBaseMonth(e.target.value)}
                            >
                              {!effectiveBaseMonth && <option value="">בחרו חודש</option>}
                              {monthlySnapshots
                                .filter((s) => s.month !== effectiveMonth)
                                .map((s) => (
                                  <option key={s.month} value={s.month}>
                                    {formatMonthLabel(s.month)}
                                  </option>
                                ))}
                            </select>
                            {baseSnapshot &&
                              (() => {
                                const from = snapshotAsOfDate(baseSnapshot);
                                const to = snapshotAsOfDate(selectedSnapshot);
                                const days = Math.round(
                                  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000
                                );
                                return (
                                  <span className="mt-compare-period" role="note">
                                    התקופה הנמדדת: {formatDay(from)} ← {formatDay(to)} ({days} ימים). הפקדות ומשיכות שבין
                                    שני התאריכים מנוטרלות מהתשואה.
                                  </span>
                                );
                              })()}
                          </div>
                        )}

                        {isEditingThis ? (
                          renderEditor()
                        ) : (
                          <ul className="mt-cats">{shownCategories.map(renderCategory)}</ul>
                        )}
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
