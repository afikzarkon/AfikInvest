import React, { useEffect, useMemo, useState } from 'react';
import PageToolbar from './PageToolbar';
import BetaBanner from './BetaBanner';
import {
  buildRecommendationContext,
  runRecommendationEngine,
  DEFAULT_RECOMMENDATION_PREFS,
  RULE_LABELS_HE
} from '../utils/recommendationEngine';

// /recommendations - rule-based Sell / Trim / Hold / Rebalance / Harvest
// suggestions from the user's own targets and thresholds (see
// utils/recommendationEngine.js). Computed in the browser from data the app
// already holds: holdings, CPI, rebalancing targets and the transactions
// ledger.

const ACTION_LABELS = {
  REBALANCE: 'איזון',
  TRIM: 'מימוש חלקי',
  SELL: 'מכירה',
  HARVEST: 'קיזוז הפסד',
  DEPLOY: 'השקעת מזומן',
  HOLD: 'החזקה'
};

const SEVERITY_LABELS = { high: 'גבוהה', medium: 'בינונית', low: 'נמוכה' };

const PREF_FIELDS = [
  { key: 'driftAbsPp', label: 'סטייה מהיעד שמפעילה איזון (נקודות אחוז)', step: 0.5 },
  { key: 'driftRel', label: 'או סטייה יחסית ליעד (0.25 = 25%)', step: 0.05 },
  { key: 'positionCapPct', label: 'תקרת פוזיציה בודדת (% מהתיק)', step: 1 },
  { key: 'profitTakePct', label: 'רווח שממנו לשקול מימוש (%)', step: 5 },
  { key: 'tlhMinLossILS', label: 'הפסד מינימלי לקיזוז (₪)', step: 100 },
  { key: 'minTradeILS', label: 'עסקה מינימלית (₪)', step: 100 }
];

