// Ported from day-trader-skill (MIT, Jake Schincariol)
//
// /trade-sim - "what could happen to this trade?" A long day-trade plan
// (entry, stop, target) is replayed 10,000 times from the stock's own
// 5-minute bars over the last ~60 days (server/tradeSimRoutes.js, the math in
// shared/tradeSim.js), the same rule is re-run on every past session, and the
// position is sized to the account and the max loss per trade. The result is
// odds, not a forecast - the disclaimer stays on the page the whole time.
import React, { useMemo, useState } from 'react';
import PageToolbar from './PageToolbar';
import { useTradeSim } from '../hooks/useTradeSim';
import './TradeSimView.css';

const STOP_OPTIONS = [
  { value: 'pct', label: 'אחוז מתחת לכניסה', unit: '%', placeholder: '1' },
  { value: 'price', label: 'מחיר', unit: '$', placeholder: '' },
  { value: 'atr', label: 'מכפיל ATR (14 נרות)', unit: 'x', placeholder: '1.5' },
  { value: 'or_mid', label: 'אמצע טווח הפתיחה (15 דק׳)', unit: '' },
  { value: 'or_low', label: 'שפל טווח הפתיחה (15 דק׳)', unit: '' }
];
const TARGET_OPTIONS = [
  { value: 'r', label: 'מכפיל R (פעמים הסיכון)', unit: 'R' },
  { value: 'price', label: 'מחיר', unit: '$' }
];
const ENTRY_TIMES = [];
for (let m = 9 * 60 + 45; m <= 15 * 60 + 30; m += 15) {
  ENTRY_TIMES.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
}

const DISCLAIMER_TITLE = 'סימולציה, לא תחזית';
const DISCLAIMER_BODY =
  'התוצאות מבוססות על התנהגות המניה עצמה ב-60 הימים האחרונים בלבד. זו אינה תחזית, אינה ייעוץ השקעות ואינה המלצה לקנות או למכור. ' +
  'דוחות, חדשות ועצירות מסחר יכולים לעשות מה שהעבר הקרוב לא עשה. סטופ אינו הבטחה: בפער מחיר או בשוק מהיר הוא עלול להתבצע במחיר גרוע יותר. ' +
  'מסחר יומי מפסיד כסף לרוב האנשים. צד הקנייה בלבד.';

