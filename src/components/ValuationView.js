import React, { useMemo, useState } from 'react';
import PageToolbar from './PageToolbar';
import BetaBanner from './BetaBanner';
import { useValuation } from '../hooks/useValuation';
import { useDcfSnapshot } from '../hooks/useDcfSnapshot';
import { evaluateDcf, EMPTY_OVERRIDES, DEFAULT_RULES } from '../shared/dcfRules';
import ValuationSummary from './valuation/ValuationSummary';
import ValuationSimple from './valuation/ValuationSimple';
import MultiplesSection from './valuation/MultiplesSection';
import DcfCalculator from './valuation/DcfCalculator';
import { fmtMoney } from './valuation/shared';

// Where the current multiples came from (server/marketDataFallbacks.js):
// Finnhub first, then FMP, then Yahoo.
const SUMMARY_SOURCE_LABELS = {
  finnhub: 'Finnhub',
  fmp: 'Financial Modeling Prep',
  'yahoo-summary': 'Yahoo Finance'
};

// /valuation - is this stock cheap or expensive? Written for someone who has
// never heard of a multiple: the answer first, on a cheap-to-expensive
// scale, then the three checks told as short stories with their numbers
// (valuation/ValuationSimple.js). Everything a professional wants - price
// multiples against the company's own 5-year history and its peers, and a
// DCF on the one engine (shared/dcfEngine.js), automatic by visible rules
// or manual - is folded below it under "למתקדמים". Market data comes from the server (server/valuationService.js
// for the multiples, server/dcfSnapshot.js for the DCF's raw data); the DCF
// runs here, so every edit recomputes instantly. Every technical number is
// still there, folded away under "details".

const SOURCE_LABELS = { summary: 'נתוני ציטוט', statements: 'דוחות כספיים', prices: 'מחירים חודשיים', peers: 'חברות להשוואה' };

// Each source's status, with the error a failed one came back with.
function SourceDiagnostics({ diagnostics }) {
  return (
    <ul className="muted-note" aria-label="פירוט מקורות">
      {Object.entries(diagnostics).map(([source, status]) => (
        <li key={source}>
          {SOURCE_LABELS[source] || source}: {status === 'ok' ? 'נטען' : 'נכשל'}
          {status === 'ok' ? '' : <bdi dir="ltr"> ({status.replace(/^error: /, '')})</bdi>}
        </li>
      ))}
    </ul>
  );
}

// One edit from the rules panel onto those made before it. The beta caps
// (keyed by size) and the WACC band (min / max, null = no edge on that
// side) are edited a field at a time, so they merge.
export function mergeRuleEdits(prev, patch) {
  const next = Object.assign({}, prev, patch);
  if (patch.betaCaps && prev.betaCaps) next.betaCaps = Object.assign({}, prev.betaCaps, patch.betaCaps);
  if (patch.waccBand && prev.waccBand) next.waccBand = Object.assign({}, prev.waccBand, patch.waccBand);
  return next;
}

// The rules the page values on: the defaults with the panel's edits.
export function rulesWithEdits(edits) {
  const patch = {};
  if (Number.isFinite(edits.fadeK)) patch.fadeK = edits.fadeK;
  if (edits.betaCaps) {
    patch.betaCaps = DEFAULT_RULES.betaCaps
      .map((tier) => {
        const e = edits.betaCaps[tier.above];
        if (e === 'off') return null;
        return Number.isFinite(e) ? Object.assign({}, tier, { betaCap: e }) : tier;
      })
      .filter(Boolean);
  }
  if (edits.waccBand) patch.waccBand = Object.assign({}, DEFAULT_RULES.waccBand, edits.waccBand);
  if (typeof edits.flatMargin === 'boolean') patch.flatMargin = edits.flatMargin;
  if (Number.isFinite(edits.sbcShareTechGrowth)) patch.sbcShareTechGrowth = Math.min(1, Math.max(0, edits.sbcShareTechGrowth));
  if (edits.terminalMethod) patch.terminalMethod = edits.terminalMethod;
  if (Number.isFinite(edits.exitMultiple)) patch.exitMultiple = edits.exitMultiple;
  return Object.assign({}, DEFAULT_RULES, patch);
}

