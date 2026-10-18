import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useIsraeliStockSearch } from '../hooks/useIsraeliStockSearch';
import { useStockSearch } from '../hooks/useStockSearch';
import { fetchHistoricalExchangeRate, fetchIsraeliSecurityMeta } from '../api/stockPrices';
import { todayISO } from '../utils/portfolioDates';
import {
  ASSET_CLASSES,
  ACTION_LABELS,
  NEW_ASSET,
  accountLabel,
  actionsFor,
  buildEntryPayload,
  classInfo,
  duplicateAccount,
  emptyEntry,
  emptyNewAccount,
  entryFromTransaction,
  entryPreview,
  heldSymbols,
  unitsHeld
} from '../utils/assetEntry';

// THE ONE FORM for adding an asset, recording a transaction on it, and
// recording a statement value - opened from the "+" button in the shell,
// from an account's ledger, or from a line in the transactions history (to
// edit it). See utils/assetEntry.js for why there is only one, and for the
// rules it applies.

const LOT_METHOD_LABELS = {
  FIFO: 'FIFO - הוותיקה ראשונה (ברירת מחדל)',
  LIFO: 'LIFO - החדשה ראשונה',
  HIFO: 'HIFO - העלות הגבוהה ראשונה'
};

const NEW_SECURITY = '__new__';

