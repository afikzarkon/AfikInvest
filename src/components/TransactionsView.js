import React, { useMemo, useState } from 'react';
import PageToolbar from './PageToolbar';
import BetaBanner from './BetaBanner';
import { computeRealizedGains } from '../utils/realizedGains';
import { fetchHistoricalExchangeRate } from '../api/stockPrices';

// /transactions - the ledger of sales, purchases, dividends, deposits and
// withdrawals.
//
// Recording a sale here (rather than editing a lot's quantity down in the
// stocks table) is what keeps every return figure honest: the sold units
// stay in the history up to the sale date and the proceeds are booked as
// money leaving, so a sale is never read as a loss. See
// shared/transactionLedger.js for the full model.

export const TYPE_LABELS = {
  SELL: 'מכירה',
  BUY: 'קנייה',
  DIVIDEND: 'דיבידנד',
  DEPOSIT: 'הפקדה',
  WITHDRAWAL: 'משיכה'
};

const ACCOUNT_CLASS_OPTIONS = [
  { key: 'pension', label: 'קופת גמל', holdingsKey: 'pensionFunds' },
  { key: 'cashFunds', label: 'כספית שקלית', holdingsKey: 'cashFunds' },
  { key: 'bank', label: 'עו"ש', holdingsKey: 'bankBalances' },
  { key: 'bankSavings', label: 'קופת חיסכון בבנק', holdingsKey: 'bankSavingsFunds' }
];

const LOT_METHOD_LABELS = {
  FIFO: 'FIFO - הוותיקה ראשונה (ברירת מחדל)',
  LIFO: 'LIFO - החדשה ראשונה',
  HIFO: 'HIFO - העלות הגבוהה ראשונה'
};

const todayString = () => new Date().toISOString().slice(0, 10);

const emptyForm = () => ({
  type: 'SELL',
  assetClass: 'israeli',
  assetId: '',
  date: todayString(),
  units: '',
  price: '',
  fees: '',
  fxRate: '',
  amount: '',
  taxWithheld: '',
  lotMethod: 'FIFO',
  note: ''
});

const isStockType = (type) => type === 'BUY' || type === 'SELL' || type === 'DIVIDEND';

