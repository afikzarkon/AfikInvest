import React, { useState } from 'react';
import { createFlag, deleteFlag, listFlags, updateFlag } from '../../adminApi';
import { ErrorNote, Loading, formatWhen, useAction, useLoad } from './shared';

// Feature flags: switched live, enforced by the server.

export const STATES = [
  { value: 'off', label: 'כבוי', hint: 'מוסתר מכולם' },
  { value: 'admin', label: 'אדמין בלבד', hint: 'לבדיקה לפני שחרור' },
  { value: 'all', label: 'כולם', hint: 'פעיל לכל המשתמשים' }
];

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
  const { busy, error, run } = useAction();
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    const ok = await run(() => onCreate({ key: form.key.trim(), description: form.description.trim(), state: form.state }));
    if (ok) setForm({ key: '', description: '', state: 'admin' });
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
      <ErrorNote>{error}</ErrorNote>
    </form>
  );
}

function FlagsTab({ onFlagsChanged }) {
  const flags = useLoad(listFlags);
  const action = useAction();
  const [busyKey, setBusyKey] = useState(null);

  // After a change: the list, and the site's flags for this admin, so the
  // nav reflects it at once rather than at the next poll.
  const act = async (key, fn) => {
    setBusyKey(key);
    if (await action.run(fn)) {
      await flags.reload();
      if (onFlagsChanged) onFlagsChanged();
    }
    setBusyKey(null);
  };

  return (
    <>
      <section className="analysis-section">
        <h3 className="section-title">פיצ׳רים</h3>
        <p className="section-subtitle">שינוי נכנס לתוקף מיד בשרת, ומגיע לדפדפנים פתוחים תוך דקה. פיצ׳ר כבוי מוסתר מהניווט וה-API שלו מחזיר 404.</p>
        <ErrorNote>{flags.error || action.error}</ErrorNote>
        {!flags.data ? (
          <Loading />
        ) : (
          <ul className="admin-flag-list">
            {flags.data.map((flag) => (
              <li key={flag.key} className="admin-flag">
                <div className="admin-flag-head">
                  <code className="admin-flag-key" dir="ltr">
                    {flag.key}
                  </code>
                  {flag.builtIn ? <span className="admin-flag-tag">בקוד</span> : null}
                </div>
                {flag.description ? <p className="admin-flag-desc">{flag.description}</p> : null}
                <div className="admin-flag-controls">
                  <StateSwitch flag={flag} busy={busyKey === flag.key} onChange={(state) => act(flag.key, () => updateFlag(flag.key, { state }))} />
                  {!flag.builtIn ? (
                    <button
                      type="button"
                      className="admin-danger-button"
                      disabled={busyKey === flag.key}
                      onClick={() => window.confirm(`למחוק את הפיצ׳ר "${flag.key}"?`) && act(flag.key, () => deleteFlag(flag.key))}
                    >
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
            await flags.reload();
            if (onFlagsChanged) onFlagsChanged();
          }}
        />
      </section>
    </>
  );
}

export default FlagsTab;
