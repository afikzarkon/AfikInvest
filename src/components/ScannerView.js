import React, { useMemo, useState } from 'react';
import PageToolbar from './PageToolbar';
import { useScanner } from '../hooks/useScanner';
import './ScannerView.css';

// /scanner - daily chart setups across US stocks (ported from the
// day-trader-skill trader-scanner, MIT). The scan runs on the server once a
// day after the US close (server/scannerJobs.js); this page reads the latest
// run, lets the user filter it and marks the stocks they already hold.

// horizon: 'long' - for a long-term investor looking for a good company at a
// lower price; 'short' - the day-trader pack's chart setups.
export const SETUPS = [
  {
    key: 'drawdown_30',
    horizon: 'long',
    label: 'ירידה של 30%+ מהשיא השנתי',
    explain: 'הסגירה האחרונה נמוכה ב-30% או יותר מסגירת השיא של 52 השבועות האחרונים. מניה שירדה חזק יכולה להיות הזדמנות - או חברה שהעסק שלה נחלש. עמודת הדוחות עוזרת להבדיל.'
  },
  {
    key: 'pullback_ma200',
    horizon: 'long',
    label: 'תיקון במגמה ארוכה',
    explain: 'המחיר ירד מתחת לממוצע 200 הימים, בזמן שהממוצע עצמו עדיין עולה (גבוה מלפני 20 ימי מסחר): ירידה זמנית בתוך מגמת עלייה ארוכה, לא מניה במגמת ירידה.'
  },
  {
    key: 'breakout_20d',
    horizon: 'short',
    label: 'פריצת שיא 20 יום',
    explain: 'הסגירה האחרונה גבוהה מכל אחת מ-20 הסגירות שלפניה (שיא סגירה, לא שיא תוך-יומי).'
  },
  {
    key: 'bull_flag',
    horizon: 'short',
    label: 'דגל שורי',
    explain: 'עלייה של יותר מ-10% ב-10 ימי המסחר שלפני חמשת האחרונים, ואז 5 הסגירות האחרונות נעות בטווח צר של פחות מ-5%.'
  },
  {
    key: 'reclaim_ma20',
    horizon: 'short',
    label: 'חזרה מעל ממוצע 20',
    explain: 'הסגירה הקודמת הייתה מתחת לממוצע 20 הימים, והסגירה האחרונה חזרה אל מעליו.'
  },
  {
    key: 'oversold',
    horizon: 'short',
    label: 'מכירת יתר',
    explain: 'מדד RSI (14 ימים, שיטת וויילדר) מתחת ל-30: המניה ירדה מהר ביחס לתנודות הרגילות שלה.'
  },
  {
    key: 'oversold_bounce',
    horizon: 'short',
    label: 'היפוך ממכירת יתר',
    explain: 'מדד RSI היה מתחת ל-30 בסגירה הקודמת, והמניה סגרה בעלייה ביום האחרון.'
  }
];
const LABEL = Object.fromEntries(SETUPS.map((s) => [s.key, s.label]));

const BASE_COLUMNS = [
  { key: 'symbol', label: 'סימול', type: 'text' },
  { key: 'name', label: 'שם', type: 'text' },
  { key: 'setups', label: 'תבנית', type: 'none' },
  { key: 'close', label: 'סגירה ($)', type: 'num' },
  { key: 'changePct', label: 'שינוי יומי', type: 'num' }
];
const COLUMNS_BY_HORIZON = {
  long: BASE_COLUMNS.concat([
    { key: 'drawdownPct', label: 'מהשיא השנתי', type: 'num' },
    { key: 'distMa200Pct', label: 'מממוצע 200', type: 'num' },
    { key: 'revenueYoy', label: 'הדוח האחרון (SEC)', type: 'num' }
  ]),
  short: BASE_COLUMNS.concat([
    { key: 'volume', label: 'מחזור', type: 'num' },
    { key: 'distHigh20Pct', label: 'מרחק משיא 20 יום', type: 'num' },
    { key: 'distMa20Pct', label: 'מרחק מממוצע 20', type: 'num' },
    { key: 'rsi', label: 'RSI 14', type: 'num' }
  ])
};
const ALL_COLUMNS = BASE_COLUMNS.concat(COLUMNS_BY_HORIZON.long.slice(BASE_COLUMNS.length), COLUMNS_BY_HORIZON.short.slice(BASE_COLUMNS.length));
const HORIZON_KEYS = {
  long: SETUPS.filter((x) => x.horizon === 'long').map((x) => x.key),
  short: SETUPS.filter((x) => x.horizon === 'short').map((x) => x.key)
};
const TREND = {
  growing: { label: 'צומחת', className: 'profit-positive' },
  mixed: { label: 'מעורב', className: '' },
  weakening: { label: 'נחלשת', className: 'profit-negative' }
};
// Sort value: revenue growth sits inside `fundamentals`.
const valueOf = (row, key) => (key === 'revenueYoy' ? (row.fundamentals ? row.fundamentals.revenueYoy : null) : row[key]);

