import React, { useMemo, useState } from 'react';
import PageToolbar from './PageToolbar';
import BetaBanner from './BetaBanner';
import { useValuation } from '../hooks/useValuation';
import { suggestDcfInputs } from '../utils/dcfValuation';
import ValuationSummary from './valuation/ValuationSummary';
import MultiplesSection from './valuation/MultiplesSection';
import DcfCalculator from './valuation/DcfCalculator';
import { fmtMoney } from './valuation/shared';

// /valuation - is this stock cheap or expensive? Written for someone who has
// never heard of a multiple: the answer first in plain words, then price
// multiples against the company's own 5-year history and its peers, then a
// DCF calculator framed as "what do you have to believe". Market data comes
// from the server (server/valuationService.js); the DCF runs here, so the
// sliders recompute instantly. Every technical number is still there,
// folded away under "details".

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

function ValuationResult({ data }) {
  const inputs = data.dcfInputs;
  const suggested = useMemo(
    () =>
      suggestDcfInputs({
        analystGrowth5y: inputs.analystGrowth5y,
        fcfHistory: inputs.fcfHistory.map((x) => x.fcf),
        beta: inputs.beta,
        riskFreeRate: inputs.riskFreeRate
      }),
    [inputs]
  );
  return (
    <>
      <div className="analysis-section">
        <h2 className="section-title">
          {data.name || data.symbol} ({data.symbol})
        </h2>
        <p className="section-subtitle">
          {[data.sector, data.industry].filter(Boolean).join(' · ')} · מחיר {fmtMoney(data.price, data.currency)} · שווי שוק {fmtMoney(data.marketCap, data.currency)} · נתונים: {data.sources.statements === 'fmp' ? 'Financial Modeling Prep' : 'Yahoo Finance'}{data.partial ? ' (חלקיים)' : ''}, {String(data.asOf).slice(0, 10)}
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

      <ValuationSummary data={data} suggested={suggested} />
      <MultiplesSection rows={data.multiples} />

      <div className="analysis-section">
        <h2 className="section-title">2. כמה החברה שווה לפי הכסף שהיא תייצר?</h2>
        <p className="val-intro">
          המחשבון (שיטת <strong>DCF</strong>) מעריך את החברה כמו שמעריכים עסק קטן: מנחשים כמה כסף פנוי הוא ייצר בשנים הבאות, מתרגמים את הכסף העתידי לערך של היום, ומחלקים במספר המניות. התוצאה תלויה לגמרי בניחושים - לכן אפשר להזיז אותם ולראות מה קורה. השאלה הכי שימושית היא לא "כמה זה שווה?" אלא "<strong>מה צריך להאמין כדי שהמחיר יהיה הגיוני?</strong>"
        </p>
        <DcfCalculator data={data} suggested={suggested} />
        <p className="section-subtitle">
          מודל מפושט: כסף פנוי (FCF) = תזרים מפעילות שוטפת פחות השקעות הוניות, מהוון ובניכוי חוב נטו. לא מודל של בנק השקעות ואינו ייעוץ השקעות.
        </p>
      </div>
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
          <PageToolbar title="הערכת שווי" subtitle="האם המניה זולה או יקרה? שלוש בדיקות פשוטות (מניות אמריקאיות)" />
          <BetaBanner tone="invest" />

          <div className="analysis-section">
            <div className="rebalance-sum-row">
              {held.length > 0 && (
                <>
                  <label htmlFor="val-held">מהתיק</label>
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
                <label htmlFor="val-symbol">סימול אחר</label> <input id="val-symbol" className="inline-input" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="AAPL" />{' '}
                <button type="submit" className="benchmark-toggle-button">
                  הצגה
                </button>
              </form>
            </div>
          </div>

          {loading && <p className="history-empty-note">טוען נתונים פיננסיים…</p>}
          {error && <p className="profit-negative">{error}</p>}
          {error && diagnostics && <SourceDiagnostics diagnostics={diagnostics} />}
          {!symbol && !loading && <p className="history-empty-note">בחרו מניה אמריקאית מהתיק או הקלידו סימול.</p>}

          {data && <ValuationResult key={data.symbol} data={data} />}

        </div>
      </div>
    </div>
  );
}

export default ValuationView;
