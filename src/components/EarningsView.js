// Ported from day-trader-skill (MIT, Jake Schincariol)
//
// /earnings - what did the company actually report? The quarterly numbers
// read straight from the company's own SEC filings (10-Q / 10-K XBRL facts,
// server/earningsService.js): revenue, margins, net income and diluted EPS,
// each quarter against the same quarter a year earlier, the last four
// quarters, a plain-Hebrew "what changed", and the latest earnings 8-K.
// The valuation page (ValuationView) answers "cheap or expensive" from
// market data; this page only reports what was filed.
import React, { useMemo, useState } from 'react';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import PageToolbar from './PageToolbar';
import BetaBanner from './BetaBanner';
import KpiTile, { KpiRow } from './KpiTile';
import { useEarnings } from '../hooks/useEarnings';
import { buildEarningsSummary } from '../shared/earningsSummary';
import { getChartTheme, tooltipStyles } from '../utils/chartTheme';
import './EarningsView.css';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const DASH = '—';

export function fmtUsd(v) {
  if (!isNum(v)) return DASH;
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  return `${sign}$${abs.toLocaleString('en-US')}`;
}
const fmtMillions = (v) => (isNum(v) ? Math.round(v / 1e6).toLocaleString('en-US') : DASH);
const fmtPct = (v) => (isNum(v) ? `${v.toFixed(1)}%` : DASH);
const fmtChange = (v) => (isNum(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1)}%` : DASH);
const fmtPt = (v) => (isNum(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1)} נק'` : null);
const toneOf = (v) => (!isNum(v) || v === 0 ? 'neutral' : v > 0 ? 'positive' : 'negative');
const changeClass = (v) => (!isNum(v) || v === 0 ? '' : v > 0 ? 'profit-positive' : 'profit-negative');

// US holdings: unique, uppercased stock names.
export function heldUsSymbols(americanStocks) {
  const out = [];
  for (const s of americanStocks || []) {
    const sym = String((s && s.stockName) || '').trim().toUpperCase();
    if (sym && !out.includes(sym)) out.push(sym);
  }
  return out;
}

function SummaryCards({ data }) {
  const q = data.quarters[0];
  const ttm = data.ttm || {};
  return (
    <KpiRow>
      <KpiTile label="הכנסות ברבעון האחרון" value={<bdi dir="ltr">{fmtUsd(q.revenue)}</bdi>} badge={isNum(q.revenueYoy) ? <bdi dir="ltr">{fmtChange(q.revenueYoy)}</bdi> : null} badgeTone={toneOf(q.revenueYoy)} sub={`שינוי שנתי · ${q.fiscal || q.end}`} />
      <KpiTile label="רווח מדולל למניה (EPS)" value={<bdi dir="ltr">{isNum(q.epsDiluted) ? `$${q.epsDiluted.toFixed(2)}` : DASH}</bdi>} badge={isNum(q.epsYoy) ? <bdi dir="ltr">{fmtChange(q.epsYoy)}</bdi> : null} badgeTone={toneOf(q.epsYoy)} sub="לעומת הרבעון המקביל אשתקד" />
      <KpiTile label="שולי רווח תפעולי" value={fmtPct(q.operatingMargin)} badge={fmtPt(q.operatingMarginYoyPt)} badgeTone={toneOf(q.operatingMarginYoyPt)} sub={`גולמי ${fmtPct(q.grossMargin)} · נקי ${fmtPct(q.netMargin)}`} />
      <KpiTile label="4 רבעונים אחרונים (TTM)" value={<bdi dir="ltr">{fmtUsd(ttm.revenue)}</bdi>} sub={<>רווח נקי <bdi dir="ltr">{fmtUsd(ttm.netIncome)}</bdi> · EPS <bdi dir="ltr">{isNum(ttm.epsDiluted) ? `$${ttm.epsDiluted.toFixed(2)}` : DASH}</bdi></>} />
    </KpiRow>
  );
}

