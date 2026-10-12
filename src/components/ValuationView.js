import React, { useEffect, useMemo, useState } from 'react';
import PageToolbar from './PageToolbar';
import BetaBanner from './BetaBanner';
import { useValuation } from '../hooks/useValuation';
import { computeDcf, dcfSensitivity, suggestDcfInputs, DCF_DEFAULTS } from '../utils/dcfValuation';

// /valuation - price multiples against their own 5-year history and the
// company's peers, and an interactive DCF calculator. Market data comes from
// the server (server/valuationService.js); the DCF itself runs here, so the
// sliders recompute instantly.

const SOURCE_LABELS = { summary: 'נתוני ציטוט', statements: 'דוחות כספיים', prices: 'מחירים חודשיים' };
const METRIC_LABELS = { PE: 'מכפיל רווח (P/E)', PS: 'מכפיל מכירות (P/S)', PFCF: 'מכפיל תזרים חופשי (P/FCF)' };
export const VERDICT_LABELS = { UNDERVALUED: 'מתומחרת בחסר', FAIRLY_VALUED: 'מתומחרת בהוגן', OVERVALUED: 'מתומחרת ביתר', 'N/A': 'לא ניתן לקבוע' };
const VERDICT_TONE = { UNDERVALUED: 'profit-positive', OVERVALUED: 'profit-negative', FAIRLY_VALUED: '', 'N/A': '' };

// Numbers are isolated as left-to-right runs so a sign never jumps to the
// wrong side inside right-to-left text ("-82.8%", not "82.8%-").
const Num = ({ children }) => <bdi dir="ltr">{children}</bdi>;

