// Ported from day-trader-skill (MIT, Jake Schincariol) - trader-pelosi.
import React, { useMemo, useState } from 'react';
import PageToolbar, { ToolbarPrimaryButton } from './PageToolbar';
import { useCongressTrades } from '../hooks/useCongressTrades';
import './CongressView.css';

// /congress - the stock trades members of the US House of Representatives
// disclose in Periodic Transaction Reports (PTRs) under the STOCK Act. The
// server reads the House Clerk's public index and PDFs on a schedule
// (server/congressService.js); this page lists the trades, highlights the
// ones in stocks the user holds, and links every row to its source PDF.

const TYPE_LABELS = {
  P: { text: 'קנייה', tone: 'is-positive' },
  S: { text: 'מכירה', tone: 'is-negative' },
  'S (partial)': { text: 'מכירה חלקית', tone: 'is-negative' },
  E: { text: 'החלפה', tone: 'is-neutral' }
};
const OWNER_LABELS = { SP: 'בן/בת זוג', JT: 'משותף', DC: 'ילד/ה', '': 'חבר/ת הקונגרס' };
const STATUS_NOTES = {
  pending: 'הדיווח טרם נקרא - ייקרא בסריקה הבאה',
  no_text: 'הדיווח הוא מסמך סרוק - יש לפתוח את ה-PDF',
  error: 'קריאת ה-PDF נכשלה - יש לפתוח את ה-PDF',
  parsed: 'לא זוהו עסקאות בדיווח - יש לפתוח את ה-PDF'
};
const DAY_OPTIONS = [30, 90, 180, 365];

const normTicker = (t) => String(t || '').trim().toUpperCase().replace(/[-/]/g, '.');

export const formatDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
};

const formatDateTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
};

const fmtUsd = (n) => `$${Number(n).toLocaleString('en-US')}`;
function amountText(row) {
  if (row.amountLow && row.amountHigh) return `${fmtUsd(row.amountLow)} - ${fmtUsd(row.amountHigh)}`;
  if (row.amountLow) return `${fmtUsd(row.amountLow)}+`;
  return row.amount || '';
}

function optionText(option) {
  if (!option) return '';
  const kind = option.kind === 'put' ? 'PUT' : 'CALL';
  return `${option.exercised ? 'מימוש ' : ''}${option.contracts} אופציות ${kind}, מימוש $${option.strike}, פקיעה ${formatDate(option.expires)}`;
}

function TypePill({ type }) {
  const label = TYPE_LABELS[type] || { text: type, tone: 'is-neutral' };
  return <span className={`value-pill ${label.tone}`}>{label.text}</span>;
}

function PdfLink({ url }) {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      PDF
    </a>
  );
}

