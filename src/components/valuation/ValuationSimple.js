import React from 'react';
import { buildValuationStory } from '../../utils/valuationStory';

// The valuation page for everyone: one answer on a cheap-to-expensive scale,
// the three checks told as short stories with the real numbers, what the
// price assumes about the future, and three possible futures against the
// price. The professional detail (multiples, the DCF calculator) stays on
// the page, folded below this. Sentences come from utils/valuationStory.js.

const TONE_WORD = { cheap: 'זולה', normal: 'הוגנת', expensive: 'יקרה', na: 'אין מספיק נתונים', mixed: 'מעורב' };

// Where the answer sits between cheap and expensive.
function Gauge({ score, tone }) {
  // Cheap at the start (right), expensive at the end - read as words.
  const at = ((score + 1) / 2) * 100;
  return (
    <div className={`vs-gauge ${tone === 'na' ? 'is-empty' : ''}`} aria-hidden="true">
      <div className="vs-gauge-track">
        <span className="vs-gauge-zone is-cheap" />
        <span className="vs-gauge-zone is-fair" />
        <span className="vs-gauge-zone is-expensive" />
        {tone !== 'na' && <span className="vs-gauge-marker" style={{ insetInlineStart: `calc(${at.toFixed(1)}% - 9px)` }} />}
      </div>
      <div className="vs-gauge-labels">
        <span>זולה</span>
        <span>הוגנת</span>
        <span>יקרה</span>
      </div>
    </div>
  );
}

