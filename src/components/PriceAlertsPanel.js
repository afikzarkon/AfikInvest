import React, { useState } from 'react';
import {
  RULE_LABELS_HE,
  MAX_PRICE_ALERTS_PER_USER,
  validatePriceAlertInput,
  describeRule,
  formatPrice,
  isPctType
} from '../shared/priceAlertRules';

// The "התראות מחיר" tab of /alerts: rules the user sets on any security
// (held or not) - above / below a price, or a percent move from the
// previous close. The server checks them during trading hours and, when one
// hits, adds a normal alert to the list (it rings once; re-arm to reuse).
// Ported from day-trader-skill (MIT, Jake Schincariol) - trader-alerts.

const EMPTY = { market: 'US', symbol: '', name: '', ruleType: 'above', value: '', note: '' };

const formatDateTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
};

function PriceAlertForm({ onCreate, disabled }) {
  const [draft, setDraft] = useState(EMPTY);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (key) => (e) => setDraft({ ...draft, [key]: e.target.value });

  const submit = async (event) => {
    event.preventDefault();
    setStatus(null);
    let input;
    try {
      input = validatePriceAlertInput(draft);
    } catch (err) {
      setStatus({ ok: false, text: err.message });
      return;
    }
    setBusy(true);
    try {
      const d = await onCreate(input);
      let text = 'ההתראה נוספה.';
      if (d && d.currentPrice !== null && d.currentPrice !== undefined) text += ` מחיר אחרון: ${formatPrice(d.currentPrice, input.market)}.`;
      if (d && d.alreadyMet) text += ' התנאי כבר מתקיים - ההתראה תופעל בבדיקה הבאה בשעות המסחר.';
      setStatus({ ok: true, text });
      setDraft({ ...EMPTY, market: input.market });
    } catch (err) {
      setStatus({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const pct = isPctType(draft.ruleType);
  return (
    <form className="stock-form" onSubmit={submit} aria-label="התראת מחיר חדשה">
      <div className="form-group">
        <label htmlFor="price-alert-market">בורסה</label>
        <select id="price-alert-market" value={draft.market} onChange={set('market')}>
          <option value="US">ארה&quot;ב</option>
          <option value="TASE">תל אביב</option>
        </select>
      </div>
      <div className="form-group">
        <label htmlFor="price-alert-symbol">{draft.market === 'TASE' ? 'מספר נייר ערך' : 'סימול'}</label>
        <input
          id="price-alert-symbol"
          type="text"
          dir="ltr"
          inputMode={draft.market === 'TASE' ? 'numeric' : 'text'}
          placeholder={draft.market === 'TASE' ? '629014' : 'AAPL'}
          value={draft.symbol}
          onChange={set('symbol')}
        />
      </div>
      <div className="form-group">
        <label htmlFor="price-alert-name">שם (לא חובה)</label>
        <input id="price-alert-name" type="text" value={draft.name} onChange={set('name')} />
      </div>
      <div className="form-group">
        <label htmlFor="price-alert-type">תנאי</label>
        <select id="price-alert-type" value={draft.ruleType} onChange={set('ruleType')}>
          {Object.keys(RULE_LABELS_HE).map((key) => (
            <option key={key} value={key}>
              {RULE_LABELS_HE[key]}
            </option>
          ))}
        </select>
      </div>
      <div className="form-group">
        <label htmlFor="price-alert-value">{pct ? 'אחוז (%)' : `מחיר (${draft.market === 'TASE' ? '₪' : '$'})`}</label>
        <input id="price-alert-value" type="number" step="any" min="0" dir="ltr" value={draft.value} onChange={set('value')} />
      </div>
      <div className="form-group">
        <label htmlFor="price-alert-note">הערה (לא חובה)</label>
        <input id="price-alert-note" type="text" maxLength={200} value={draft.note} onChange={set('note')} />
      </div>
      <div className="rebalance-sum-row">
        <button type="submit" className="benchmark-toggle-button active" disabled={busy || disabled}>
          {busy ? 'מוסיף…' : 'הוספת התראה'}
        </button>
        {status && (
          <span role="status" className={status.ok ? 'profit-positive' : 'profit-negative'}>
            {status.text}
          </span>
        )}
      </div>
    </form>
  );
}

function PriceAlertRow({ rule, onRearm, onRemove }) {
  const [rowError, setRowError] = useState('');
  const run = (fn) => async () => {
    setRowError('');
    try {
      await fn(rule.id);
    } catch (err) {
      setRowError(err.message);
    }
  };
  const label = rule.name ? `${rule.name} (${rule.symbol})` : rule.symbol;
  return (
    <tr>
      <td>
        {label}
        <span className="section-subtitle"> {rule.market === 'TASE' ? 'ת"א' : 'ארה"ב'}</span>
      </td>
      <td>{describeRule(rule)}</td>
      <td>
        {rule.status === 'triggered' ? (
          <span className="profit-negative">
            הופעלה {formatDateTime(rule.triggeredAt)}
            {rule.triggeredPrice !== null && rule.triggeredPrice !== undefined ? ` ב-${formatPrice(rule.triggeredPrice, rule.market)}` : ''}
          </span>
        ) : (
          'פעילה'
        )}
      </td>
      <td title={rule.lastCheckedAt ? `נבדק ${formatDateTime(rule.lastCheckedAt)}` : ''}>
        {rule.lastPrice !== null && rule.lastPrice !== undefined ? formatPrice(rule.lastPrice, rule.market) : '—'}
      </td>
      <td>{rule.note}</td>
      <td>
        {rule.status === 'triggered' && (
          <button type="button" className="benchmark-toggle-button" onClick={run(onRearm)} aria-label={`הפעלה מחדש ${rule.symbol}`}>
            הפעלה מחדש
          </button>
        )}
        <button type="button" className="benchmark-toggle-button" onClick={run(onRemove)} aria-label={`מחיקה ${rule.symbol}`}>
          מחיקה
        </button>
        {rowError && (
          <span role="alert" className="profit-negative">
            {rowError}
          </span>
        )}
      </td>
    </tr>
  );
}

function PriceAlertsPanel({ rules = [], max = MAX_PRICE_ALERTS_PER_USER, loading = false, error = '', create, rearm, remove }) {
  const full = rules.length >= max;
  return (
    <div className="analysis-section">
      <h2 className="section-title">התראות מחיר</h2>
      <p className="section-subtitle">
        התראה על כל נייר - גם כזה שאינו בתיק - כשהמחיר עובר רף שתגדירו, או כשהוא זז באחוז מסוים מהסגירה הקודמת. כל התראה מופעלת פעם אחת ונשארת
        שקטה עד שתפעילו אותה מחדש. ({rules.length}/{max})
      </p>
      <PriceAlertForm onCreate={create} disabled={full} />
      {full && <p className="profit-negative">הגעתם למספר ההתראות המרבי ({max}). מחקו התראה כדי להוסיף חדשה.</p>}
      {error && <p className="profit-negative">{error}</p>}
      {loading && !rules.length ? (
        <p className="history-empty-note">טוען…</p>
      ) : rules.length === 0 ? (
        <p className="history-empty-note">עוד לא הוגדרו התראות מחיר.</p>
      ) : (
        <div className="stocks-table-container">
          <table className="analysis-table" aria-label="התראות מחיר">
            <thead>
              <tr>
                <th>נייר</th>
                <th>תנאי</th>
                <th>סטטוס</th>
                <th>מחיר אחרון</th>
                <th>הערה</th>
                <th>פעולות</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <PriceAlertRow key={rule.id} rule={rule} onRearm={rearm} onRemove={remove} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="section-subtitle">
        המחירים מושהים ואינם בזמן אמת, ונבדקים בערך כל רבע שעה בשעות המסחר - מחיר יכול לעבור את הרף ולחזור בין שתי בדיקות. ההתראה היא מידע בלבד, לא
        פקודת מסחר ולא ייעוץ השקעות.
      </p>
    </div>
  );
}

export default PriceAlertsPanel;
