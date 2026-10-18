import React from 'react';
import { multiplesSummary, DCF_VERDICT_TONE } from '../../utils/valuationInsights';
import { VALUE_WORDS, irrSentence } from './DcfCalculator';
import { Num, ToneBadge, fmtMoney } from './shared';

// The page's answer up front: three one-word readings and the return the
// price implies, the DCF on its automatic base case. The sections below
// show the why.

const HISTORY_WORDS = { cheap: 'זולה מהרגיל', expensive: 'יקרה מהרגיל', normal: 'כרגיל', mixed: 'תמונה מעורבת', na: 'אין מספיק נתונים' };
const PEER_WORDS = { cheap: 'זולה מהן', expensive: 'יקרה מהן', normal: 'דומה להן', mixed: 'תמונה מעורבת', na: 'אין נתונים' };

function DcfReading({ evaluation, loading, snapshot }) {
  if (loading) return <span className="val-summary-why">טוען נתונים…</span>;
  if (!evaluation) {
    return (
      <>
        <ToneBadge tone="na">לא זמין</ToneBadge>
        <span className="val-summary-why">לא ניתן היה לטעון את נתוני ה-DCF</span>
      </>
    );
  }
  if (evaluation.unsuitable) {
    return (
      <>
        <ToneBadge tone="na">לא מתאים ל-DCF</ToneBadge>
        <span className="val-summary-why">{evaluation.unsuitable}</span>
      </>
    );
  }
  const main = evaluation.main;
  if (!main || !main.ok) {
    return (
      <>
        <ToneBadge tone="na">לא ניתן לחשב</ToneBadge>
        <span className="val-summary-why">{main ? main.errors[0] : `חסר: ${evaluation.missing.join(', ')}`}</span>
      </>
    );
  }
  const label = evaluation.labels[evaluation.baseKey];
  const currency = (snapshot && (snapshot.financialCurrency || snapshot.currency)) || '';
  return (
    <>
      <ToneBadge tone={DCF_VERDICT_TONE[label]}>{VALUE_WORDS[label]}</ToneBadge>
      <span className="val-summary-why">
        שווי <Num>{fmtMoney(main.perShare, currency)}</Num> מול מחיר <Num>{fmtMoney(main.price, snapshot && snapshot.currency)}</Num>, תרחיש הבסיס האוטומטי
      </span>
    </>
  );
}

export default function ValuationSummary({ data, autoEvaluation, dcfLoading, snapshot }) {
  const multiples = multiplesSummary(data.multiples);
  const irrText = autoEvaluation && autoEvaluation.main && autoEvaluation.main.ok ? irrSentence(autoEvaluation) : '';

  return (
    <section className="analysis-section val-summary" aria-labelledby="val-summary-title">
      <h2 className="section-title" id="val-summary-title">
        בשורה התחתונה
      </h2>
      <ul className="val-summary-list">
        <li>
          <span className="val-summary-q">לעומת העבר של החברה</span>
          <ToneBadge tone={multiples.history}>{HISTORY_WORDS[multiples.history]}</ToneBadge>
          <span className="val-summary-why">לפי מכפילי המחיר מול 5 השנים האחרונות</span>
        </li>
        <li>
          <span className="val-summary-q">לעומת חברות דומות</span>
          <ToneBadge tone={multiples.peers}>{PEER_WORDS[multiples.peers]}</ToneBadge>
          <span className="val-summary-why">לפי אותם מכפילים אצל חברות מאותו תחום</span>
        </li>
        <li>
          <span className="val-summary-q">לפי הכסף שהיא צפויה לייצר</span>
          <DcfReading evaluation={autoEvaluation} loading={dcfLoading} snapshot={snapshot} />
        </li>
      </ul>

      {irrText && (
        <div className="val-implied">
          <h3>מה המחיר מניח?</h3>
          <p>{irrText}</p>
        </div>
      )}

      <p className="muted-note">
        שלוש בדיקות שונות, וכל אחת מסתכלת מזווית אחרת. כשהן מסכימות, התמונה ברורה יותר. זה כלי לחשיבה על בסיס נתוני עבר והנחות, לא המלצה לקנות או למכור.
      </p>
    </section>
  );
}