function CheckCard({ check }) {
  return (
    <article className={`vs-check is-${check.tone}`}>
      <header className="vs-check-head">
        <span className="vs-check-icon" aria-hidden="true">
          {check.icon}
        </span>
        <h3>{check.title}</h3>
        <span className={`vs-chip is-${check.tone}`}>{TONE_WORD[check.tone] || TONE_WORD.na}</span>
      </header>
      {check.story.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {check.takeaway && <p className="vs-takeaway">{check.takeaway}</p>}
    </article>
  );
}

// The scenario names as they fit on the line itself; the list above it
// carries the full sentences.
const FUTURE_SHORT_LABELS = { bear: 'פחות טוב', base: 'כצפוי', bull: 'מצוין' };

// Labels nearer than this (in % of the line) go up to a second level
// rather than printing over each other. About one "$156.09" at phone width.
const LABEL_MIN_GAP = 22;

// Each scenario label's level: 0 just above the line, 1 above that. Read in
// order along the line, a label takes the first level where it clears the
// last label on it - and when it clears neither, the one with more room.
export function placeScaleLabels(points, minGap = LABEL_MIN_GAP) {
  const lastAt = [-Infinity, -Infinity];
  return [...points]
    .sort((a, b) => a.at - b.at)
    .map((p) => {
      const gaps = lastAt.map((last) => p.at - last);
      const free = gaps.findIndex((gap) => gap >= minGap);
      const lane = free !== -1 ? free : gaps[0] >= gaps[1] ? 0 : 1;
      lastAt[lane] = p.at;
      return { ...p, lane };
    });
}

// A label near an end of the line is anchored by that end, so it stays
// inside the card instead of being centred half off it.
const edgeClass = (at) => (at < 12 ? 'is-start' : at > 88 ? 'is-end' : '');

// Three futures on one line, with today's price marked among them - each
// with its price written on the line, so the gap can be read off it rather
// than looked up in the list above.
export function Futures({ futures }) {
  const values = futures.rows.map((r) => r.value).concat(futures.price);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  // A little room past both ends so no mark sits on the card's edge.
  const pad = (hi - lo) * 0.04;
  // A number line: low on the left, as on any scale.
  const at = (v) => (hi > lo ? ((v - lo + pad) / (hi - lo + 2 * pad)) * 100 : 50);
  const labels = placeScaleLabels(futures.rows.map((r) => ({ key: r.key, text: r.text, at: at(r.value) })));
  const twoLevels = labels.some((l) => l.lane === 1);
  const priceAt = at(futures.price);
  return (
    <section className="vs-block" aria-labelledby="vs-futures">
      <h3 id="vs-futures">ומה אם העתיד יהיה שונה?</h3>
      <p className="vs-muted">אף אחד לא יודע מה יקרה, אז חישבנו גם מה קורה אם הדברים ילכו פחות טוב או יותר טוב מהצפוי.</p>
      <ul className="vs-futures">
        {futures.rows.map((r) => (
          <li key={r.key} className={`vs-future is-${r.vsPrice}`}>
            <span className="vs-future-label">{r.label}</span>
            <span className="vs-future-value">{r.text}</span>
            <span className="vs-future-note">{r.vsPrice === 'above' ? 'יותר מהמחיר' : 'פחות מהמחיר'}</span>
          </li>
        ))}
      </ul>
      {/* Hidden from screen readers: the list above says the same in full. */}
      <div className="vs-scale" aria-hidden="true">
        <div className={`vs-scale-labels ${twoLevels ? 'has-two-levels' : ''}`}>
          {labels.map((l) => (
            <span key={l.key} className={`vs-scale-label is-lane-${l.lane} ${edgeClass(l.at)}`} style={{ left: `${l.at}%` }}>
              <span className="vs-scale-label-name">{FUTURE_SHORT_LABELS[l.key]}</span>
              <b>{l.text}</b>
            </span>
          ))}
        </div>
        <div className="vs-scale-track">
          <span className="vs-scale-range" style={{ left: `${at(futures.rows[0].value)}%`, width: `${at(futures.rows[2].value) - at(futures.rows[0].value)}%` }} />
          {futures.rows.map((r) => (
            <span key={r.key} className="vs-scale-dot" style={{ left: `${at(r.value)}%` }} />
          ))}
          <span className="vs-scale-price" style={{ left: `${priceAt}%` }} />
        </div>
        <div className="vs-scale-today-row">
          <span className={`vs-scale-today ${edgeClass(priceAt)}`} style={{ left: `${priceAt}%` }}>
            מחיר היום <b>{futures.priceText}</b>
          </span>
        </div>
      </div>
      <p className="vs-takeaway">{futures.summary}</p>
    </section>
  );
}

export default function ValuationSimple({ data, evaluation, dcfLoading }) {
  const story = buildValuationStory(data, evaluation);
  const { verdict } = story;
  return (
    <div className="vs">
      <section className={`vs-answer is-${verdict.tone}`} aria-labelledby="vs-answer-title">
        <p className="vs-stock">
          {story.name} <bdi dir="ltr">({data.symbol})</bdi> · מחיר היום {story.priceText}
        </p>
        <h2 id="vs-answer-title">{verdict.headline}</h2>
        <p className="vs-answer-line">{verdict.line}</p>
        {verdict.note && <p className="vs-answer-note">{verdict.note}</p>}
        <Gauge score={verdict.score} tone={verdict.tone} />
        {dcfLoading && <p className="vs-muted">ממשיכים לחשב את הבדיקה השלישית…</p>}
      </section>

      <section className="vs-block" aria-labelledby="vs-checks">
        <h3 id="vs-checks">איך בדקנו? שלוש שאלות פשוטות</h3>
        <div className="vs-checks">
          {story.checks.map((c) => (
            <CheckCard key={c.key} check={c} />
          ))}
        </div>
      </section>

      {story.assumption && (
        <section className={`vs-block vs-assume is-${story.assumption.tone}`} aria-labelledby="vs-assume">
          <h3 id="vs-assume">מה צריך לקרות כדי שהמחיר יהיה הגיוני?</h3>
          {story.assumption.lines.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </section>
      )}

      {story.futures && <Futures futures={story.futures} />}

      <details className="vs-explain">
        <summary>איך זה עובד? הסבר בשתי דקות</summary>
        <p>
          <strong>מניה היא חתיכה קטנה מחברה.</strong> כשקונים מניה, קונים חלק קטן מכל מה שהחברה תרוויח מעכשיו והלאה.
        </p>
        <p>
          <strong>"זולה" או "יקרה" זה לא המספר על המחיר.</strong> מניה ב-{'⁦'}$10{'⁩'} יכולה להיות יקרה, ומניה ב-{'⁦'}$500{'⁩'} יכולה להיות זולה. מה שחשוב זה כמה משלמים ביחס
          למה שהחברה מרוויחה.
        </p>
        <p>
          <strong>דוגמה:</strong> שני דוכני לימונדה. כל אחד מרוויח {'⁦'}$100{'⁩'} בשנה. את הראשון מוכרים ב-{'⁦'}$1,000{'⁩'} ואת השני ב-{'⁦'}$3,000{'⁩'}. הדוכן הראשון זול
          יותר - על אותו רווח משלמים פחות. בדיוק ככה אנחנו בודקים מניות.
        </p>
        <p>
          <strong>למה שלוש בדיקות?</strong> כל בדיקה מסתכלת מזווית אחרת: מה שילמו על החברה בעבר, מה משלמים על חברות דומות, וכמה כסף היא צפויה להרוויח. כשכולן אומרות אותו
          דבר, התמונה ברורה יותר.
        </p>
      </details>

      <p className="vs-disclaimer">
        זה כלי שעוזר לחשוב, לא המלצה לקנות או למכור. החישובים מבוססים על נתונים מהעבר ועל הנחות לגבי העתיד, והעתיד יכול להיות שונה.
      </p>
    </div>
  );
}