// Opens the earnings page on a ticker without reloading the app (useRoute
// listens to popstate).
function openEarnings(e, symbol) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
  e.preventDefault();
  window.history.pushState({}, '', `/earnings/${symbol}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
  if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
}

function FundamentalsCell({ hit }) {
  const f = hit.fundamentals;
  const link = (
    <a className="scanner-earnings-link" href={`/earnings/${hit.symbol}`} onClick={(e) => openEarnings(e, hit.symbol)}>
      {f ? 'לפרטים' : 'בדיקת דוחות'}
    </a>
  );
  if (!f) return link;
  const t = TREND[f.trend] || TREND.mixed;
  return (
    <span className="scanner-fundamentals">
      <span className={`scanner-trend ${t.className}`}>{t.label}</span>{' '}
      <span className="scanner-subnote">
        הכנסות <bdi dir="ltr">{fmtPct(f.revenueYoy)}</bdi>
        {Number.isFinite(Number(f.operatingMarginYoyPt)) && f.operatingMarginYoyPt !== null && (
          <>
            {' · '}שולי תפעולי <bdi dir="ltr">{`${f.operatingMarginYoyPt > 0 ? '+' : ''}${Number(f.operatingMarginYoyPt).toFixed(1)}`}</bdi> נק׳
          </>
        )}
        {f.quarter ? ` (${f.quarter})` : ''}
      </span>{' '}
      {link}
    </span>
  );
}

const intFmt = new Intl.NumberFormat('en-US');
const fmtInt = (n) => (Number.isFinite(Number(n)) ? intFmt.format(Math.round(Number(n))) : '—');
const fmtPrice = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : '—');
const fmtPct = (n) => {
  if (!Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
};
const pctClass = (n) => (Number(n) > 0 ? 'profit-positive' : Number(n) < 0 ? 'profit-negative' : '');

const formatDate = (iso) => {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return d && m && y ? `${d}/${m}/${y}` : iso;
};

function sortRows(rows, { key, dir }) {
  const col = ALL_COLUMNS.find((c) => c.key === key);
  if (!col || col.type === 'none') return rows;
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = valueOf(a, key);
    const bv = valueOf(b, key);
    const aMissing = av === null || av === undefined || av === '';
    const bMissing = bv === null || bv === undefined || bv === '';
    if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1; // blanks last
    if (col.type === 'num') return (Number(av) - Number(bv)) * sign;
    return String(av).localeCompare(String(bv)) * sign;
  });
}

function CoverageNote({ run }) {
  const pct = run.universeSize ? Math.round((run.fetched / run.universeSize) * 100) : 0;
  return (
    <div className="scanner-coverage">
      <p>
        סריקה מ-{formatDate(run.runDate)}
        {run.asOf ? `, לפי מחירי הסגירה של ${formatDate(run.asOf)}` : ''}. נסרקו{' '}
        <bdi dir="ltr">{fmtInt(run.fetched)}</bdi> מתוך <bdi dir="ltr">{fmtInt(run.universeSize)}</bdi> מניות ({pct}%),{' '}
        <bdi dir="ltr">{fmtInt(run.scanned)}</bdi> מהן עברו את סינון הנזילות
        {run.filters && Number.isFinite(Number(run.filters.minPrice))
          ? ` (מחיר מ-$${run.filters.minPrice} ומחזור מ-${fmtInt(run.filters.minVolume)} מניות ביום)`
          : ''}
        .
      </p>
      {run.partial && (
        <p className="scanner-partial" role="status">
          סריקה חלקית: הסריקה נעצרה במגבלת הזמן לפני סוף הרשימה, כך שחלק מהמניות לא נבדקו.
        </p>
      )}
    </div>
  );
}

function ScannerView({ user, authHeader }) {
  const [priceDraft, setPriceDraft] = useState('');
  const [volumeDraft, setVolumeDraft] = useState('');
  const [floors, setFloors] = useState({ minPrice: '', minVolume: '' });
  // Long-term first: the app is for long-term investors.
  const [horizon, setHorizon] = useState('long');
  const [setup, setSetup] = useState('');
  const [sort, setSort] = useState({ key: 'drawdownPct', dir: 'asc' });
  const { data, loading, error } = useScanner(user, authHeader, floors);

  const run = data ? data.run : null;
  const results = useMemo(() => (data && Array.isArray(data.results) ? data.results : []), [data]);
  const counts = (data && data.counts) || {};
  const inHorizon = useMemo(
    () => results.filter((h) => (h.setups || []).some((k) => HORIZON_KEYS[horizon].includes(k))),
    [results, horizon]
  );
  const total = inHorizon.length;
  const rows = useMemo(
    () => sortRows(setup ? inHorizon.filter((h) => (h.setups || []).includes(setup)) : inHorizon, sort),
    [inHorizon, setup, sort]
  );
  const setups = SETUPS.filter((x) => x.horizon === horizon);
  const columns = COLUMNS_BY_HORIZON[horizon];
  const active = SETUPS.find((s) => s.key === setup);
  const chooseHorizon = (h) => {
    setHorizon(h);
    setSetup('');
    setSort(h === 'long' ? { key: 'drawdownPct', dir: 'asc' } : { key: 'volume', dir: 'desc' });
  };
  // Only the setups of the horizon shown, in the table's "setup" column.
  const labelsFor = (h) => (h.setups || []).filter((k) => HORIZON_KEYS[horizon].includes(k)).map((k) => LABEL[k] || k).join(', ');

  const toggleSort = (key) =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'symbol' || key === 'name' ? 'asc' : 'desc' }));

  return (
    <div className="App">
      <div className="analysis-container">
        <div className="analysis-content">
          <PageToolbar title="סורק שוק" subtitle="מניות ארה״ב שירדו חזק או נמצאות בתיקון, ותבניות גרף לטווח קצר - נסרק פעם ביום אחרי סגירת המסחר" />

          <p className="scanner-disclaimer">
            הסריקה היא רשימת גרפים שעונים על כלל טכני, לא רשימת מניות לקנייה. תבנית בגרף אינה תחזית, והמידע אינו ייעוץ השקעות
            ואינו תחליף לייעוץ המתחשב בנתונים ובצרכים של כל אדם. הנתונים מ-Yahoo, באיחור ולא בזמן אמת.
          </p>

          {loading && !data && <p className="history-empty-note">טוען את תוצאות הסריקה…</p>}
          {error && <p className="profit-negative">{error}</p>}

          {data && !run && (
            <div className="analysis-section">
              <p className="history-empty-note">
                הסריקה הראשונה עוד לא רצה. הסורק עובר על כל המניות הרגילות הרשומות בארה״ב פעם ביום אחרי סגירת המסחר, והתוצאות
                יופיעו כאן.
              </p>
            </div>
          )}

          {run && (
            <>
              <CoverageNote run={run} />

              <div className="analysis-section">
                <form
                  className="scanner-filters"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setFloors({ minPrice: priceDraft.trim(), minVolume: volumeDraft.trim() });
                  }}
                >
                  <label htmlFor="scanner-min-price">מחיר מינימלי ($)</label>
                  <input id="scanner-min-price" className="inline-input" type="number" min="0" step="any" inputMode="decimal" value={priceDraft} onChange={(e) => setPriceDraft(e.target.value)} />
                  <label htmlFor="scanner-min-volume">מחזור מינימלי (מניות)</label>
                  <input id="scanner-min-volume" className="inline-input" type="number" min="0" step="1" inputMode="numeric" value={volumeDraft} onChange={(e) => setVolumeDraft(e.target.value)} />
                  <button type="submit" className="benchmark-toggle-button">
                    סינון
                  </button>
                </form>

                <div className="scanner-horizon" role="group" aria-label="טווח השקעה">
                  <button type="button" className={`scanner-chip ${horizon === 'long' ? 'is-active' : ''}`} aria-pressed={horizon === 'long'} onClick={() => chooseHorizon('long')}>
                    לטווח ארוך
                  </button>
                  <button type="button" className={`scanner-chip ${horizon === 'short' ? 'is-active' : ''}`} aria-pressed={horizon === 'short'} onClick={() => chooseHorizon('short')}>
                    תבניות לטווח קצר
                  </button>
                </div>

                <div className="scanner-chips" role="group" aria-label="סוג תבנית">
                  <button type="button" className={`scanner-chip ${setup === '' ? 'is-active' : ''}`} aria-pressed={setup === ''} onClick={() => setSetup('')}>
                    הכל <span className="scanner-chip-count">{total}</span>
                  </button>
                  {setups.map((s) => (
                    <button
                      key={s.key}
                      type="button"
                      className={`scanner-chip ${setup === s.key ? 'is-active' : ''}`}
                      aria-pressed={setup === s.key}
                      onClick={() => setSetup(s.key)}
                    >
                      {s.label} <span className="scanner-chip-count">{counts[s.key] || 0}</span>
                    </button>
                  ))}
                </div>

                {active ? (
                  <p className="scanner-explain">
                    <strong>{active.label}:</strong> {active.explain}
                  </p>
                ) : (
                  <details className="scanner-explain-all">
                    <summary>מה כל תבנית אומרת?</summary>
                    <ul>
                      {setups.map((s) => (
                        <li key={s.key}>
                          <strong>{s.label}:</strong> {s.explain}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>

              {rows.length === 0 ? (
                <p className="history-empty-note">אין מניות שעונות על התבנית והסינון שנבחרו בסריקה האחרונה.</p>
              ) : (
                <div className="stocks-table-container">
                  <table className="analysis-table scanner-table" aria-label="תוצאות הסריקה">
                    <thead>
                      <tr>
                        {columns.map((c) => (
                          <th key={c.key} aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                            {c.type === 'none' ? (
                              c.label
                            ) : (
                              <button type="button" className="scanner-sort-button" onClick={() => toggleSort(c.key)}>
                                {c.label}
                                {sort.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                              </button>
                            )}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((h) => (
                        <tr key={h.symbol}>
                          <td>
                            <bdi dir="ltr" className="scanner-symbol">
                              {h.symbol}
                            </bdi>
                            {h.held && <span className="scanner-held-badge">בתיק</span>}
                          </td>
                          <td className="scanner-name">{h.name || ''}</td>
                          <td>{labelsFor(h)}</td>
                          <td>
                            <bdi dir="ltr">{fmtPrice(h.close)}</bdi>
                          </td>
                          <td className={pctClass(h.changePct)}>
                            <bdi dir="ltr">{fmtPct(h.changePct)}</bdi>
                          </td>
                          {horizon === 'long' ? (
                            <>
                              <td className={pctClass(h.drawdownPct)}>
                                <bdi dir="ltr">{fmtPct(h.drawdownPct)}</bdi>
                              </td>
                              <td className={pctClass(h.distMa200Pct)}>
                                <bdi dir="ltr">{fmtPct(h.distMa200Pct)}</bdi>
                              </td>
                              <td>
                                <FundamentalsCell hit={h} />
                              </td>
                            </>
                          ) : (
                            <>
                              <td>
                                <bdi dir="ltr">{fmtInt(h.volume)}</bdi>
                                {Number.isFinite(Number(h.volumeRatio)) && h.volumeRatio !== null && (
                                  <span className="scanner-subnote"> (פי {Number(h.volumeRatio).toFixed(1)} מהממוצע)</span>
                                )}
                              </td>
                              <td className={pctClass(h.distHigh20Pct)}>
                                <bdi dir="ltr">{fmtPct(h.distHigh20Pct)}</bdi>
                              </td>
                              <td className={pctClass(h.distMa20Pct)}>
                                <bdi dir="ltr">{fmtPct(h.distMa20Pct)}</bdi>
                              </td>
                              <td>
                                <bdi dir="ltr">{Number.isFinite(Number(h.rsi)) && h.rsi !== null ? Number(h.rsi).toFixed(1) : '—'}</bdi>
                              </td>
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {horizon === 'long' && (
                <p className="muted-note">
                  עמודת הדוח האחרון: צמיחת ההכנסות ושינוי שולי הרווח התפעולי ברבעון האחרון מול אותו רבעון אשתקד, מדוחות ה-SEC.
                  &quot;צומחת&quot; - הכנסות בעלייה ושולי רווח יציבים או משתפרים; &quot;נחלשת&quot; - הכנסות ושולי רווח בירידה. הנתונים
                  נטענים מראש ל-40 המניות הנסחרות ביותר; לשאר - &quot;בדיקת דוחות&quot; פותח את דף ניתוח הדוחות. מכפיל רווח היסטורי לא נכלל:
                  אין לו מקור חינמי לכל השוק.
                </p>
              )}
              <p className="muted-note">
                המחזור הוא של יום המסחר האחרון. התבניות מחושבות ממחירי סגירה יומיים בלבד, והתוצאות מתיישנות ברגע שהמחיר זז: כדאי
                לבדוק את הגרף העדכני לפני כל החלטה.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default ScannerView;