function CongressView({ user, authHeader, americanStocks = [] }) {
  const [days, setDays] = useState(90);
  const [memberQuery, setMemberQuery] = useState('');
  const [onlyHeld, setOnlyHeld] = useState(false);
  const [refreshState, setRefreshState] = useState(null);
  const { filings, heldTickers, lastScanAt, loading, error, refreshNow } = useCongressTrades(user, authHeader, { days });

  // The server matches the user's stored portfolio; the live prop covers
  // lots added since the last save.
  const held = useMemo(() => {
    const set = new Set(heldTickers.map((h) => normTicker(h.ticker)));
    (americanStocks || []).forEach((lot) => {
      if (lot && lot.stockName && Number(lot.quantity) > 0) set.add(normTicker(lot.stockName));
    });
    return set;
  }, [heldTickers, americanStocks]);

  const lines = useMemo(() => {
    const q = memberQuery.trim().toLowerCase();
    const out = [];
    filings.forEach((f) => {
      if (q && !`${f.memberName} ${f.stateDistrict}`.toLowerCase().includes(q)) return;
      if (!f.rows.length) {
        if (!onlyHeld) out.push({ key: `${f.docId}:none`, filing: f, row: null, isHeld: false });
        return;
      }
      f.rows.forEach((row, i) => {
        const isHeld = Boolean(row.ticker) && held.has(normTicker(row.ticker));
        if (onlyHeld && !isHeld) return;
        out.push({ key: `${f.docId}:${i}`, filing: f, row, isHeld });
      });
    });
    return out;
  }, [filings, memberQuery, onlyHeld, held]);

  const heldMatches = heldTickers.filter((h) => h.trades > 0);

  const handleRefresh = async () => {
    setRefreshState({ busy: true });
    try {
      const r = await refreshNow();
      const s = r.scan || {};
      setRefreshState({ text: `נמצאו ${s.newFilings || 0} דיווחים חדשים, נקראו ${s.parsed || 0}` });
    } catch (err) {
      setRefreshState({ error: true, text: err.message });
    }
  };

  return (
    <div className="App">
      <div className="analysis-container">
        <div className="analysis-content">
          <PageToolbar
            title="עסקאות חברי קונגרס"
            subtitle="מניות שחברי בית הנבחרים האמריקאי ובני משפחתם קנו ומכרו, מתוך הדיווחים הציבוריים"
            primaryAction={
              <ToolbarPrimaryButton onClick={handleRefresh} disabled={refreshState?.busy}>
                {refreshState?.busy ? 'מרענן…' : 'רענון'}
              </ToolbarPrimaryButton>
            }
            status={
              refreshState?.text ? (
                <span role="status" className={refreshState.error ? 'profit-negative' : ''}>
                  {refreshState.text}
                </span>
              ) : lastScanAt ? (
                <span>עודכן לאחרונה: {formatDateTime(lastScanAt)}</span>
              ) : null
            }
          />

          <div className="analysis-section congress-intro">
            <p className="section-subtitle">
              חברי בית הנבחרים חייבים לפי חוק STOCK לדווח בפומבי על עסקאות בניירות ערך שלהם, של בני הזוג ושל ילדיהם. הדיווח מוגש עד 30 יום
              מהיום שבו נודע להם על העסקה ולכל המאוחר 45 יום אחריה, כך שהמידע מגיע באיחור, והסכומים מדווחים כטווחים ולא כמחירים. הנתונים
              נלקחים מאתר משרד הכתבן של בית הנבחרים; דיווחי הסנאט אינם כלולים. מידע ציבורי בלבד, לא ייעוץ השקעות.
            </p>
          </div>

          {heldMatches.length > 0 && (
            <div className="analysis-section congress-held" aria-label="מניות שבתיק">
              <h2 className="section-title">מניות שבתיק שלך בדיווחים</h2>
              <ul className="congress-held-list">
                {heldMatches.map((h) => (
                  <li key={h.ticker}>
                    <bdi dir="ltr" className="congress-ticker">
                      {h.ticker}
                    </bdi>{' '}
                    - {h.trades} עסקאות, אחרונה {formatDate(h.lastTradeDate)} ({h.members.join(', ')})
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="analysis-section">
            <div className="rebalance-sum-row congress-filters">
              <label htmlFor="congress-member">חבר/ת קונגרס</label>
              <input
                id="congress-member"
                type="search"
                value={memberQuery}
                placeholder="למשל Pelosi"
                onChange={(e) => setMemberQuery(e.target.value)}
              />
              <label htmlFor="congress-days">תקופה</label>
              <select id="congress-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {DAY_OPTIONS.map((d) => (
                  <option key={d} value={d}>
                    {d} ימים אחרונים
                  </option>
                ))}
              </select>
              <label className="congress-toggle">
                <input type="checkbox" checked={onlyHeld} onChange={(e) => setOnlyHeld(e.target.checked)} />
                רק מניות שבתיק
              </label>
            </div>

            {error ? (
              <p className="history-empty-note profit-negative">{error}</p>
            ) : loading && !filings.length ? (
              <p className="history-empty-note">טוען…</p>
            ) : lines.length === 0 ? (
              <p className="history-empty-note">
                {filings.length ? 'אין עסקאות שתואמות לסינון.' : 'עדיין אין דיווחים שמורים לתקופה הזו. הסריקה רצה כמה פעמים ביום.'}
              </p>
            ) : (
              <div className="stocks-table-container">
                <table className="analysis-table congress-table" aria-label="עסקאות חברי קונגרס">
                  <thead>
                    <tr>
                      <th>חבר/ת קונגרס</th>
                      <th>נייר</th>
                      <th>פעולה</th>
                      <th>סכום</th>
                      <th>תאריך עסקה</th>
                      <th>תאריך דיווח</th>
                      <th>ימים לדיווח</th>
                      <th>מקור</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map(({ key, filing, row, isHeld }) => (
                      <tr key={key} className={isHeld ? 'congress-row-held' : undefined}>
                        <td data-label="חבר/ת קונגרס">
                          <div>{filing.memberName}</div>
                          <div className="congress-sub">
                            <bdi dir="ltr">{filing.stateDistrict}</bdi>
                            {row ? ` · ${OWNER_LABELS[row.owner] ?? row.ownerName}` : ''}
                          </div>
                        </td>
                        {row ? (
                          <>
                            <td data-label="נייר">
                              {row.ticker ? (
                                <bdi dir="ltr" className="congress-ticker">
                                  {row.ticker}
                                </bdi>
                              ) : null}
                              {isHeld && <span className="congress-held-badge">בתיק</span>}
                              <div className="congress-sub">{row.asset}</div>
                              {row.option && <div className="congress-sub">{optionText(row.option)}</div>}
                            </td>
                            <td data-label="פעולה">
                              <TypePill type={row.type} />
                            </td>
                            <td data-label="סכום">
                              <bdi dir="ltr">{amountText(row)}</bdi>
                            </td>
                            <td data-label="תאריך עסקה">{formatDate(row.date)}</td>
                            <td data-label="תאריך דיווח">{formatDate(filing.filedDate)}</td>
                            <td data-label="ימים לדיווח" className={row.late ? 'profit-negative' : undefined}>
                              {row.daysToDisclose ?? ''}
                              {row.late ? ' (באיחור)' : ''}
                            </td>
                          </>
                        ) : (
                          <>
                            <td colSpan={4} className="congress-sub" data-label="נייר">
                              {STATUS_NOTES[filing.parseStatus] || STATUS_NOTES.parsed}
                            </td>
                            <td data-label="תאריך דיווח">{formatDate(filing.filedDate)}</td>
                            <td data-label="ימים לדיווח" />
                          </>
                        )}
                        <td data-label="מקור">
                          <PdfLink url={filing.pdfUrl} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default CongressView;
