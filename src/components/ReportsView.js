import React, { useMemo, useState } from 'react';
import PageToolbar, { ToolbarPrimaryButton } from './PageToolbar';

// /reports - the monthly sync and the PDF reports it produces.
//
// The report is generated when this month's manually-updated accounts are
// all in (or when the user says they are done), ten minutes after the last
// change - see server/report/reportService.js. This page shows which
// accounts are still missing, lets the user stop waiting for one, and lists
// every report version for download.

const STATE_LABELS = {
  OPEN: 'טרם התחיל',
  IN_PROGRESS: 'בתהליך',
  COMPLETE: 'הושלם'
};

const CATEGORY_LABELS = { pension: 'קופת גמל', cashFunds: 'קרן כספית', bank: 'עו"ש' };

const HEBREW_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
export const monthLabel = (month) => {
  const [y, m] = String(month).split('-').map(Number);
  return `${HEBREW_MONTHS[m - 1] || ''} ${y}`;
};

// The last 12 months, newest first.
export function recentMonths(today = new Date(), count = 12) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

const formatTime = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
};

function ReportsView({
  status,
  reports = [],
  error = '',
  onSelectMonth,
  onSetExcluded,
  onComplete,
  onRegenerate,
  onDownload,
  emailOnReady = false,
  onToggleEmail
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const months = useMemo(() => recentMonths(), []);

  const run = async (fn, okText) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      if (okText) setMessage({ ok: true, text: okText });
    } catch (err) {
      setMessage({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const toggleExcluded = (key) => {
    const excluded = new Set(status.accounts.filter((a) => a.excluded).map((a) => a.key));
    if (excluded.has(key)) excluded.delete(key);
    else excluded.add(key);
    run(() => onSetExcluded([...excluded]));
  };

  const monthReports = status ? reports.filter((r) => r.month === status.month) : [];
  const otherReports = status ? reports.filter((r) => r.month !== status.month) : reports;

  return (
    <div className="App">
      <div className="analysis-container">
        <div className="analysis-content">
          <PageToolbar
            title="דוחות חודשיים"
            subtitle="הדוח נוצר אחרי שכל החשבונות שמתעדכנים ידנית עודכנו לחודש - לא לפי תאריך קבוע"
            primaryAction={
              status && status.state !== 'COMPLETE' ? (
                <ToolbarPrimaryButton disabled={busy} onClick={() => run(onComplete, 'החודש סומן כהושלם - הדוח ייווצר בעוד כ-10 דקות')}>
                  סיימתי עדכון חודשי
                </ToolbarPrimaryButton>
              ) : null
            }
            status={
              message ? (
                <span role="status" className={message.ok ? 'profit-positive' : 'profit-negative'}>
                  {message.text}
                </span>
              ) : null
            }
          />

          {error && <p className="profit-negative">{error}</p>}
          {!status ? (
            <p className="history-empty-note">טוען…</p>
          ) : (
            <>
              <div className="analysis-section">
                <div className="rebalance-sum-row">
                  <label htmlFor="sync-month">חודש</label>
                  <select id="sync-month" value={status.month} onChange={(e) => onSelectMonth(e.target.value)}>
                    {months.map((m) => (
                      <option key={m} value={m}>
                        {monthLabel(m)}
                      </option>
                    ))}
                  </select>
                  <span className={`alert-severity-badge ${status.state === 'COMPLETE' ? 'severity-info' : 'severity-warning'}`}>
                    {STATE_LABELS[status.state] || status.state}
                  </span>
                  <span>
                    {status.updatedCount}/{status.requiredCount} חשבונות עודכנו
                  </span>
                </div>

                {status.accounts.length === 0 ? (
                  <p className="history-empty-note">אין חשבונות שמתעדכנים ידנית - אפשר לסמן את החודש כהושלם.</p>
                ) : (
                  <div className="stocks-table-container">
                    <table className="analysis-table" aria-label="חשבונות לעדכון">
                      <thead>
                        <tr>
                          <th>חשבון</th>
                          <th>סוג</th>
                          <th>תאריך ערך</th>
                          <th>מצב</th>
                          <th>לא לחכות לו</th>
                        </tr>
                      </thead>
                      <tbody>
                        {status.accounts.map((a) => (
                          <tr key={a.key}>
                            <td>{a.name}</td>
                            <td>{CATEGORY_LABELS[a.category] || a.category}</td>
                            <td>{a.valueDate || '—'}</td>
                            <td className={a.excluded ? '' : a.updated ? 'profit-positive' : 'profit-negative'}>
                              {a.excluded ? 'מוחרג' : a.updated ? 'עודכן' : 'ממתין לעדכון'}
                            </td>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`לא לחכות ל${a.name}`}
                                checked={a.excluded}
                                disabled={busy}
                                onChange={() => toggleExcluded(a.key)}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="section-subtitle">
                  חשבון נחשב מעודכן לחודש אם תאריך הערך שלו בתוך החודש או ב-10 הימים הראשונים של החודש שאחריו.
                </p>
                {status.pendingReport && (
                  <p role="status">
                    גרסה {status.pendingReport.version} של הדוח תיווצר בסביבות {formatTime(status.pendingReport.runAfter)} (תיקון לפני כן רק ידחה אותה).
                  </p>
                )}
              </div>

              <div className="analysis-section">
                <h2 className="section-title">הדוחות של {monthLabel(status.month)}</h2>
                <ReportList reports={monthReports} onDownload={(r) => run(() => onDownload(r))} />
                {status.state === 'COMPLETE' && (
                  <button type="button" className="benchmark-toggle-button" disabled={busy} onClick={() => run(onRegenerate, 'גרסה חדשה תיווצר בעוד כ-10 דקות')}>
                    יצירת גרסה חדשה
                  </button>
                )}
              </div>

              {otherReports.length > 0 && (
                <div className="analysis-section">
                  <h2 className="section-title">דוחות קודמים</h2>
                  <ReportList reports={otherReports} onDownload={(r) => run(() => onDownload(r))} />
                </div>
              )}

              <div className="analysis-section">
                <label className="form-group-checkbox">
                  <input type="checkbox" checked={emailOnReady} onChange={(e) => run(() => onToggleEmail(e.target.checked))} />
                  לשלוח לי מייל עם קישור כשהדוח מוכן
                </label>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ReportList({ reports, onDownload }) {
  if (!reports.length) return <p className="history-empty-note">עדיין אין דוחות.</p>;
  return (
    <div className="stocks-table-container">
      <table className="analysis-table" aria-label="דוחות">
        <thead>
          <tr>
            <th>חודש</th>
            <th>גרסה</th>
            <th>מצב</th>
            <th>נוצר</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {reports.map((r) => (
            <tr key={r.id}>
              <td>{monthLabel(r.month)}</td>
              <td>{r.version}</td>
              <td>{r.status === 'ready' ? 'מוכן' : r.status === 'failed' ? 'נכשל' : 'בהכנה'}</td>
              <td>{String(r.updatedAt || '').slice(0, 10)}</td>
              <td>
                {r.status === 'ready' && (
                  <button type="button" className="benchmark-toggle-button" onClick={() => onDownload(r)}>
                    הורדת PDF
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default ReportsView;
