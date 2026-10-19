import React, { useEffect, useState } from 'react';
import { clearErrors, listErrors, listJobs } from '../../adminApi';
import { ErrorNote, Loading, formatWhen, useAction, useLoad } from './shared';

// Server errors (captured from the server's log, addresses and tokens
// scrubbed) and the background job queue.

const JOB_STATUS = { queued: 'בתור', running: 'רץ', done: 'הושלם', failed: 'נכשל', cancelled: 'בוטל' };
const JOB_FILTERS = ['', 'failed', 'queued', 'running', 'done'];

function ErrorsSection() {
  const errors = useLoad(listErrors);
  const action = useAction();
  const [open, setOpen] = useState(null);

  return (
    <section className="analysis-section">
      <h3 className="section-title">שגיאות שרת</h3>
      <p className="section-subtitle">נשמרות 30 יום. כתובות אימייל וטוקנים מוסתרים לפני השמירה.</p>
      <div className="admin-actions">
        <button type="button" className="benchmark-toggle-button" onClick={errors.reload} disabled={errors.loading}>
          רענון
        </button>
        {errors.data && errors.data.length ? (
          <button
            type="button"
            className="admin-danger-button"
            disabled={action.busy}
            onClick={async () => window.confirm('למחוק את כל השגיאות השמורות?') && (await action.run(clearErrors)) && errors.reload()}
          >
            ניקוי
          </button>
        ) : null}
      </div>
      <ErrorNote>{errors.error || action.error}</ErrorNote>
      {!errors.data ? (
        <Loading />
      ) : errors.data.length === 0 ? (
        <p className="history-empty-note">אין שגיאות שמורות.</p>
      ) : (
        <ul className="admin-log-list">
          {errors.data.map((e) => (
            <li key={e.id} className="admin-log-entry">
              <button type="button" className="admin-log-toggle" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)}>
                <span className="admin-audit-when">{formatWhen(e.createdAt)}</span>
                <code dir="ltr" className="admin-log-label">
                  {e.label}
                </code>
              </button>
              {open === e.id ? (
                <pre className="admin-log-detail" dir="ltr">
                  {e.detail}
                </pre>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function JobsSection() {
  const [filter, setFilter] = useState('');
  const [jobs, setJobs] = useState({ data: null, error: '' });

  useEffect(() => {
    let cancelled = false;
    setJobs((j) => ({ ...j, data: null }));
    listJobs(filter)
      .then((data) => !cancelled && setJobs({ data, error: '' }))
      .catch((err) => !cancelled && setJobs({ data: [], error: err.message }));
    return () => {
      cancelled = true;
    };
  }, [filter]);

  return (
    <section className="analysis-section">
      <h3 className="section-title">משימות רקע</h3>
      <p className="section-subtitle">סריקות התראות, לוח אירועים ותחזוקת חשבונות. תוכן המשימות אינו מוצג.</p>
      <div className="alerts-tabs" role="tablist" aria-label="סינון משימות">
        {JOB_FILTERS.map((f) => (
          <button key={f || 'all'} type="button" role="tab" aria-selected={filter === f} className={`benchmark-toggle-button ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
            {f ? JOB_STATUS[f] : 'הכל'}
          </button>
        ))}
      </div>
      <ErrorNote>{jobs.error}</ErrorNote>
      {!jobs.data ? (
        <Loading />
      ) : jobs.data.length === 0 ? (
        <p className="history-empty-note">אין משימות.</p>
      ) : (
        <ul className="admin-log-list">
          {jobs.data.map((j) => (
            <li key={j.id} className="admin-log-entry admin-job">
              <div className="admin-job-head">
                <code dir="ltr">{j.name}</code>
                <span className={`admin-badge is-${j.status === 'failed' ? 'danger' : j.status === 'done' ? 'good' : 'neutral'}`}>{JOB_STATUS[j.status] || j.status}</span>
              </div>
              <p className="admin-flag-meta">
                ניסיונות {j.attempts}/{j.maxAttempts} · עודכן {formatWhen(j.updatedAt)}
                {j.status === 'queued' ? ` · ירוץ ב-${formatWhen(j.runAfter)}` : ''}
              </p>
              {j.lastError ? (
                <pre className="admin-log-detail" dir="ltr">
                  {j.lastError}
                </pre>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function HealthTab() {
  return (
    <>
      <ErrorsSection />
      <JobsSection />
    </>
  );
}

export default HealthTab;