const fmtX = (v) => (v === null || v === undefined || !Number.isFinite(v) ? 'N/M' : `${v.toFixed(1)}x`);
const fmtPct = (v, digits = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`);
const fmtMoney = (v, currency = '') => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const text = abs >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : abs >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v.toFixed(2);
  return `${text}${currency ? ` ${currency}` : ''}`;
};

// A 5-year range bar: min-max track, a tick for the 5y average, a diamond for
// the peer median and a dot for today.
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
              <td>{METRIC_LABELS[row.metric]}</td>
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
        ממוצע וחציון מדגימה בסוף כל חודש ב-5 השנים האחרונות, מול השנה הפיסקלית שכבר פורסמה באותו זמן ({rows[0]?.samples || 0} מתוך {rows[0]?.totalMonths || 0} חודשים ל-P/E; שנים הפסדיות אינן נספרות). אחוזון 88 = המכפיל היום גבוה מ-88% מההיסטוריה. בגרף: קו = טווח 5 שנים, קו אנכי = ממוצע, מעוין = חציון מתחרים, עיגול = היום. P/FCF של המתחרים מבוסס על נתון ה-FCF של Yahoo ולכן משוער.
      </p>
    </div>
  );
}

function Slider({ id, label, value, min, max, step, onChange, format }) {
  return (
    <div className="form-group dcf-slider">
      <label htmlFor={id}>
        {label}: <strong>{format(value)}</strong>
      </label>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

function DcfCalculator({ data }) {
  const inputs = data.dcfInputs;
  const currency = data.financialCurrency || data.currency || '';
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
  const [g, setG] = useState(suggested.growthRate);
  const [r, setR] = useState(suggested.discountRate);
  const [gT, setGT] = useState(DCF_DEFAULTS.terminalGrowth);
  const [baseMethod, setBaseMethod] = useState(DCF_DEFAULTS.baseMethod);
  const [band, setBand] = useState(DCF_DEFAULTS.fairBand);

  useEffect(() => {
    setG(suggested.growthRate);
    setR(suggested.discountRate);
  }, [suggested]);

  const dcfInput = {
    fcfHistory: inputs.fcfHistory.map((x) => x.fcf),
    growthRate: g,
    discountRate: r,
    terminalGrowth: gT,
    cash: inputs.cash || 0,
    debt: inputs.debt || 0,
    sharesDiluted: inputs.sharesDiluted,
    marketPrice: inputs.marketPrice,
    baseMethod,
    fairBand: band
  };
  const result = computeDcf(dcfInput);
  const grid = result.errors.length ? null : dcfSensitivity(dcfInput);
  const pct = (v) => `${(v * 100).toFixed(1)}%`;

  return (
    <div className="dcf-layout">
      <div className="dcf-controls">
        <Slider id="dcf-g" label="צמיחה שנתית ב-5 השנים הקרובות (g)" value={g} min={-0.2} max={0.4} step={0.005} onChange={setG} format={pct} />
        <Slider id="dcf-r" label="שיעור היוון / WACC (r)" value={r} min={0.04} max={0.2} step={0.0025} onChange={setR} format={pct} />
        <details className="dcf-advanced">
          <summary>מתקדם</summary>
          <Slider id="dcf-gt" label="צמיחה לטווח ארוך (g∞)" value={gT} min={0} max={0.05} step={0.0025} onChange={setGT} format={pct} />
          <Slider id="dcf-band" label="טווח 'מחיר הוגן' סביב 0" value={band} min={0.05} max={0.3} step={0.05} onChange={setBand} format={(v) => `±${Math.round(v * 100)}%`} />
          <div className="form-group">
            <label htmlFor="dcf-base">בסיס ה-FCF</label>
            <select id="dcf-base" value={baseMethod} onChange={(e) => setBaseMethod(e.target.value)}>
              <option value="avg3">ממוצע 3 השנים האחרונות</option>
              <option value="latest">השנה האחרונה</option>
            </select>
          </div>
        </details>
        <button
          type="button"
          className="benchmark-toggle-button"
          onClick={() => {
            setG(suggested.growthRate);
            setR(suggested.discountRate);
            setGT(DCF_DEFAULTS.terminalGrowth);
          }}
        >
          חזרה לערכים המוצעים
        </button>
        <p className="section-subtitle">
          מוצע: g = {pct(suggested.growthRate)} ({suggested.growthSource === 'analysts' ? 'הערכת אנליסטים ל-5 שנים' : suggested.growthSource === 'history' ? 'קצב צמיחת ה-FCF ההיסטורי' : 'ברירת מחדל'}), r = {pct(suggested.discountRate)} (CAPM: תשואת אג"ח 10 שנים {pct(suggested.riskFreeRate)}
          {inputs.riskFreeRateIsDefault ? ' - ברירת מחדל' : ''} + בטא {suggested.beta.toFixed(2)} × פרמיית סיכון 5%).
        </p>
      </div>

      <div className="dcf-results">
        {result.errors.length ? (
          <ul className="dcf-errors" role="alert">
            {result.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        ) : (
          <>
            <div className="distribution-grid">
              <div className="distribution-card">
                <h3>שווי פנימי למניה</h3>
                <div className="distribution-value"><Num>{fmtMoney(result.intrinsicPerShare, currency)}</Num></div>
                <div className="distribution-percentage">מחיר שוק <Num>{fmtMoney(result.marketPrice, data.currency)}</Num></div>
              </div>
              <div className="distribution-card">
                <h3>מרווח ביטחון</h3>
                <div className={`distribution-value ${VERDICT_TONE[result.verdict]}`}><Num>{fmtPct(result.marginOfSafety * 100)}</Num></div>
                <div className="distribution-percentage">אפסייד <Num>{fmtPct(result.upside * 100)}</Num></div>
              </div>
              <div className="distribution-card">
                <h3>מסקנה</h3>
                <div className={`distribution-value ${VERDICT_TONE[result.verdict]}`} data-testid="dcf-verdict">
                  {VERDICT_LABELS[result.verdict]}
                </div>
                <div className="distribution-percentage">מרווח ביטחון מעל ±{Math.round(band * 100)}%</div>
              </div>
            </div>

            <table className="analysis-table dcf-bridge" aria-label="גשר שווי">
              <tbody>
                <tr><td>FCF בסיס</td><td>{fmtMoney(result.baseFcf, currency)}</td></tr>
                <tr><td>ערך נוכחי של 5 שנים</td><td>{fmtMoney(result.pvStage1, currency)}</td></tr>
                <tr><td>ערך נוכחי של הטרמינל</td><td>{fmtMoney(result.pvTerminal, currency)} ({Math.round(result.terminalShareOfEv * 100)}%)</td></tr>
                <tr><td>שווי פעילות (EV)</td><td>{fmtMoney(result.enterpriseValue, currency)}</td></tr>
                <tr><td>+ מזומן, - חוב</td><td>{fmtMoney(inputs.cash, currency)} / {fmtMoney(inputs.debt, currency)}</td></tr>
                <tr><td>שווי הון</td><td>{fmtMoney(result.equityValue, currency)}</td></tr>
                <tr><td>מניות מדוללות</td><td>{fmtMoney(inputs.sharesDiluted)}</td></tr>
              </tbody>
            </table>

            {result.warnings.length > 0 && (
              <ul className="dcf-warnings">
                {result.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}

            {grid && (
              <div className="stocks-table-container">
                <table className="analysis-table dcf-grid" aria-label="רגישות">
                  <thead>
                    <tr>
                      <th>r \ g</th>
                      {grid.growthRates.map((gr) => (
                        <th key={gr}>{pct(gr)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {grid.values.map((row, i) => (
                      <tr key={grid.discountRates[i]}>
                        <th>{pct(grid.discountRates[i])}</th>
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
                <p className="section-subtitle">שווי למניה לפי שיעור היוון (שורות) וצמיחה (עמודות). ירוק = מעל המחיר ביותר מהטווח, אדום = מתחתיו.</p>
              </div>
            )}
          </>
        )}
        <p className="section-subtitle">
          DCF דו-שלבי על FCF = תזרים מפעילות שוטפת פחות השקעות הוניות, מהוון ב-WACC ובניכוי חוב נטו - מודל מפושט, לא מודל של בנק השקעות. אינו ייעוץ השקעות.
        </p>
      </div>
    </div>
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
          <PageToolbar title="הערכת שווי" subtitle="מכפילים מול ההיסטוריה והמתחרים, ומחשבון DCF (מניות אמריקאיות)" />
          <BetaBanner tone="tax" />

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
          {error && diagnostics && (
            <ul className="muted-note" aria-label="פירוט מקורות">
              {Object.entries(diagnostics).map(([source, status]) => (
                <li key={source}>
                  {SOURCE_LABELS[source] || source}: {status === 'ok' ? 'נטען' : 'נכשל'}
                  {status === 'ok' ? '' : <bdi dir="ltr"> ({status.replace(/^error: /, '')})</bdi>}
                </li>
              ))}
            </ul>
          )}
          {!symbol && !loading && <p className="history-empty-note">בחרו מניה אמריקאית מהתיק או הקלידו סימול.</p>}

          {data && (
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
                <MultiplesTable rows={data.multiples} />
              </div>

              <div className="analysis-section">
                <h2 className="section-title">מחשבון DCF</h2>
                <DcfCalculator key={data.symbol} data={data} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default ValuationView;