function ValuationResult({ data }) {
  const { snapshot, loading: dcfLoading, error: dcfError } = useDcfSnapshot(data.symbol);
  // What a person added to the auto model (consensus growth, guided
  // margins, a normalized FCF, a missing rate - each with its source), and
  // the rule settings shown for editing (see the rules memo below).
  const [overrides, setOverrides] = useState(EMPTY_OVERRIDES);
  const [ruleEdits, setRuleEdits] = useState({});
  // The rules as edited on the page, on top of the default set: k, the
  // mega-cap beta cap ('off' for none), flat margins on or off, and the
  // terminal method with its multiple.
  const rules = useMemo(() => rulesWithEdits(ruleEdits), [ruleEdits]);
  // The automatic model, on the day it is viewed. Pure: the same snapshot,
  // additions, rules and date always give the same numbers.
  const autoEvaluation = useMemo(
    () => (snapshot ? evaluateDcf({ mode: 'auto', snapshot, overrides, rules, valuationDate: new Date().toISOString().slice(0, 10) }) : null),
    [snapshot, overrides, rules]
  );
  return (
    <>
      <ValuationSimple data={data} evaluation={autoEvaluation} dcfLoading={dcfLoading} />

      <details className="vs-advanced">
        <summary>
          <span>כל הנתונים והחישובים</span>
          <span className="vs-advanced-hint">למתקדמים: מכפילים, מחשבון DCF והנחות</span>
        </summary>
      <div className="analysis-section">
        <h2 className="section-title">
          {data.name || data.symbol} ({data.symbol})
        </h2>
        <p className="section-subtitle">
          {[data.sector, data.industry].filter(Boolean).join(' · ')} · מחיר {fmtMoney(data.price, data.currency)} · שווי שוק {fmtMoney(data.marketCap, data.currency)} · נתונים: {data.sources.statements === 'fmp' ? 'Financial Modeling Prep' : 'Yahoo Finance'}
          {data.sources.summary && SUMMARY_SOURCE_LABELS[data.sources.summary] ? ` · מכפילים נוכחיים: ${SUMMARY_SOURCE_LABELS[data.sources.summary]}` : ''}
          {data.partial ? ' (חלקיים)' : ''}, {String(data.asOf).slice(0, 10)}
        </p>
        {data.warnings.map((w) => (
          <p key={w} className="profit-negative">
            {w}
          </p>
        ))}
        {/* Why a source is missing, so a partial page can be traced
            to its cause without the server's logs. */}
        {data.partial && data.diagnostics && <SourceDiagnostics diagnostics={data.diagnostics} />}
      </div>

      <ValuationSummary data={data} autoEvaluation={autoEvaluation} dcfLoading={dcfLoading} snapshot={snapshot} />
      <MultiplesSection rows={data.multiples} peers={data.peers || []} />

      <div className="analysis-section">
        <h2 className="section-title">2. כמה החברה שווה לפי הכסף שהיא תייצר?</h2>
        <p className="val-intro">
          המחשבון (שיטת <strong>DCF</strong>) מעריך את החברה כמו שמעריכים עסק קטן: כמה כסף פנוי היא תייצר בכל אחת מ-5 השנים הבאות, כמה הוא שווה היום, ומה נשאר לכל מניה. במצב <strong>אוטומטי</strong> כל הנחה נגזרת מכללים גלויים (קונצנזוס אנליסטים, הדוחות האחרונים, ריבית האג"ח) - בלי תקרות או התאמות נסתרות. במצב <strong>ידני</strong> אפשר לשנות כל מספר. התוצאה תלויה בהנחות, ולכן מוצגים שלושה תרחישים ולא מספר אחד.
        </p>
        {dcfLoading && <p className="history-empty-note">טוען נתוני DCF…</p>}
        {dcfError && <p className="profit-negative">{dcfError}</p>}
        {(snapshot || !dcfLoading) && <DcfCalculator
            key={data.symbol}
            ticker={data.symbol}
            snapshot={snapshot}
            autoEvaluation={autoEvaluation}
            overrides={overrides}
            onOverrides={setOverrides}
            onRules={(patch) => setRuleEdits((r) => mergeRuleEdits(r, patch))}
          />}
        <p className="section-subtitle">
          FCF = תזרים מפעילות שוטפת פחות השקעות הוניות, ובניכוי תגמול מבוסס מניות (SBC). ערך סופי בשיטת Gordon. אינו ייעוץ השקעות. אפשר לייצא את כל הקלטים לכרטיס JSON ולשחזר את החישוב מחוץ לאתר.
        </p>
      </div>
      </details>
    </>
  );
}

function ValuationView({ americanStocks = [] }) {
  const held = useMemo(
    () => [...new Set(americanStocks.map((s) => String(s.stockName || '').trim().toUpperCase()).filter(Boolean))].sort(),
    [americanStocks]
  );
  const [symbol, setSymbol] = useState(held[0] || '');
  const [draft, setDraft] = useState('');
  const { data, loading, error, diagnostics } = useValuation(symbol);

  return (
    <div className="App">
      <div className="analysis-container">
        <div className="analysis-content">
          <PageToolbar title="הערכת שווי" subtitle="האם המניה זולה או יקרה? תשובה פשוטה, עם הסבר (מניות אמריקאיות)" />
          <BetaBanner tone="invest" />

          <div className="analysis-section">
            <div className="rebalance-sum-row">
              {held.length > 0 && (
                <>
                  <label htmlFor="val-held">בחרו מניה מהתיק</label>
                  <select id="val-held" value={held.includes(symbol) ? symbol : ''} onChange={(e) => setSymbol(e.target.value)}>
                    <option value="">—</option>
                    {held.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (draft.trim()) setSymbol(draft.trim().toUpperCase());
                }}
              >
                <label htmlFor="val-symbol">או הקלידו סימול של מניה</label> <input id="val-symbol" className="inline-input" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="AAPL" />{' '}
                <button type="submit" className="benchmark-toggle-button">
                  הצגה
                </button>
              </form>
            </div>
          </div>

          {loading && <p className="history-empty-note">אוספים נתונים על החברה…</p>}
          {error && <p className="profit-negative">{error}</p>}
          {error && diagnostics && <SourceDiagnostics diagnostics={diagnostics} />}
          {!symbol && !loading && (
            <p className="history-empty-note">
              בחרו מניה אמריקאית מהתיק או הקלידו את הסימול שלה (למשל AAPL לאפל), ונסביר בפשטות אם היא נראית זולה או יקרה.
            </p>
          )}

          {data && <ValuationResult key={data.symbol} data={data} />}

        </div>
      </div>
    </div>
  );
}

export default ValuationView;
