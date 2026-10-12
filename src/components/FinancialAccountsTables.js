import React, { useState } from 'react';
import ScrollableTable from './ScrollableTable';
import { calculatePensionRealGainTax, calculateBankSavingsFundTax, monthKeyFromDate } from '../utils/cpiTax';
import { calculateLedgerPeriodReturn, hasAmbiguousLedgerPeriod } from '../utils/portfolioMath';
import { computeBankSavingsFundValue } from '../utils/bankSavingsFund';
import { todayISO } from '../utils/portfolioDates';
import { liquidBalanceOn, movementsSinceLastBalance } from '../shared/liquidBalance';

// The four ledger-backed account tables: provident funds, money-market
// funds, current accounts and bank savings.
//
// `sections` picks which of them to render, because each now belongs to a
// different page - /provident-funds wants only the provident table,
// /cash-and-checking wants the money-market and current-account pair, and
// so on. It defaults to all four, so a caller that wants the whole set
// (and the original behaviour) passes nothing.
export const ACCOUNT_SECTIONS = ['pension', 'cash', 'bank', 'bank_savings'];

// The column headers for each of the four tables, named once and used for
// BOTH the <th> row and each cell's data-label. Below 720px a holdings
// table is not a table any more - App.css turns every row into a card and
// clips the header row away - so a value with no label of its own becomes
// an anonymous number in a stack of anonymous numbers, which is what these
// four tables were on a phone. Sourcing both from one object is what stops
// a renamed header from leaving a card labelled with the old name.
const PENSION_COL = {
  name: 'שם קופה',
  initial: 'סך השקעה ראשונית (₪)',
  current: 'סך ערך השקעה כיום (₪)',
  currentDate: 'תאריך שווי נוכחי',
  previous: 'סך ערך ההשקעה בעדכון הקודם (₪)',
  previousDate: 'תאריך שווי קודם',
  indexToday: 'מדד היום (הידוע)',
  indexAtDeposit: 'מדד ביום ההפקדה',
  realGain: 'רווח ריאלי (חייב במס)',
  inflationary: 'רווח אינפלציוני (פטור)',
  afterTax: 'רווח לאחר מס (₪)',
  periodReturn: 'תשואה (מעדכון קודם)',
  cumulative: 'רווח מצטבר מול הפקדות',
  totalProfit: 'סך רווח/הפסד (₪)',
  updateProfit: 'רווח/הפסד מהשקעה קודמת להיום (₪)',
  actions: 'פעולות'
};

const CASH_COL = {
  name: 'שם',
  securityId: 'מספר נייר ערך',
  current: 'שווי נוכחי (₪)',
  currentDate: 'תאריך שווי נוכחי',
  previous: 'שווי בעדכון הקודם (₪)',
  previousDate: 'תאריך שווי קודם',
  periodReturn: 'תשואה (מעדכון קודם)',
  actions: 'פעולות'
};

const BANK_COL = {
  current: 'שווי נוכחי (₪)',
  currentDate: 'תאריך שווי נוכחי',
  previous: 'שווי בעדכון הקודם (₪)',
  previousDate: 'תאריך שווי קודם',
  periodReturn: 'תשואה (מעדכון קודם)',
  actions: 'פעולות'
};

const SAVINGS_COL = {
  name: 'שם',
  track: 'מסלול השקעה',
  rate: 'ריבית שנתית (%)',
  linked: 'צמוד למדד?',
  deposited: 'סך הפקדות (₪)',
  current: 'שווי נוכחי (₪)',
  profit: 'רווח/הפסד (₪)',
  tax: 'מס (₪)',
  afterTax: 'רווח אחרי מס (₪)',
  actions: 'פעולות'
};

// A deposit row is not a row of the table's own columns - its first two
// cells hold a date and an amount, under headings that mean something
// else. As a card it says what it actually is.
const DEPOSIT_COL = { date: 'תאריך הפקדה', amount: 'סכום' };

