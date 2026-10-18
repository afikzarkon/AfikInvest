import React from 'react';
import { computeDcf, impliedGrowthRate, historicalFcfGrowth, DCF_DEFAULTS } from '../../utils/dcfValuation';
import { multiplesSummary, impliedGrowthReading, DCF_VERDICT_TONE } from '../../utils/valuationInsights';
import { VERDICT_WORDS, impliedSentence } from './DcfCalculator';
import { Num, ToneBadge, fmtMoney, dcfInputFrom } from './shared';

// The page's answer up front: three one-word readings and what the price
// assumes, all on the suggested inputs. The sections below show the why.

const HISTORY_WORDS = { cheap: 'זולה מהרגיל', expensive: 'יקרה מהרגיל', normal: 'כרגיל', mixed: 'תמונה מעורבת', na: 'אין מספיק נתונים' };
const PEER_WORDS = { cheap: 'זולה מהן', expensive: 'יקרה מהן', normal: 'דומה להן', mixed: 'תמונה מעורבת', na: 'אין נתונים' };
const IMPLIED_WORDS = {
  higher: 'זה הרבה יותר ממה שהחברה עשתה עד היום - המחיר מגלם ציפיות גבוהות.',
  lower: 'זה פחות ממה שהחברה עשתה עד היום - הציפיות שבמחיר צנועות.',
  similar: 'זה דומה לקצב של החברה עד היום.'
};

export default function ValuationSummary({ data, suggested }) {
  const multiples = multiplesSummary(data.multiples);
  const input = dcfInputFrom(data.dcfInputs, {
    growthRate: suggested.growthRate,
    discountRate: suggested.discountRate,
    terminalGrowth: DCF_DEFAULTS.terminalGrowth,
    baseMethod: DCF_DEFAULTS.baseMethod,
    fairBand: DCF_DEFAULTS.fairBand
  });
  const dcf = computeDcf(input);
  const dcfOk = dcf.errors.length === 0;
  const historical = historicalFcfGrowth(input.fcfHistory);
  const implied = dcfOk ? impliedGrowthRate(input) : { rate: null, beyond: null };
  const impliedText = dcfOk ? impliedSentence(implied, historical) : null;
  const reading = impliedGrowthReading(implied.rate, historical);
  const currency = data.financialCurrency || data.currency || '';

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
          {dcfOk ? (
            <>
              <ToneBadge tone={DCF_VERDICT_TONE[dcf.verdict]}>{VERDICT_WORDS[dcf.verdict]}</ToneBadge>
              <span className="val-summary-why">
                שווי <Num>{fmtMoney(dcf.intrinsicPerShare, currency)}</Num> מול מחיר <Num>{fmtMoney(dcf.marketPrice, data.currency)}</Num>, בהנחות המוצעות
              </span>
            </>
          ) : (
            <>
              <ToneBadge tone="na">לא ניתן לחשב</ToneBadge>
              <span className="val-summary-why">לחברה אין כרגע תזרים מזומנים חיובי לבנות עליו תחזית</span>
            </>
          )}
        </li>
      </ul>

      {impliedText && (
        <div className="val-implied">
          <h3>מה המחיר מניח?</h3>
          <p>
            {impliedText} {reading && IMPLIED_WORDS[reading]}
          </p>
        </div>
      )}

      <p className="muted-note">
        שלוש בדיקות שונות, וכל אחת מסתכלת מזווית אחרת. כשהן מסכימות, התמונה ברורה יותר. זה כלי לחשיבה על בסיס נתוני עבר והנחות, לא המלצה לקנות או למכור.
      </p>
    </section>
  );
}