function QuarterTable({ quarters }) {
  return (
    <div className="stocks-table-container">
      <table className="analysis-table earnings-table" aria-label="רבעון אחר רבעון">
        <thead>
          <tr>
            <th>רבעון</th>
            <th>סוף תקופה</th>
            <th>הכנסות ($M)</th>
            <th>שינוי שנתי</th>
            <th>שולי גולמי</th>
            <th>שולי תפעולי</th>
            <th>שולי נקי</th>
            <th>רווח נקי ($M)</th>
            <th>שינוי שנתי</th>
            <th>EPS מדולל</th>
            <th>שינוי שנתי</th>
          </tr>
        </thead>
        <tbody>
          {quarters.map((q) => (
            <tr key={q.end}>
              <td>
                <bdi dir="ltr">{(q.fiscal || '').trim() || DASH}</bdi>
                {q.derived && (
                  <span className="earnings-derived" title="הדוח השנתי פחות שלושת הרבעונים שבתוכו; ה-EPS משוער">
                    {' '}
                    מחושב
                  </span>
                )}
              </td>
              <td>
                <bdi dir="ltr">{q.end}</bdi>
              </td>
              <td>
                <bdi dir="ltr">{fmtMillions(q.revenue)}</bdi>
              </td>
              <td className={changeClass(q.revenueYoy)}>
                <bdi dir="ltr">{fmtChange(q.revenueYoy)}</bdi>
              </td>
              <td>{fmtPct(q.grossMargin)}</td>
              <td>{fmtPct(q.operatingMargin)}</td>
              <td>{fmtPct(q.netMargin)}</td>
              <td>
                <bdi dir="ltr">{fmtMillions(q.netIncome)}</bdi>
              </td>
              <td className={changeClass(q.netIncomeYoy)}>
                <bdi dir="ltr">{fmtChange(q.netIncomeYoy)}</bdi>
              </td>
              <td>
                <bdi dir="ltr">{isNum(q.epsDiluted) ? q.epsDiluted.toFixed(2) : DASH}</bdi>
              </td>
              <td className={changeClass(q.epsYoy)}>
                <bdi dir="ltr">{fmtChange(q.epsYoy)}</bdi>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RevenueChart({ quarters, theme }) {
  const chartTheme = getChartTheme(theme);
  const points = useMemo(
    () =>
      quarters
        .slice()
        .reverse()
        .map((q) => ({ label: (q.fiscal || '').trim() || q.end, revenue: isNum(q.revenue) ? q.revenue / 1e9 : null, operatingMargin: q.operatingMargin })),
    [quarters]
  );
  if (points.filter((p) => p.revenue !== null).length < 2) return null;
  return (
    <div className="earnings-chart" aria-label="הכנסות ושולי רווח תפעולי לפי רבעון" dir="ltr">
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={chartTheme.grid} vertical={false} />
          <XAxis dataKey="label" stroke={chartTheme.axis} tick={{ fontSize: 11 }} />
          <YAxis yAxisId="rev" stroke={chartTheme.axis} tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v}B`} width={56} />
          <YAxis yAxisId="margin" orientation="right" stroke={chartTheme.axis} tick={{ fontSize: 11 }} tickFormatter={(v) => `${v}%`} width={44} />
          <Tooltip
            {...tooltipStyles(theme)}
            formatter={(v, name) => (name === 'revenue' ? [isNum(v) ? `$${v.toFixed(2)}B` : DASH, 'הכנסות'] : [fmtPct(v), 'שולי תפעולי'])}
          />
          <Bar yAxisId="rev" dataKey="revenue" fill={chartTheme.accent} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          <Line yAxisId="margin" type="monotone" dataKey="operatingMargin" stroke={chartTheme.benchmark} strokeWidth={2} dot={{ r: 3 }} connectNulls isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function Filings({ data }) {
  const e8 = data.latest8k;
  const rep = data.latestReport;
  const next = data.nextEarnings || (data.nextEarningsDate ? { date: data.nextEarningsDate } : null);
  if (!e8 && !rep && !next) return null;
  return (
    <ul className="earnings-filings">
      {e8 && (
        <li>
          הודעת הרווחים האחרונה (8-K, סעיף 2.02), הוגשה ב-<bdi dir="ltr">{e8.filed}</bdi>:{' '}
          <a href={e8.exhibit || e8.index} target="_blank" rel="noopener noreferrer">
            {e8.exhibit ? 'הודעה לעיתונות' : 'תיק ההגשה'}
          </a>
          {e8.exhibit && (
            <>
              {' · '}
              <a href={e8.index} target="_blank" rel="noopener noreferrer">
                תיק ההגשה
              </a>
            </>
          )}
        </li>
      )}
      {rep && (
        <li>
          הדוח התקופתי האחרון ({rep.form}) לתקופה שהסתיימה ב-<bdi dir="ltr">{rep.period}</bdi>:{' '}
          <a href={rep.url} target="_blank" rel="noopener noreferrer">
            לקריאה ב-SEC
          </a>
        </li>
      )}
      {next && (
        <li>
          הדוח הבא צפוי ב-<bdi dir="ltr">{next.date}</bdi>
          {next.dateEnd ? (
            <>
              {' '}
              עד <bdi dir="ltr">{next.dateEnd}</bdi>
            </>
          ) : null}
          {next.status === 'estimated' ? ' (הערכה)' : ''} · מקור: Yahoo Finance, לא SEC
        </li>
      )}
    </ul>
  );
}

function EarningsResult({ data, theme }) {
  const summary = Array.isArray(data.summary) && data.summary.length ? data.summary : buildEarningsSummary(data);
  return (
    <>
      <div className="analysis-section">
        <h2 className="section-title">
          {data.name || data.symbol} <bdi dir="ltr">({data.symbol})</bdi>
        </h2>
        <p className="section-subtitle">המספרים כפי שהחברה הגישה ל-SEC בדוחות הרבעוניים והשנתיים (10-Q / 10-K). סכומים בדולר.</p>
        <SummaryCards data={data} />
      </div>

      <div className="analysis-section">
        <h2 className="section-title">מה השתנה</h2>
        <ul className="earnings-summary">
          {summary.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {data.staleNote && data.staleNote.url && (
          <p className="muted-note">
            <a href={data.staleNote.url} target="_blank" rel="noopener noreferrer">
              לדוח {data.staleNote.form} שטרם נכלל בנתונים
            </a>
          </p>
        )}
        <Filings data={data} />
      </div>

      <div className="analysis-section">
        <h2 className="section-title">רבעון אחר רבעון</h2>
        <p className="section-subtitle">כל רבעון מושווה לרבעון המקביל אשתקד, כי עסקים רבים עונתיים.</p>
        <RevenueChart quarters={data.quarters} theme={theme} />
        <QuarterTable quarters={data.quarters} />
      </div>
    </>
  );
}

function EarningsView({ americanStocks, authHeader, theme = 'dark' }) {
  const held = useMemo(() => heldUsSymbols(americanStocks), [americanStocks]);
  const [symbol, setSymbol] = useState(held[0] || '');
  const [draft, setDraft] = useState('');
  const { data, loading, error } = useEarnings(symbol, authHeader);

  return (
    <div className="App">
      <div className="analysis-container">
        <div className="analysis-content">
          <PageToolbar title="דוחות רבעוניים" subtitle="מה החברה דיווחה ל-SEC: הכנסות, שולי רווח ורווח למניה, רבעון מול רבעון (מניות אמריקאיות)" />
          <BetaBanner tone="invest" />

          <div className="analysis-section">
            <div className="rebalance-sum-row">
              {held.length > 0 && (
                <>
                  <label htmlFor="earn-held">בחרו מניה מהתיק</label>
                  <select id="earn-held" value={held.includes(symbol) ? symbol : ''} onChange={(e) => setSymbol(e.target.value)}>
                    <option value="">{DASH}</option>
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
                <label htmlFor="earn-symbol">או הקלידו סימול של מניה</label>{' '}
                <input id="earn-symbol" className="inline-input" dir="ltr" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="AAPL" maxLength={8} />{' '}
                <button type="submit" className="benchmark-toggle-button">
                  הצגה
                </button>
              </form>
            </div>
          </div>

          {loading && <p className="history-empty-note">קוראים את הדוחות מ-SEC…</p>}
          {error && <p className="profit-negative">{error}</p>}
          {!symbol && !loading && <p className="history-empty-note">בחרו מניה אמריקאית מהתיק או הקלידו את הסימול שלה (למשל AAPL לאפל), ונציג מה החברה דיווחה ברבעונים האחרונים.</p>}
          {data && data.secConfigured === false && <p className="history-empty-note">{data.message || 'נתוני הדוחות מ-SEC אינם זמינים כרגע.'}</p>}
          {data && data.secConfigured !== false && Array.isArray(data.quarters) && data.quarters.length > 0 && <EarningsResult key={data.symbol} data={data} theme={theme} />}

          <p className="muted-note earnings-footnote">
            מקור: SEC EDGAR (נתוני XBRL מדוחות 10-Q ו-10-K). המידע מוצג כפי שדווח ואינו ייעוץ השקעות או המלצה לקנות, למכור או להחזיק נייר ערך כלשהו. רבעון רביעי מחושב מהדוח השנתי וה-EPS בו משוער; נתוני SEC עשויים לפגר אחרי הגשת דוח.
          </p>
        </div>
      </div>
    </div>
  );
}

export default EarningsView;
