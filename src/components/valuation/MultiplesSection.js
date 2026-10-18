import React from 'react';
import { readMultiple, describeGap } from '../../utils/valuationInsights';
import { Num, ToneBadge, fmtX, fmtPlain, fmtPct } from './shared';

// The price multiples, first as one card each in plain words, then the full
// table for whoever wants every number.

const METRICS = {
  PE: { title: 'מחיר מול רווח', code: 'P/E', per: 'רווח שנתי' },
  PS: { title: 'מחיר מול מכירות', code: 'P/S', per: 'מכירות שנתיות' },
  PFCF: { title: 'מחיר מול כסף פנוי', code: 'P/FCF', per: 'תזרים מזומנים חופשי (הכסף שנשאר אחרי כל ההוצאות וההשקעות)' }
};

const HISTORY_WORDS = { cheap: 'זול מהרגיל', expensive: 'יקר מהרגיל', normal: 'כרגיל' };
const PEER_WORDS = { cheap: 'זול מהן', expensive: 'יקר מהן', normal: 'דומה להן' };

// A 5-year range bar: min-max track, a tick for the 5y average, a diamond for
// the peer median and a dot for today. Low on the left, as on any scale.
function RangeBar({ row }) {
  const values = [row.min5y, row.max5y, row.current, row.sectorMedian].filter((v) => Number.isFinite(v));
  if (values.length < 2 || !Number.isFinite(row.min5y)) return <span className="muted-note">אין מספיק היסטוריה</span>;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const x = (v) => (hi > lo ? 6 + ((v - lo) / (hi - lo)) * 188 : 100);
  return (
    <svg className="range-bar" viewBox="0 0 200 24" width="200" height="24" role="img" aria-label={`טווח 5 שנים ${fmtX(row.min5y)} עד ${fmtX(row.max5y)}`}>
      <line className="range-track" x1={x(row.min5y)} x2={x(row.max5y)} y1="12" y2="12" />
      {Number.isFinite(row.avg5y) && <line className="range-avg" x1={x(row.avg5y)} x2={x(row.avg5y)} y1="5" y2="19" />}
      {Number.isFinite(row.sectorMedian) && <rect className="range-peer" x={x(row.sectorMedian) - 4} y="8" width="8" height="8" transform={`rotate(45 ${x(row.sectorMedian)} 12)`} />}
      {Number.isFinite(row.current) && <circle className="range-now" cx={x(row.current)} cy="12" r="5" />}
    </svg>
  );
}

function MultipleCard({ row }) {
  const m = METRICS[row.metric];
  const reading = readMultiple(row);
  return (
    <article className="val-card" aria-label={m.title}>
      <header className="val-card-head">
        <h3>
          {m.title} <span className="muted-note">{m.code}</span>
        </h3>
        {reading.meaningful && reading.history !== 'na' && <ToneBadge tone={reading.history}>{HISTORY_WORDS[reading.history]}</ToneBadge>}
      </header>

      {reading.meaningful ? (
        <>
          <p className="val-card-big">
            <Num>{fmtPlain(row.current)}</Num>
          </p>
          <p className="val-card-explain">
            משלמים היום <Num>{fmtPlain(row.current)}</Num> דולר על כל דולר של {m.per}.
          </p>
          <ul className="val-compare">
            {Number.isFinite(row.avg5y) && (
              <li>
                <span>ממוצע 5 השנים האחרונות</span>
                <span>
                  <Num>{fmtPlain(row.avg5y)}</Num> · <strong>{describeGap(row.vsHistoryPct)}</strong>
                </span>
              </li>
            )}
            {reading.peers !== 'na' && (
              <li>
                <span>חברות דומות ({row.peerCount})</span>
                <span>
                  <Num>{fmtPlain(row.sectorMedian)}</Num> · <strong>{describeGap(row.vsSectorPct)}</strong>
                  <span className="visually-hidden"> ({PEER_WORDS[reading.peers]})</span>
                </span>
              </li>
            )}
          </ul>
          <div className="val-range" dir="ltr">
            <RangeBar row={row} />
          </div>
        </>
      ) : (
        <p className="val-card-explain val-card-na">
          {reading.reason === 'unstable-earnings'
            ? `המכפיל (${fmtPlain(row.current)}) לא משמעותי כרגע: הרווח של החברה קטן מאוד או קופץ בגלל אירועים חד-פעמיים, אז כל שינוי קטן בו מזיז את המכפיל במאות. עדיף להסתכל על שני המכפילים האחרים.`
            : 'אין נתון - למשל כשהחברה מפסידה, אין מכפיל.'}
        </p>
      )}
    </article>
  );
}

