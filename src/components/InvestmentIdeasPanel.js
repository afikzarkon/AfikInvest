import React from 'react';
import { IDEAS_DISCLAIMER_HE, IDEAS_CONFIG } from '../utils/portfolioReviewConfig';
import { CATALOG_NOTICE_HE } from '../utils/investmentIdeas';
import { formatPriceWithSign } from '../utils/formatters';

// The "ideas to enrich the portfolio" tab of /review. Renders what
// utils/investmentIdeas.js returns; every reason, figure and drawback
// comes from there or from the catalog.
//
// Drawbacks sit beside the advantages, in a column of the same weight -
// never folded away under them.

const ils = (v) => `${formatPriceWithSign(v)} ₪`;
const pctText = (v) => (Number.isFinite(v) ? `${v.toFixed(1)}%` : '—');
const scoreText = (v) => (Number.isFinite(v) ? String(v) : '—');

const SIM_ROWS = [
  { key: 'largestPct', label: 'המניה הבודדת הגדולה', format: pctText },
  { key: 'topSectorPct', label: 'הסקטור הגדול', format: pctText },
  { key: 'topCurrencyPct', label: 'המטבע הדומיננטי', format: pctText },
  { key: 'israelPct', label: 'ישראל מתוך ניירות הערך', format: pctText },
  { key: 'fixedIncomePct', label: 'אג"ח ופיקדונות', format: pctText },
  { key: 'diversificationScore', label: 'ציון פיזור וסיכון', format: scoreText },
  { key: 'overallScore', label: 'ציון כללי', format: scoreText }
];

