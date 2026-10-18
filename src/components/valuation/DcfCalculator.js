import React, { useEffect, useMemo, useState } from 'react';
import { computeDcf, dcfSensitivity, impliedGrowthRate, historicalFcfGrowth, DCF_DEFAULTS, DCF_LIMITS } from '../../utils/dcfValuation';
import { DCF_VERDICT_TONE } from '../../utils/valuationInsights';
import { Num, ToneBadge, fmtMoney, fmtPct, fmtRate, dcfInputFrom } from './shared';

// The DCF as a "what do you have to believe" calculator: two plain sliders,
// ready-made scenarios, the value against the price, and the arithmetic
// behind it folded away for whoever wants it.

export const VERDICT_WORDS = { UNDERVALUED: 'נראית זולה', FAIRLY_VALUED: 'קרוב למחיר הוגן', OVERVALUED: 'נראית יקרה', 'N/A': 'לא ניתן לקבוע' };

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const near = (a, b) => Math.abs(a - b) < 1e-4;

// "3.2 times" past doubling, else a percentage.
function howMuch(bigger, smaller) {
  const ratio = bigger / smaller;
  return ratio >= 2 ? `פי ${ratio.toFixed(1)}` : `ב-${Math.round((ratio - 1) * 100)}%`;
}

function Slider({ id, label, hint, value, min, max, step, onChange }) {
  return (
    <div className="form-group dcf-slider">
      <label htmlFor={id}>
        {label}: <strong><Num>{fmtRate(value)}</Num></strong>
      </label>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-describedby={hint ? `${id}-hint` : undefined} />
      {hint && (
        <p id={`${id}-hint`} className="dcf-hint">
          {hint}
        </p>
      )}
    </div>
  );
}

// Value next to price as two bars, so "how far apart" is seen, not read.
function ValueVsPrice({ value, price, currency, priceCurrency }) {
  const top = Math.max(value, price, 0) || 1;
  const width = (v) => `${Math.max(2, (Math.max(v, 0) / top) * 100)}%`;
  return (
    <div className="val-bars">
      <div className="val-bar-row">
        <span className="val-bar-label">השווי לפי ההנחות</span>
        <span className="val-bar-track">
          <span className="val-bar val-bar-value" style={{ width: width(value) }} />
        </span>
        <strong className="val-bar-num"><Num>{fmtMoney(value, currency)}</Num></strong>
      </div>
      <div className="val-bar-row">
        <span className="val-bar-label">המחיר היום</span>
        <span className="val-bar-track">
          <span className="val-bar val-bar-price" style={{ width: width(price) }} />
        </span>
        <strong className="val-bar-num"><Num>{fmtMoney(price, priceCurrency)}</Num></strong>
      </div>
    </div>
  );
}

function verdictSentence(result, band) {
  const { intrinsicPerShare: value, marketPrice: price, verdict } = result;
  if (verdict === 'N/A' || !(value > 0)) return 'לפי ההנחות האלה אין למניה שווי חיובי - החוב של החברה גדול מהשווי של הפעילות שלה.';
  if (verdict === 'OVERVALUED') return `לפי ההנחות האלה המניה נראית יקרה: המחיר היום גבוה ${howMuch(price, value)} מהשווי שחישבנו.`;
  if (verdict === 'UNDERVALUED') return `לפי ההנחות האלה המניה נראית זולה: השווי שחישבנו גבוה ${howMuch(value, price)} מהמחיר היום.`;
  return `לפי ההנחות האלה המחיר היום קרוב לשווי (הפרש של פחות מ-${Math.round(band * 100)}%).`;
}

export function impliedSentence(implied, historical) {
  if (implied.beyond === 'above') return 'גם צמיחה של יותר מ-150% בשנה לא מגיעה למחיר הנוכחי בהנחות האלה - השוק מצפה להרבה יותר ממה שהמודל יכול להסביר.';
  if (implied.beyond === 'below') return 'גם אם התזרים יתכווץ בחצי כל שנה, השווי עדיין מעל המחיר - המחיר מניח ירידה חדה.';
  if (implied.rate === null) return null;
  const hist = Number.isFinite(historical) ? ` בשנים האחרונות הוא גדל בכ-${Math.round(historical * 100)}% בשנה.` : '';
  return `כדי שהמחיר של היום יהיה הוגן, הכסף הפנוי של החברה צריך לגדול בכ-${Math.round(implied.rate * 100)}% בכל שנה, 5 שנים ברציפות.${hist}`;
}

