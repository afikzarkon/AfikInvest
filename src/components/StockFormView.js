import React, { useState } from 'react';
import { useIsraeliStockSearch } from '../hooks/useIsraeliStockSearch';
import { useStockSearch } from '../hooks/useStockSearch';
import BetaBanner from './BetaBanner';
import {
  describeEntry,
  applyLiquidAccountTransaction,
  isBeforeLastBalance,
  lastRecordedBalanceDate
} from '../utils/assetEntry';
import { formatPriceWithSign } from '../utils/formatters';

const formatDateHe = (iso) => {
  const [y, m, d] = String(iso || '').split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso;
};

// What this submission will do, said before it is done (see
// utils/assetEntry.js, which App.js's submit handler uses to decide the
// same thing). null when not enough is filled in to tell.
function entryPreviewText(formData, holdings) {
  const entry = describeEntry(formData, holdings);
  if (!entry) return null;
  const type = formData.itemType;

  if (entry.kind === 'additional-lot') {
    const units = entry.lots.reduce((sum, lot) => sum + (Number(lot.quantity) || 0), 0);
    const name = entry.lots[0].officialName || formData.officialName || formData.stockName;
    return `כבר מוחזקות ${units} יחידות של ${name} (${entry.lots.length} קניות). הקנייה תירשם כקנייה נוספת באותה החזקה, עם תאריך ומחיר משלה.`;
  }
  if (entry.kind === 'new-holding') {
    return 'החזקה חדשה - תיפתח שורה חדשה בטבלה.';
  }
  if (entry.kind === 'new-account') {
    if (type === 'bank') return 'ייפתח חשבון עו"ש, והסכום יהיה היתרה ההתחלתית שלו.';
    const label = type === 'cash_fund' ? `כספית חדשה (נייר ${formData.securityId.trim()})` : `קופה חדשה: "${formData.stockName.trim()}"`;
    return `תיפתח ${label}, וההפקדה הזו תהיה הראשונה בפנקס שלה.`;
  }

  // An existing account: a transaction on its ledger.
  const target = entry.target;
  const name = type === 'bank' ? 'חשבון העו"ש' : `"${target.fundName || target.securityId}"`;
  if (type === 'pension') {
    return `ההפקדה תירשם בפנקס ההפקדות של ${name}. השווי הנוכחי של הקופה לא משתנה - הוא מתעדכן מדוח הקופה, בטבלה.`;
  }
  if (type === 'bank_savings') {
    return `ההפקדה תירשם בפנקס של ${name}, והשווי יחושב ממנה אוטומטית.`;
  }
  const amount = parseFloat(formData.purchasePrice);
  if (!Number.isFinite(amount) || !formData.purchaseDate) {
    return `התנועה תירשם בפנקס של ${name}.`;
  }
  if (isBeforeLastBalance(target, formData.purchaseDate)) {
    return `התנועה תירשם בפנקס של ${name} בלבד: היא מוקדמת מהיתרה האחרונה שנרשמה (${formatDateHe(lastRecordedBalanceDate(target))}), שכבר כוללת אותה.`;
  }
  const after = applyLiquidAccountTransaction(target, amount, formData.purchaseDate);
  return `התנועה תירשם בפנקס של ${name}, והיתרה תתעדכן ל-${formatPriceWithSign(after.currentValue)} ₪.`;
}