function AssetEntryModal({
  // { assetClass, assetId, action } to open pointed at an asset, or
  // { transaction } to edit a recorded one; {} for a blank form.
  initial = {},
  holdings = {},
  onClose,
  onRecordTransaction,
  onUpdateTransaction,
  onPreviewTransaction,
  onUpdateValue,
  // The broker fee a new trade starts with, per currency (settings ←
  // investments); { ILS, USD }, either may be missing.
  defaultFees = {}
}) {
  const today = useMemo(() => todayISO(), []);
  const defaultFeeFor = (assetClass) => {
    const fee = assetClass === 'israeli' ? defaultFees.ILS : assetClass === 'american' ? defaultFees.USD : undefined;
    return Number.isFinite(Number(fee)) && fee !== '' && fee !== null && fee !== undefined ? String(fee) : '';
  };
  const [state, setState] = useState(() => {
    if (initial.transaction) return entryFromTransaction(initial.transaction);
    const entry = emptyEntry(initial, today);
    return entry.fees === '' ? { ...entry, fees: defaultFeeFor(entry.assetClass) } : entry;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [salePreview, setSalePreview] = useState(null);
  const [fxStatus, setFxStatus] = useState('');
  const editing = Boolean(state.editingTxId);
  const info = classInfo(state.assetClass);
  const isStock = info.kind === 'stock';

  // ---- modal behaviour: focus inside, Escape closes, no page scroll ----
  const dialogRef = useRef(null);
  useEffect(() => {
    const first = dialogRef.current && dialogRef.current.querySelector('select, input, button');
    if (first) first.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => {
      if (e.key === 'Escape' && onClose) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const set = (patch) => {
    setError('');
    setSalePreview(null);
    setState((prev) => ({ ...prev, ...patch }));
  };

  // ---- the asset ----
  const symbols = useMemo(() => (isStock ? heldSymbols(holdings[info.holdingsKey]) : []), [isStock, holdings, info.holdingsKey]);
  const accounts = isStock ? [] : holdings[info.holdingsKey] || [];
  const held = isStock && state.assetId ? unitsHeld(holdings, state.assetClass, state.assetId) : 0;
  const isNewAccount = !isStock && state.assetId === NEW_ASSET;
  const actions = actionsFor(state.assetClass, { isNew: isNewAccount, held });

  // A stock entry picks a held security or a new one; a new one is found by
  // search (or its symbol/number typed in).
  const [pickingNewSecurity, setPickingNewSecurity] = useState(
    () => isStock && !initial.transaction && !(state.assetId && symbols.some((s) => s.symbol === state.assetId))
  );
  const [searchText, setSearchText] = useState('');
  const israeliSearch = useIsraeliStockSearch(isStock && pickingNewSecurity && state.assetClass === 'israeli' ? searchText : '');
  const usSearch = useStockSearch(isStock && pickingNewSecurity && state.assetClass === 'american' ? searchText : '');
  const searchResults = state.assetClass === 'israeli' ? israeliSearch.results : usSearch.results;
  const searchLoading = state.assetClass === 'israeli' ? israeliSearch.loading : usSearch.loading;

  // Keep the action valid for the asset chosen.
  useEffect(() => {
    if (!actions.includes(state.action)) setState((prev) => ({ ...prev, action: actions[0] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions.join(','), state.action]);

  const changeClass = (assetClass) => {
    const next = classInfo(assetClass);
    setPickingNewSecurity(next.kind === 'stock');
    setSearchText('');
    set({
      assetClass,
      assetId: '',
      action: next.kind === 'stock' ? 'BUY' : 'DEPOSIT',
      fxRate: '',
      fees: defaultFeeFor(assetClass),
      lotDetails: null,
      newAccount: emptyNewAccount()
    });
  };

  const pickHeldSecurity = (value) => {
    if (value === NEW_SECURITY) {
      setPickingNewSecurity(true);
      set({ assetId: '', lotDetails: null, action: 'BUY' });
      return;
    }
    setPickingNewSecurity(false);
    const symbol = symbols.find((s) => s.symbol === value);
    set({ assetId: value, lotDetails: symbol && symbol.name ? { officialName: symbol.name } : null });
  };

  const pickSearchResult = async (result) => {
    if (state.assetClass === 'american') {
      set({ assetId: result.symbol, lotDetails: null });
      setSearchText(`${result.symbol} — ${result.name || ''}`);
      return;
    }
    const details = {
      officialName: result.officialName || '',
      securityType: result.securityType || '',
      branch: result.branch || '',
      isFund: result.isFund === true,
      isForeignETF: result.isForeignETF === true
    };
    set({ assetId: result.securityId, lotDetails: details });
    setSearchText(`${result.officialName || ''} (${result.securityId})`);
    // The exchange's full classification, best-effort.
    const meta = await fetchIsraeliSecurityMeta(result.securityId);
    if (meta) {
      setState((prev) =>
        prev.assetId !== result.securityId
          ? prev
          : {
              ...prev,
              lotDetails: {
                officialName: meta.officialName || details.officialName,
                securityType: meta.securityType || '',
                securitySubType: meta.securitySubType || '',
                branch: meta.branch || '',
                isFund: meta.isFund === true,
                isForeignETF: meta.isForeignETF === true
              }
            }
      );
    }
  };

  // ---- the USD rate on the trade date, filled in automatically ----
  const needsFx = state.assetClass === 'american' && ['BUY', 'SELL', 'DIVIDEND'].includes(state.action);
  const pullFx = async (date) => {
    if (!date) return;
    setFxStatus('loading');
    const rate = await fetchHistoricalExchangeRate(date);
    if (rate !== null && rate !== undefined) {
      setState((prev) => (prev.date === date ? { ...prev, fxRate: Number(rate).toFixed(4) } : prev));
      setFxStatus('');
    } else {
      setFxStatus('missing');
    }
  };
  const lastFxDate = useRef(editing ? state.date : null);
  useEffect(() => {
    if (!needsFx || !state.date || lastFxDate.current === state.date) return;
    lastFxDate.current = state.date;
    pullFx(state.date);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsFx, state.date]);

  // ---- submit ----
  const duplicate = duplicateAccount(state, holdings);
  const preview = entryPreview(state, holdings);

  const handlePreviewSale = async () => {
    if (!onPreviewTransaction) return;
    setBusy(true);
    const result = await onPreviewTransaction(buildEntryPayload(state).tx);
    setBusy(false);
    if (result && result.ok) setSalePreview(result.transaction);
    else setError((result && result.error) || 'התצוגה המקדימה נכשלה');
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!state.assetId) {
      setError(isStock ? 'בחרו נייר ערך' : 'בחרו חשבון או פתחו חשבון חדש');
      return;
    }
    setBusy(true);
    setError('');
    let payload = buildEntryPayload(state);
    // A security whose number was typed rather than picked from the search
    // still gets its official name and classification.
    if (payload.kind === 'transaction' && payload.tx.type === 'BUY' && state.assetClass === 'israeli' && !state.lotDetails) {
      const meta = await fetchIsraeliSecurityMeta(state.assetId);
      if (meta) {
        payload = {
          ...payload,
          tx: {
            ...payload.tx,
            lotDetails: {
              officialName: meta.officialName || '',
              securityType: meta.securityType || '',
              securitySubType: meta.securitySubType || '',
              branch: meta.branch || '',
              isFund: meta.isFund === true,
              isForeignETF: meta.isForeignETF === true
            }
          }
        };
      }
    }
    let result;
    if (payload.kind === 'value') result = await onUpdateValue(payload);
    else if (editing) result = await onUpdateTransaction(state.editingTxId, payload.tx);
    else result = await onRecordTransaction(payload.tx);
    setBusy(false);
    if (result && result.ok) onClose();
    else setError((result && result.error) || 'הרישום נכשל');
  };

  const currency = state.assetClass === 'american' ? '$' : '₪';
  const newAccount = state.newAccount;
  const setNewAccount = (patch) => set({ newAccount: { ...newAccount, ...patch } });

  return (
    <div
      className="beta-modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && onClose) onClose();
      }}
    >
      <div className="beta-modal asset-entry-modal" role="dialog" aria-modal="true" aria-labelledby="asset-entry-title" ref={dialogRef}>
        <div className="asset-entry-header">
          <h2 className="beta-modal-title" id="asset-entry-title">
            {editing ? 'עריכת עסקה' : 'הוספת נכס או רישום פעולה'}
          </h2>
          <button type="button" className="asset-entry-close" onClick={onClose} aria-label="סגירה">
            ×
          </button>
        </div>

        <form className="stock-form asset-entry-body" onSubmit={handleSubmit} aria-label="טופס הוספה ורישום">
          <div className="form-group">
            <label htmlFor="entry-class">סוג נכס</label>
            <select id="entry-class" value={state.assetClass} onChange={(e) => changeClass(e.target.value)} disabled={editing}>
              {ASSET_CLASSES.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          {isStock ? (
            <>
              <div className="form-group">
                <label htmlFor="entry-security">נייר ערך</label>
                <select
                  id="entry-security"
                  value={pickingNewSecurity ? NEW_SECURITY : state.assetId}
                  onChange={(e) => pickHeldSecurity(e.target.value)}
                  disabled={editing}
                >
                  {!pickingNewSecurity && !state.assetId && <option value="">בחרו נייר</option>}
                  {/* A transaction being edited may be on a position since sold. */}
                  {!pickingNewSecurity && state.assetId && !symbols.some((s) => s.symbol === state.assetId) && (
                    <option value={state.assetId}>{state.assetId}</option>
                  )}
                  {symbols.map((s) => (
                    <option key={s.symbol} value={s.symbol}>
                      {s.name ? `${s.name} (${s.symbol})` : s.symbol} - {s.units} יח'
                    </option>
                  ))}
                  <option value={NEW_SECURITY}>➕ נייר שלא מוחזק עדיין</option>
                </select>
              </div>
              {pickingNewSecurity && !editing && (
                <div className="form-group">
                  <label htmlFor="entry-search">{state.assetClass === 'israeli' ? 'חיפוש לפי שם או מספר נייר' : 'חיפוש לפי סימול או שם חברה'}</label>
                  <div className="sw-search-box">
                    <input
                      id="entry-search"
                      className="sw-search-input"
                      value={searchText}
                      autoComplete="off"
                      placeholder={state.assetClass === 'israeli' ? 'לדוגמה: טבע, 629014' : 'לדוגמה: AAPL, Microsoft'}
                      onChange={(e) => setSearchText(e.target.value)}
                    />
                    {searchText.trim().length >= 2 && !state.assetId && (
                      <div className="sw-search-suggestions">
                        {searchLoading ? (
                          <div className="sw-search-suggestion-empty">מחפש…</div>
                        ) : searchResults.length === 0 ? (
                          <div className="sw-search-suggestion-empty">לא נמצאו תוצאות - אפשר להזין את המספר/הסימול ידנית למטה.</div>
                        ) : (
                          searchResults.map((r) => (
                            <button
                              key={r.securityId || r.symbol}
                              type="button"
                              className="sw-search-suggestion"
                              onClick={() => pickSearchResult(r)}
                            >
                              {state.assetClass === 'israeli' ? (
                                <>
                                  <strong>{r.officialName}</strong> ({r.securityId})
                                </>
                              ) : (
                                <>
                                  <strong>{r.symbol}</strong> — {r.name}
                                </>
                              )}
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                  <label htmlFor="entry-symbol" className="form-help">
                    {state.assetClass === 'israeli' ? 'מספר נייר (TASE)' : 'סימול'}
                  </label>
                  <input
                    id="entry-symbol"
                    value={state.assetId}
                    onChange={(e) => set({ assetId: e.target.value.trim(), lotDetails: null })}
                    placeholder={state.assetClass === 'israeli' ? '1159250' : 'AAPL'}
                  />
                </div>
              )}
            </>
          ) : (
            <>
              <div className="form-group">
                <label htmlFor="entry-account">חשבון</label>
                <select id="entry-account" value={state.assetId} onChange={(e) => set({ assetId: e.target.value })} disabled={editing}>
                  <option value="">בחרו חשבון</option>
                  {accounts.map((a, i) => (
                    <option key={a.id} value={String(a.id)}>
                      {accountLabel(state.assetClass, a, i)}
                    </option>
                  ))}
                  {!editing && <option value={NEW_ASSET}>➕ פתיחת חשבון חדש</option>}
                </select>
              </div>
              {isNewAccount && (
                <>
                  {state.assetClass !== 'bank' && (
                    <div className="form-group">
                      <label htmlFor="entry-fund-name">{state.assetClass === 'cashFunds' ? 'שם הקרן (אופציונלי)' : 'שם'}</label>
                      <input
                        id="entry-fund-name"
                        value={newAccount.fundName}
                        required={state.assetClass !== 'cashFunds'}
                        onChange={(e) => setNewAccount({ fundName: e.target.value })}
                      />
                    </div>
                  )}
                  {state.assetClass === 'cashFunds' && (
                    <div className="form-group">
                      <label htmlFor="entry-security-id">מספר נייר ערך</label>
                      <input
                        id="entry-security-id"
                        value={newAccount.securityId}
                        required
                        onChange={(e) => setNewAccount({ securityId: e.target.value })}
                      />
                    </div>
                  )}
                  {state.assetClass === 'bankSavings' && (
                    <>
                      <div className="form-group">
                        <label htmlFor="entry-track">מסלול השקעה</label>
                        <input id="entry-track" value={newAccount.investmentTrack} required onChange={(e) => setNewAccount({ investmentTrack: e.target.value })} />
                      </div>
                      <div className="form-group">
                        <label htmlFor="entry-rate">ריבית שנתית (%)</label>
                        <input id="entry-rate" type="number" step="0.01" min="0" value={newAccount.interestRate} required onChange={(e) => setNewAccount({ interestRate: e.target.value })} />
                      </div>
                      <div className="form-group form-group-checkbox">
                        <label htmlFor="entry-linked">
                          <input id="entry-linked" type="checkbox" checked={!!newAccount.isLinkedToIndex} onChange={(e) => setNewAccount({ isLinkedToIndex: e.target.checked })} />
                          מסלול צמוד למדד המחירים לצרכן
                        </label>
                      </div>
                    </>
                  )}
                  {duplicate && (
                    <p className="exchange-rate-warning" role="alert">
                      כבר קיים חשבון כזה ({duplicate.fundName || duplicate.securityId}).{' '}
                      <button type="button" className="link-button" onClick={() => set({ assetId: String(duplicate.id) })}>
                        לרשום בו את הפעולה
                      </button>
                    </p>
                  )}
                </>
              )}
            </>
          )}

          <div className="form-group">
            <label htmlFor="entry-action">פעולה</label>
            <select id="entry-action" value={state.action} onChange={(e) => set({ action: e.target.value })} disabled={editing}>
              {actions.map((a) => (
                <option key={a} value={a}>
                  {isNewAccount && a === 'DEPOSIT' ? 'פתיחה עם הפקדה ראשונה' : ACTION_LABELS[a]}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="entry-date">{state.action === 'VALUE' ? 'השווי נכון לתאריך' : 'תאריך'}</label>
            <input id="entry-date" type="date" value={state.date} max={today} required onChange={(e) => set({ date: e.target.value })} />
          </div>

          {(state.action === 'BUY' || state.action === 'SELL') && (
            <>
              <div className="form-group">
                <label htmlFor="entry-units">כמות</label>
                <input id="entry-units" type="number" step="any" min="0" value={state.units} required onChange={(e) => set({ units: e.target.value })} />
                {state.action === 'SELL' && held > 0 && <small className="form-help">מוחזקות כרגע {held} יחידות</small>}
              </div>
              <div className="form-group">
                <label htmlFor="entry-price">מחיר ליחידה ({currency})</label>
                <input id="entry-price" type="number" step="any" min="0" value={state.price} required onChange={(e) => set({ price: e.target.value })} />
              </div>
              <div className="form-group">
                <label htmlFor="entry-fees">עמלות ({currency})</label>
                <input id="entry-fees" type="number" step="any" min="0" value={state.fees} onChange={(e) => set({ fees: e.target.value })} />
              </div>
            </>
          )}

          {state.action === 'SELL' && (
            <div className="form-group">
              <label htmlFor="entry-method">שיטת התאמת מנות</label>
              <select id="entry-method" value={state.lotMethod} onChange={(e) => set({ lotMethod: e.target.value })}>
                {Object.entries(LOT_METHOD_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {state.action === 'DIVIDEND' && (
            <>
              <div className="form-group">
                <label htmlFor="entry-amount">סכום ברוטו ({currency})</label>
                <input id="entry-amount" type="number" step="any" min="0" value={state.amount} required onChange={(e) => set({ amount: e.target.value })} />
              </div>
              <div className="form-group">
                <label htmlFor="entry-tax">מס שנוכה במקור ({currency})</label>
                <input id="entry-tax" type="number" step="any" min="0" value={state.taxWithheld} onChange={(e) => set({ taxWithheld: e.target.value })} />
              </div>
            </>
          )}

          {(state.action === 'DEPOSIT' || state.action === 'WITHDRAWAL') && (
            <div className="form-group">
              <label htmlFor="entry-amount">סכום (₪)</label>
              <input id="entry-amount" type="number" step="any" min="0" value={state.amount} required onChange={(e) => set({ amount: e.target.value })} />
            </div>
          )}

          {state.action === 'VALUE' && (
            <div className="form-group">
              <label htmlFor="entry-value">שווי לפי הדוח (₪)</label>
              <input id="entry-value" type="number" step="any" value={state.value} required onChange={(e) => set({ value: e.target.value })} />
            </div>
          )}

          {needsFx && (
            <div className="form-group">
              <label htmlFor="entry-fx">שער דולר ביום העסקה</label>
              <input id="entry-fx" type="number" step="any" min="0" value={state.fxRate} required onChange={(e) => set({ fxRate: e.target.value })} />
              <small className="form-help">
                {fxStatus === 'loading'
                  ? 'מושך את השער היציג…'
                  : fxStatus === 'missing'
                    ? 'לא נמצא שער לתאריך הזה - הזינו אותו ידנית.'
                    : 'נמשך אוטומטית לתאריך העסקה.'}{' '}
                <button type="button" className="link-button" onClick={() => pullFx(state.date)}>
                  משיכה מחדש
                </button>
              </small>
            </div>
          )}

          {state.action !== 'VALUE' && (
            <div className="form-group">
              <label htmlFor="entry-note">הערה</label>
              <input id="entry-note" value={state.note} onChange={(e) => set({ note: e.target.value })} />
            </div>
          )}

          {preview && (
            <p className="exchange-rate-display" role="status">
              {preview}
            </p>
          )}

          {salePreview && salePreview.allocations && (
            <div className="stocks-table-container">
              <table className="analysis-table" aria-label="מנות שיימכרו">
                <thead>
                  <tr>
                    <th>מנה מתאריך</th>
                    <th>יחידות</th>
                    <th>מחיר קנייה</th>
                  </tr>
                </thead>
                <tbody>
                  {salePreview.allocations.map((a) => (
                    <tr key={a.lotId}>
                      <td>{a.purchaseDate}</td>
                      <td>{a.units}</td>
                      <td>{a.purchasePrice}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {error && (
            <p className="exchange-rate-warning" role="alert">
              {error}
            </p>
          )}

          <div className="form-buttons">
            <button type="button" className="back-button" onClick={onClose}>
              ביטול
            </button>
            {state.action === 'SELL' && onPreviewTransaction && !editing && (
              <button type="button" className="cancel-button" onClick={handlePreviewSale} disabled={busy}>
                אילו מנות יימכרו?
              </button>
            )}
            <button type="submit" className="submit-button" disabled={busy || Boolean(duplicate)}>
              {busy ? 'שומר…' : editing ? 'שמירת התיקון' : isNewAccount ? 'פתיחת החשבון' : `רישום ${ACTION_LABELS[state.action]}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default AssetEntryModal;
