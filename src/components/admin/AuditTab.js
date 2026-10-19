import React from 'react';
import { downloadExport, listAudit } from '../../adminApi';
import { ErrorNote, Loading, formatWhen, useAction, useLoad } from './shared';
import { STATES } from './FlagsTab';

// The log of every admin action, and the CSV exports (each export is
// itself logged).

const ACTION_LABELS = {
  'flag.create': 'יצירת פיצ׳ר',
  'flag.update': 'עדכון פיצ׳ר',
  'flag.delete': 'מחיקת פיצ׳ר',
  'admin.grant': 'מתן הרשאת אדמין',
  'admin.revoke': 'הסרת הרשאת אדמין',
  'user.block': 'חסימת משתמש',
  'user.unblock': 'ביטול חסימה',
  'user.revoke_sessions': 'ניתוק מכל המכשירים',
  'user.password_reset_sent': 'שליחת קישור איפוס סיסמה',
  'setting.banner': 'עדכון באנר',
  'setting.maintenance': 'מצב תחזוקה',
  'errors.clear': 'ניקוי שגיאות',
  'export.users': 'ייצוא משתמשים',
  'export.audit': 'ייצוא יומן'
};

const STATE_LABEL = STATES.reduce((acc, s) => ({ ...acc, [s.value]: s.label }), {});

function describe(entry) {
  const { action, before, after } = entry;
  if (action === 'flag.update' && before && after && before.state !== after.state) {
    return `${STATE_LABEL[before.state] || before.state} ← ${STATE_LABEL[after.state] || after.state}`;
  }
  if (action === 'flag.create' && after) return STATE_LABEL[after.state] || '';
  if (action === 'setting.maintenance' && after) return after.enabled ? 'הופעל' : 'כובה';
  if (action === 'setting.banner' && after) return after.active ? `פעיל: ${after.text}` : 'כובה';
  if (action.startsWith('user.') && after && after.email) return after.reason ? `${after.email} · ${after.reason}` : after.email;
  if (action.startsWith('export.') && after) return `${after.rows} שורות`;
  return '';
}

function AuditTab() {
  const audit = useLoad(() => listAudit(200));
  const exporting = useAction();

  const exportCsv = async (name) => {
    if (await exporting.run(() => downloadExport(name))) audit.reload();
  };

  return (
    <>
      <section className="analysis-section">
        <h3 className="section-title">ייצוא ל-CSV</h3>
        <p className="section-subtitle">קובץ שנפתח באקסל. ייצוא המשתמשים כולל סטטוס חשבון בלבד, בלי נתוני תיקים. כל ייצוא נרשם ביומן.</p>
        <div className="admin-actions">
          <button type="button" className="benchmark-toggle-button" disabled={exporting.busy} onClick={() => exportCsv('users.csv')}>
            ייצוא משתמשים
          </button>
          <button type="button" className="benchmark-toggle-button" disabled={exporting.busy} onClick={() => exportCsv('audit.csv')}>
            ייצוא יומן ניהול
          </button>
        </div>
        <ErrorNote>{exporting.error}</ErrorNote>
      </section>

      <section className="analysis-section">
        <h3 className="section-title">יומן פעולות</h3>
        <ErrorNote>{audit.error}</ErrorNote>
        {!audit.data ? (
          <Loading />
        ) : audit.data.length === 0 ? (
          <p className="history-empty-note">אין עדיין פעולות.</p>
        ) : (
          <ul className="admin-audit-list">
            {audit.data.map((entry) => (
              <li key={entry.id} className="admin-audit-entry">
                <span className="admin-audit-when">{formatWhen(entry.createdAt)}</span>
                <span className="admin-audit-what">
                  {ACTION_LABELS[entry.action] || entry.action}
                  {entry.target && entry.target.startsWith('flag:') ? (
                    <>
                      {' '}
                      <code dir="ltr">{entry.target.slice(5)}</code>
                    </>
                  ) : null}
                  {describe(entry) ? <span className="admin-audit-change"> · {describe(entry)}</span> : null}
                </span>
                <span className="admin-audit-who" dir="ltr">
                  {entry.actorEmail || '-'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export default AuditTab;
