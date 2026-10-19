import React, { useState } from 'react';
import { grantAdmin, listAdmins, revokeAdmin } from '../../adminApi';
import { ErrorNote, Loading, formatWhen, useAction, useLoad } from './shared';

// Who is an admin. Granting needs a verified account; an admin without
// two-factor sign-in holds the role but the server refuses every admin
// action until it is on. The last admin cannot be removed.

function AdminsTab({ currentUserId }) {
  const admins = useLoad(listAdmins);
  const action = useAction();
  const [email, setEmail] = useState('');

  const grant = async (e) => {
    e.preventDefault();
    if (!window.confirm(`לתת הרשאת אדמין ל-${email.trim()}? אדמין יכול לנהל משתמשים, פיצ׳רים ומצב תחזוקה.`)) return;
    if (await action.run(() => grantAdmin(email.trim()))) {
      setEmail('');
      admins.reload();
    }
  };

  const revoke = async (a) => {
    const self = a.userId === currentUserId;
    if (!window.confirm(self ? 'להסיר את הרשאת האדמין שלך? לא תוכל לחזור לפאנל.' : `להסיר את הרשאת האדמין של ${a.email}?`)) return;
    if (await action.run(() => revokeAdmin(a.userId))) {
      if (self) window.location.assign('/');
      else admins.reload();
    }
  };

  const list = admins.data ? admins.data.admins : null;
  return (
    <section className="analysis-section">
      <h3 className="section-title">אדמינים</h3>
      <p className="section-subtitle">
        {admins.data && admins.data.require2fa
          ? 'הרשאות אדמין פועלות רק עם אימות דו-שלבי פעיל בחשבון.'
          : 'דרישת האימות הדו-שלבי כבויה בסביבה הזו (פיתוח בלבד).'}
      </p>
      <ErrorNote>{admins.error || action.error}</ErrorNote>
      {!list ? (
        <Loading />
      ) : (
        <ul className="admin-user-list">
          {list.map((a) => (
            <li key={a.userId} className="admin-user">
              <div className="admin-user-head">
                <span className="admin-user-email" dir="ltr">
                  {a.email}
                </span>
                <span className="admin-badges">
                  {a.userId === currentUserId ? <span className="admin-badge is-accent">את/ה</span> : null}
                  <span className={`admin-badge is-${a.has2fa ? 'good' : 'warning'}`}>{a.has2fa ? '2FA פעיל' : 'ללא 2FA - לא פעיל'}</span>
                </span>
              </div>
              <p className="admin-flag-meta">
                מאז {formatWhen(a.grantedAt)} · ע״י <span dir="ltr">{a.grantedBy}</span>
              </p>
              {list.length > 1 ? (
                <div className="admin-actions">
                  <button type="button" className="admin-danger-button" disabled={action.busy} onClick={() => revoke(a)}>
                    הסרת הרשאה
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <form className="admin-search" onSubmit={grant}>
        <input className="auth-input" dir="ltr" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@example.com" aria-label="אימייל של חשבון קיים" />
        <button type="submit" className="benchmark-toggle-button active" disabled={action.busy || !email.trim()}>
          הוספת אדמין
        </button>
      </form>
    </section>
  );
}

export default AdminsTab;