function MultiplesTable({ rows }) {
  return (
    <div className="stocks-table-container">
      <table className="analysis-table" aria-label="מכפילים">
        <thead>
          <tr>
            <th>מכפיל</th>
            <th>היום</th>
            <th>ממוצע 5 שנים</th>
            <th>חציון 5 שנים</th>
            <th>אחוזון</th>
            <th>חציון מתחרים</th>
            <th>טווח</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.metric}>
              <td>
                {METRICS[row.metric].title} ({METRICS[row.metric].code})
              </td>
              <td><Num>{fmtX(row.current)}</Num></td>
              <td>
                <Num>{fmtX(row.avg5y)}</Num> <span className="muted-note">(<Num>{fmtPct(row.vsHistoryPct, 0)}</Num>)</span>
              </td>
              <td><Num>{fmtX(row.median5y)}</Num></td>
              <td>{row.percentile5y === null ? '—' : `${Math.round(row.percentile5y)}`}</td>
              <td>
                <Num>{fmtX(row.sectorMedian)}</Num>
                {row.peerCount ? (
                  <span className="muted-note">
                    {' '}
                    ({row.peerCount} חברות, <Num>{fmtPct(row.vsSectorPct, 0)}</Num>)
                  </span>
                ) : null}
              </td>
              <td>
                <RangeBar row={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="section-subtitle">
        ממוצע וחציון מדגימה בסוף כל חודש ב-5 השנים האחרונות, מול השנה הפיסקלית שכבר פורסמה באותו זמן ({rows[0]?.samples || 0} מתוך {rows[0]?.totalMonths || 0} חודשים ל-P/E; שנים הפסדיות אינן נספרות). אחוזון 88 = המכפיל היום גבוה מ-88% מההיסטוריה. P/FCF של המתחרים מחושב כמו של החברה עצמה - מהתזרים החופשי בדוחות 12 החודשים האחרונים; מתחרה עם תזרים חופשי שלילי אינו נספר.
      </p>
    </div>
  );
}

export default function MultiplesSection({ rows }) {
  return (
    <div className="analysis-section">
      <h2 className="section-title">1. יקרה או זולה מהרגיל?</h2>
      <p className="val-intro">
        <strong>מכפיל</strong> אומר כמה דולרים משלמים על כל דולר שהחברה מרוויחה, מוכרת או מייצרת. מכפיל נמוך = זול יותר. כאן משווים את המכפיל של היום לממוצע של החברה ב-5 השנים האחרונות ולחברות דומות.
      </p>
      <div className="val-cards">
        {rows.map((row) => (
          <MultipleCard key={row.metric} row={row} />
        ))}
      </div>
      <p className="muted-note val-legend" aria-hidden="true">
        בפס: <span className="val-legend-now">●</span> היום · <span className="val-legend-avg">|</span> ממוצע 5 שנים · <span className="val-legend-peer">◆</span> חברות דומות · שמאל = נמוך (זול), ימין = גבוה (יקר)
      </p>
      <details className="val-details">
        <summary>טבלה מלאה עם כל המספרים</summary>
        <MultiplesTable rows={rows} />
      </details>
    </div>
  );
}
