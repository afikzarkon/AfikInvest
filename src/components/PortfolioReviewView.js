import React, { useContext, useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import PageToolbar from './PageToolbar';
import { PrivacyContext } from './PrivacyToggle';
import InvestmentIdeasPanel from './InvestmentIdeasPanel';
import { buildPortfolioReview } from '../utils/portfolioReview';
import { buildInvestmentIdeas } from '../utils/investmentIdeas';
import { REVIEW_BENCHMARKS, REVIEW_DISCLAIMER_HE, NO_DATA_LABEL_HE, CATEGORY_WEIGHTS, HISTORY_MONTHS } from '../utils/portfolioReviewConfig';
import { shiftMonth } from '../utils/portfolioReviewData';
import { formatMonthLabel, todayISO } from '../utils/portfolioDates';
import { formatPriceWithSign } from '../utils/formatters';
import { getChartTheme, tooltipStyles } from '../utils/chartTheme';
import { expandHoldingsWithClosedLots } from '../shared/transactionLedger';
import { benchmarkPointsInILS } from '../utils/benchmarkComparison';
import { useHistoricalPortfolioValue } from '../hooks/useHistoricalPortfolioValue';
import { useStockSectors } from '../hooks/useStockSectors';
import { useBenchmarkHistory } from '../hooks/useBenchmarkHistory';
import { useDividendData } from '../hooks/useDividendData';

// /review - the monthly portfolio review: an overall score, one score per
// category, the review in words, and how every number was reached.
//
// The page only gathers inputs - holdings, the ledger, historical closes,
// sectors, an index - and renders what utils/portfolioReview.js returns.
// Every score, threshold and sentence comes from there.

const ils = (v) => `${formatPriceWithSign(v)} ₪`;
const signedPct = (v, digits = 1) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}%` : '—');

const scoreTone = (score) => (score === null || score === undefined ? 'none' : score >= 70 ? 'good' : score >= 40 ? 'mid' : 'low');

const DAY = 86400000;
const minusDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) - days * DAY).toISOString().slice(0, 10);

// The earliest date anything was bought or deposited, including lots a
// sale has since closed.
function earliestDate(expanded) {
  const dates = [
    ...expanded.israeliStocks.map((l) => l.purchaseDate),
    ...expanded.americanStocks.map((l) => l.purchaseDate),
    ...[...expanded.pensionFunds, ...expanded.cashFunds, ...expanded.bankBalances, ...expanded.bankSavingsFunds].flatMap((a) =>
      (Array.isArray(a.deposits) ? a.deposits : []).map((d) => d && d.date)
    )
  ].filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d));
  return dates.length ? dates.sort()[0].slice(0, 10) : null;
}

function ScoreRing({ score, size = 132 }) {
  const r = (size - 14) / 2;
  const c = 2 * Math.PI * r;
  const filled = Number.isFinite(score) ? (score / 100) * c : 0;
  return (
    <svg className={`review-ring tone-${scoreTone(score)}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle className="review-ring-track" cx={size / 2} cy={size / 2} r={r} />
      <circle
        className="review-ring-fill"
        cx={size / 2}
        cy={size / 2}
        r={r}
        strokeDasharray={`${filled} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" className="review-ring-value">
        {Number.isFinite(score) ? score : '—'}
      </text>
    </svg>
  );
}

function ScoreChip({ category }) {
  if (category.status === 'scored') return <span className={`review-chip tone-${scoreTone(category.score)}`}>{category.score}</span>;
  if (category.status === 'info') return <span className="review-chip tone-none">מידע</span>;
  if (category.status === 'noGoal') return <span className="review-chip tone-none">לא הוגדר</span>;
  return <span className="review-chip tone-none">{NO_DATA_LABEL_HE}</span>;
}

function NoteList({ title, tone, notes, empty }) {
  return (
    <div className={`review-notes review-notes-${tone}`}>
      <h3>{title}</h3>
      {notes.length ? (
        <ul>
          {notes.map((n, i) => (
            <li key={i}>{n.text}</li>
          ))}
        </ul>
      ) : (
        <p className="review-muted">{empty}</p>
      )}
    </div>
  );
}

// A share-of-total bar per row - where the month's money went.
function SplitBars({ rows }) {
  if (!rows || !rows.length) return <p className="review-muted">לא הושקע כסף בחודש זה.</p>;
  return (
    <ul className="review-split">
      {rows.slice(0, 8).map((row) => (
        <li key={row.key}>
          <div className="review-split-head">
            <span className="review-split-label">{row.label}</span>
            <span className="review-split-figure">
              {ils(row.amount)} · {Math.round(row.share * 100)}%
            </span>
          </div>
          <div className="review-split-track">
            <div className="review-split-fill" style={{ width: `${Math.max(2, row.share * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

const SPLITS = [
  { key: 'byAccount', label: 'חשבון' },
  { key: 'byInstrument', label: 'סוג מכשיר' },
  { key: 'bySector', label: 'סקטור' },
  { key: 'byCurrency', label: 'מטבע' },
  { key: 'byAsset', label: 'נכס' }
];

const formatComponentValue = (c) => {
  if (!c.available) return '—';
  if (c.unit === 'pct') return `${c.value.toFixed(1)}%`;
  if (c.unit === 'ratio') return Number.isFinite(c.value) ? c.value.toFixed(2) : '∞';
  if (c.unit === 'cv') return c.value.toFixed(2);
  if (c.unit === 'days') return `${Math.round(c.value)} ימים`;
  if (c.unit === 'months') return `${c.value} חודשים`;
  if (c.unit === 'count') return String(c.value);
  return String(c.value);
};

function CategoryCard({ category, summary, open, onToggle, children }) {
  return (
    <article className={`review-category status-${category.status}`}>
      <header className="review-category-head">
        <h3>{category.label}</h3>
        <ScoreChip category={category} />
      </header>
      {summary ? <p className="review-category-summary">{summary}</p> : null}
      {category.partial ? <p className="review-partial-note">חודש חלקי - הנתונים עד היום</p> : null}
      {children}
      {category.components.length ? (
        <button type="button" className="review-link-button" onClick={onToggle} aria-expanded={open}>
          {open ? 'הסתר איך חושב' : 'איך חושב?'}
        </button>
      ) : null}
      {open ? (
        <table className="review-components">
          <tbody>
            {category.components.map((c) => (
              <tr key={c.key} className={c.available ? '' : 'is-skipped'}>
                <th scope="row">{c.label}</th>
                <td>{formatComponentValue(c)}</td>
                <td>{c.available ? c.score : <span className="review-muted">{c.reason}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </article>
  );
}

function GoalForm({ goal, onSave }) {
  const [amount, setAmount] = useState(goal && goal.targetAmount ? String(goal.targetAmount) : '');
  const [date, setDate] = useState((goal && goal.targetDate) || '');
  const [status, setStatus] = useState(null);
  useEffect(() => {
    setAmount(goal && goal.targetAmount ? String(goal.targetAmount) : '');
    setDate((goal && goal.targetDate) || '');
  }, [goal]);
  const save = async (event) => {
    event.preventDefault();
    try {
      await onSave(amount && date ? { targetAmount: Number(amount), targetDate: date } : {});
      setStatus({ ok: true, text: 'נשמר' });
    } catch (err) {
      setStatus({ ok: false, text: err.message });
    }
  };
  return (
    <form className="review-goal-form" onSubmit={save} aria-label="יעד השקעה">
      <label>
        סכום יעד (₪)
        <input type="number" min="1" step="1000" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <label>
        תאריך יעד
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <button type="submit" className="benchmark-toggle-button active">
        {amount && date ? 'שמירת יעד' : 'ניקוי יעד'}
      </button>
      {status ? (
        <span role="status" className={status.ok ? 'profit-positive' : 'profit-negative'}>
          {status.text}
        </span>
      ) : null}
    </form>
  );
}

const EMPTY_SNAPSHOTS = [];

function PortfolioReviewView({
  israeliStocks = [],
  americanStocks = [],
  pensionFunds = [],
  cashFunds = [],
  bankBalances = [],
  bankSavingsFunds = [],
  transactions = [],
  // The saved daily values: a month-end the price history cannot value.
  valueSnapshots = EMPTY_SNAPSHOTS,
  analysis,
  cpi,
  theme,
  goal = null,
  onSaveGoal
}) {
  const { hideAmounts } = useContext(PrivacyContext) || {};
  const today = todayISO();
  const [month, setMonth] = useState(null);
  const [split, setSplit] = useState('byAccount');
  const [openCategory, setOpenCategory] = useState(null);
  const [benchmarkKey, setBenchmarkKey] = useState(null);
  const [tab, setTab] = useState('review');

  const holdings = useMemo(
    () => ({ israeliStocks, americanStocks, pensionFunds, cashFunds, bankBalances, bankSavingsFunds }),
    [israeliStocks, americanStocks, pensionFunds, cashFunds, bankBalances, bankSavingsFunds]
  );
  const expanded = useMemo(() => expandHoldingsWithClosedLots(holdings, transactions), [holdings, transactions]);
  const inception = useMemo(() => earliestDate(expanded), [expanded]);

  // Closes reach back far enough for the selected month's trailing year,
  // the score history before it, and the month before each purchase (the
  // "bought after a sharp rise" check) - but not past the first purchase.
  const anchorMonth = month || today.slice(0, 7);
  const wantedFrom = `${shiftMonth(anchorMonth, -(HISTORY_MONTHS * 2))}-01`;
  const fetchFrom = inception ? (minusDays(inception, 45) > wantedFrom ? minusDays(inception, 45) : wantedFrom) : null;
  const { priceData, loading: pricesLoading, error: pricesError } = useHistoricalPortfolioValue({
    fromDate: fetchFrom,
    toDate: today,
    israeliStocks: expanded.israeliStocks,
    americanStocks: expanded.americanStocks,
    needsFxHistory: true
  });

  const americanSymbols = useMemo(() => [...new Set(expanded.americanStocks.map((s) => String(s.stockName || '').toUpperCase()).filter(Boolean))], [expanded]);
  const { sectorBySymbol } = useStockSectors(americanSymbols);

  // Dividends a US holding is expected to pay over a year, at today's rate.
  const openAmerican = useMemo(() => [...new Set(americanStocks.map((s) => String(s.stockName || '').toUpperCase()).filter(Boolean))], [americanStocks]);
  const firstAmericanDate = useMemo(() => americanStocks.map((s) => s.purchaseDate).filter(Boolean).sort()[0] || null, [americanStocks]);
  const { dividendsBySymbol } = useDividendData(openAmerican, firstAmericanDate);
  const projectedAnnualDividendsILS = useMemo(() => {
    let total = 0;
    let any = false;
    americanStocks.forEach((lot) => {
      const d = dividendsBySymbol[String(lot.stockName || '').toUpperCase()];
      if (!d || !Number.isFinite(d.dividendRate)) return;
      any = true;
      total += d.dividendRate * (Number(lot.quantity) || 0) * (Number(lot.currentExchangeRate || lot.exchangeRate) || 0);
    });
    return any ? total : null;
  }, [americanStocks, dividendsBySymbol]);

  // The index the "simple alternative" is measured against: the user's
  // pick, else the market most of their securities are in.
  const defaultBenchmark = useMemo(() => {
    const exchange = (analysis && analysis.exchangeDistribution) || {};
    const israeliValue = (exchange.israeli && exchange.israeli.value) || 0;
    const americanValue = (exchange.american && exchange.american.value) || 0;
    return israeliValue > americanValue ? 'ta125' : 'sp500';
  }, [analysis]);
  const benchmark = REVIEW_BENCHMARKS.find((b) => b.key === (benchmarkKey || defaultBenchmark));
  const { points: rawBenchmarkPoints, loading: benchmarkLoading } = useBenchmarkHistory(inception ? benchmark.key : null, inception);
  const benchmarkPoints = useMemo(
    () => benchmarkPointsInILS(rawBenchmarkPoints, benchmark.currency, priceData.fxHistoricalCloses),
    [rawBenchmarkPoints, benchmark.currency, priceData.fxHistoricalCloses]
  );

  const liveTotalValueILS = analysis && analysis.summaryMetrics ? analysis.summaryMetrics.overallTotalValueILS : null;

  const reviewInput = useMemo(
    () => ({
      holdings,
      transactions,
      priceData,
      sectorBySymbol,
      today,
      liveTotalValueILS,
      valueSnapshots,
      cpi,
      goal: goal && goal.targetAmount ? goal : null,
      benchmark,
      benchmarkPoints,
      projectedAnnualDividendsILS
    }),
    // hideAmounts: the sentences carry formatted amounts, so privacy mode
    // has to re-word them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [holdings, transactions, priceData, sectorBySymbol, today, liveTotalValueILS, valueSnapshots, cpi, goal, benchmark, benchmarkPoints, projectedAnnualDividendsILS, hideAmounts]
  );
  const review = useMemo(() => buildPortfolioReview(reviewInput, { month }), [reviewInput, month]);

  // Ideas are about the portfolio as it is now, whichever month the review
  // tab is showing - and are only worked out once the tab is opened.
  const ideas = useMemo(() => {
    if (tab !== 'ideas' || review.empty) return null;
    const current = review.selectedMonth === today.slice(0, 7) ? review : buildPortfolioReview(reviewInput, { withHistory: false });
    return buildInvestmentIdeas(current);
  }, [tab, review, reviewInput, today]);

  const chartTheme = getChartTheme(theme);

  if (review.empty) {
    return (
      <div className="App">
        <div className="analysis-container">
          <div className="analysis-content review-page">
            <PageToolbar title="ביקורת תיק" subtitle="ציון חודשי וביקורת על ההתנהלות שלך כמשקיע" />
            <p className="review-disclaimer">{REVIEW_DISCLAIMER_HE}</p>
            <div className="analysis-section">
              <p className="history-empty-note">
                עדיין אין בתיק השקעות או הפקדות עם תאריך. אחרי שתוסיפו נכסים, כאן תופיע ביקורת חודשית עם ציון לכל תחום.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const { text, facts } = review;
  const byKey = Object.fromEntries(review.categories.map((c) => [c.key, c]));
  const history = review.scoreHistory.map((p) => ({ ...p, label: formatMonthLabel(p.month) }));
  const comparisonRows = byKey.comparison.metrics.rows || [];
  const success = byKey.success.metrics;
  const trendLabel = { improving: 'במגמת שיפור', eroding: 'במגמת ירידה', stable: 'יציב' }[review.trend.direction];

  const monthPicker = (
    <label className="review-month-picker">
      <span className="visually-hidden">בחירת חודש</span>
      <select value={review.selectedMonth} onChange={(e) => setMonth(e.target.value)} aria-label="בחירת חודש">
        {[...review.months].reverse().map((m) => (
          <option key={m} value={m}>
            {formatMonthLabel(m)}
            {m === today.slice(0, 7) ? ' (חלקי)' : ''}
          </option>
        ))}
      </select>
    </label>
  );

  const formatRowValue = (row, v) => {
    if (v === null || v === undefined) return '—';
    if (row.unit === 'ils') return ils(v);
    if (row.unit === 'pct') return signedPct(v);
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  };

  const countedWeight = review.categories.filter((c) => c.effectiveWeight > 0);

  return (
    <div className="App">
      <div className="analysis-container">
        <div className="analysis-content review-page">
          <PageToolbar
            title="ביקורת תיק"
            subtitle={tab === 'review' ? `סיכום ${text.monthLabel} - מה עבד, מה פחות, ועל מה כדאי לשים לב` : 'סוגי השקעות שכדאי להכיר, לפי הפערים בתיק שלך היום'}
            secondaryActions={tab === 'review' ? monthPicker : null}
          />
          <div className="benchmark-toggle-row review-tabs" role="tablist" aria-label="תצוגה">
            <button type="button" role="tab" aria-selected={tab === 'review'} className={`benchmark-toggle-button ${tab === 'review' ? 'active' : ''}`} onClick={() => setTab('review')}>
              ביקורת וציון
            </button>
            <button type="button" role="tab" aria-selected={tab === 'ideas'} className={`benchmark-toggle-button ${tab === 'ideas' ? 'active' : ''}`} onClick={() => setTab('ideas')}>
              רעיונות להעשרת התיק
            </button>
          </div>
          {tab === 'review' ? <p className="review-disclaimer">{REVIEW_DISCLAIMER_HE}</p> : null}

          {pricesLoading || benchmarkLoading ? <p className="review-loading" role="status">טוען היסטוריית מחירים ומדדים - חלק מהנתונים יתעדכנו בעוד רגע…</p> : null}
          {pricesError ? <p className="review-loading" role="status">{pricesError}. נתונים שתלויים במחירי עבר יוצגו כ"{NO_DATA_LABEL_HE}".</p> : null}

          {tab === 'ideas' ? <InvestmentIdeasPanel ideas={ideas} /> : (
          <>
          {/* Overall */}
          <section className="analysis-section review-hero" aria-label="ציון כללי">
            <div className="review-hero-score">
              <ScoreRing score={review.score} />
              <div>
                <p className="review-hero-rating">{review.score !== null ? review.rating : 'אין עדיין ציון כללי'}</p>
                <p className="review-muted">
                  {review.score !== null
                    ? `מבוסס על ${review.countedCount} תחומים עם מספיק נתונים${review.isPartial ? ' · ציון ביניים, החודש עדיין לא הסתיים' : ''}`
                    : `נדרשים נתונים בלפחות 3 תחומים (יש ${review.countedCount}). הציון יופיע כשיצטברו עוד נתונים.`}
                </p>
                {trendLabel ? <p className="review-muted">מגמה ב-{history.filter((h) => !h.isPartial).length} החודשים האחרונים: {trendLabel}</p> : null}
              </div>
            </div>
            <div className="review-profile">
              <span className="review-profile-label">פרופיל משקיע</span>
              <strong>{text.profile.label}</strong>
              <p className="review-muted">{text.profile.reason}</p>
            </div>
            {text.badges.length ? (
              <ul className="review-badges" aria-label="הישגים">
                {text.badges.map((b) => (
                  <li key={b.key}>
                    <span aria-hidden="true">{b.icon}</span> {b.label}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          {text.oneThing ? (
            <section className="review-one-thing" aria-label="הדבר האחד לשיפור החודש">
              <h2>הדבר האחד לשיפור החודש</h2>
              <p className="review-one-thing-text">{text.oneThing.text}</p>
              {text.oneThing.why ? <p className="review-muted">{text.oneThing.why}</p> : null}
            </section>
          ) : null}

          <section className="analysis-section" aria-label="הביקורת">
            <h2>הביקורת על {text.monthLabel}</h2>
            <div className="review-notes-grid">
              <NoteList title="מה עבד טוב" tone="good" notes={text.good} empty="לא נמצאה החודש נקודת חוזק בולטת בנתונים." />
              <NoteList title="מה דורש תשומת לב" tone="attention" notes={text.attention} empty="לא זוהו נקודות שדורשות תשומת לב." />
              <NoteList title="נקודות למחשבה" tone="thought" notes={text.thoughts} empty="אין נקודות נוספות החודש." />
            </div>
          </section>

          {history.length > 1 ? (
            <section className="analysis-section" aria-label="מגמת הציון">
              <h2>מגמת הציון הכללי</h2>
              <p className="section-subtitle">כל נקודה היא הציון של אותו חודש, מחושב באותה שיטה. חודש בלי ציון מופיע כרווח בקו.</p>
              <div className="review-chart">
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={history} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
                    <CartesianGrid stroke={chartTheme.grid} vertical={false} />
                    <XAxis dataKey="label" tick={{ fill: chartTheme.axis, fontSize: 11 }} interval="preserveStartEnd" />
                    <YAxis domain={[0, 100]} tick={{ fill: chartTheme.axis, fontSize: 11 }} width={32} />
                    <Tooltip {...tooltipStyles(theme)} formatter={(v) => [v === null ? '—' : v, 'ציון']} />
                    <Line type="monotone" dataKey="score" stroke={chartTheme.accent} strokeWidth={2.5} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>
          ) : null}

          <section className="analysis-section" aria-label="לאן הלך הכסף">
            <h2>לאן הלך הכסף {facts.isPartial ? '(עד כה)' : ''}</h2>
            <div className="review-kpis">
              <div>
                <span>הושקע</span>
                <strong>{ils(facts.invested)}</strong>
              </div>
              <div>
                <span>מול ממוצע 3 חודשים</span>
                <strong>{signedPct(byKey.volume.metrics.vsAvg3Pct, 0)}</strong>
              </div>
              <div>
                <span>מול ממוצע 6 חודשים</span>
                <strong>{signedPct(byKey.volume.metrics.vsAvg6Pct, 0)}</strong>
              </div>
              <div>
                <span>נטו (בניכוי מכירות ומשיכות)</span>
                <strong>{ils(facts.net)}</strong>
              </div>
            </div>
            <div className="benchmark-toggle-row review-split-tabs" role="tablist" aria-label="פילוח">
              {SPLITS.map((s) => (
                <button key={s.key} type="button" role="tab" aria-selected={split === s.key} className={`benchmark-toggle-button ${split === s.key ? 'active' : ''}`} onClick={() => setSplit(s.key)}>
                  {s.label}
                </button>
              ))}
            </div>
            <SplitBars rows={facts.destinations[split]} />
            {facts.parked > 0 ? <p className="review-muted">בנוסף הופקדו {ils(facts.parked)} לעו"ש ולקרנות כספיות (לא נספר כהשקעה).</p> : null}
          </section>

          {comparisonRows.length ? (
            <section className="analysis-section" aria-label="השוואה לחודשים קודמים">
              <h2>החודש מול החודשים הקודמים</h2>
              <div className="review-table-wrap">
                <table className="review-table">
                  <thead>
                    <tr>
                      <th scope="col">מדד</th>
                      <th scope="col">{text.monthLabel}</th>
                      <th scope="col">{formatMonthLabel(byKey.comparison.metrics.previousMonth)}</th>
                      <th scope="col">ממוצע 3 חודשים</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparisonRows.map((row) => (
                      <tr key={row.key}>
                        <th scope="row">{row.label}</th>
                        <td>{formatRowValue(row, row.current)}</td>
                        <td>{formatRowValue(row, row.previous)}</td>
                        <td>{formatRowValue(row, row.average)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          <section className="analysis-section" aria-label="ההשקעות החודש">
            <h2>איך עשו ההשקעות {facts.isPartial ? 'עד כה ' : ''}החודש</h2>
            {success.positions && success.positions.length ? (
              <ul className="review-positions">
                {success.positions.map((p) => (
                  <li key={p.id} className={p.pnl >= 0 ? 'is-up' : 'is-down'}>
                    <span className="review-position-name">
                      {p.label}
                      {p.boughtThisMonth ? <small> · נקנה החודש</small> : null}
                    </span>
                    <span className={p.pnl >= 0 ? 'profit-positive' : 'profit-negative'}>{ils(p.pnl)}</span>
                    <span className="review-muted">{Number.isFinite(p.contributionPct) ? `${signedPct(p.contributionPct, 2)} לתיק` : ''}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="review-muted">{byKey.success.reason || 'אין ניירות ערך עם נתוני מחיר לחודש זה.'}</p>
            )}
            {success.missing && success.missing.length ? <p className="review-muted">ללא נתוני מחיר: {success.missing.join(', ')}</p> : null}
          </section>

          <section aria-label="ציון לפי תחום">
            <h2 className="review-section-title">ציון לפי תחום</h2>
            <div className="review-category-grid">
              {review.categories.map((c) => (
                <CategoryCard key={c.key} category={c} summary={text.summaries[c.key]} open={openCategory === c.key} onToggle={() => setOpenCategory(openCategory === c.key ? null : c.key)}>
                  {c.key === 'benchmark' ? (
                    <div className="benchmark-toggle-row" role="group" aria-label="מדד להשוואה">
                      {REVIEW_BENCHMARKS.map((b) => (
                        <button key={b.key} type="button" className={`benchmark-toggle-button ${b.key === benchmark.key ? 'active' : ''}`} onClick={() => setBenchmarkKey(b.key)}>
                          {b.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {c.key === 'benchmark' && c.status === 'scored' ? <p className="review-muted">המדד ללא דיבידנדים, כך שההשוואה מעט מקלה עם התיק.</p> : null}
                  {c.key === 'goal' && onSaveGoal ? <GoalForm goal={goal} onSave={onSaveGoal} /> : null}
                  {c.key === 'costs' && c.status === 'scored' ? <p className="review-muted">לא כולל דמי ניהול ועלויות המרת מטבע - אינם נשמרים במערכת.</p> : null}
                </CategoryCard>
              ))}
            </div>
          </section>

          <section className="analysis-section review-method" aria-label="איך חושב הציון">
            <h2>איך חושב הציון</h2>
            <p className="section-subtitle">
              כל תחום מקבל ציון 0-100 מממוצע הרכיבים שלו (פתחו &quot;איך חושב?&quot; בכל כרטיס). הציון הכללי הוא ממוצע משוקלל של התחומים שיש להם מספיק נתונים.
              תחום בלי נתונים לא נספר כאפס - המשקלים של השאר מתאזנים מחדש. כל הספים והמשקלים מוגדרים בקובץ הגדרות אחד ושקוף.
            </p>
            <div className="review-table-wrap">
              <table className="review-table">
                <thead>
                  <tr>
                    <th scope="col">תחום</th>
                    <th scope="col">משקל בסיס</th>
                    <th scope="col">משקל בפועל</th>
                    <th scope="col">ציון</th>
                    <th scope="col">תרומה לציון</th>
                  </tr>
                </thead>
                <tbody>
                  {review.categories.map((c) => (
                    <tr key={c.key} className={c.effectiveWeight > 0 ? '' : 'is-skipped'}>
                      <th scope="row">{c.label}</th>
                      <td>{CATEGORY_WEIGHTS[c.key] || 0}</td>
                      <td>{c.effectiveWeight > 0 ? `${Math.round(c.effectiveWeight * 100)}%` : '—'}</td>
                      <td>{c.status === 'scored' ? c.score : c.status === 'info' ? 'מידע בלבד' : NO_DATA_LABEL_HE}</td>
                      <td>{c.effectiveWeight > 0 ? (c.score * c.effectiveWeight).toFixed(1) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
                {countedWeight.length ? (
                  <tfoot>
                    <tr>
                      <th scope="row">סה&quot;כ</th>
                      <td />
                      <td>100%</td>
                      <td />
                      <td>{review.score !== null ? review.score : '—'}</td>
                    </tr>
                  </tfoot>
                ) : null}
              </table>
            </div>
          </section>

          <p className="review-disclaimer review-disclaimer-foot">{REVIEW_DISCLAIMER_HE}</p>
          </>
          )}
        </div>
      </div>
    </div>
  );
}

export default PortfolioReviewView;