export default function DcfCalculator({ data, suggested }) {
  const inputs = data.dcfInputs;
  const currency = data.financialCurrency || data.currency || '';
  const [g, setG] = useState(suggested.growthRate);
  const [r, setR] = useState(suggested.discountRate);
  const [gT, setGT] = useState(DCF_DEFAULTS.terminalGrowth);
  const [baseMethod, setBaseMethod] = useState(DCF_DEFAULTS.baseMethod);
  const [band, setBand] = useState(DCF_DEFAULTS.fairBand);

  useEffect(() => {
    setG(suggested.growthRate);
    setR(suggested.discountRate);
  }, [suggested]);

  const dcfInput = dcfInputFrom(inputs, { growthRate: g, discountRate: r, terminalGrowth: gT, baseMethod, fairBand: band });
  const result = computeDcf(dcfInput);
  const grid = result.errors.length ? null : dcfSensitivity(dcfInput);
  const historical = useMemo(() => historicalFcfGrowth(inputs.fcfHistory.map((x) => x.fcf)), [inputs]);
  const implied = result.errors.length ? { rate: null, beyond: null } : impliedGrowthRate(dcfInput);

  const scenarios = [
    { key: 'careful', label: 'זהיר', g: clamp(suggested.growthRate - 0.05, DCF_LIMITS.growth), r: clamp(suggested.discountRate + 0.015, DCF_LIMITS.discount) },
    { key: 'suggested', label: 'מוצע', g: suggested.growthRate, r: suggested.discountRate },
    { key: 'optimistic', label: 'אופטימי', g: clamp(suggested.growthRate + 0.05, DCF_LIMITS.growth), r: clamp(suggested.discountRate - 0.01, DCF_LIMITS.discount) }
  ];
  const impliedOnSlider = implied.rate === null ? null : clamp(implied.rate, DCF_LIMITS.growth);

  const growthSource =
    suggested.growthSource === 'analysts' ? 'הערכת אנליסטים' : suggested.growthSource === 'history' ? 'הקצב שבו הכסף הפנוי של החברה גדל בשנים האחרונות, עד 20% לכל היותר' : 'ברירת מחדל';

  return (
    <div className="dcf-layout">
      <div className="dcf-controls">
        <div className="dcf-scenarios" role="group" aria-label="תרחישים">
          {scenarios.map((s) => (
            <button
              key={s.key}
              type="button"
              className={`dcf-scenario ${near(g, s.g) && near(r, s.r) ? 'is-active' : ''}`}
              aria-pressed={near(g, s.g) && near(r, s.r)}
              onClick={() => {
                setG(s.g);
                setR(s.r);
              }}
            >
              {s.label}
            </button>
          ))}
          {impliedOnSlider !== null && (
            <button
              type="button"
              className={`dcf-scenario ${near(g, impliedOnSlider) ? 'is-active' : ''}`}
              aria-pressed={near(g, impliedOnSlider)}
              onClick={() => setG(impliedOnSlider)}
            >
              מה המחיר מניח?
            </button>
          )}
        </div>

        <Slider
          id="dcf-g"
          label="בכמה החברה תגדל בכל שנה (5 השנים הקרובות)"
          hint={
            <>
              הצעת המערכת: <Num>{fmtRate(suggested.growthRate)}</Num> ({growthSource}).
              {Number.isFinite(historical) && !near(historical, suggested.growthRate) && (
                <>
                  {' '}
                  בפועל בשנים האחרונות: <Num>{fmtRate(historical)}</Num> בשנה.
                </>
              )}
            </>
          }
          value={g}
          min={DCF_LIMITS.growth[0]}
          max={DCF_LIMITS.growth[1]}
          step={0.005}
          onChange={setG}
        />
        <Slider
          id="dcf-r"
          label="התשואה שאתה דורש (שיעור היוון)"
          hint={
            <>
              גבוה יותר = זהיר יותר, והשווי יוצא נמוך יותר. מקובל: 8%-10% לחברה יציבה, 10%-12% לחברה מסוכנת. הצעת המערכת (<Num>{fmtRate(suggested.discountRate)}</Num>) מבוססת על תשואת אג"ח ארה"ב (<Num>{fmtRate(suggested.riskFreeRate)}</Num>
              {inputs.riskFreeRateIsDefault ? ', ברירת מחדל' : ''}) ועל התנודתיות של המניה (בטא <Num>{suggested.beta.toFixed(2)}</Num>).
            </>
          }
          value={r}
          min={DCF_LIMITS.discount[0]}
          max={DCF_LIMITS.discount[1]}
          step={0.0025}
          onChange={setR}
        />

        <details className="dcf-advanced val-details">
          <summary>הגדרות מתקדמות</summary>
          <Slider id="dcf-gt" label="צמיחה לטווח ארוך, אחרי 5 השנים" value={gT} min={DCF_LIMITS.terminalGrowth[0]} max={DCF_LIMITS.terminalGrowth[1]} step={0.0025} onChange={setGT} />
          <div className="form-group dcf-slider">
            <label htmlFor="dcf-band">
              מתי לקרוא למחיר "הוגן": <strong>הפרש של עד <Num>±{Math.round(band * 100)}%</Num></strong>
            </label>
            <input id="dcf-band" type="range" min={0.05} max={0.3} step={0.05} value={band} onChange={(e) => setBand(Number(e.target.value))} />
          </div>
          <div className="form-group">
            <label htmlFor="dcf-base">נקודת המוצא של הכסף הפנוי</label>
            <select id="dcf-base" value={baseMethod} onChange={(e) => setBaseMethod(e.target.value)}>
              <option value="avg3">ממוצע 3 השנים האחרונות (יציב יותר)</option>
              <option value="latest">השנה האחרונה (מתאים לחברה שצומחת מהר)</option>
            </select>
          </div>
        </details>
      </div>

      <div className="dcf-results" aria-live="polite">
        {result.errors.length ? (
          <ul className="dcf-errors" role="alert">
            {result.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        ) : (
          <>
            <div className="val-result">
              <div className="val-result-head">
                <span>התוצאה:</span>
                <ToneBadge tone={DCF_VERDICT_TONE[result.verdict]}>
                  <span data-testid="dcf-verdict">
                    {VERDICT_WORDS[result.verdict]}
                  </span>
                </ToneBadge>
              </div>
              <ValueVsPrice value={result.intrinsicPerShare} price={result.marketPrice} currency={currency} priceCurrency={data.currency} />
              <p className="val-result-sentence">{verdictSentence(result, band)}</p>
              {impliedSentence(implied, historical) && <p className="val-result-implied">{impliedSentence(implied, historical)}</p>}
            </div>

            {result.warnings.length > 0 && (
              <ul className="dcf-warnings">
                {result.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}

            <details className="val-details">
              <summary>איך הגענו למספר?</summary>
              <ol className="val-steps">
                <li>
                  נקודת המוצא: החברה מייצרת היום כ-<Num>{fmtMoney(result.baseFcf, currency)}</Num> בשנה של <strong>כסף פנוי</strong> - מה שנשאר אחרי כל ההוצאות וההשקעות.
                </li>
                <li>
                  מגדילים אותו ב-<Num>{fmtRate(g)}</Num> בכל שנה, 5 שנים, ואחר כך ב-<Num>{fmtRate(gT)}</Num> בשנה לתמיד.
                </li>
                <li>
                  כסף עתידי שווה היום פחות, אז כל שנה "מוזלת" ב-<Num>{fmtRate(r)}</Num>. ההכנסות של 5 השנים הראשונות שוות היום <Num>{fmtMoney(result.pvStage1, currency)}</Num>, וכל מה שאחריהן <Num>{fmtMoney(result.pvTerminal, currency)}</Num> ({Math.round(result.terminalShareOfEv * 100)}% מהשווי).
                </li>
                <li>
                  מוסיפים את המזומן שבקופה (<Num>{fmtMoney(inputs.cash, currency)}</Num>) ומורידים את החוב (<Num>{fmtMoney(inputs.debt, currency)}</Num>): שווי החברה כולה <Num>{fmtMoney(result.equityValue, currency)}</Num>.
                </li>
                <li>
                  מחלקים במספר המניות (<Num>{fmtMoney(inputs.sharesDiluted)}</Num>): <strong><Num>{fmtMoney(result.intrinsicPerShare, currency)}</Num></strong> למניה.
                </li>
              </ol>
              <p className="muted-note">
                מרווח ביטחון: <Num>{fmtPct(result.marginOfSafety * 100)}</Num> (ההפרש מחולק בשווי) · פוטנציאל: <Num>{fmtPct(result.upside * 100)}</Num> (ההפרש מחולק במחיר)
              </p>
            </details>

            {grid && (
              <details className="val-details">
                <summary>מה יוצא בהנחות אחרות?</summary>
                <p className="muted-note">
                  כל משבצת היא השווי למניה בצירוף אחר: עמודות = צמיחה, שורות = התשואה שאתה דורש. ירוק = מעל המחיר היום, אדום = מתחתיו. המסגרת היא ההנחות הנוכחיות. אם כמעט כל הטבלה באותו צבע, המסקנה לא תלויה הרבה בהנחות המדויקות.
                </p>
                <div className="stocks-table-container">
                  <table className="analysis-table dcf-grid" aria-label="רגישות">
                    <thead>
                      <tr>
                        <th>תשואה \ צמיחה</th>
                        {grid.growthRates.map((gr) => (
                          <th key={gr}><Num>{fmtRate(gr)}</Num></th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {grid.values.map((row, i) => (
                        <tr key={grid.discountRates[i]}>
                          <th><Num>{fmtRate(grid.discountRates[i])}</Num></th>
                          {row.map((v, j) => {
                            const tone = v === null ? '' : v >= result.marketPrice * (1 + band) ? 'cell-under' : v <= result.marketPrice * (1 - band) ? 'cell-over' : '';
                            return (
                              <td key={grid.growthRates[j]} className={`${tone} ${i === 2 && j === 2 ? 'cell-current' : ''}`}>
                                {v === null ? '—' : v.toFixed(2)}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}
