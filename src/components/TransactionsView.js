import React, { useCallback, useMemo, useState } from 'react';
import PageToolbar from './PageToolbar';
import BetaBanner from './BetaBanner';
import BottomSheet from './ui/BottomSheet';
import { computeRealizedGains } from '../utils/realizedGains';
import { todayISO, formatMonthLabel } from '../utils/portfolioDates';
import { formatDate } from '../utils/formatters';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { ACTION_LABELS, ASSET_CLASSES, accountLabel, classInfo, heldSymbols } from '../utils/assetEntry';

// /transactions - the HISTORY of sales, purchases, dividends, deposits and
// withdrawals: browsing, filtering, editing and deleting what was recorded.
//
// It does not record anything itself. New entries go through the one entry
// form (AssetEntryModal.js) like every other change to a holding - this page
// opens it, and opens it pre-filled with a line to edit it. A creation form
// of its own here was a second way to record the same events, and the add
// page was a third; see utils/assetEntry.js.
//
// Recording a sale through the ledger (rather than editing a lot's quantity
// down in the stocks table) is what keeps every return figure honest: the
// sold units stay in the history up to the sale date and the proceeds are
// booked as money leaving, so a sale is never read as a loss. See
// shared/transactionLedger.js for the full model.

export const TYPE_LABELS = {
  SELL: ACTION_LABELS.SELL,
  BUY: ACTION_LABELS.BUY,
  DIVIDEND: ACTION_LABELS.DIVIDEND,
  DEPOSIT: ACTION_LABELS.DEPOSIT,
  WITHDRAWAL: ACTION_LABELS.WITHDRAWAL
};

export { heldSymbols };

const isStockType = (type) => type === 'BUY' || type === 'SELL' || type === 'DIVIDEND';

// Form-shaped values -> the request body the API validates. Kept for the
// callers (and tests) that build a transaction from plain fields.
export function buildTransactionPayload(form) {
  const base = { type: form.type, date: form.date, assetClass: form.assetClass, assetId: form.assetId, note: form.note || undefined };
  if (form.type === 'BUY' || form.type === 'SELL') {
    return {
      ...base,
      units: Number(form.units),
      price: Number(form.price),
      fees: form.fees === '' ? 0 : Number(form.fees),
      fxRate: form.assetClass === 'american' ? Number(form.fxRate) : undefined,
      lotMethod: form.type === 'SELL' ? form.lotMethod : undefined
    };
  }
  if (form.type === 'DIVIDEND') {
    return {
      ...base,
      amount: Number(form.amount),
      taxWithheld: form.taxWithheld === '' ? 0 : Number(form.taxWithheld),
      fxRate: form.assetClass === 'american' ? Number(form.fxRate) : undefined
    };
  }
  return { ...base, amount: Number(form.amount) };
}

export function describeAsset(tx, holdings) {
  if (isStockType(tx.type)) {
    const lots = holdings[classInfo(tx.assetClass).holdingsKey] || [];
    const named = lots.find((l) => String(l.stockName) === String(tx.assetId) && l.officialName);
    return named ? `${named.officialName} (${tx.assetId})` : tx.assetId;
  }
  const info = classInfo(tx.assetClass);
  const accounts = holdings[info.holdingsKey] || [];
  const index = accounts.findIndex((a) => String(a.id) === String(tx.assetId));
  const name = index >= 0 ? accountLabel(tx.assetClass, accounts[index], index) : '';
  return `${info.label}${name && name !== info.label ? ` - ${name}` : ''}${tx.createdAccountId !== undefined ? ' (פתיחה)' : ''}`;
}

const EMPTY_FILTERS = { type: '', assetClass: '', text: '', from: '', to: '' };

// The history newest first, in calendar months - the way a statement is
// read on a phone, where a nine-column table does not fit. Pure.
export function groupByMonth(transactions) {
  const groups = [];
  [...(transactions || [])]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .forEach((tx) => {
      const month = String(tx.date || '').slice(0, 7);
      const last = groups[groups.length - 1];
      if (last && last.month === month) last.items.push(tx);
      else groups.push({ month, items: [tx] });
    });
  return groups;
}