const pct1 = (x) => `${(100 * (Number(x) || 0)).toFixed(1)}%`;
const usd = (x) => (x == null || !Number.isFinite(Number(x)) ? '—' : `$${Number(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const signed = (x, digits = 2) => (x == null ? '—' : `${x > 0 ? '+' : ''}${Number(x).toFixed(digits)}`);
const OUTCOME_LABELS = { target: 'יעד', stop: 'סטופ', close: 'פתוחה בסגירה' };

function heldSymbols(americanStocks) {
  const seen = new Set();
  (Array.isArray(americanStocks) ? americanStocks : []).forEach((s) => {
    const sym = String((s && (s.stockName || s.symbol)) || '').trim().toUpperCase();
    if (/^[A-Z][A-Z0-9.-]{0,9}$/.test(sym)) seen.add(sym);
  });
  return Array.from(seen).sort();
}

function Disclaimer() {
  return (
    <div className="ts-disclaimer" role="note" aria-label="הבהרה">
      <strong>{DISCLAIMER_TITLE}</strong>
      <p>{DISCLAIMER_BODY}</p>
    </div>
  );
}

function OddsBar({ odds, until }) {
  const parts = [
    { key: 'target', label: 'יעד קודם', value: odds.target },
    { key: 'stop', label: 'סטופ קודם', value: odds.stop },
    { key: 'open', label: `פתוחה ב-${until}`, value: odds.open }
  ];
  return (
    <div>
      <div className="ts-odds-bar" role="img" aria-label={parts.map((p) => `${p.label} ${pct1(p.value)}`).join(', ')}>
        {parts.map((p) => (p.value > 0 ? <span key={p.key} className={`ts-odds-${p.key}`} style={{ width: `${100 * p.value}%` }} /> : null))}
      </div>
      <ul className="ts-odds-legend">
        {parts.map((p) => (
          <li key={p.key} data-testid={`ts-odds-${p.key}`}>
            <span className={`ts-dot ts-odds-${p.key}`} aria-hidden="true" />
            {p.label}: <bdi>{pct1(p.value)}</bdi>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Histogram({ dist, plan }) {
  const bins = (dist.hist && dist.hist.bins) || [];
  const max = Math.max(1, ...bins);
  const { lo, hi } = dist.hist || {};
  const width = bins.length ? (hi - lo) / bins.length : 0;
  return (
    <div>
      <div className="ts-hist" role="img" aria-label="התפלגות מחיר הסגירה בסימולציות">
        {bins.map((n, i) => {
          const mid = lo + width * (i + 0.5);
          const tone = mid >= plan.target ? 'up' : mid <= plan.stop ? 'down' : mid >= plan.entry ? 'flat-up' : 'flat-down';
          return <span key={i} className={`ts-hist-bar ts-hist-${tone}`} style={{ height: `${(100 * n) / max}%` }} title={`${usd(lo + width * i)} - ${usd(lo + width * (i + 1))}: ${n}`} />;
        })}
      </div>
      <div className="ts-hist-axis" dir="ltr">
        <span>{usd(lo)}</span>
        <span>{usd(hi)}</span>
      </div>
    </div>
  );
}

function Results({ r }) {
  const { plan, sizing, history, coverage } = r;
  return (
    <>
      <div className="analysis-section" aria-label="השורה התחתונה" role="region">
        <h2 className="section-title">השורה התחתונה</h2>
        <p className="ts-verdict" data-testid="ts-verdict">
          {r.verdict}
        </p>
        {r.verdictNotes.map((n) => (
          <p key={n} className="muted-note">
            {n}
          </p>
        ))}
        {r.warnings.map((w) => (
          <p key={w} className="profit-negative">
            {w}
          </p>
        ))}
        <p className="muted-note">
          {r.mode === 'live'
            ? `המסחר פתוח: כניסה בסגירת הנר של ${r.entryTime} (שעון ניו יורק), והסימולציה משחזרת את המשך היום עד ${r.until}.`
            : `השוק סגור כעת: כניסה היפותטית ב-${r.entryTime} (שעון ניו יורק) ביום המסחר הבא, מהמחיר האחרון, עד ${r.until}.`}
        </p>
      </div>

      <div className="ts-grid">
        <div className="analysis-section" role="region" aria-label="התכנית">
          <h2 className="section-title">התכנית</h2>
          <dl className="ts-kv">
            <dt>כניסה</dt>
            <dd data-testid="ts-entry">{usd(plan.entry)}</dd>
            <dt>סטופ</dt>
            <dd>
              {usd(plan.stop)} <span className="muted-note">({plan.stopLabel})</span>
            </dd>
            <dt>יעד</dt>
            <dd>
              {usd(plan.target)} <span className="muted-note">({plan.targetLabel})</span>
            </dd>
            <dt>סיכון למניה</dt>
            <dd>
              {usd(plan.risk)} <span className="muted-note">({plan.riskPct}% מהכניסה)</span>
            </dd>
            <dt>סיכוי:סיכון</dt>
            <dd data-testid="ts-rr">1 : {plan.rewardRisk}</dd>
          </dl>
        </div>

        <div className="analysis-section" role="region" aria-label="כמה מניות">
          <h2 className="section-title">כמה מניות</h2>
          {sizing.refusal ? (
            <p className="profit-negative" data-testid="ts-refusal">
              {sizing.refusal}
            </p>
          ) : (
            <>
              <p className="ts-shares" data-testid="ts-shares">
                {sizing.qty} מניות · {usd(sizing.cost)}
              </p>
              <p>
                המגבלה שקבעה: <strong>{sizing.boundByLabel}</strong>
              </p>
              <p>
                הפסד מרבי אם הסטופ נפגע: <strong className="profit-negative">{usd(sizing.maxLossAtStop)}</strong> ({sizing.qty} × {usd(sizing.riskPerShare)})
              </p>
            </>
          )}
          <details>
            <summary>כל המגבלות</summary>
            <ul className="muted-note">
              {sizing.limits.map((l) => (
                <li key={l.name}>
                  {l.label}: {l.shares} מניות <bdi dir="ltr">({l.how})</bdi>
                  {l.binds ? ' ← קובעת' : ''}
                </li>
              ))}
            </ul>
          </details>
        </div>
      </div>

      <div className="analysis-section" role="region" aria-label="הסיכויים">
        <h2 className="section-title">
          הסיכויים ב-{r.sims.toLocaleString('en-US')} סימולציות
        </h2>
        <OddsBar odds={r.odds} until={r.until} />
        <p className="muted-note">
          R ממוצע: <bdi dir="ltr">{signed(r.avgR, 3)}</bdi> (‎+{r.rAtTarget}R ביעד, ‎-1R בסטופ). ירוק בסוף: {pct1(r.odds.green)} (יעד קודם, או מעל הכניסה ב-{r.until}).
        </p>
      </div>

      <div className="analysis-section" role="region" aria-label="מחיר בסגירה">
        <h2 className="section-title">איפה המחיר ב-{r.until}</h2>
        <p>
          חציון <strong>{usd(r.closeDistribution.median)}</strong>; ב-90% מהסימולציות בין {usd(r.closeDistribution.p5)} ל-{usd(r.closeDistribution.p95)}; בחצי האמצעי בין {usd(r.closeDistribution.p25)} ל-
          {usd(r.closeDistribution.p75)}.
        </p>
        <Histogram dist={r.closeDistribution} plan={plan} />
      </div>

      <div className="analysis-section" role="region" aria-label="היסטוריה">
        <h2 className="section-title">אותו כלל על ימי המסחר הקודמים</h2>
        {history.triggered ? (
          <p data-testid="ts-history">
            {history.rule === 'orb' ? 'פריצה של טווח הפתיחה, עם אותו סטופ ויעד, ' : `כניסה ב-${r.entryTime} עם אותו סטופ ויעד, `}
            הופעל {history.triggered} פעמים ב-{history.sessions} ימי מסחר: {history.target} יעד, {history.stop} סטופ, {history.open} פתוחות בסגירה. R ממוצע{' '}
            <bdi dir="ltr">{signed(history.avgR, 3)}</bdi>.
          </p>
        ) : (
          <p className="history-empty-note">הכלל לא הופעל באף אחד מ-{history.sessions} ימי המסחר.</p>
        )}
        {history.trades.length > 0 && (
          <details>
            <summary>העסקאות האחרונות</summary>
            <table className="ts-table">
              <thead>
                <tr>
                  <th>תאריך</th>
                  <th>שעה</th>
                  <th>כניסה</th>
                  <th>סטופ</th>
                  <th>יעד</th>
                  <th>תוצאה</th>
                  <th>R</th>
                </tr>
              </thead>
              <tbody>
                {history.trades.map((t) => (
                  <tr key={t.date}>
                    <td>{t.date}</td>
                    <td dir="ltr">{t.time}</td>
                    <td>{t.entry.toFixed(2)}</td>
                    <td>{t.stop.toFixed(2)}</td>
                    <td>{t.target.toFixed(2)}</td>
                    <td>{OUTCOME_LABELS[t.outcome] || t.outcome}</td>
                    <td dir="ltr" className={t.R > 0 ? 'profit-positive' : t.R < 0 ? 'profit-negative' : ''}>
                      {signed(t.R)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </div>

      <p className="muted-note" data-testid="ts-coverage">
        נתונים: {coverage.sessions} ימי מסחר מלאים ({coverage.from} עד {coverage.to}), נרות של 5 דקות; נר אחרון {coverage.lastBar}.
        {coverage.shortSessionsLeftOut && coverage.shortSessionsLeftOut.length > 0 ? ` ימים חלקיים שלא נכללו: ${coverage.shortSessionsLeftOut.map((s) => s.date).join(', ')}.` : ''} seed {r.seed}
        {' '}(אותו seed, אותם מספרים).
      </p>
    </>
  );
}

export default function TradeSimView({ user, authHeader, americanStocks }) {
  const held = useMemo(() => heldSymbols(americanStocks), [americanStocks]);
  const [form, setForm] = useState({
    symbol: held[0] || '',
    entry: '',
    entryTime: '10:00',
    stopType: 'pct',
    stopValue: '1',
    targetType: 'r',
    targetValue: '2',
    account: '5000',
    maxLoss: '50',
    positionCapPct: '75',
    cashBufferPct: '10'
  });
  const { result, loading, error, run } = useTradeSim(user, authHeader);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const stopOpt = STOP_OPTIONS.find((o) => o.value === form.stopType) || STOP_OPTIONS[0];
  const needsStopValue = Boolean(stopOpt.unit);

  const onSubmit = (e) => {
    e.preventDefault();
    run({
      symbol: form.symbol.trim().toUpperCase(),
      entry: form.entry === '' ? undefined : Number(form.entry),
      entryTime: form.entryTime,
      stop: { type: form.stopType, value: needsStopValue ? Number(form.stopValue) : undefined },
      target: { type: form.targetType, value: Number(form.targetValue) },
      account: Number(form.account),
      maxLossPerTrade: Number(form.maxLoss),
      positionCapPct: form.positionCapPct === '' ? undefined : Number(form.positionCapPct),
      cashBufferPct: form.cashBufferPct === '' ? undefined : Number(form.cashBufferPct)
    });
  };

  return (
    <div className="App">
      <div className="analysis-container">
        <div className="analysis-content">
          <PageToolbar title="סימולטור עסקה" subtitle="מה יכול לקרות לעסקה יומית לפני שמסכנים דולר: סטופ, יעד, סיכויים וגודל פוזיציה (מניות אמריקאיות, קנייה בלבד)" />
          <Disclaimer />

          <form className="analysis-section ts-form" onSubmit={onSubmit} aria-label="תכנית העסקה">
            <div className="ts-field">
              <label htmlFor="ts-symbol">סימול</label>
              <input id="ts-symbol" className="inline-input" list="ts-held" value={form.symbol} onChange={set('symbol')} placeholder="AAPL" dir="ltr" autoComplete="off" required />
              <datalist id="ts-held">
                {held.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </div>
            <div className="ts-field">
              <label htmlFor="ts-entry">מחיר כניסה</label>
              <input id="ts-entry" className="inline-input" type="number" step="0.01" min="0" value={form.entry} onChange={set('entry')} placeholder="מחיר אחרון" dir="ltr" />
            </div>
            <div className="ts-field">
              <label htmlFor="ts-entry-time">שעת כניסה כשהשוק סגור (ניו יורק)</label>
              <select id="ts-entry-time" value={form.entryTime} onChange={set('entryTime')}>
                {ENTRY_TIMES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="ts-field">
              <label htmlFor="ts-stop-type">סטופ</label>
              <select id="ts-stop-type" value={form.stopType} onChange={set('stopType')}>
                {STOP_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {needsStopValue && (
                <input
                  aria-label={`ערך הסטופ (${stopOpt.unit})`}
                  className="inline-input ts-small"
                  type="number"
                  step="any"
                  min="0"
                  value={form.stopValue}
                  onChange={set('stopValue')}
                  placeholder={stopOpt.placeholder}
                  dir="ltr"
                  required
                />
              )}
            </div>
            <div className="ts-field">
              <label htmlFor="ts-target-type">יעד</label>
              <select id="ts-target-type" value={form.targetType} onChange={set('targetType')}>
                {TARGET_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <input aria-label="ערך היעד" className="inline-input ts-small" type="number" step="any" min="0" value={form.targetValue} onChange={set('targetValue')} dir="ltr" required />
            </div>
            <div className="ts-field">
              <label htmlFor="ts-account">גודל החשבון ($)</label>
              <input id="ts-account" className="inline-input" type="number" step="any" min="0" value={form.account} onChange={set('account')} dir="ltr" required />
            </div>
            <div className="ts-field">
              <label htmlFor="ts-max-loss">הפסד מרבי לעסקה ($)</label>
              <input id="ts-max-loss" className="inline-input" type="number" step="any" min="0" value={form.maxLoss} onChange={set('maxLoss')} dir="ltr" required />
            </div>
            <details className="ts-advanced">
              <summary>מגבלות נוספות</summary>
              <div className="ts-field">
                <label htmlFor="ts-cap">תקרת פוזיציה (% מהחשבון)</label>
                <input id="ts-cap" className="inline-input ts-small" type="number" step="any" min="0" max="100" value={form.positionCapPct} onChange={set('positionCapPct')} dir="ltr" />
              </div>
              <div className="ts-field">
                <label htmlFor="ts-buffer">כרית מזומן (%)</label>
                <input id="ts-buffer" className="inline-input ts-small" type="number" step="any" min="0" max="99" value={form.cashBufferPct} onChange={set('cashBufferPct')} dir="ltr" />
              </div>
            </details>
            <div className="ts-actions">
              <button type="submit" className="benchmark-toggle-button active" disabled={loading}>
                {loading ? 'מריצים 10,000 סימולציות…' : 'הריצו סימולציה'}
              </button>
            </div>
          </form>

          {error && (
            <p className="profit-negative" role="alert">
              {error}
            </p>
          )}
          {result && <Results r={result} />}
        </div>
      </div>
    </div>
  );
}
