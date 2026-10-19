import React, { useState } from 'react';
import { getSettings, saveBanner, saveMaintenance } from '../../adminApi';
import { SystemBanner } from '../SystemNotices';
import { ErrorNote, Loading, formatWhen, useAction, useLoad } from './shared';

// The site-wide banner and maintenance mode.

const LEVELS = [
  { value: 'info', label: 'מידע' },
  { value: 'warning', label: 'אזהרה' },
  { value: 'critical', label: 'קריטי (אי אפשר לסגור)' }
];

// An ISO instant as the value a datetime-local input takes (local time).
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function BannerForm({ initial, onSaved }) {
  const [form, setForm] = useState({
    active: Boolean(initial.active),
    text: initial.text || '',
    level: initial.level || 'info',
    expiresAt: toLocalInput(initial.expiresAt)
  });
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState('');
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const save = async (e) => {
    e.preventDefault();
    setSaved('');
    const ok = await run(async () => {
      await saveBanner({ ...form, expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null });
      await onSaved();
    });
    if (ok) setSaved(form.active ? 'הבאנר פורסם. משתמשים יראו אותו תוך דקה.' : 'הבאנר כבוי.');
  };

  return (
    <form className="admin-form" onSubmit={save}>
      <label className="admin-check">
        <input type="checkbox" checked={form.active} onChange={set('active')} />
        <span>באנר פעיל</span>
      </label>
      <label className="admin-field">
        <span>טקסט</span>
        <textarea className="auth-input admin-textarea" value={form.text} onChange={set('text')} maxLength={500} rows={3} placeholder="למשל: עדכון גרסה הלילה ב-23:00, ייתכנו הפרעות קצרות" />
      </label>
      <div className="admin-form-row">
        <label className="admin-field">
          <span>רמה</span>
          <select className="auth-input" value={form.level} onChange={set('level')}>
            {LEVELS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <label className="admin-field">
          <span>יורד אוטומטית ב- (לא חובה)</span>
          <input className="auth-input" type="datetime-local" value={form.expiresAt} onChange={set('expiresAt')} />
        </label>
      </div>
      {form.text.trim() ? (
        <div className="admin-preview">
          <span className="admin-flag-meta">תצוגה מקדימה:</span>
          <SystemBanner banner={{ text: form.text, level: form.level, id: 'preview' }} />
        </div>
      ) : null}
      <div className="admin-actions">
        <button type="submit" className="benchmark-toggle-button active admin-submit" disabled={busy}>
          {busy ? 'שומר…' : 'שמירה'}
        </button>
        {saved ? (
          <span className="admin-notice" role="status">
            {saved}
          </span>
        ) : null}
      </div>
      <ErrorNote>{error}</ErrorNote>
    </form>
  );
}

function MaintenanceForm({ initial, onSaved }) {
  const [message, setMessage] = useState(initial.message || '');
  const { busy, error, run } = useAction();
  const enabled = Boolean(initial.enabled);

  const toggle = async () => {
    const next = !enabled;
    if (next && !window.confirm('להפעיל מצב תחזוקה? כל המשתמשים מלבד אדמינים יראו מסך תחזוקה, וה-API יחזיר להם 503.')) return;
    await run(async () => {
      await saveMaintenance({ enabled: next, message });
      await onSaved();
    });
  };

  return (
    <div className="admin-form">
      <p className={`admin-maintenance-state ${enabled ? 'is-on' : ''}`}>{enabled ? 'מצב תחזוקה פעיל' : 'האתר פתוח לכולם'}</p>
      <label className="admin-field">
        <span>הודעה למשתמשים</span>
        <textarea className="auth-input admin-textarea" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} rows={2} placeholder="אנחנו משדרגים את המערכת. נחזור עד 23:30." />
      </label>
      <div className="admin-actions">
        <button type="button" className={enabled ? 'benchmark-toggle-button active admin-submit' : 'admin-danger-button admin-submit'} disabled={busy} onClick={toggle}>
          {enabled ? 'סיום תחזוקה' : 'הפעלת מצב תחזוקה'}
        </button>
        {enabled ? (
          <button type="button" className="benchmark-toggle-button" disabled={busy} onClick={() => run(async () => { await saveMaintenance({ enabled: true, message }); await onSaved(); })}>
            עדכון ההודעה
          </button>
        ) : null}
      </div>
      <ErrorNote>{error}</ErrorNote>
    </div>
  );
}

function SystemTab({ onSystemChanged }) {
  const settings = useLoad(getSettings);
  const [version, setVersion] = useState(0);
  const afterSave = async () => {
    await settings.reload();
    // Remounts the forms on the saved values.
    setVersion((v) => v + 1);
    if (onSystemChanged) onSystemChanged();
  };

  if (!settings.data) return settings.error ? <ErrorNote>{settings.error}</ErrorNote> : <Loading />;
  const { banner, maintenance } = settings.data;
  return (
    <>
      <section className="analysis-section">
        <h3 className="section-title">באנר הודעות מערכת</h3>
        <p className="section-subtitle">
          מופיע בראש כל המסכים, גם במסך ההתחברות.
          {banner.updatedByEmail ? ` עודכן לאחרונה ע״י ${banner.updatedByEmail} · ${formatWhen(banner.updatedAt)}` : ''}
        </p>
        <BannerForm key={`b${version}`} initial={banner} onSaved={afterSave} />
      </section>
      <section className="analysis-section">
        <h3 className="section-title">מצב תחזוקה</h3>
        <p className="section-subtitle">
          כשהוא פעיל, השרת מחזיר 503 לכל מי שאינו אדמין, והאתר מציג מסך תחזוקה. אדמינים ממשיכים לעבוד כרגיל.
          {maintenance.updatedByEmail ? ` עודכן לאחרונה ע״י ${maintenance.updatedByEmail} · ${formatWhen(maintenance.updatedAt)}` : ''}
        </p>
        <MaintenanceForm key={`m${version}`} initial={maintenance} onSaved={afterSave} />
      </section>
    </>
  );
}

export default SystemTab;