// The symbols currently held in a market, with the units held - the choices
// a sale or a dividend can refer to.
export function heldSymbols(lots) {
  const bySymbol = new Map();
  (lots || []).forEach((lot) => {
    const symbol = String(lot.stockName || '').trim();
    if (!symbol) return;
    const entry = bySymbol.get(symbol) || { symbol, name: lot.officialName || '', units: 0 };
    entry.units += Number(lot.quantity) || 0;
    if (!entry.name && lot.officialName) entry.name = lot.officialName;
    bySymbol.set(symbol, entry);
  });
  return [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

// Form state -> the request body the API validates (server-side
// normalizeTransaction is the authority; this only shapes the fields).
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

function describeAsset(tx, holdings) {
  if (isStockType(tx.type)) return tx.assetId;
  const option = ACCOUNT_CLASS_OPTIONS.find((o) => o.key === tx.assetClass);
  const account = (holdings[option?.holdingsKey] || []).find((a) => String(a.id) === String(tx.assetId));
  return `${option ? option.label : tx.assetClass}${account && account.fundName ? ` - ${account.fundName}` : ''}`;
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
  onRecordTransaction,
  onPreviewTransaction,
  onDeleteTransaction,
  cpi = null,
  formatPriceWithSign = (v) => String(v)
}) {
  const holdings = { israeliStocks, americanStocks, pensionFunds, cashFunds, bankBalances, bankSavingsFunds };
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [previewResult, setPreviewResult] = useState(null);
  const [fxLoading, setFxLoading] = useState(false);

  const stockClass = form.assetClass === 'american' ? 'american' : 'israeli';
  const symbols = useMemo(
    () => heldSymbols(stockClass === 'american' ? americanStocks : israeliStocks),
    [stockClass, americanStocks, israeliStocks]
  );

  const accountOption = ACCOUNT_CLASS_OPTIONS.find((o) => o.key === form.assetClass) || ACCOUNT_CLASS_OPTIONS[0];
  const accounts = holdings[accountOption.holdingsKey] || [];

  const realized = useMemo(
    () => computeRealizedGains(transactions, { indexByMonth: cpi?.indexByMonth || {} }),
    [transactions, cpi]
  );
  const currentYear = todayString().slice(0, 4);
  const yearTotals = realized.byYear[currentYear];

  const setField = (name, value) => {
    setPreviewResult(null);
    setMessage(null);
    setForm((prev) => {
      const next = { ...prev, [name]: value };
      if (name === 'type') {
        next.assetId = '';
        next.assetClass = isStockType(value) ? (isStockType(prev.type) ? prev.assetClass : 'israeli') : 'pension';
      }
      if (name === 'assetClass') next.assetId = '';
      return next;
    });
  };

  const onChange = (event) => setField(event.target.name, event.target.value);

  const pullFxRate = async () => {
    setFxLoading(true);
    const rate = await fetchHistoricalExchangeRate(form.date);
    setFxLoading(false);
    if (rate) setField('fxRate', String(rate));
    else setMessage({ tone: 'error', text: 'לא נמצא שער יציג לתאריך הזה - הזינו אותו ידנית' });
  };

  const handlePreview = async () => {
    if (!onPreviewTransaction) return;
    setBusy(true);
    const result = await onPreviewTransaction(buildTransactionPayload(form));
    setBusy(false);
    if (result.ok) {
      setPreviewResult(result.transaction);
    } else {
      setMessage({ tone: 'error', text: result.error });
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const result = await onRecordTransaction(buildTransactionPayload(form));
    setBusy(false);
    if (result.ok) {
      setMessage({ tone: 'ok', text: `${TYPE_LABELS[form.type]} נרשמה והתיק עודכן` });
      setPreviewResult(null);
      setForm((prev) => ({ ...emptyForm(), type: prev.type, assetClass: prev.assetClass }));
    } else {
      setMessage({ tone: 'error', text: result.error || 'הרישום נכשל' });
    }
  };

  const handleDelete = async (tx) => {
    const ok = window.confirm(`למחוק את ה${TYPE_LABELS[tx.type]} מ-${tx.date}? הפעולה תבוטל גם בתיק.`);
    if (!ok) return;
    const result = await onDeleteTransaction(tx.id);
    if (!result.ok) setMessage({ tone: 'error', text: result.error || 'המחיקה נכשלה' });
  };

  const selectedHolding = symbols.find((s) => s.symbol === form.assetId);

  return (
    <div className="App">
      <div className="analysis-container">
        <div className="analysis-content">
          <PageToolbar
            title="עסקאות"
            subtitle="מכירות, קניות, דיבידנדים, הפקדות ומשיכות - כדי שמכירה או משיכה לא ייראו כהפסד"
          />
          <BetaBanner tone="data" />

          <div className="analysis-section">
            <h2 className="section-title">רישום עסקה</h2>
            <form className="stock-form" onSubmit={handleSubmit} aria-label="רישום עסקה">
              <div className="form-group">
                <label htmlFor="tx-type">סוג</label>
                <select id="tx-type" name="type" value={form.type} onChange={onChange}>
                  {Object.entries(TYPE_LABELS).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>

              {isStockType(form.type) ? (
                <>
                  <div className="form-group">
                    <label htmlFor="tx-market">בורסה</label>
                    <select id="tx-market" name="assetClass" value={stockClass} onChange={onChange}>
                      <option value="israeli">בורסה ישראלית</option>
                      <option value="american">בורסה אמריקאית</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label htmlFor="tx-asset">{stockClass === 'american' ? 'סימול' : 'מספר נייר'}</label>
                    {form.type === 'BUY' ? (
                      <input id="tx-asset" name="assetId" value={form.assetId} onChange={onChange} required />
                    ) : (
                      <select id="tx-asset" name="assetId" value={form.assetId} onChange={onChange} required>
                        <option value="">בחרו נייר מהתיק</option>
                        {symbols.map((s) => (
                          <option key={s.symbol} value={s.symbol}>
                            {s.name ? `${s.name} (${s.symbol})` : s.symbol} - {s.units} יח'
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="form-group">
                    <label htmlFor="tx-account-class">סוג חשבון</label>
                    <select id="tx-account-class" name="assetClass" value={accountOption.key} onChange={onChange}>
                      {ACCOUNT_CLASS_OPTIONS.map((o) => (
                        <option key={o.key} value={o.key}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label htmlFor="tx-account">חשבון</label>
                    <select id="tx-account" name="assetId" value={form.assetId} onChange={onChange} required>
                      <option value="">בחרו חשבון</option>
                      {accounts.map((a, i) => (
                        <option key={a.id} value={String(a.id)}>
                          {a.fundName || `${accountOption.label} #${i + 1}`}
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              )}

              <div className="form-group">
                <label htmlFor="tx-date">תאריך</label>
                <input id="tx-date" type="date" name="date" value={form.date} max={todayString()} onChange={onChange} required />
              </div>

              {(form.type === 'BUY' || form.type === 'SELL') && (
                <>
                  <div className="form-group">
                    <label htmlFor="tx-units">כמות</label>
                    <input id="tx-units" type="number" step="any" min="0" name="units" value={form.units} onChange={onChange} required />
                    {form.type === 'SELL' && selectedHolding && (
                      <small className="form-help">מוחזקות כרגע {selectedHolding.units} יחידות</small>
                    )}
                  </div>
                  <div className="form-group">
                    <label htmlFor="tx-price">מחיר ליחידה ({stockClass === 'american' ? '$' : '₪'})</label>
                    <input id="tx-price" type="number" step="any" min="0" name="price" value={form.price} onChange={onChange} required />
                  </div>
                  <div className="form-group">
                    <label htmlFor="tx-fees">עמלות ({stockClass === 'american' ? '$' : '₪'})</label>
                    <input id="tx-fees" type="number" step="any" min="0" name="fees" value={form.fees} onChange={onChange} />
                  </div>
                </>
              )}

              {form.type === 'DIVIDEND' && (
                <>
                  <div className="form-group">
                    <label htmlFor="tx-amount">סכום ברוטו ({stockClass === 'american' ? '$' : '₪'})</label>
                    <input id="tx-amount" type="number" step="any" min="0" name="amount" value={form.amount} onChange={onChange} required />
                  </div>
                  <div className="form-group">
                    <label htmlFor="tx-tax">מס שנוכה במקור</label>
                    <input id="tx-tax" type="number" step="any" min="0" name="taxWithheld" value={form.taxWithheld} onChange={onChange} />
                  </div>
                </>
              )}

              {(form.type === 'DEPOSIT' || form.type === 'WITHDRAWAL') && (
                <div className="form-group">
                  <label htmlFor="tx-amount">סכום (₪)</label>
                  <input id="tx-amount" type="number" step="any" min="0" name="amount" value={form.amount} onChange={onChange} required />
                  <small className="form-help">עדכנו גם את שווי החשבון כרגיל - המשיכה נרשמת כתזרים, לא כשינוי שווי.</small>
                </div>
              )}

              {isStockType(form.type) && stockClass === 'american' && (
                <div className="form-group">
                  <label htmlFor="tx-fx">שער דולר ביום העסקה</label>
                  <input id="tx-fx" type="number" step="any" min="0" name="fxRate" value={form.fxRate} onChange={onChange} required />
                  <button type="button" className="benchmark-toggle-button" onClick={pullFxRate} disabled={fxLoading}>
                    {fxLoading ? 'מושך…' : 'משיכת שער יציג'}
                  </button>
                </div>
              )}

              {form.type === 'SELL' && (
                <div className="form-group">
                  <label htmlFor="tx-method">שיטת התאמת מנות</label>
                  <select id="tx-method" name="lotMethod" value={form.lotMethod} onChange={onChange}>
                    {Object.entries(LOT_METHOD_LABELS).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <small className="form-help">ברוב הברוקרים בישראל ההתאמה היא FIFO לכל חשבון - בדקו מול הברוקר שלכם.</small>
                </div>
              )}

              <div className="form-group">
                <label htmlFor="tx-note">הערה</label>
                <input id="tx-note" name="note" value={form.note} onChange={onChange} />
              </div>

              <div className="rebalance-sum-row">
                {form.type === 'SELL' && (
                  <button type="button" className="benchmark-toggle-button" onClick={handlePreview} disabled={busy}>
                    אילו מנות יימכרו?
                  </button>
                )}
                <button type="submit" className="benchmark-toggle-button active" disabled={busy}>
                  {busy ? 'שומר…' : `רישום ${TYPE_LABELS[form.type]}`}
                </button>
                {message && (
                  <span role="status" className={message.tone === 'ok' ? 'profit-positive' : 'profit-negative'}>
                    {message.text}
                  </span>
                )}
              </div>
            </form>

            {previewResult && previewResult.allocations && (
              <div className="stocks-table-container" style={{ marginTop: 16 }}>
                <table className="analysis-table" aria-label="מנות שיימכרו">
                  <thead>
                    <tr>
                      <th>מנה מתאריך</th>
                      <th>יחידות</th>
                      <th>מחיר קנייה</th>
                      <th>רווח נומינלי</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewResult.allocations.map((a) => (
                      <tr key={a.lotId}>
                        <td>{a.purchaseDate}</td>
                        <td>{a.units}</td>
                        <td>{a.purchasePrice}</td>
                        <td>{formatPriceWithSign(a.units * previewResult.price - a.feeShare - a.units * a.purchasePrice)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="analysis-section">
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

          <div className="analysis-section">
            <h2 className="section-title">כל העסקאות</h2>
            {transactionsLoading ? (
              <p className="history-empty-note">טוען…</p>
            ) : transactions.length === 0 ? (
              <p className="history-empty-note">עדיין לא נרשמו עסקאות.</p>
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
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {[...transactions].reverse().map((tx) => (
                      <tr key={tx.id}>
                        <td>{tx.date}</td>
                        <td>{TYPE_LABELS[tx.type] || tx.type}</td>
                        <td>{describeAsset(tx, holdings)}</td>
                        <td>{tx.units ?? ''}</td>
                        <td>{tx.price ?? ''}</td>
                        <td>{tx.fees || ''}</td>
                        <td>{tx.amountILS !== null && tx.amountILS !== undefined ? formatPriceWithSign(tx.amountILS) : ''}</td>
                        <td>
                          <button type="button" className="benchmark-toggle-button" onClick={() => handleDelete(tx)} aria-label={`מחיקת עסקה ${tx.date}`}>
                            מחיקה
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default TransactionsView;
