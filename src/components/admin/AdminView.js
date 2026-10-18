import React, { useCallback, useEffect, useState } from 'react';
import PageToolbar from '../PageToolbar';
import { createFlag, deleteFlag, listAudit, listFlags, updateFlag } from '../../adminApi';

// The admin panel: feature flags switched live, and the log of every admin
// action. Rendered only for admins (App.js), but that is only what the
// page shows - every call it makes is checked for the admin role on the
// server (server/adminRoutes.js), so the page is no key to anything.

const STATES = [
  { value: 'off', label: 'כבוי', hint: 'מוסתר מכולם' },
  { value: 'admin', label: 'אדמין בלבד', hint: 'לבדיקה לפני שחרור' },
  { value: 'all', label: 'כולם', hint: 'פעיל לכל המשתמשים' }
];

const ACTION_LABELS = {
  'flag.create': 'יצירת פיצ׳ר',
  'flag.update': 'עדכון פיצ׳ר',
  'flag.delete': 'מחיקת פיצ׳ר',
  'admin.grant': 'מתן הרשאת אדמין'
};

const STATE_LABEL = STATES.reduce((acc, s) => ({ ...acc, [s.value]: s.label }), {});

function formatWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
}

function describeChange(entry) {
  const { before, after } = entry;
  if (before && after && before.state !== after.state) return `${STATE_LABEL[before.state] || before.state} ← ${STATE_LABEL[after.state] || after.state}`;
  if (before && after && before.description !== after.description) return 'תיאור עודכן';
  if (!before && after && after.state) return STATE_LABEL[after.state] || after.state;
  return '';
}

function StateSwitch({ flag, busy, onChange }) {
  return (
    <div className="admin-state-switch" role="radiogroup" aria-label={`מצב ${flag.key}`}>
      {STATES.map((s) => (
        <button
          key={s.value}
          type="button"
          role="radio"
          aria-checked={flag.state === s.value}
          className={`admin-state-option is-${s.value} ${flag.state === s.value ? 'active' : ''}`}
          disabled={busy}
          title={s.hint}
          onClick={() => flag.state !== s.value && onChange(s.value)}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

function NewFlagForm({ onCreate }) {
  const [form, setForm] = useState({ key: '', description: '', state: 'admin' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onCreate({ key: form.key.trim(), description: form.description.trim(), state: form.state });
      setForm({ key: '', description: '', state: 'admin' });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="admin-new-flag" onSubmit={submit}>
      <label className="admin-field">
        <span>מזהה</span>
        <input className="auth-input" dir="ltr" value={form.key} onChange={set('key')} placeholder="new-feature" required pattern="[a-z][a-z0-9-]{1,48}" />
      </label>
      <label className="admin-field admin-field-wide">
        <span>תיאור</span>
        <input className="auth-input" value={form.description} onChange={set('description')} maxLength={300} placeholder="מה הפיצ׳ר עושה" />
      </label>
      <label className="admin-field">
        <span>מצב התחלתי</span>
        <select className="auth-input" value={form.state} onChange={set('state')}>
          {STATES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="benchmark-toggle-button active admin-submit" disabled={busy || !form.key.trim()}>
        {busy ? 'מוסיף…' : 'הוספה'}
      </button>
      {error ? (
        <p className="admin-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function AdminView({ onFlagsChanged }) {
  const [flags, setFlags] = useState(null);
  const [audit, setAudit] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [f, a] = await Promise.all([listFlags(), listAudit(100)]);
      setFlags(f);
      setAudit(a);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // After any change: the panel's own lists, and the site's flags for this
  // admin, so the nav reflects it at once rather than at the next poll.
  const afterChange = async () => {
    await load();
    if (onFlagsChanged) onFlagsChanged();
  };

  const changeState = async (flag, state) => {
    setBusyKey(flag.key);
    setError('');
    try {
      await updateFlag(flag.key, { state });
      await afterChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyKey(null);
    }
  };

  const remove = async (flag) => {
    if (!window.confirm(`למחוק את הפיצ׳ר "${flag.key}"?`)) return;
    setBusyKey(flag.key);
    setError('');
    try {
      await deleteFlag(flag.key);
      await afterChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="App">
      <div className="analysis-container">
        <div className="analysis-content">
          <PageToolbar title="ניהול" subtitle="הפעלה וכיבוי של פיצ׳רים בזמן אמת, ויומן פעולות הניהול" />

          {error ? (
            <p className="admin-error" role="alert">
              {error}
            </p>
          ) : null}

          <section className="analysis-section">
            <h3 className="section-title">פיצ׳רים</h3>
            <p className="section-subtitle">
              שינוי נכנס לתוקף מיד בשרת, ומגיע לדפדפנים פתוחים תוך דקה. פיצ׳ר כבוי מוסתר מהניווט וה-API שלו מחזיר 404.
            </p>
            {flags === null ? (
              <p className="history-empty-note">טוען…</p>
            ) : (
              <ul className="admin-flag-list">
                {flags.map((flag) => (
                  <li key={flag.key} className="admin-flag">
                    <div className="admin-flag-head">
                      <code className="admin-flag-key" dir="ltr">
                        {flag.key}
                      </code>
                      {flag.builtIn ? <span className="admin-flag-tag">בקוד</span> : null}
                    </div>
                    {flag.description ? <p className="admin-flag-desc">{flag.description}</p> : null}
                    <div className="admin-flag-controls">
                      <StateSwitch flag={flag} busy={busyKey === flag.key} onChange={(state) => changeState(flag, state)} />
                      {!flag.builtIn ? (
                        <button type="button" className="admin-flag-delete" disabled={busyKey === flag.key} onClick={() => remove(flag)}>
                          מחיקה
                        </button>
                      ) : null}
                    </div>
                    <p className="admin-flag-meta">
                      {flag.updatedByEmail ? (
                        <>
                          עודכן ע״י <span dir="ltr">{flag.updatedByEmail}</span> · {formatWhen(flag.updatedAt)}
                        </>
                      ) : (
                        <>ברירת מחדל · {formatWhen(flag.updatedAt)}</>
                      )}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="analysis-section">
            <h3 className="section-title">פיצ׳ר חדש</h3>
            <p className="section-subtitle">למזהה שהקוד עומד לבדוק. אפשר להתחיל ב&quot;אדמין בלבד&quot; ולשחרר לכולם אחרי בדיקה.</p>
            <NewFlagForm
              onCreate={async (flag) => {
                await createFlag(flag);
                await afterChange();
              }}
            />
          </section>

          <section className="analysis-section">
            <h3 className="section-title">יומן פעולות</h3>
            {audit === null ? (
              <p className="history-empty-note">טוען…</p>
            ) : audit.length === 0 ? (
              <p className="history-empty-note">אין עדיין פעולות.</p>
            ) : (
              <ul className="admin-audit-list">
                {audit.map((entry) => (
                  <li key={entry.id} className="admin-audit-entry">
                    <span className="admin-audit-when">{formatWhen(entry.createdAt)}</span>
                    <span className="admin-audit-what">
                      {ACTION_LABELS[entry.action] || entry.action}
                      {entry.target ? (
                        <>
                          {' '}
                          <code dir="ltr">{entry.target.replace(/^flag:/, '')}</code>
                        </>
                      ) : null}
                      {describeChange(entry) ? <span className="admin-audit-change"> · {describeChange(entry)}</span> : null}
                    </span>
                    <span className="admin-audit-who" dir="ltr">
                      {entry.actorEmail || '-'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

export default AdminView;
