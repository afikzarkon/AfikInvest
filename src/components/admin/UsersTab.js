import React, { useCallback, useEffect, useState } from 'react';
import { blockUser, listUsers, revokeSessions, sendPasswordReset, unblockUser } from '../../adminApi';
import { ErrorNote, Loading, formatWhen, useAction } from './shared';

// Users: account status and the actions an admin may take on an account.
// Deliberately nothing from inside the portfolio - the server does not
// send it.

const PAGE = 50;
const PROVIDER_LABELS = { google: 'Google', facebook: 'Facebook' };

function Badge({ tone = 'neutral', children }) {
  return <span className={`admin-badge is-${tone}`}>{children}</span>;
}

function UserCard({ user, isSelf, onAction, busy }) {
  const confirmAnd = (text, fn) => () => window.confirm(text) && onAction(fn);
  const block = () => {
    const reason = window.prompt(`סיבת החסימה של ${user.email} (נשמרת ביומן):`, '');
    if (reason !== null) onAction(() => blockUser(user.id, reason));
  };
  return (
    <li className="admin-user">
      <div className="admin-user-head">
        <span className="admin-user-email" dir="ltr">
          {user.email}
        </span>
        <span className="admin-badges">
          {user.isAdmin ? <Badge tone="accent">אדמין</Badge> : null}
          {user.blocked ? <Badge tone="danger">חסום</Badge> : null}
          {user.deletionPending ? <Badge tone="warning">ממתין למחיקה</Badge> : null}
          <Badge tone={user.emailVerified ? 'good' : 'warning'}>{user.emailVerified ? 'מאומת' : 'לא מאומת'}</Badge>
          <Badge tone={user.has2fa ? 'good' : 'neutral'}>{user.has2fa ? '2FA פעיל' : 'ללא 2FA'}</Badge>
          {user.providers.map((p) => (
            <Badge key={p}>{PROVIDER_LABELS[p] || p}</Badge>
          ))}
        </span>
      </div>
      <p className="admin-flag-meta">
        נרשם {formatWhen(user.createdAt)} · פעילות אחרונה {user.lastSeenAt ? formatWhen(user.lastSeenAt) : '—'} · {user.activeSessions} סשנים פעילים
      </p>
      {user.blocked ? (
        <p className="admin-flag-meta">
          נחסם {formatWhen(user.blocked.at)} ע״י <span dir="ltr">{user.blocked.by}</span>
          {user.blocked.reason ? ` · ${user.blocked.reason}` : ''}
        </p>
      ) : null}
      <div className="admin-actions">
        {user.blocked ? (
          <button type="button" className="benchmark-toggle-button" disabled={busy} onClick={confirmAnd(`לבטל את החסימה של ${user.email}?`, () => unblockUser(user.id))}>
            ביטול חסימה
          </button>
        ) : !isSelf && !user.isAdmin ? (
          <button type="button" className="admin-danger-button" disabled={busy} onClick={block}>
            חסימה
          </button>
        ) : null}
        <button
          type="button"
          className="benchmark-toggle-button"
          disabled={busy || user.activeSessions === 0}
          onClick={confirmAnd(`לנתק את ${user.email} מכל המכשירים?`, () => revokeSessions(user.id))}
        >
          ניתוק מכל המכשירים
        </button>
        <button
          type="button"
          className="benchmark-toggle-button"
          disabled={busy}
          onClick={confirmAnd(`לשלוח ל-${user.email} קישור לאיפוס סיסמה? הקישור נשלח רק לכתובת שלו.`, () => sendPasswordReset(user.id))}
        >
          שליחת קישור איפוס סיסמה
        </button>
      </div>
    </li>
  );
}

function UsersTab({ currentUserId }) {
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [result, setResult] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const action = useAction();

  const load = useCallback(async (q, offset = 0) => {
    try {
      const page = await listUsers({ q, offset, limit: PAGE });
      setResult((prev) => (offset && prev ? { total: page.total, users: prev.users.concat(page.users) } : page));
      setLoadError('');
    } catch (err) {
      setLoadError(err.message);
    }
  }, []);

  useEffect(() => {
    load(submitted);
  }, [submitted, load]);

  const onAction = async (fn) => {
    setNotice('');
    if (await action.run(fn)) {
      setNotice('בוצע ונרשם ביומן.');
      await load(submitted);
    }
  };

  return (
    <section className="analysis-section">
      <h3 className="section-title">משתמשים</h3>
      <p className="section-subtitle">סטטוס חשבון בלבד. תוכן התיקים, סיסמאות וסודות האימות אינם נגישים מכאן.</p>
      <form
        className="admin-search"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(query.trim());
        }}
      >
        <input className="auth-input" dir="ltr" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="חיפוש לפי אימייל" aria-label="חיפוש לפי אימייל" />
        <button type="submit" className="benchmark-toggle-button active">
          חיפוש
        </button>
      </form>
      <ErrorNote>{loadError || action.error}</ErrorNote>
      {notice ? (
        <p className="admin-notice" role="status">
          {notice}
        </p>
      ) : null}
      {!result ? (
        <Loading />
      ) : result.users.length === 0 ? (
        <p className="history-empty-note">לא נמצאו משתמשים.</p>
      ) : (
        <>
          <p className="admin-flag-meta">
            {result.users.length} מתוך {result.total}
          </p>
          <ul className="admin-user-list">
            {result.users.map((u) => (
              <UserCard key={u.id} user={u} isSelf={u.id === currentUserId} onAction={onAction} busy={action.busy} />
            ))}
          </ul>
          {result.users.length < result.total ? (
            <button type="button" className="benchmark-toggle-button" onClick={() => load(submitted, result.users.length)}>
              טעינת עוד
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

export default UsersTab;