// The history, narrowed by the filters. Pure, so it is tested directly.
export function filterTransactions(transactions, filters, holdings) {
  const text = String(filters.text || '').trim().toLowerCase();
  return (transactions || []).filter((tx) => {
    if (filters.type && tx.type !== filters.type) return false;
    if (filters.assetClass && tx.assetClass !== filters.assetClass) return false;
    if (filters.from && tx.date < filters.from) return false;
    if (filters.to && tx.date > filters.to) return false;
    if (text) {
      const haystack = `${describeAsset(tx, holdings)} ${tx.assetId} ${tx.note || ''}`.toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    return true;
  });
}

function TransactionsView({
  israeliStocks = [],
  americanStocks = [],
  pensionFunds = [],
  cashFunds = [],
  bankBalances = [],
  bankSavingsFunds = [],
  transactions = [],
  transactionsLoading = false,
  // Opens the entry form blank, or pre-filled with a line to correct it.
  onNewTransaction,
  onEditTransaction,
  onDeleteTransaction,
  cpi = null,
  formatPriceWithSign = (v) => String(v)
}) {
  const holdings = { israeliStocks, americanStocks, pensionFunds, cashFunds, bankBalances, bankSavingsFunds };
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [message, setMessage] = useState(null);

  const realized = useMemo(
    () => computeRealizedGains(transactions, { indexByMonth: cpi?.indexByMonth || {} }),
    [transactions, cpi]
  );
  const currentYear = todayISO().slice(0, 4);
  const yearTotals = realized.byYear[currentYear];

  const visible = filterTransactions(transactions, filters, holdings);
  const setFilter = (name, value) => setFilters((prev) => ({ ...prev, [name]: value }));
  const filtersActive = Object.values(filters).some(Boolean);

  // THE PAGE ON A PHONE: the realized-gain totals first as three small
  // tiles, then search and the type buttons, the rest of the filters in a
  // sheet, and the history as cards by month instead of a table.
  const isPhone = useMediaQuery('(max-width: 768px)');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const closeFilters = useCallback(() => setFiltersOpen(false), []);
  // What the sheet holds and is set away from "everything".
  const sheetFilterCount = [filters.assetClass, filters.from, filters.to].filter(Boolean).length;

  const handleDelete = async (tx) => {
    const ok = window.confirm(`למחוק את ה${TYPE_LABELS[tx.type]} מ-${tx.date}? הפעולה תבוטל גם בתיק.`);
    if (!ok) return;
    const result = await onDeleteTransaction(tx.id);
    setMessage(result.ok ? { tone: 'ok', text: 'העסקה נמחקה והתיק עודכן' } : { tone: 'error', text: result.error || 'המחיקה נכשלה' });
  };

  const amountText = (tx) =>
    tx.amountILS !== null && tx.amountILS !== undefined ? `${formatPriceWithSign(tx.amountILS)} ₪` : '';

  const rowActions = (tx) => (
    <>
      {onEditTransaction && (
        <button
          type="button"
          className="benchmark-toggle-button"
          onClick={() => onEditTransaction(tx)}
          aria-label={`עריכת עסקה ${tx.date}`}
        >
          עריכה
        </button>
      )}
      <button type="button" className="benchmark-toggle-button" onClick={() => handleDelete(tx)} aria-label={`מחיקת עסקה ${tx.date}`}>
        מחיקה
      </button>
    </>
  );

  const realizedSection = (
    <div className="analysis-section tx-realized">
      <h2 className="section-title">רווח הון ממומש {currentYear}</h2>
      <div className="distribution-grid">
        <div className="distribution-card">
          <h3>רווח ריאלי נטו</h3>
          <div className={`distribution-value ${(yearTotals?.netRealGainILS || 0) >= 0 ? 'profit-positive' : 'profit-negative'}`}>
            {formatPriceWithSign(yearTotals?.netRealGainILS || 0)} ₪
          </div>
          <div className="distribution-percentage">{yearTotals?.count || 0} מנות שמומשו</div>
        </div>
        <div className="distribution-card">
          <h3>הפסדים ממומשים לקיזוז</h3>
          <div className="distribution-value profit-negative">{formatPriceWithSign(yearTotals?.realLossesILS || 0)} ₪</div>
        </div>
        <div className="distribution-card">
          <h3>מס משוער (25%)</h3>
          <div className="distribution-value">{formatPriceWithSign(yearTotals?.estimatedTaxILS || 0)} ₪</div>
          <div className="distribution-percentage">הערכה בלבד, לא ייעוץ מס</div>
        </div>
      </div>
    </div>
  );

  const assetClassSelect = (
    <select id="tx-filter-class" className="monthly-select" value={filters.assetClass} onChange={(e) => setFilter('assetClass', e.target.value)}>
      <option value="">הכול</option>
      {ASSET_CLASSES.map((c) => (
        <option key={c.key} value={c.key}>
          {c.label}
        </option>
      ))}
    </select>
  );

  const dateInputs = (
    <>
      <div className="rebalance-input-item">
        <label htmlFor="tx-filter-from">מתאריך</label>
        <input id="tx-filter-from" className="monthly-select" type="date" value={filters.from} onChange={(e) => setFilter('from', e.target.value)} />
      </div>
      <div className="rebalance-input-item">
        <label htmlFor="tx-filter-to">עד תאריך</label>
        <input id="tx-filter-to" className="monthly-select" type="date" value={filters.to} onChange={(e) => setFilter('to', e.target.value)} />
      </div>
    </>
  );

  return (
    <div className="App phone-flat">
      <div className="analysis-container">
        <div className="analysis-content">
          <PageToolbar
            title="עסקאות"
            subtitle="יומן כל הפעולות - קניות, מכירות, דיבידנדים, הפקדות ומשיכות. רישום ועריכה דרך טופס ההוספה האחד."
            sticky={!isPhone}
          />
          <BetaBanner tone="data" />

          {/* The year's totals are what a person checks; on a phone they
              come before the history rather than after all of it. */}
          {isPhone && realizedSection}

          <div className="analysis-section">
            <div className="rebalance-sum-row">
              <h2 className="section-title">כל העסקאות</h2>
              {onNewTransaction && (
                <button type="button" className="benchmark-toggle-button active" onClick={onNewTransaction}>
                  + רישום עסקה
                </button>
              )}
            </div>

            {isPhone ? (
              <div className="tx-phone-filters" role="search" aria-label="סינון עסקאות">
                <div className="tx-phone-search">
                  <label htmlFor="tx-filter-text" className="visually-hidden">
                    חיפוש
                  </label>
                  <input
                    id="tx-filter-text"
                    className="monthly-select"
                    type="search"
                    value={filters.text}
                    placeholder="חיפוש נייר, חשבון או הערה"
                    onChange={(e) => setFilter('text', e.target.value)}
                  />
                  <button
                    type="button"
                    className="perf-filter-button"
                    aria-haspopup="dialog"
                    aria-expanded={filtersOpen}
                    onClick={() => setFiltersOpen(true)}
                  >
                    סינון
                    {sheetFilterCount > 0 && (
                      <span className="perf-filter-count" aria-label={`${sheetFilterCount} פעילים`}>
                        {sheetFilterCount}
                      </span>
                    )}
                  </button>
                </div>
                <div className="tx-type-chips" role="group" aria-label="סוג">
                  {[['', 'הכול'], ...Object.entries(TYPE_LABELS)].map(([key, label]) => (
                    <button
                      key={key || 'all'}
                      type="button"
                      className={`period-toggle ${filters.type === key ? 'active' : ''}`}
                      aria-pressed={filters.type === key}
                      onClick={() => setFilter('type', key)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {filtersOpen && (
                  <BottomSheet
                    title="סינון עסקאות"
                    onClose={closeFilters}
                    footer={
                      <button type="button" className="perf-filter-apply" onClick={closeFilters}>
                        הצגת {visible.length} עסקאות
                      </button>
                    }
                  >
                    <div className="perf-sheet-group">
                      <label className="perf-sheet-label" htmlFor="tx-filter-class">
                        סוג נכס
                      </label>
                      {assetClassSelect}
                    </div>
                    <div className="perf-sheet-group">
                      <span className="perf-sheet-label">טווח תאריכים</span>
                      <div className="tx-sheet-dates">{dateInputs}</div>
                    </div>
                    {filtersActive && (
                      <button type="button" className="benchmark-toggle-button" onClick={() => setFilters(EMPTY_FILTERS)}>
                        ניקוי סינון
                      </button>
                    )}
                  </BottomSheet>
                )}
              </div>
            ) : (
              <div className="rebalance-inputs-grid" role="search" aria-label="סינון עסקאות">
                <div className="rebalance-input-item">
                  <label htmlFor="tx-filter-type">סוג</label>
                  <select id="tx-filter-type" className="monthly-select" value={filters.type} onChange={(e) => setFilter('type', e.target.value)}>
                    <option value="">הכול</option>
                    {Object.entries(TYPE_LABELS).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="rebalance-input-item">
                  <label htmlFor="tx-filter-class">סוג נכס</label>
                  {assetClassSelect}
                </div>
                <div className="rebalance-input-item">
                  <label htmlFor="tx-filter-text">חיפוש</label>
                  <input id="tx-filter-text" className="monthly-select" value={filters.text} placeholder="נייר, חשבון או הערה" onChange={(e) => setFilter('text', e.target.value)} />
                </div>
                {dateInputs}
                {filtersActive && (
                  <button type="button" className="benchmark-toggle-button" onClick={() => setFilters(EMPTY_FILTERS)}>
                    ניקוי סינון
                  </button>
                )}
              </div>
            )}

            {message && (
              <p role="status" className={message.tone === 'ok' ? 'profit-positive' : 'profit-negative'}>
                {message.text}
              </p>
            )}

            {transactionsLoading ? (
              <p className="history-empty-note">טוען…</p>
            ) : transactions.length === 0 ? (
              <p className="history-empty-note">עדיין לא נרשמו עסקאות. לחצו "+ רישום עסקה" כדי להתחיל.</p>
            ) : visible.length === 0 ? (
              <p className="history-empty-note">אין עסקאות שמתאימות לסינון.</p>
            ) : isPhone ? (
              <div className="tx-months" aria-label="עסקאות">
                {groupByMonth(visible).map((group) => (
                  <section className="tx-month" key={group.month} aria-label={formatMonthLabel(group.month)}>
                    <h3 className="tx-month-title">{formatMonthLabel(group.month)}</h3>
                    <ul className="tx-cards">
                      {group.items.map((tx) => (
                        <li className="tx-card" key={tx.id}>
                          <div className="tx-card-row">
                            <span className="tx-card-asset">
                              <span className={`tx-type is-${String(tx.type).toLowerCase()}`}>{TYPE_LABELS[tx.type] || tx.type}</span>
                              {describeAsset(tx, holdings)}
                            </span>
                            <span className="tx-card-amount">{amountText(tx)}</span>
                          </div>
                          <div className="tx-card-sub">
                            {formatDate(tx.date)}
                            {tx.units != null && tx.price != null ? ` · ${tx.units} × ${tx.price}` : ''}
                            {tx.fees ? ` · עמלות ${tx.fees}` : ''}
                          </div>
                          {tx.note && <p className="tx-card-note">{tx.note}</p>}
                          <div className="tx-card-actions">{rowActions(tx)}</div>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            ) : (
              <div className="stocks-table-container">
                <table className="analysis-table" aria-label="עסקאות">
                  <thead>
                    <tr>
                      <th>תאריך</th>
                      <th>סוג</th>
                      <th>נכס</th>
                      <th>כמות</th>
                      <th>מחיר</th>
                      <th>עמלות</th>
                      <th>סכום בש"ח</th>
                      <th>הערה</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {[...visible].reverse().map((tx) => (
                      <tr key={tx.id}>
                        <td>{tx.date}</td>
                        <td>{TYPE_LABELS[tx.type] || tx.type}</td>
                        <td>{describeAsset(tx, holdings)}</td>
                        <td>{tx.units ?? ''}</td>
                        <td>{tx.price ?? ''}</td>
                        <td>{tx.fees || ''}</td>
                        <td>{tx.amountILS !== null && tx.amountILS !== undefined ? formatPriceWithSign(tx.amountILS) : ''}</td>
                        <td>{tx.note || ''}</td>
                        <td>{rowActions(tx)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {!isPhone && realizedSection}
        </div>
      </div>
    </div>
  );
}

export default TransactionsView;