function PrefsForm({ prefs, onSave }) {
  const [draft, setDraft] = useState(prefs);
  const [status, setStatus] = useState(null);
  useEffect(() => setDraft(prefs), [prefs]);

  const toggleRule = (id) => {
    const set = new Set(draft.enabledRules);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    setDraft({ ...draft, enabledRules: [...set] });
  };

  const submit = async (event) => {
    event.preventDefault();
    try {
      const payload = { lotMethod: draft.lotMethod, usTaxResident: draft.usTaxResident, enabledRules: draft.enabledRules };
      PREF_FIELDS.forEach(({ key }) => {
        payload[key] = Number(draft[key]);
      });
      await onSave(payload);
      setStatus({ ok: true, text: 'נשמר' });
    } catch (err) {
      setStatus({ ok: false, text: err.message });
    }
  };

  return (
    <form className="stock-form" onSubmit={submit} aria-label="הגדרות המלצות">
      {PREF_FIELDS.map(({ key, label, step }) => (
        <div className="form-group" key={key}>
          <label htmlFor={`pref-${key}`}>{label}</label>
          <input id={`pref-${key}`} type="number" step={step} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
        </div>
      ))}
      <div className="form-group">
        <label htmlFor="pref-lotMethod">שיטת התאמת מנות במכירה</label>
        <select id="pref-lotMethod" value={draft.lotMethod} onChange={(e) => setDraft({ ...draft, lotMethod: e.target.value })}>
          <option value="FIFO">FIFO - הוותיקה ראשונה</option>
          <option value="LIFO">LIFO - החדשה ראשונה</option>
          <option value="HIFO">HIFO - העלות הגבוהה ראשונה</option>
          <option value="SPECIFIC">בחירת מנות ספציפית</option>
        </select>
        <small className="form-help">הברוקר קובע איזו שיטה חלה עליכם; ברוב הברוקרים בישראל - FIFO.</small>
      </div>
      <div className="form-group form-group-checkbox">
        <label>
          <input type="checkbox" checked={Boolean(draft.usTaxResident)} onChange={(e) => setDraft({ ...draft, usTaxResident: e.target.checked })} />
          אני תושב מס בארה&quot;ב (חל כלל ה-Wash Sale של 30 יום)
        </label>
      </div>
      <fieldset className="form-group">
        <legend>כללים פעילים</legend>
        {Object.entries(RULE_LABELS_HE).map(([id, label]) => (
          <label key={id} className="form-group-checkbox">
            <input type="checkbox" checked={draft.enabledRules.includes(id)} onChange={() => toggleRule(id)} /> {label}
          </label>
        ))}
      </fieldset>
      <div className="rebalance-sum-row">
        <button type="submit" className="benchmark-toggle-button active">
          שמירה
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

function RecommendationsView({
  israeliStocks = [],
  americanStocks = [],
  pensionFunds = [],
  cashFunds = [],
  bankBalances = [],
  bankSavingsFunds = [],
  analysis,
  rebalanceTargets = null,
  cpi = null,
  transactions = [],
  savedPrefs = null,
  onSavePrefs,
  formatPriceWithSign = (v) => String(v)
}) {
  const prefs = useMemo(() => ({ ...DEFAULT_RECOMMENDATION_PREFS, ...(savedPrefs || {}) }), [savedPrefs]);
  const [showWhy, setShowWhy] = useState(null);
  const [showSettings, setShowSettings] = useState(false);

  const recommendations = useMemo(() => {
    const ctx = buildRecommendationContext({
      israeliStocks,
      americanStocks,
      pensionFunds,
      cashFunds,
      bankBalances,
      bankSavingsFunds,
      analysis,
      targets: rebalanceTargets,
      cpi,
      transactions,
      prefs
    });
    return runRecommendationEngine(ctx);
  }, [israeliStocks, americanStocks, pensionFunds, cashFunds, bankBalances, bankSavingsFunds, analysis, rebalanceTargets, cpi, transactions, prefs]);

  const hasTargets = rebalanceTargets && Object.values(rebalanceTargets).some((v) => Number(v) > 0);

  return (
    <div className="App">
      <div className="analysis-container">
        <div className="analysis-content">
          <PageToolbar title="המלצות" subtitle="איזון, מימוש רווחים, קיזוז הפסדים ומזומן עודף - לפי היעדים והספים שלכם" />
          <BetaBanner tone="tax" />

          <div className="analysis-section">
            {!hasTargets && (
              <p className="history-empty-note">
                לא הוגדרו יעדי הקצאה - המלצות האיזון יופיעו אחרי הגדרת יעדים בעמוד &quot;ניתוח תיק&quot;.
              </p>
            )}
            {recommendations.length === 0 ? (
              <p className="history-empty-note">אין כרגע המלצות - התיק בתוך הספים שהוגדרו. (החזקה)</p>
            ) : (
              <ul className="alert-list" aria-label="המלצות">
                {recommendations.map((rec) => (
                  <li key={rec.id} className={`alert-card severity-${rec.severity === 'high' ? 'critical' : rec.severity === 'medium' ? 'warning' : 'info'}`}>
                    <div className="alert-card-head">
                      <span className="alert-severity-badge severity-info">{ACTION_LABELS[rec.action] || rec.action}</span>
                      <h3 className="alert-card-title">{rec.title}</h3>
                      <span className="alert-card-time">עדיפות {SEVERITY_LABELS[rec.severity]}</span>
                    </div>
                    <p className="alert-card-message">{rec.rationale}</p>
                    <p className="alert-card-recommendation">
                      סכום: <bdi>{formatPriceWithSign(rec.amountILS)} ₪</bdi>
                      {rec.estTaxILS ? <> · מס משוער <bdi>{formatPriceWithSign(rec.estTaxILS)} ₪</bdi></> : null}
                      {rec.estTaxSavedILS ? <> · חיסכון מס משוער <bdi>{formatPriceWithSign(rec.estTaxSavedILS)} ₪</bdi></> : null}
                      {rec.blocked ? ` · חסום עד ${rec.blocked.until}` : ''}
                    </p>
                    <button type="button" className="benchmark-toggle-button" onClick={() => setShowWhy(showWhy === rec.id ? null : rec.id)} aria-expanded={showWhy === rec.id}>
                      למה?
                    </button>
                    {showWhy === rec.id && (
                      <dl className="recommendation-why">
                        <dt>כלל</dt>
                        <dd>
                          {RULE_LABELS_HE[rec.rule]}
                          {rec.alsoFlagged && rec.alsoFlagged.length ? ` (וגם: ${rec.alsoFlagged.map((r) => RULE_LABELS_HE[r]).join(', ')})` : ''}
                        </dd>
                        {Object.entries(rec.inputs || {}).map(([k, v]) => (
                          <React.Fragment key={k}>
                            <dt>{k}</dt>
                            <dd>{typeof v === 'number' ? Math.round(v * 100) / 100 : String(v)}</dd>
                          </React.Fragment>
                        ))}
                      </dl>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="section-subtitle">
              המלצות מבוססות כללים מכניים על היעדים והספים שלכם - אינן ייעוץ השקעות או ייעוץ מס. מס מחושב לפי 25% על הרווח הריאלי, אחרי קיזוז הפסדים שמומשו השנה.
            </p>
          </div>

          <div className="analysis-section">
            <button type="button" className="benchmark-toggle-button" onClick={() => setShowSettings(!showSettings)} aria-expanded={showSettings}>
              {showSettings ? 'הסתרת הגדרות' : 'הגדרות ההמלצות'}
            </button>
            {showSettings && <PrefsForm prefs={prefs} onSave={onSavePrefs} />}
          </div>
        </div>
      </div>
    </div>
  );
}

export default RecommendationsView;