function StockFormView({
  isEditMode,
  formData,
  // The current portfolio - only read, to tell an existing account from a
  // new one (see entryPreviewText) and to suggest existing names.
  holdings = {},
  handleSubmit,
  handleInputChange,
  handleBackToHome,
  handleSaveEdit,
  handleCancelEdit,
  exchangeRateFetching = false,
  exchangeRateNotFound = false,
  onPullExchangeRate,
  onSelectIsraeliStock
}) {
  // Name-based autocomplete for adding a NEW Israeli stock only (editing an
  // existing lot keeps the plain numeric-id field below untouched - lower
  // risk, and there's no real need to re-resolve a name that's already
  // been resolved once). searchText is local/uncommitted - only
  // onSelectIsraeliStock actually updates formData (stockName + a new
  // officialName field), exactly like picking a suggestion in any other
  // autocomplete in this app.
  const [searchText, setSearchText] = useState('');
  const [showIsraeliSuggestions, setShowIsraeliSuggestions] = useState(false);
  const showIsraeliSearch = !isEditMode && formData.itemType === 'stock' && formData.exchange === 'israeli';
  const { results: israeliSearchResults, loading: israeliSearchLoading } = useIsraeliStockSearch(
    showIsraeliSearch ? searchText : ''
  );

  // The same affordance for the American side, which had none: the ticker
  // was a free-text field, so adding a holding meant knowing the exact
  // symbol beforehand and a typo was only discovered later, when no price
  // came back for it. Backed by the ticker/company search the research
  // page already uses.
  const [usSearchText, setUsSearchText] = useState('');
  const [showUsSuggestions, setShowUsSuggestions] = useState(false);
  const showUsSearch = !isEditMode && formData.itemType === 'stock' && formData.exchange === 'american';
  const { results: usSearchResults, loading: usSearchLoading } = useStockSearch(
    showUsSearch ? usSearchText : ''
  );

  const selectUsSymbol = (result) => {
    handleInputChange({ target: { name: 'stockName', value: result.symbol } });
    setUsSearchText(`${result.symbol} — ${result.name}`);
    setShowUsSuggestions(false);
  };
  return (
    <div className="App">
      <div className="form-container">
        <div className="form-content">
          <h1 className="form-title">{isEditMode ? 'עריכת מנייה' : 'הוספת נכס או רישום פעולה'}</h1>
          {!isEditMode && (
            <p className="form-help">
              שם של נכס קיים רושם פעולה עליו (קנייה נוספת, הפקדה או משיכה); שם חדש פותח נכס חדש. אפשר לרשום פעולה גם
              ישירות מהפנקס של כל חשבון בטבלה.
            </p>
          )}

          {/* The one screen that invites a real balance to be typed in. */}
          <BetaBanner tone="data" />

          <form onSubmit={handleSubmit} className="stock-form">
            <div className="form-group">
              <label htmlFor="itemType">מה להוסיף</label>
              <select
                id="itemType"
                name="itemType"
                value={formData.itemType}
                onChange={handleInputChange}
              >
                <option value="stock">מנייה</option>
                <option value="pension">קופת גמל</option>
                <option value="bank">עו"ש</option>
                <option value="cash_fund">כספית שקלית</option>
                <option value="bank_savings">קופת חיסכון בבנק</option>
              </select>
            </div>

            {/* The market comes SECOND, before anything about the holding
                itself. It decides what every field below means - a ticker
                or a TASE id, which search box appears, whether an exchange
                rate is needed at all - so asking for it after the ticker
                had people type a symbol into a field that then changed
                under them. */}
            {formData.itemType === 'stock' && (
              <div className="form-group">
                <label htmlFor="exchange">בורסה *</label>
                <select
                  id="exchange"
                  name="exchange"
                  value={formData.exchange}
                  onChange={handleInputChange}
                  required
                >
                  <option value="israeli">בורסה ישראלית</option>
                  <option value="american">בורסה אמריקאית</option>
                </select>
              </div>
            )}

            {showUsSearch && (
              <div className="form-group">
                <label htmlFor="usStockSearch">חיפוש מנייה אמריקאית (סימול או שם חברה)</label>
                <div
                  className="sw-search-box"
                  onBlur={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget)) setShowUsSuggestions(false);
                  }}
                >
                  <input
                    type="text"
                    id="usStockSearch"
                    name="usStockSearch"
                    className="sw-search-input"
                    value={usSearchText}
                    onChange={(e) => {
                      setUsSearchText(e.target.value);
                      setShowUsSuggestions(true);
                    }}
                    onFocus={() => setShowUsSuggestions(true)}
                    placeholder="לדוגמה: AAPL, Microsoft, טסלה"
                    autoComplete="off"
                  />
                  {showUsSuggestions && usSearchText.trim().length >= 2 && (
                    <div className="sw-search-suggestions">
                      {usSearchLoading ? (
                        <div className="sw-search-suggestion-empty">מחפש…</div>
                      ) : usSearchResults.length === 0 ? (
                        <div className="sw-search-suggestion-empty">
                          לא נמצאו תוצאות - אפשר להזין את הסימול ידנית למטה.
                        </div>
                      ) : (
                        usSearchResults.map((r) => (
                          <button
                            key={r.symbol}
                            type="button"
                            className="sw-search-suggestion"
                            onClick={() => selectUsSymbol(r)}
                          >
                            <strong>{r.symbol}</strong> — {r.name}
                            {r.exchange && <span className="sw-search-exchange">{r.exchange}</span>}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {formData.itemType === 'stock' && showIsraeliSearch && (
              <div className="form-group">
                <label htmlFor="israeliStockSearch">חיפוש נייר ערך ישראלי (שם או מספר נייר)</label>
                <div
                  className="sw-search-box"
                  onBlur={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget)) setShowIsraeliSuggestions(false);
                  }}
                >
                  <input
                    type="text"
                    id="israeliStockSearch"
                    name="israeliStockSearch"
                    className="sw-search-input"
                    value={searchText}
                    onChange={(e) => {
                      setSearchText(e.target.value);
                      setShowIsraeliSuggestions(true);
                    }}
                    onFocus={() => setShowIsraeliSuggestions(true)}
                    placeholder="לדוגמה: טבע, קסם S&P 500, או 1159250"
                    autoComplete="off"
                  />
                  {showIsraeliSuggestions && searchText.trim().length >= 2 && (
                    <div className="sw-search-suggestions">
                      {israeliSearchLoading ? (
                        <div className="sw-search-suggestion-empty">מחפש…</div>
                      ) : israeliSearchResults.length === 0 ? (
                        <div className="sw-search-suggestion-empty">
                          לא נמצאו תוצאות - אפשר להזין את מספר הנייר ידנית למטה.
                        </div>
                      ) : (
                        israeliSearchResults.map((r) => (
                          <button
                            key={r.securityId}
                            type="button"
                            className="sw-search-suggestion"
                            onClick={() => {
                              onSelectIsraeliStock(r);
                              setSearchText(r.officialName);
                              setShowIsraeliSuggestions(false);
                            }}
                          >
                            {r.officialName}
                            <span className="sw-search-exchange">
                              ({r.securityId}
                              {r.isFund ? ' · קרן/מחקה מדד' : ''})
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {formData.itemType === 'stock' && (
              <div className="form-group">
                <label htmlFor="stockName">
                  {formData.exchange === 'israeli' ? 'מספר נייר (TASE) *' : 'שם מנייה *'}
                </label>
                <input
                  type="text"
                  id="stockName"
                  name="stockName"
                  value={formData.stockName}
                  onChange={handleInputChange}
                  required
                  placeholder={formData.exchange === 'israeli' ? 'לדוגמה: 1159250 (מספר הנייר בבורסה)' : 'לדוגמה: AAPL, MSFT, TSLA'}
                />
                {formData.exchange === 'israeli' && (
                  <small className="form-help">
                    {formData.officialName
                      ? `נבחר: ${formData.officialName} (${formData.stockName})${
                          formData.isFund ? ' · קרן סל / מחקה מדד' : ''
                        }`
                      : 'הזינו את מספר הנייר בבורסה (למשל 1159250), או חפשו לפי שם/מספר בתיבה שמעל - גם קרנות סל, קרנות נאמנות ומחקות מדד'}
                  </small>
                )}
              </div>
            )}

            {formData.itemType === 'pension' && (
              <div className="form-group">
                <label htmlFor="stockName">שם קופה *</label>
                <input
                  type="text"
                  id="stockName"
                  name="stockName"
                  value={formData.stockName}
                  onChange={handleInputChange}
                  required
                  list="existing-pension-funds"
                  autoComplete="off"
                  placeholder="לדוגמה: קופת גמל להשקעה X"
                />
                <datalist id="existing-pension-funds">
                  {(holdings.pensionFunds || []).map((f) => (
                    <option key={f.id} value={f.fundName} />
                  ))}
                </datalist>
                <small className="form-help">
                  בחרו קופה קיימת מהרשימה כדי לרשום בה הפקדה, או הזינו שם חדש כדי לפתוח קופה.
                </small>
              </div>
            )}

            {formData.itemType === 'cash_fund' && (
              <>
                <div className="form-group">
                  <label htmlFor="stockName">שם הכספית (אופציונלי)</label>
                  <input
                    type="text"
                    id="stockName"
                    name="stockName"
                    value={formData.stockName}
                    onChange={handleInputChange}
                    placeholder="לדוגמה: כספית שקלית - בית השקעות"
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="securityId">מספר נייר ערך *</label>
                  <input
                    type="text"
                    id="securityId"
                    name="securityId"
                    value={formData.securityId}
                    onChange={handleInputChange}
                    required
                    list="existing-cash-funds"
                    autoComplete="off"
                    placeholder="לדוגמה: 5119609"
                  />
                  <datalist id="existing-cash-funds">
                    {(holdings.cashFunds || []).map((f) => (
                      <option key={f.id} value={f.securityId}>
                        {f.fundName}
                      </option>
                    ))}
                  </datalist>
                  <small className="form-help">
                    מספר נייר של כספית קיימת רושם בה הפקדה/משיכה; מספר חדש פותח כספית חדשה.
                  </small>
                </div>
              </>
            )}

            {formData.itemType === 'bank_savings' && (
              <div className="form-group">
                <label htmlFor="stockName">שם קופת חיסכון *</label>
                <input
                  type="text"
                  id="stockName"
                  name="stockName"
                  value={formData.stockName}
                  onChange={handleInputChange}
                  required
                  list="existing-bank-savings"
                  autoComplete="off"
                  placeholder="לדוגמה: קופת חיסכון - בנק לאומי"
                />
                <datalist id="existing-bank-savings">
                  {(holdings.bankSavingsFunds || []).map((f) => (
                    <option key={f.id} value={f.fundName} />
                  ))}
                </datalist>
                <small className="form-help">
                  בחרו קופה קיימת מהרשימה כדי לרשום בה הפקדה, או הזינו שם חדש כדי לפתוח קופה.
                </small>
              </div>
            )}

            {(formData.itemType === 'stock' || formData.itemType === 'pension' || formData.itemType === 'bank' || formData.itemType === 'cash_fund' || formData.itemType === 'bank_savings') && (
              <div className="form-group">
                <label htmlFor="purchaseDate">{formData.itemType === 'stock' ? 'תאריך קנייה *' : (formData.itemType === 'pension' || formData.itemType === 'bank_savings') ? 'תאריך ההפקדה *' : 'תאריך עדכון *'}</label>
                <input
                  type="date"
                  id="purchaseDate"
                  name="purchaseDate"
                  value={formData.purchaseDate}
                  onChange={handleInputChange}
                  required
                />
              </div>
            )}

            {formData.itemType === 'stock' ? (
              <div className="form-group">
                <label htmlFor="purchasePrice">מחיר קנייה *</label>
                <input
                  type="number"
                  id="purchasePrice"
                  name="purchasePrice"
                  value={formData.purchasePrice}
                  onChange={handleInputChange}
                  required
                  step="0.01"
                  min="0"
                  placeholder="0.00"
                />
              </div>
            ) : formData.itemType === 'pension' ? (
              <>
                <div className="form-group">
                  <label htmlFor="initialInvestment">סכום ההפקדה *</label>
                  <input
                    type="number"
                    id="initialInvestment"
                    name="initialInvestment"
                    value={formData.initialInvestment}
                    onChange={handleInputChange}
                    required
                    step="0.01"
                    min="0"
                    placeholder="0.00"
                  />
                  <small className="form-help">
                    השווי הנוכחי של הקופה יתחיל שווה לסכום ההפקדה (אם זו קופה חדשה) - אפשר לעדכן אותו בהמשך בטבלה כשיש שווי עדכני אמיתי.
                  </small>
                </div>
              </>
            ) : formData.itemType === 'bank' ? (
              <div className="form-group">
                <label htmlFor="purchasePrice">סכום ההפקדה/משיכה בעו"ש *</label>
                <input
                  type="number"
                  id="purchasePrice"
                  name="purchasePrice"
                  value={formData.purchasePrice}
                  onChange={handleInputChange}
                  required
                  step="0.01"
                  placeholder="0.00"
                />
                <small className="form-help">
                  סכום חיובי = הפקדה, סכום שלילי = משיכה. היתרה מתעדכנת בהתאם (ראו הסיכום למטה).
                </small>
              </div>
            ) : formData.itemType === 'cash_fund' ? (
              <div className="form-group">
                <label htmlFor="purchasePrice">סכום ההפקדה/משיכה *</label>
                <input
                  type="number"
                  id="purchasePrice"
                  name="purchasePrice"
                  value={formData.purchasePrice}
                  onChange={handleInputChange}
                  required
                  step="0.01"
                  placeholder="0.00"
                />
                <small className="form-help">
                  סכום חיובי = הפקדה, סכום שלילי = משיכה. היתרה מתעדכנת בהתאם (ראו הסיכום למטה).
                </small>
              </div>
            ) : formData.itemType === 'bank_savings' ? (
              <>
                <div className="form-group">
                  <label htmlFor="initialInvestment">סכום ההפקדה *</label>
                  <input
                    type="number"
                    id="initialInvestment"
                    name="initialInvestment"
                    value={formData.initialInvestment}
                    onChange={handleInputChange}
                    required
                    step="0.01"
                    min="0"
                    placeholder="0.00"
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="investmentTrack">מסלול השקעה *</label>
                  <input
                    type="text"
                    id="investmentTrack"
                    name="investmentTrack"
                    value={formData.investmentTrack}
                    onChange={handleInputChange}
                    required
                    placeholder="לדוגמה: מסלול שקלי, מסלול צמוד מדד..."
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="interestRate">ריבית שנתית (%) *</label>
                  <input
                    type="number"
                    id="interestRate"
                    name="interestRate"
                    value={formData.interestRate}
                    onChange={handleInputChange}
                    required
                    step="0.01"
                    min="0"
                    placeholder="4.00"
                  />
                  <small className="form-help">
                    השווי הנוכחי יחושב אוטומטית לפי ריבית-דריבית שנתית מתאריך ההפקדה - אין צורך לעדכן אותו ידנית.
                  </small>
                </div>
                <div className="form-group form-group-checkbox">
                  <label htmlFor="isLinkedToIndex">
                    <input
                      type="checkbox"
                      id="isLinkedToIndex"
                      name="isLinkedToIndex"
                      checked={!!formData.isLinkedToIndex}
                      onChange={(e) => handleInputChange({ target: { name: 'isLinkedToIndex', value: e.target.checked } })}
                    />
                    מסלול צמוד למדד המחירים לצרכן
                  </label>
                  <p className="form-hint">
                    צמוד למדד: מס של 25% על הרווח הריאלי בלבד. לא צמוד: מס שטוח של 15% על מלוא הרווח הנומינלי.
                  </p>
                </div>
              </>
            ) : null}

            {formData.itemType === 'stock' && (
              <div className="form-group">
                <label htmlFor="quantity">כמות *</label>
                <input
                  type="number"
                  id="quantity"
                  name="quantity"
                  value={formData.quantity}
                  onChange={handleInputChange}
                  required
                  min="1"
                  placeholder="1"
                />
              </div>
            )}

            {formData.itemType === 'stock' && formData.exchange === 'american' && (
              <div className="form-group">
                <label htmlFor="exchangeRate">שער חליפין ביום הקנייה *</label>
                {!formData.purchaseDate ? (
                  <small className="form-help">יש לבחור תחילה תאריך קנייה — שער החליפין יימשך אוטומטית.</small>
                ) : exchangeRateNotFound ? (
                  <>
                    <p className="exchange-rate-warning">
                      לא נמצא שער חליפין אוטומטי ליום זה — נא להזין ידנית.{' '}
                      <button type="button" className="link-button" onClick={onPullExchangeRate}>
                        נסה שוב
                      </button>
                    </p>
                    <input
                      type="number"
                      id="exchangeRate"
                      name="exchangeRate"
                      value={formData.exchangeRate}
                      onChange={handleInputChange}
                      required
                      step="0.0001"
                      min="0"
                      placeholder="3.5000"
                    />
                  </>
                ) : exchangeRateFetching || !formData.exchangeRate ? (
                  <small className="form-help">שולף את שער הדולר-שקל של יום הקנייה…</small>
                ) : (
                  <p className="exchange-rate-display">
                    שער חליפין: <strong>{formData.exchangeRate} ₪</strong> (נשלף אוטומטית ליום הקנייה)
                  </p>
                )}
              </div>
            )}

            {!isEditMode && (() => {
              const preview = entryPreviewText(formData, holdings);
              return preview ? (
                <p className="exchange-rate-display" role="status">
                  {preview}
                </p>
              ) : null;
            })()}

            <div className="form-buttons">
              <button type="button" onClick={handleBackToHome} className="back-button">
                חזרה לדף הבית
              </button>
              {isEditMode ? (
                <>
                  <button type="button" onClick={handleSaveEdit} className="submit-button">
                    שמור שינויים
                  </button>
                  <button type="button" onClick={handleCancelEdit} className="cancel-button">
                    ביטול
                  </button>
                </>
              ) : (
                <button type="submit" className="submit-button">
                  שמור מידע
                </button>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export default StockFormView;