function Simulation({ simulation }) {
  if (!simulation) {
    return <p className="review-muted">אין עדיין היסטוריית הפקדות, ולכן אי אפשר לחשב מה הפקדה רגילה הייתה משנה.</p>;
  }
  return (
    <>
      <p className="review-muted">
        אם {Math.round(simulation.share * 100)}% מההפקדה הבאה ({ils(simulation.amountILS)} מתוך {ils(simulation.depositILS)}) היו הולכים לכאן, והשאר לפי התמהיל הנוכחי:
      </p>
      <div className="review-table-wrap">
        <table className="review-table idea-sim">
          <thead>
            <tr>
              <th scope="col">מדד</th>
              <th scope="col">היום</th>
              <th scope="col">אחרי</th>
            </tr>
          </thead>
          <tbody>
            {SIM_ROWS.map((row) => (
              <tr key={row.key}>
                <th scope="row">{row.label}</th>
                <td>{row.format(simulation.before[row.key])}</td>
                <td>{row.format(simulation.after[row.key])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="review-muted">הפקדה אחת משנה מעט. הטבלה מראה את הכיוון, לא תחזית. רק תחום הפיזור מחושב מחדש, ושאר התחומים נשארים כמו שהם.</p>
    </>
  );
}

function IdeaCard({ idea }) {
  const c = idea.item;
  const drawbacks = [...(c.consHe || []), ...(c.risksHe || [])];
  return (
    <article className="idea-card">
      <header className="idea-card-head">
        <div>
          <h3>{c.nameHe}</h3>
          <p className="review-muted">
            {c.symbol ? `${c.symbol} · ` : ''}
            {c.name}
            {c.listing ? ` · ${c.listing === 'TASE' ? 'בורסת ת"א' : c.listing === 'LSE' ? 'בורסת לונדון' : 'בורסה אמריקאית'}` : ''}
          </p>
        </div>
        <div className="idea-chips">
          <span className="review-chip tone-none">{idea.typeLabel}</span>
          <span className={`review-chip idea-risk-${c.risk}`}>סיכון {idea.riskLabel}</span>
        </div>
      </header>
      {idea.isSample ? <p className="idea-sample">נתוני דוגמה - יש לאמת מול התשקיף לפני שימוש</p> : null}

      <div className="idea-why">
        <h4>למה זה עלה לך</h4>
        <ul>
          {idea.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      </div>

      <p className="idea-description">{c.descriptionHe}</p>

      <div className="idea-pros-cons">
        <div className="idea-pros">
          <h4>יתרונות</h4>
          <ul>
            {(c.prosHe || []).map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>
        <div className="idea-cons">
          <h4>חסרונות וסיכונים</h4>
          <ul>
            {drawbacks.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>
      </div>

      <dl className="idea-facts">
        <div>
          <dt>עלויות</dt>
          <dd>{idea.costText}</dd>
        </div>
        <div>
          <dt>אזור ומטבע</dt>
          <dd>
            {idea.regionLabel} · {c.currency === 'ILS' ? 'שקל' : 'דולר'}
          </dd>
        </div>
        <div>
          <dt>שיקולי מס כלליים</dt>
          <dd>{c.taxNotesHe}</dd>
        </div>
        <div>
          <dt>התאמה לאופק ולפרופיל</dt>
          <dd>{idea.fit.notes.join(' ')}</dd>
        </div>
      </dl>

      <div className="idea-sim-block">
        <h4>מה זה משנה בתיק</h4>
        <Simulation simulation={idea.simulation} />
      </div>
    </article>
  );
}

function InvestmentIdeasPanel({ ideas }) {
  return (
    <div className="ideas-panel">
      <p className="review-disclaimer ideas-disclaimer" role="note">
        {IDEAS_DISCLAIMER_HE}
      </p>
      {!ideas ? null : !ideas.available ? (
        <div className="analysis-section">
          <p className="history-empty-note">{ideas.reason}</p>
        </div>
      ) : (
        <>
          <section className="analysis-section" aria-label="איך נבחרו הרעיונות">
            <h2>רעיונות לבחינה - מה כדאי להכיר</h2>
            <p className="section-subtitle">
              הרעיונות נבחרים בחוקים שקופים, לפי פערים וריכוזים שזוהו בתיק שלך היום: סקטור, אזור, מטבע, סוג נכס ורמת סיכון. הם מדורגים לפי גודל הפער, לא לפי ביצועי עבר.
              מוצגים רק פריטים מהקטלוג המקומי, ללא קישורים וללא אינטרס מסחרי. מוצרים ממונפים וקריפטו מוצגים רק למי שכבר מחזיק בהם.
            </p>
            {ideas.depositText ? <p className="review-muted">{ideas.depositText}</p> : null}
            <p className="review-muted">קרן עולמית נספרת כ-{Math.round(IDEAS_CONFIG.globalFundUsShare * 100)}% ארה"ב והשאר שאר העולם (קירוב).</p>
          </section>

          <section aria-label="דומה למה שאתה מכיר">
            <h2 className="review-section-title">דומה למה שאתה מכיר</h2>
            {ideas.similar.length ? (
              <div className="ideas-grid">
                {ideas.similar.map((idea) => (
                  <IdeaCard key={idea.item.id} idea={idea} />
                ))}
              </div>
            ) : (
              <p className="review-muted ideas-empty">לא נמצאו חלופות מהקטלוג שדומות למה שכבר יש בתיק.</p>
            )}
          </section>

          <section aria-label="משלים או שונה">
            <h2 className="review-section-title">משלים או שונה</h2>
            {ideas.complement.length ? (
              <div className="ideas-grid">
                {ideas.complement.map((idea) => (
                  <IdeaCard key={idea.item.id} idea={idea} />
                ))}
              </div>
            ) : (
              <p className="review-muted ideas-empty">לא זוהו פערים בולטים שהקטלוג יכול להשלים.</p>
            )}
          </section>

          <p className="review-muted ideas-catalog-notice">{CATALOG_NOTICE_HE}</p>
        </>
      )}
      <p className="review-disclaimer ideas-disclaimer review-disclaimer-foot" role="note">
        {IDEAS_DISCLAIMER_HE}
      </p>
    </div>
  );
}

export default InvestmentIdeasPanel;
