import React, { useMemo, useState } from 'react';
import PageToolbar from './PageToolbar';
import { useScanner } from '../hooks/useScanner';
import './ScannerView.css';

// /scanner - daily chart setups across US stocks (ported from the
// day-trader-skill trader-scanner, MIT). The scan runs on the server once a
// day after the US close (server/scannerJobs.js); this page reads the latest
// run, lets the user filter it and marks the stocks they already hold.

export const SETUPS = [
  {
    key: 'breakout_20d',
    label: 'פריצת שיא 20 יום',
    explain: 'הסגירה האחרונה גבוהה מכל אחת מ-20 הסגירות שלפניה (שיא סגירה, לא שיא תוך-יומי).'
  },
  {
    key: 'bull_flag',
    label: 'דגל שורי',
    explain: 'עלייה של יותר מ-10% ב-10 ימי המסחר שלפני חמשת האחרונים, ואז 5 הסגירות האחרונות נעות בטווח צר של פחות מ-5%.'
  },
  {
    key: 'reclaim_ma20',
    label: 'חזרה מעל ממוצע 20',
    explain: 'הסגירה הקודמת הייתה מתחת לממוצע 20 הימים, והסגירה האחרונה חזרה אל מעליו.'
  },
  {
    key: 'oversold',
    label: 'מכירת יתר',
    explain: 'מדד RSI (14 ימים, שיטת וויילדר) מתחת ל-30: המניה ירדה מהר ביחס לתנודות הרגילות שלה.'
  },
  {
    key: 'oversold_bounce',
    label: 'היפוך ממכירת יתר',
    explain: 'מדד RSI היה מתחת ל-30 בסגירה הקודמת, והמניה סגרה בעלייה ביום האחרון.'
  }
];
const LABEL = Object.fromEntries(SETUPS.map((s) => [s.key, s.label]));

const COLUMNS = [
  { key: 'symbol', label: 'סימול', type: 'text' },
  { key: 'name', label: 'שם', type: 'text' },
  { key: 'setups', label: 'תבנית', type: 'none' },
  { key: 'close', label: 'סגירה ($)', type: 'num' },
  { key: 'changePct', label: 'שינוי יומי', type: 'num' },
  { key: 'volume', label: 'מחזור', type: 'num' },
  { key: 'distHigh20Pct', label: 'מרחק משיא 20 יום', type: 'num' },
  { key: 'distMa20Pct', label: 'מרחק מממוצע 20', type: 'num' },
  { key: 'rsi', label: 'RSI 14', type: 'num' }
];

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
  const col = COLUMNS.find((c) => c.key === key);
  if (!col || col.type === 'none') return rows;
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
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
  const [setup, setSetup] = useState('');
  const [sort, setSort] = useState({ key: 'volume', dir: 'desc' });
  const { data, loading, error } = useScanner(user, authHeader, floors);

  const run = data ? data.run : null;
  const results = useMemo(() => (data && Array.isArray(data.results) ? data.results : []), [data]);
  const counts = (data && data.counts) || {};
  const total = data && Number.isFinite(Number(data.total)) ? Number(data.total) : results.length;
  const rows = useMemo(
    () => sortRows(setup ? results.filter((h) => (h.setups || []).includes(setup)) : results, sort),
    [results, setup, sort]
  );
  const active = SETUPS.find((s) => s.key === setup);

  const toggleSort = (key) =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'symbol' || key === 'name' ? 'asc' : 'desc' }));

  return (
    <div className="App">
      <div className="analysis-container">
        <div className="analysis-content">
          <PageToolbar title="סורק שוק" subtitle="תבניות גרף יומיות במניות ארה״ב, נסרק פעם ביום אחרי סגירת המסחר" />

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

                <div className="scanner-chips" role="group" aria-label="סוג תבנית">
                  <button type="button" className={`scanner-chip ${setup === '' ? 'is-active' : ''}`} aria-pressed={setup === ''} onClick={() => setSetup('')}>
                    הכל <span className="scanner-chip-count">{total}</span>
                  </button>
                  {SETUPS.map((s) => (
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
                      {SETUPS.map((s) => (
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
                        {COLUMNS.map((c) => (
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
                          <td>{(h.setups || []).map((k) => LABEL[k] || k).join(', ')}</td>
                          <td>
                            <bdi dir="ltr">{fmtPrice(h.close)}</bdi>
                          </td>
                          <td className={pctClass(h.changePct)}>
                            <bdi dir="ltr">{fmtPct(h.changePct)}</bdi>
                          </td>
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
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
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