function FinancialAccountsTables({
  pensionFunds,
  cashFunds,
  bankBalances,
  bankSavingsFunds = [],
  sections = ACCOUNT_SECTIONS,
  cpi,
  showAdditionalData,
  isEditMode,
  editingField,
  handleCellClick,
  handleInlineEdit,
  finishInlineEdit,
  handleKeyDown,
  formatDate,
  formatPriceWithSign,
  handleDelete,
  // Opens the entry form pointed at one account (see App.js's
  // handleOpenLedgerEntry). Optional - without it the ledgers are
  // read-only, as they always were.
  onOpenLedgerEntry,
  // Deletes a ledger row recorded through the transactions ledger, so the
  // row and its history line go together (see deleteDeposit).
  onDeleteTransaction
}) {
  const formatPercent = (value) => {
    if (value === null || value === undefined || Number.isNaN(value)) {
      return '-';
    }
    return `${Number(value).toFixed(2)}%`;
  };

  // The first row of every expanded ledger: record a new movement on THIS
  // account. Its transactions are listed right under it, so this is where
  // adding one belongs - rather than only behind the toolbar's generic add
  // button, where the account had to be picked again by retyping its name.
  const renderRecordTransactionRow = (itemType, item, colSpan, label) =>
    onOpenLedgerEntry ? (
      <tr className={`${isEditMode ? 'editable-row' : ''} detail-row`}>
        <td style={{ paddingLeft: '20px' }} colSpan={colSpan}>
          <button type="button" className="monthly-toolbar-btn" onClick={() => onOpenLedgerEntry(itemType, item)}>
            {label}
          </button>
        </td>
      </tr>
    ) : null;

  const [expandedFunds, setExpandedFunds] = useState({});
  const toggleFundExpanded = (fundId) => {
    setExpandedFunds((prev) => ({ ...prev, [fundId]: !prev[fundId] }));
  };

  const [expandedCashFunds, setExpandedCashFunds] = useState({});
  const toggleCashFundExpanded = (fundId) => {
    setExpandedCashFunds((prev) => ({ ...prev, [fundId]: !prev[fundId] }));
  };

  const [expandedBankAccounts, setExpandedBankAccounts] = useState({});
  const toggleBankAccountExpanded = (accountId) => {
    setExpandedBankAccounts((prev) => ({ ...prev, [accountId]: !prev[accountId] }));
  };

  // עריכת "שווי נוכחי" מבקשת גם את התאריך באותה פעולה (במקום שני שדות
  // נפרדים לערוך בזה אחר זה) - ראו applyLedgerValueEditPayload ב-
  // portfolioMath.js להסבר המלא על הבאג שזה מונע. משותף לשלוש הטבלאות
  // מבוססות-ledger (קופות גמל, כספית שקלית, עו"ש) - לא רק לפנסיה.
  const [valueDraft, setValueDraft] = useState({ value: '', date: '' });
  const startValueEdit = (item, exchange) => {
    const todayStr = todayISO();
    setValueDraft({
      value: item.currentValue ?? item.amount ?? '',
      date: item.currentValueDate || todayStr
    });
    handleCellClick(item.id, 'currentValue', exchange);
  };
  const commitValueEdit = (item, exchange) => {
    const numValue = parseFloat(valueDraft.value);
    if (!Number.isNaN(numValue) && valueDraft.date) {
      handleInlineEdit(item.id, 'currentValue', { value: numValue, date: valueDraft.date }, exchange);
    }
    finishInlineEdit();
  };
  // A row recorded through the ledger carries its transaction's id: it is
  // deleted THROUGH the ledger, so the history line and whatever the
  // transaction did go with it. Removing only the row here used to leave
  // the transaction listed in the history with nothing behind it. Rows
  // from before the ledger (no txId) are still removed directly.
  const deleteDeposit = async (fund, depositIndex, exchange) => {
    const deposits = Array.isArray(fund.deposits) ? fund.deposits : [];
    const row = deposits[depositIndex];
    if (row && row.txId && onDeleteTransaction) {
      if (!window.confirm('למחוק את התנועה? היא תימחק גם מיומן העסקאות.')) return;
      const result = await onDeleteTransaction(row.txId);
      if (result && !result.ok) window.alert(result.error || 'המחיקה נכשלה');
      return;
    }
    const updatedDeposits = deposits.filter((_, i) => i !== depositIndex);
    handleInlineEdit(fund.id, 'deposits', updatedDeposits, exchange);
  };

  // A current account's or money-market fund's balance: the recorded one
  // plus the movements recorded since (shared/liquidBalance.js), saying so
  // when the two differ.
  const renderLiquidBalance = (item) => {
    const today = todayISO();
    const since = movementsSinceLastBalance(item, today);
    return (
      <>
        {`${formatPriceWithSign(liquidBalanceOn(item, today))} ₪`}
        {since !== 0 && (
          <small className="form-help" style={{ display: 'block' }}>
            {`כולל ${since > 0 ? '+' : ''}${formatPriceWithSign(since)} ₪ תנועות מאז העדכון`}
          </small>
        )}
      </>
    );
  };

  const [expandedBankSavingsFunds, setExpandedBankSavingsFunds] = useState({});
  const toggleBankSavingsFundExpanded = (fundId) => {
    setExpandedBankSavingsFunds((prev) => ({ ...prev, [fundId]: !prev[fundId] }));
  };
  const deleteBankSavingsDeposit = (fund, depositIndex) => {
    const deposits = Array.isArray(fund.deposits) ? fund.deposits : [];
    if (deposits[depositIndex] && deposits[depositIndex].txId && onDeleteTransaction) {
      deleteDeposit(fund, depositIndex, 'bank_savings');
      return;
    }
    const updatedDeposits = deposits.filter((_, i) => i !== depositIndex);
    handleInlineEdit(fund.id, 'deposits', updatedDeposits, 'bank_savings');
  };

  const shows = (name) => sections.includes(name);

  return (
    <>
      {shows('pension') && pensionFunds.length > 0 && (
        <div className="stocks-section">
          <h2 className="section-title">קופות גמל</h2>
          <ScrollableTable label="קופות גמל">
              <thead>
                <tr>
                  <th>{PENSION_COL.name}</th>
                  <th>{PENSION_COL.initial}</th>
                  <th>{PENSION_COL.current}</th>
                  <th>{PENSION_COL.currentDate}</th>
                  <th>{PENSION_COL.previous}</th>
                  {showAdditionalData && <th>{PENSION_COL.previousDate}</th>}
                  {showAdditionalData && <th>{PENSION_COL.indexToday}</th>}
                  {showAdditionalData && <th>{PENSION_COL.indexAtDeposit}</th>}
                  {showAdditionalData && <th>{PENSION_COL.realGain}</th>}
                  {showAdditionalData && <th>{PENSION_COL.inflationary}</th>}
                  {showAdditionalData && <th>{PENSION_COL.afterTax}</th>}
                  <th>{PENSION_COL.periodReturn}</th>
                  <th>{PENSION_COL.cumulative}</th>
                  <th>{PENSION_COL.totalProfit}</th>
                  <th>{PENSION_COL.updateProfit}</th>
                  {isEditMode && <th>{PENSION_COL.actions}</th>}
                </tr>
              </thead>
              <tbody>
                {pensionFunds.map(item => {
                  const deposits = Array.isArray(item.deposits) ? item.deposits : [];
                  // סך ההשקעה הראשונית נגזרת תמיד מפנקס ההפקדות - בדיוק
                  // כמו "סה\"כ רכישה" במניות, לא שדה שמתעדכן ידנית בנפרד.
                  const initialInvestment = deposits.reduce((s, d) => s + (d.amount || 0), 0);
                  const currentValue = item.currentValue ?? item.amount ?? 0;
                  const previousValue = item.previousValue ?? 0;
                  // רווח מצטבר מול סך ההפקדות - מדד עזר בלבד, לא תשואה אמיתית
                  // (מתעלם מתזמון ההפקדות השונות, ראו הערה ב-portfolioSummary.js)
                  const profitPercent = initialInvestment > 0 ? ((currentValue / initialInvestment) - 1) * 100 : null;
                  // תשואה מעדכון-לעדכון: מזהה אוטומטית (לפי תאריכים בפנקס
                  // ההפקדות) אילו הפקדות נפלו בין העדכון הקודם לנוכחי,
                  // ומנטרל אותן - כך שהתשואה משקפת רק שינוי אמיתי בשווי.
                  const periodReturn = calculateLedgerPeriodReturn(item);
                  const previousProfitPercent = previousValue > 0 ? periodReturn.percent : null;
                  const totalProfitLoss = currentValue - initialInvestment;
                  // Uses periodReturn.adjustedPreviousValue (previousValue +
                  // deposits that fell strictly within this period) - NOT
                  // the raw previousValue. This used to be a plain
                  // currentValue - previousValue, which silently counted
                  // any deposit made between the previous and current
                  // update as if it were investment profit (a real ₪35,000
                  // deposit would inflate this column by ₪35,000). Now it
                  // matches exactly what the % column next to it already
                  // does, so the two stay consistent.
                  const updateProfitLoss = previousValue > 0 ? currentValue - periodReturn.adjustedPreviousValue : null;
                  // See hasAmbiguousLedgerPeriod's own comment for the
                  // full story - flags a same-day previous/current period,
                  // which silently drops any deposit made before that
                  // shared date from the return calculation above.
                  const ambiguousPeriod = hasAmbiguousLedgerPeriod(item);

                  // רווח ריאלי/אינפלציוני/מס לקופה הזו בלבד - לוידוא נקודתי מול
                  // הפירוק המצטבר שמוצג בסיכום התיק (PortfolioSummary.js)
                  let realGain = null;
                  let inflationaryGain = null;
                  let tax = null;
                  let afterTaxProfit = null;
                  if (cpi && cpi.currentIndex) {
                    const result = calculatePensionRealGainTax({
                      deposits,
                      currentValue,
                      currentIndex: cpi.currentIndex,
                      indexByMonth: cpi.indexByMonth || {}
                    });
                    realGain = result.gain;
                    inflationaryGain = (currentValue - result.totalDeposited) - result.gain;
                    tax = result.tax;
                    afterTaxProfit = totalProfitLoss - tax;
                  }
                  const isExpanded = !!expandedFunds[item.id];
                  return (
                    <React.Fragment key={item.id}>
                    <tr className={isEditMode ? 'editable-row' : ''}>
                      <td onClick={() => handleCellClick(item.id, 'fundName', 'pension')} className={isEditMode ? 'editable-cell' : ''} data-label={PENSION_COL.name}>
                        <button onClick={() => toggleFundExpanded(item.id)} className="expand-button" style={{ marginRight: '8px', background: 'none', border: 'none', cursor: 'pointer' }}>
                          {isExpanded ? '▼' : '▶'}
                        </button>
                        {editingField === `${item.id}-fundName` ? (
                          <input
                            type="text"
                            value={item.fundName}
                            onChange={(e) => handleInlineEdit(item.id, 'fundName', e.target.value, 'pension')}
                            onBlur={finishInlineEdit}
                            onKeyDown={(e) => handleKeyDown(e, item.id, 'fundName', 'pension')}
                            autoFocus
                          />
                        ) : item.fundName}
                      </td>
                      <td data-label={PENSION_COL.initial}>{`${formatPriceWithSign(initialInvestment)} ₪`}</td>
                      <td
                        onClick={() => { if (editingField !== `${item.id}-currentValue`) startValueEdit(item, 'pension'); }}
                        className={isEditMode ? 'editable-cell' : ''}
                        data-label={PENSION_COL.current}
                      >
                        {editingField === `${item.id}-currentValue` ? (
                          <div
                            className="pension-value-edit-group"
                            onBlur={(e) => {
                              if (!e.currentTarget.contains(e.relatedTarget)) {
                                commitValueEdit(item, 'pension');
                              }
                            }}
                          >
                            <input
                              type="number"
                              value={valueDraft.value}
                              onChange={(e) => setValueDraft((d) => ({ ...d, value: e.target.value }))}
                              onKeyDown={(e) => { if (e.key === 'Enter') commitValueEdit(item, 'pension'); }}
                              autoFocus
                              step="0.01"
                              min="0"
                            />
                            <input
                              type="date"
                              value={valueDraft.date}
                              onChange={(e) => setValueDraft((d) => ({ ...d, date: e.target.value }))}
                              onKeyDown={(e) => { if (e.key === 'Enter') commitValueEdit(item, 'pension'); }}
                            />
                          </div>
                        ) : `${formatPriceWithSign(currentValue)} ₪`}
                      </td>
                      <td onClick={() => handleCellClick(item.id, 'currentValueDate', 'pension')} className={isEditMode ? 'editable-cell' : ''} data-label={PENSION_COL.currentDate}>
                        {editingField === `${item.id}-currentValueDate` ? (
                          <input
                            type="date"
                            value={item.currentValueDate || ''}
                            onChange={(e) => handleInlineEdit(item.id, 'currentValueDate', e.target.value, 'pension')}
                            onBlur={finishInlineEdit}
                            onKeyDown={(e) => handleKeyDown(e, item.id, 'currentValueDate', 'pension')}
                            autoFocus
                          />
                        ) : (item.currentValueDate ? formatDate(item.currentValueDate) : '-')}
                      </td>
                      {/* previousValue/previousValueDate הן תצוגה בלבד בכוונה - עריכה ישירה
                          שלהן תעקוף את applyPensionValueUpdate שדואג לשמר היסטוריה נכונה
                          כשמעדכנים "שווי נוכחי" (ראו portfolioMath.js). זה בעצמו הבאג שהיה
                          כאן בעבר - השדות האלה משתנים רק כתוצאה מעדכון "שווי נוכחי" חדש. */}
                      <td data-label={PENSION_COL.previous}>{`${formatPriceWithSign(previousValue)} ₪`}</td>
                      {showAdditionalData && (
                        <td data-label={PENSION_COL.previousDate}>{item.previousValueDate ? formatDate(item.previousValueDate) : '-'}</td>
                      )}
                      {showAdditionalData && (
                        <td data-label={PENSION_COL.indexToday}>{cpi && cpi.currentIndex != null ? cpi.currentIndex : '-'}</td>
                      )}
                      {/* מדד ביום ההפקדה הוא ערך פר-הפקדה (לכל הפקדה החודש שלה) - לא
                          מוצג כאן בשורת הסיכום כי לקופה יכולות להיות הפקדות ממספר
                          חודשים שונים; ראו את הערך האמיתי בשורות ההפקדה המורחבות למטה. */}
                      {showAdditionalData && <td data-label={PENSION_COL.indexAtDeposit}>-</td>}
                      {showAdditionalData && (
                      <td className={realGain !== null && realGain > 0 ? 'profit-positive' : realGain !== null && realGain < 0 ? 'profit-negative' : ''} data-label={PENSION_COL.realGain}>
                        {realGain !== null ? `${formatPriceWithSign(realGain)} ₪` : '-'}
                      </td>
                      )}
                      {showAdditionalData && (
                      <td data-label={PENSION_COL.inflationary}>
                        {inflationaryGain !== null ? `${formatPriceWithSign(inflationaryGain)} ₪` : '-'}
                      </td>
                      )}
                      {showAdditionalData && (
                      <td className={afterTaxProfit !== null && afterTaxProfit > 0 ? 'profit-positive' : afterTaxProfit !== null && afterTaxProfit < 0 ? 'profit-negative' : ''} data-label={PENSION_COL.afterTax}>
                        {afterTaxProfit !== null ? `${formatPriceWithSign(afterTaxProfit)} ₪` : '-'}
                      </td>
                      )}
                      <td className={previousProfitPercent > 0 ? 'profit-positive' : previousProfitPercent < 0 ? 'profit-negative' : ''} data-label={PENSION_COL.periodReturn}>
                        {ambiguousPeriod && (
                          <span
                            className="ambiguous-period-warning"
                            title='תאריך "שווי קודם" זהה לתאריך "שווי נוכחי" - כל הפקדה שקדמה לתאריך הזה, גם אם קדמה זמן רב, לא נלקחת בחשבון בחישוב הזה. ודאו שהתאריכים משקפים נכון מתי כל שווי היה נכון.'
                          >
                            ⚠️{' '}
                          </span>
                        )}
                        {formatPercent(previousProfitPercent)}
                      </td>
                      <td className={profitPercent > 0 ? 'profit-positive' : profitPercent < 0 ? 'profit-negative' : ''} data-label={PENSION_COL.cumulative}>
                        {formatPercent(profitPercent)}
                      </td>
                      <td className={totalProfitLoss > 0 ? 'profit-positive' : totalProfitLoss < 0 ? 'profit-negative' : ''} data-label={PENSION_COL.totalProfit}>
                        {`${formatPriceWithSign(totalProfitLoss)} ₪`}
                      </td>
                      <td className={updateProfitLoss > 0 ? 'profit-positive' : updateProfitLoss < 0 ? 'profit-negative' : ''} data-label={PENSION_COL.updateProfit}>
                        {updateProfitLoss !== null ? `${formatPriceWithSign(updateProfitLoss)} ₪` : '-'}
                      </td>
                      {isEditMode && (
                        <td data-label={PENSION_COL.actions}>
                          <button onClick={() => handleDelete(item.id, 'pension')} className="delete-button">מחק קופה</button>
                        </td>
                      )}
                    </tr>
                    {isExpanded && renderRecordTransactionRow('pension', item, (showAdditionalData ? 15 : 9) + (isEditMode ? 1 : 0), '+ רישום פעולה (הפקדה / משיכה / עדכון שווי)')}
                    {isExpanded && deposits.length === 0 && (
                      <tr className={`${isEditMode ? 'editable-row' : ''} detail-row`}>
                        <td style={{ paddingLeft: '20px' }} colSpan={(showAdditionalData ? 15 : 9) + (isEditMode ? 1 : 0)}>אין הפקדות רשומות</td>
                      </tr>
                    )}
                    {isExpanded && deposits.map((d, i) => (
                      <tr key={i} className={`${isEditMode ? 'editable-row' : ''} detail-row`}>
                        <td style={{ paddingLeft: '20px' }} data-label={DEPOSIT_COL.date}>{d.date ? formatDate(d.date) : '-'}</td>
                        <td data-label={DEPOSIT_COL.amount}>{`${formatPriceWithSign(d.amount)} ₪`}</td>
                        <td></td>
                        <td></td>
                        <td></td>
                        {showAdditionalData && <td></td>}
                        {showAdditionalData && <td></td>}
                        {showAdditionalData && (
                          <td data-label={PENSION_COL.indexAtDeposit}>{cpi && cpi.indexByMonth ? cpi.indexByMonth[monthKeyFromDate(d.date)] ?? '-' : '-'}</td>
                        )}
                        {showAdditionalData && <td></td>}
                        {showAdditionalData && <td></td>}
                        {showAdditionalData && <td></td>}
                        <td></td>
                        <td></td>
                        <td></td>
                        <td></td>
                        {isEditMode && (
                          <td>
                            <button onClick={() => deleteDeposit(item, i, 'pension')} className="delete-button">מחק הפקדה</button>
                          </td>
                        )}
                      </tr>
                    ))}
                    </React.Fragment>
                  );
                })}
              </tbody>
          </ScrollableTable>
        </div>
      )}

      {shows('cash') && cashFunds.length > 0 && (
        <div className="stocks-section">
          <h2 className="section-title">כספית שקלית</h2>
          <ScrollableTable label="כספית שקלית">
              <thead>
                <tr>
                  <th>{CASH_COL.name}</th>
                  <th>{CASH_COL.securityId}</th>
                  <th>{CASH_COL.current}</th>
                  <th>{CASH_COL.currentDate}</th>
                  <th>{CASH_COL.previous}</th>
                  {showAdditionalData && <th>{CASH_COL.previousDate}</th>}
                  <th>{CASH_COL.periodReturn}</th>
                  {isEditMode && <th>{CASH_COL.actions}</th>}
                </tr>
              </thead>
              <tbody>
                {cashFunds.map(item => {
                  const deposits = Array.isArray(item.deposits) ? item.deposits : [];
                  const previousValue = item.previousValue ?? 0;
                  const periodReturn = calculateLedgerPeriodReturn(item);
                  const periodReturnPercent = previousValue > 0 ? periodReturn.percent : null;
                  const ambiguousPeriod = hasAmbiguousLedgerPeriod(item);
                  const isExpanded = !!expandedCashFunds[item.id];
                  return (
                    <React.Fragment key={item.id}>
                      <tr className={isEditMode ? 'editable-row' : ''}>
                        <td onClick={() => handleCellClick(item.id, 'fundName', 'cash_fund')} className={isEditMode ? 'editable-cell' : ''} data-label={CASH_COL.name}>
                          <button onClick={() => toggleCashFundExpanded(item.id)} className="expand-button" style={{ marginRight: '8px', background: 'none', border: 'none', cursor: 'pointer' }}>
                            {isExpanded ? '▼' : '▶'}
                          </button>
                          {editingField === `${item.id}-fundName` ? (
                            <input
                              type="text"
                              value={item.fundName}
                              onChange={(e) => handleInlineEdit(item.id, 'fundName', e.target.value, 'cash_fund')}
                              onBlur={finishInlineEdit}
                              onKeyDown={(e) => handleKeyDown(e, item.id, 'fundName', 'cash_fund')}
                              autoFocus
                            />
                          ) : (item.fundName || '-')}
                        </td>
                        <td onClick={() => handleCellClick(item.id, 'securityId', 'cash_fund')} className={isEditMode ? 'editable-cell' : ''} data-label={CASH_COL.securityId}>
                          {editingField === `${item.id}-securityId` ? (
                            <input
                              type="text"
                              value={item.securityId}
                              onChange={(e) => handleInlineEdit(item.id, 'securityId', e.target.value, 'cash_fund')}
                              onBlur={finishInlineEdit}
                              onKeyDown={(e) => handleKeyDown(e, item.id, 'securityId', 'cash_fund')}
                              autoFocus
                            />
                          ) : item.securityId}
                        </td>
                        <td
                          onClick={() => { if (editingField !== `${item.id}-currentValue`) startValueEdit(item, 'cash_fund'); }}
                          className={isEditMode ? 'editable-cell' : ''}
                          data-label={CASH_COL.current}
                        >
                          {editingField === `${item.id}-currentValue` ? (
                            <div
                              className="pension-value-edit-group"
                              onBlur={(e) => {
                                if (!e.currentTarget.contains(e.relatedTarget)) {
                                  commitValueEdit(item, 'cash_fund');
                                }
                              }}
                            >
                              <input
                                type="number"
                                value={valueDraft.value}
                                onChange={(e) => setValueDraft((d) => ({ ...d, value: e.target.value }))}
                                onKeyDown={(e) => { if (e.key === 'Enter') commitValueEdit(item, 'cash_fund'); }}
                                autoFocus
                                step="0.01"
                                min="0"
                              />
                              <input
                                type="date"
                                value={valueDraft.date}
                                onChange={(e) => setValueDraft((d) => ({ ...d, date: e.target.value }))}
                                onKeyDown={(e) => { if (e.key === 'Enter') commitValueEdit(item, 'cash_fund'); }}
                              />
                            </div>
                          ) : renderLiquidBalance(item)}
                        </td>
                        <td data-label={CASH_COL.currentDate}>{item.currentValueDate ? formatDate(item.currentValueDate) : '-'}</td>
                        {/* previousValue/previousValueDate הן תצוגה בלבד בכוונה - ראו
                            הערת השדות המקבילים בטבלת קופות הגמל למעלה. */}
                        <td data-label={CASH_COL.previous}>{`${formatPriceWithSign(previousValue)} ₪`}</td>
                        {showAdditionalData && (
                          <td data-label={CASH_COL.previousDate}>{item.previousValueDate ? formatDate(item.previousValueDate) : '-'}</td>
                        )}
                        <td className={periodReturnPercent > 0 ? 'profit-positive' : periodReturnPercent < 0 ? 'profit-negative' : ''} data-label={CASH_COL.periodReturn}>
                          {ambiguousPeriod && (
                            <span
                              className="ambiguous-period-warning"
                              title='תאריך "שווי קודם" זהה לתאריך "שווי נוכחי" - כל הפקדה/משיכה שקדמה לתאריך הזה, גם אם קדמה זמן רב, לא נלקחת בחשבון בחישוב הזה.'
                            >
                              ⚠️{' '}
                            </span>
                          )}
                          {formatPercent(periodReturnPercent)}
                        </td>
                        {isEditMode && (
                          <td data-label={CASH_COL.actions}>
                            <button onClick={() => handleDelete(item.id, 'cash_fund')} className="delete-button">מחק כספית</button>
                          </td>
                        )}
                      </tr>
                      {isExpanded && renderRecordTransactionRow('cash_fund', item, (showAdditionalData ? 8 : 7) + (isEditMode ? 1 : 0), '+ רישום פעולה (הפקדה / משיכה / עדכון שווי)')}
                      {isExpanded && deposits.length === 0 && (
                        <tr className={`${isEditMode ? 'editable-row' : ''} detail-row`}>
                          <td style={{ paddingLeft: '20px' }} colSpan={(showAdditionalData ? 8 : 7) + (isEditMode ? 1 : 0)}>אין הפקדות/משיכות רשומות</td>
                        </tr>
                      )}
                      {isExpanded && deposits.map((d, i) => (
                        <tr key={i} className={`${isEditMode ? 'editable-row' : ''} detail-row`}>
                          <td style={{ paddingLeft: '20px' }} data-label={DEPOSIT_COL.date}>{d.date ? formatDate(d.date) : '-'}</td>
                          <td data-label={DEPOSIT_COL.amount}>{`${formatPriceWithSign(d.amount)} ₪ ${d.amount < 0 ? '(משיכה)' : ''}`}</td>
                          <td></td>
                          <td></td>
                          <td></td>
                          {showAdditionalData && <td></td>}
                          <td></td>
                          {isEditMode && (
                            <td>
                              <button onClick={() => deleteDeposit(item, i, 'cash_fund')} className="delete-button">מחק</button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </React.Fragment>
                  );
                })}
              </tbody>
          </ScrollableTable>
        </div>
      )}

      {shows('bank') && bankBalances.length > 0 && (
        <div className="stocks-section">
          <h2 className="section-title">עו"ש</h2>
          <ScrollableTable label={'עו"ש'}>
              <thead>
                <tr>
                  <th>{BANK_COL.current}</th>
                  <th>{BANK_COL.currentDate}</th>
                  <th>{BANK_COL.previous}</th>
                  {showAdditionalData && <th>{BANK_COL.previousDate}</th>}
                  <th>{BANK_COL.periodReturn}</th>
                  {isEditMode && <th>{BANK_COL.actions}</th>}
                </tr>
              </thead>
              <tbody>
                {bankBalances.map(item => {
                  const deposits = Array.isArray(item.deposits) ? item.deposits : [];
                  const previousValue = item.previousValue ?? 0;
                  const periodReturn = calculateLedgerPeriodReturn(item);
                  const periodReturnPercent = previousValue > 0 ? periodReturn.percent : null;
                  const ambiguousPeriod = hasAmbiguousLedgerPeriod(item);
                  const isExpanded = !!expandedBankAccounts[item.id];
                  return (
                    <React.Fragment key={item.id}>
                      <tr className={isEditMode ? 'editable-row' : ''}>
                        <td
                          onClick={() => { if (editingField !== `${item.id}-currentValue`) startValueEdit(item, 'bank'); }}
                          className={isEditMode ? 'editable-cell' : ''}
                          data-label={BANK_COL.current}
                        >
                          <button onClick={() => toggleBankAccountExpanded(item.id)} className="expand-button" style={{ marginRight: '8px', background: 'none', border: 'none', cursor: 'pointer' }}>
                            {isExpanded ? '▼' : '▶'}
                          </button>
                          {editingField === `${item.id}-currentValue` ? (
                            <div
                              className="pension-value-edit-group"
                              onBlur={(e) => {
                                if (!e.currentTarget.contains(e.relatedTarget)) {
                                  commitValueEdit(item, 'bank');
                                }
                              }}
                            >
                              <input
                                type="number"
                                value={valueDraft.value}
                                onChange={(e) => setValueDraft((d) => ({ ...d, value: e.target.value }))}
                                onKeyDown={(e) => { if (e.key === 'Enter') commitValueEdit(item, 'bank'); }}
                                autoFocus
                                step="0.01"
                                min="0"
                              />
                              <input
                                type="date"
                                value={valueDraft.date}
                                onChange={(e) => setValueDraft((d) => ({ ...d, date: e.target.value }))}
                                onKeyDown={(e) => { if (e.key === 'Enter') commitValueEdit(item, 'bank'); }}
                              />
                            </div>
                          ) : renderLiquidBalance(item)}
                        </td>
                        <td data-label={BANK_COL.currentDate}>{item.currentValueDate ? formatDate(item.currentValueDate) : '-'}</td>
                        <td data-label={BANK_COL.previous}>{`${formatPriceWithSign(previousValue)} ₪`}</td>
                        {showAdditionalData && (
                          <td data-label={BANK_COL.previousDate}>{item.previousValueDate ? formatDate(item.previousValueDate) : '-'}</td>
                        )}
                        <td className={periodReturnPercent > 0 ? 'profit-positive' : periodReturnPercent < 0 ? 'profit-negative' : ''} data-label={BANK_COL.periodReturn}>
                          {ambiguousPeriod && (
                            <span
                              className="ambiguous-period-warning"
                              title='תאריך "שווי קודם" זהה לתאריך "שווי נוכחי" - כל הפקדה/משיכה שקדמה לתאריך הזה, גם אם קדמה זמן רב, לא נלקחת בחשבון בחישוב הזה.'
                            >
                              ⚠️{' '}
                            </span>
                          )}
                          {formatPercent(periodReturnPercent)}
                        </td>
                        {isEditMode && (
                          <td data-label={BANK_COL.actions}>
                            <button onClick={() => handleDelete(item.id, 'bank')} className="delete-button">מחק חשבון</button>
                          </td>
                        )}
                      </tr>
                      {isExpanded && renderRecordTransactionRow('bank', item, (showAdditionalData ? 6 : 5) + (isEditMode ? 1 : 0), '+ רישום פעולה (הפקדה / משיכה / עדכון שווי)')}
                      {isExpanded && deposits.length === 0 && (
                        <tr className={`${isEditMode ? 'editable-row' : ''} detail-row`}>
                          <td style={{ paddingLeft: '20px' }} colSpan={(showAdditionalData ? 6 : 5) + (isEditMode ? 1 : 0)}>אין הפקדות/משיכות רשומות</td>
                        </tr>
                      )}
                      {isExpanded && deposits.map((d, i) => (
                        <tr key={i} className={`${isEditMode ? 'editable-row' : ''} detail-row`}>
                          <td style={{ paddingLeft: '20px' }} data-label={DEPOSIT_COL.amount}>{`${formatPriceWithSign(d.amount)} ₪ ${d.amount < 0 ? '(משיכה)' : ''}`}</td>
                          <td data-label={DEPOSIT_COL.date}>{d.date ? formatDate(d.date) : '-'}</td>
                          <td></td>
                          {showAdditionalData && <td></td>}
                          <td></td>
                          {isEditMode && (
                            <td>
                              <button onClick={() => deleteDeposit(item, i, 'bank')} className="delete-button">מחק</button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </React.Fragment>
                  );
                })}
              </tbody>
          </ScrollableTable>
        </div>
      )}

      {shows('bank_savings') && bankSavingsFunds.length > 0 && (
        <div className="stocks-section">
          <h2 className="section-title">קופות חיסכון בבנק</h2>
          <ScrollableTable label="קופות חיסכון בבנק">
              <thead>
                <tr>
                  <th>{SAVINGS_COL.name}</th>
                  <th>{SAVINGS_COL.track}</th>
                  <th>{SAVINGS_COL.rate}</th>
                  <th>{SAVINGS_COL.linked}</th>
                  <th>{SAVINGS_COL.deposited}</th>
                  <th>{SAVINGS_COL.current}</th>
                  <th>{SAVINGS_COL.profit}</th>
                  {showAdditionalData && <th>{SAVINGS_COL.tax}</th>}
                  {showAdditionalData && <th>{SAVINGS_COL.afterTax}</th>}
                  {isEditMode && <th>{SAVINGS_COL.actions}</th>}
                </tr>
              </thead>
              <tbody>
                {bankSavingsFunds.map((item) => {
                  const deposits = Array.isArray(item.deposits) ? item.deposits : [];
                  const totalDeposited = deposits.reduce((s, d) => s + (d.amount || 0), 0);
                  const currentValue = computeBankSavingsFundValue(item);
                  const profitLoss = currentValue - totalDeposited;

                  let tax = null;
                  let afterTaxProfit = null;
                  const taxResult = calculateBankSavingsFundTax({
                    deposits,
                    currentValue,
                    isLinkedToIndex: !!item.isLinkedToIndex,
                    currentIndex: cpi && cpi.currentIndex,
                    indexByMonth: (cpi && cpi.indexByMonth) || {}
                  });
                  tax = taxResult.tax;
                  afterTaxProfit = profitLoss - tax;

                  const isExpanded = !!expandedBankSavingsFunds[item.id];
                  return (
                    <React.Fragment key={item.id}>
                    <tr className={isEditMode ? 'editable-row' : ''}>
                      <td onClick={() => handleCellClick(item.id, 'fundName', 'bank_savings')} className={isEditMode ? 'editable-cell' : ''} data-label={SAVINGS_COL.name}>
                        <button onClick={() => toggleBankSavingsFundExpanded(item.id)} className="expand-button" style={{ marginRight: '8px', background: 'none', border: 'none', cursor: 'pointer' }}>
                          {isExpanded ? '▼' : '▶'}
                        </button>
                        {editingField === `${item.id}-fundName` ? (
                          <input
                            type="text"
                            value={item.fundName}
                            onChange={(e) => handleInlineEdit(item.id, 'fundName', e.target.value, 'bank_savings')}
                            onBlur={finishInlineEdit}
                            onKeyDown={(e) => handleKeyDown(e, item.id, 'fundName', 'bank_savings')}
                            autoFocus
                          />
                        ) : item.fundName}
                      </td>
                      <td onClick={() => handleCellClick(item.id, 'investmentTrack', 'bank_savings')} className={isEditMode ? 'editable-cell' : ''} data-label={SAVINGS_COL.track}>
                        {editingField === `${item.id}-investmentTrack` ? (
                          <input
                            type="text"
                            value={item.investmentTrack || ''}
                            onChange={(e) => handleInlineEdit(item.id, 'investmentTrack', e.target.value, 'bank_savings')}
                            onBlur={finishInlineEdit}
                            onKeyDown={(e) => handleKeyDown(e, item.id, 'investmentTrack', 'bank_savings')}
                            autoFocus
                          />
                        ) : (item.investmentTrack || '-')}
                      </td>
                      <td onClick={() => handleCellClick(item.id, 'interestRate', 'bank_savings')} className={isEditMode ? 'editable-cell' : ''} data-label={SAVINGS_COL.rate}>
                        {editingField === `${item.id}-interestRate` ? (
                          <input
                            type="number"
                            value={item.interestRate ?? ''}
                            onChange={(e) => handleInlineEdit(item.id, 'interestRate', parseFloat(e.target.value), 'bank_savings')}
                            onBlur={finishInlineEdit}
                            onKeyDown={(e) => handleKeyDown(e, item.id, 'interestRate', 'bank_savings')}
                            autoFocus
                            step="0.01"
                            min="0"
                          />
                        ) : `${item.interestRate ?? 0}%`}
                      </td>
                      <td data-label={SAVINGS_COL.linked}>
                        <input
                          type="checkbox"
                          checked={!!item.isLinkedToIndex}
                          disabled={!isEditMode}
                          onChange={(e) => handleInlineEdit(item.id, 'isLinkedToIndex', e.target.checked, 'bank_savings')}
                        />
                      </td>
                      <td data-label={SAVINGS_COL.deposited}>{`${formatPriceWithSign(totalDeposited)} ₪`}</td>
                      <td data-label={SAVINGS_COL.current}>{`${formatPriceWithSign(currentValue)} ₪`}</td>
                      <td className={profitLoss > 0 ? 'profit-positive' : profitLoss < 0 ? 'profit-negative' : ''} data-label={SAVINGS_COL.profit}>
                        {`${formatPriceWithSign(profitLoss)} ₪`}
                      </td>
                      {showAdditionalData && (
                        <td data-label={SAVINGS_COL.tax}>{tax !== null ? `${formatPriceWithSign(tax)} ₪` : '-'}</td>
                      )}
                      {showAdditionalData && (
                        <td className={afterTaxProfit !== null && afterTaxProfit > 0 ? 'profit-positive' : afterTaxProfit !== null && afterTaxProfit < 0 ? 'profit-negative' : ''} data-label={SAVINGS_COL.afterTax}>
                          {afterTaxProfit !== null ? `${formatPriceWithSign(afterTaxProfit)} ₪` : '-'}
                        </td>
                      )}
                      {isEditMode && (
                        <td data-label={SAVINGS_COL.actions}>
                          <button onClick={() => handleDelete(item.id, 'bank_savings')} className="delete-button">מחק קופה</button>
                        </td>
                      )}
                    </tr>
                    {isExpanded && renderRecordTransactionRow('bank_savings', item, (showAdditionalData ? 9 : 7) + (isEditMode ? 1 : 0), '+ רישום הפקדה / משיכה')}
                    {isExpanded && deposits.length === 0 && (
                      <tr className={`${isEditMode ? 'editable-row' : ''} detail-row`}>
                        <td style={{ paddingLeft: '20px' }} colSpan={(showAdditionalData ? 9 : 7) + (isEditMode ? 1 : 0)}>אין הפקדות רשומות</td>
                      </tr>
                    )}
                    {isExpanded && deposits.map((d, i) => (
                      <tr key={i} className={`${isEditMode ? 'editable-row' : ''} detail-row`}>
                        <td style={{ paddingLeft: '20px' }} data-label={DEPOSIT_COL.date}>{d.date ? formatDate(d.date) : '-'}</td>
                        <td data-label={DEPOSIT_COL.amount}>{`${formatPriceWithSign(d.amount)} ₪`}</td>
                        <td></td>
                        <td></td>
                        <td></td>
                        <td></td>
                        <td></td>
                        {showAdditionalData && <td></td>}
                        {showAdditionalData && <td></td>}
                        {isEditMode && (
                          <td>
                            <button onClick={() => deleteBankSavingsDeposit(item, i)} className="delete-button">מחק הפקדה</button>
                          </td>
                        )}
                      </tr>
                    ))}
                    </React.Fragment>
                  );
                })}
              </tbody>
          </ScrollableTable>
        </div>
      )}
    </>
  );
}

export default FinancialAccountsTables;
