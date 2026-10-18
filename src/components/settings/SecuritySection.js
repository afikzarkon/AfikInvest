import React, { useCallback, useEffect, useState } from 'react';
import { apiUrl, getApiBase } from '../../apiBase';
import { getAccount, postAccount, deleteAccount, authHeaders } from '../../accountApi';
import { postAuth } from '../../authApi';
import { setAuthToken } from '../../authToken';
import { useToast } from '../ui/Toast';
import PasswordField from '../ui/PasswordField';
import { SettingsCard, Field, StatusBadge, formatDateTime, timeAgo } from './shared';

// Account and security: the email address, the password, 2FA and its
// backup codes, the devices signed in, linked Google/Facebook accounts and
// the security log.
//
// Sensitive changes re-authenticate: the current password, or - for an
// account that has none (opened through Google/Facebook) - a sign-in from
// the last few minutes; the server says which is missing (`reauth`).

const METHOD_LABELS = {
  password: 'סיסמה',
  google: 'Google',
  facebook: 'Facebook',
  magic_link: 'קישור במייל',
  email_verification: 'אימות מייל',
  two_factor_setup: 'הפעלת אימות דו-שלבי',
  password_change: 'שינוי סיסמה',
  password_set: 'הגדרת סיסמה'
};

const EVENT_LABELS = {
  signup: 'פתיחת החשבון',
  login: 'כניסה',
  login_failed: 'ניסיון כניסה שנכשל',
  logout: 'יציאה',
  email_verified: 'אימות כתובת האימייל',
  two_factor_enabled: 'הפעלת אימות דו-שלבי',
  two_factor_disabled: 'כיבוי אימות דו-שלבי',
  two_factor_failed: 'קוד אימות שגוי',
  backup_code_used: 'כניסה עם קוד גיבוי',
  backup_codes_regenerated: 'יצירת קודי גיבוי חדשים',
  password_changed: 'שינוי סיסמה',
  password_set: 'הגדרת סיסמה',
  password_reset: 'איפוס סיסמה',
  email_change_requested: 'בקשה לשינוי כתובת אימייל',
  email_changed: 'שינוי כתובת אימייל',
  email_change_cancelled: 'ביטול שינוי כתובת',
  session_revoked: 'ניתוק מכשיר',
  other_sessions_revoked: 'ניתוק כל שאר המכשירים',
  provider_linked: 'חיבור חשבון חיצוני',
  provider_unlinked: 'ניתוק חשבון חיצוני',
  provider_data_deleted: 'מחיקת מידע מ-Facebook',
  data_exported: 'ייצוא נתונים',
  account_deletion_requested: 'בקשה למחיקת החשבון',
  account_restored: 'שחזור החשבון'
};
const PROVIDER_NAMES = { google: 'Google', facebook: 'Facebook' };

// What to do when the server asks for a fresh sign-in.
function ReauthHint({ reauth, onLogout }) {
  if (reauth !== 'fresh_login') return null;
  return (
    <div className="auth-notice" role="status">
      לחשבון אין סיסמה, ולכן לאישור הפעולה צריך להתחבר מחדש (למשל עם Google), ואז לחזור לכאן תוך כמה דקות.{' '}
      <button type="button" className="auth-link auth-link-inline" onClick={onLogout}>
        יציאה והתחברות מחדש
      </button>
    </div>
  );
}

function EmailCard({ user, onLogout }) {
  const toast = useToast();
  const [newEmail, setNewEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState({});
  const [reauth, setReauth] = useState('');
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setReauth('');
    const r = await postAccount('/api/account/email', { newEmail: newEmail.trim(), currentPassword: password });
    setBusy(false);
    if (!r.ok) {
      setErrors(r.data.fieldErrors || {});
      setReauth(r.data.reauth || '');
      toast.error(r.data.error || 'הבקשה נכשלה');
      return;
    }
    setSentTo(newEmail.trim());
    setNewEmail('');
    setPassword('');
    toast.success('נשלח קישור אישור לכתובת החדשה');
  };

  return (
    <SettingsCard
      title="כתובת אימייל"
      description="הכתובת משמשת לכניסה ולהודעות אבטחה. כתובת חדשה תתעדכן רק אחרי שתאשרו אותה מהמייל שיישלח אליה, והכתובת הנוכחית תקבל הודעה עם אפשרות לבטל."
      badge={<StatusBadge on={user.emailVerified} onText="מאומתת" offText="לא מאומתת" />}
    >
      <p className="settings-current" dir="ltr">
        {user.email}
      </p>
      {sentTo ? (
        <div className="auth-notice" role="status">
          שלחנו קישור אישור ל-<bdi>{sentTo}</bdi>. הכתובת תתעדכן אחרי האישור (הקישור תקף ל-24 שעות).
        </div>
      ) : null}
      <form className="settings-form" onSubmit={submit} noValidate>
        <Field label="כתובת חדשה" error={errors.newEmail}>
          <input type="email" dir="ltr" autoComplete="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} maxLength={254} required />
        </Field>
        {user.hasPassword ? <PasswordField label="הסיסמה הנוכחית (לאישור)" value={password} onChange={setPassword} error={errors.currentPassword} /> : null}
        <ReauthHint reauth={reauth} onLogout={onLogout} />
        <div className="settings-actions">
          <button type="submit" className="auth-submit" disabled={busy || !newEmail.trim()}>
            {busy ? 'שולח…' : 'שליחת קישור אישור'}
          </button>
        </div>
      </form>
    </SettingsCard>
  );
}

function PasswordCard({ user, onSessionChange, onLogout }) {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [errors, setErrors] = useState({});
  const [reauth, setReauth] = useState('');
  const [busy, setBusy] = useState(false);
  const setting = !user.hasPassword;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setReauth('');
    const r = await postAccount('/api/account/password', { currentPassword: current, newPassword: next });
    setBusy(false);
    if (!r.ok) {
      setErrors(r.data.fieldErrors || {});
      setReauth(r.data.reauth || '');
      toast.error(r.data.error || 'השינוי נכשל');
      return;
    }
    setCurrent('');
    setNext('');
    if (r.data.token) setAuthToken(r.data.token);
    onSessionChange(r.data.user, r.data.token);
    toast.success(setting ? 'הסיסמה הוגדרה. כל שאר המכשירים נותקו.' : 'הסיסמה שונתה. כל שאר המכשירים נותקו.');
  };

  return (
    <SettingsCard
      title={setting ? 'הגדרת סיסמה' : 'שינוי סיסמה'}
      description={
        setting
          ? 'נכנסתם דרך Google/Facebook או קישור במייל. אפשר להגדיר סיסמה כדי להיכנס גם איתה.'
          : 'סיסמה חדשה מנתקת את כל שאר המכשירים. סיסמאות שהופיעו בדליפות מידע ידועות נחסמות.'
      }
    >
      <form className="settings-form" onSubmit={submit} noValidate>
        {!setting ? <PasswordField label="הסיסמה הנוכחית" value={current} onChange={setCurrent} error={errors.currentPassword} /> : null}
        <PasswordField label={setting ? 'סיסמה' : 'סיסמה חדשה'} value={next} onChange={setNext} autoComplete="new-password" showStrength error={errors.newPassword} />
        <ReauthHint reauth={reauth} onLogout={onLogout} />
        <div className="settings-actions">
          <button type="submit" className="auth-submit" disabled={busy || next.length < 8 || (!setting && !current)}>
            {busy ? 'שומר…' : setting ? 'הגדרת סיסמה' : 'שינוי סיסמה'}
          </button>
        </div>
      </form>
    </SettingsCard>
  );
}

// The codes, shown once: copy or save them now.
function BackupCodes({ codes, onDone }) {
  const toast = useToast();
  const text = codes.join('\n');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('הקודים הועתקו');
    } catch {
      toast.error('ההעתקה נכשלה - העתיקו ידנית');
    }
  };
  const download = () => {
    const blob = new Blob([`AfikInvest - קודי גיבוי לאימות דו-שלבי\n\n${text}\n\nכל קוד עובד פעם אחת.\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'afikinvest-backup-codes.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="backup-codes" role="region" aria-label="קודי גיבוי">
      <p className="auth-step-text">
        <strong>שמרו את הקודים האלה במקום בטוח.</strong> אם תאבדו גישה לאפליקציית האימות, כל קוד יאפשר כניסה אחת. הם מוצגים רק עכשיו.
      </p>
      <ul className="backup-codes-list" dir="ltr">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ul>
      <div className="settings-actions">
        <button type="button" className="settings-button" onClick={copy}>
          העתקה
        </button>
        <button type="button" className="settings-button" onClick={download}>
          הורדה כקובץ
        </button>
        <button type="button" className="auth-submit" onClick={onDone}>
          שמרתי אותם
        </button>
      </div>
    </div>
  );
}

function TwoFactorCard({ user, security, onSessionChange, onLogout, onChanged }) {
  const toast = useToast();
  const enabled = Boolean(user.twoFactorEnabled);
  const [enrollment, setEnrollment] = useState(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reauth, setReauth] = useState('');
  const [codes, setCodes] = useState(null);
  const [mode, setMode] = useState(''); // '' | 'disable' | 'regenerate'

  const call = async (path, body) => {
    setBusy(true);
    setError('');
    setReauth('');
    const r = await postAuth(path, body, authHeaders());
    setBusy(false);
    if (!r.ok) {
      setError(r.data.error || 'אירעה שגיאה, נסו שוב');
      setReauth(r.data.reauth || '');
    }
    return r;
  };

  const startSetup = async () => {
    const r = await call('/api/auth/2fa/setup', {});
    if (r.ok) {
      setEnrollment(r.data);
      setCode('');
    }
  };

  const confirmSetup = async (e) => {
    e.preventDefault();
    const r = await call('/api/auth/2fa/enable', { code });
    if (!r.ok) return;
    setEnrollment(null);
    setCode('');
    if (r.data.token) setAuthToken(r.data.token);
    onSessionChange(r.data.user, r.data.token);
    setCodes(r.data.backupCodes || []);
    toast.success('אימות דו-שלבי הופעל. מכשירים אחרים נותקו.');
    onChanged();
  };

  const submitDisableOrRegenerate = async (e) => {
    e.preventDefault();
    const path = mode === 'disable' ? '/api/auth/2fa/disable' : '/api/auth/2fa/backup-codes';
    const r = await call(path, { password, code });
    if (!r.ok) return;
    setPassword('');
    setCode('');
    setMode('');
    if (mode === 'disable') {
      onSessionChange(r.data.user, '');
      toast.success('אימות דו-שלבי כובה');
    } else {
      setCodes(r.data.backupCodes || []);
      toast.success('נוצרו קודי גיבוי חדשים; הקודים הקודמים כבר לא עובדים');
    }
    onChanged();
  };

  const codeInput = (
    <Field label={mode ? 'קוד מהאפליקציה או קוד גיבוי' : 'קוד מהאפליקציה'}>
      <input
        type="text"
        dir="ltr"
        className="auth-input auth-code-input"
        inputMode={mode ? 'text' : 'numeric'}
        autoComplete="one-time-code"
        maxLength={mode ? 11 : 6}
        value={code}
        onChange={(ev) => setCode(mode ? ev.target.value.slice(0, 11) : ev.target.value.replace(/\D/g, '').slice(0, 6))}
        required
      />
    </Field>
  );

  let content;
  if (codes) {
    content = <BackupCodes codes={codes} onDone={() => setCodes(null)} />;
  } else if (enrollment) {
    content = (
      <form className="settings-form" onSubmit={confirmSetup} noValidate>
        <ol className="security-steps">
          <li>פתחו אפליקציית אימות (Google Authenticator, Microsoft Authenticator, 1Password וכדומה).</li>
          <li>סרקו את הקוד, או הזינו את המפתח ידנית.</li>
          <li>הזינו את הקוד בן 6 הספרות שהאפליקציה מציגה.</li>
        </ol>
        <img className="security-qr" src={enrollment.qrCodeDataUrl} alt="קוד QR להגדרת אפליקציית האימות" width={220} height={220} />
        <div className="security-secret">
          <span className="auth-hint">מפתח להזנה ידנית:</span>
          <code dir="ltr">{enrollment.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
        </div>
        {codeInput}
        {error ? (
          <div className="auth-error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="settings-actions">
          <button type="submit" className="auth-submit" disabled={busy || code.length !== 6}>
            {busy ? 'מאמת…' : 'אימות והפעלה'}
          </button>
          <button type="button" className="auth-link" onClick={() => setEnrollment(null)}>
            ביטול
          </button>
        </div>
      </form>
    );
  } else if (enabled && mode) {
    content = (
      <form className="settings-form" onSubmit={submitDisableOrRegenerate} noValidate>
        <p className="auth-step-text">
          {mode === 'disable' ? 'כיבוי מחליש את הגנת החשבון. לאישור:' : 'קודי גיבוי חדשים מחליפים את הקודמים. לאישור:'}
        </p>
        {user.hasPassword ? <PasswordField label="סיסמה" value={password} onChange={setPassword} /> : null}
        {codeInput}
        <ReauthHint reauth={reauth} onLogout={onLogout} />
        {error && reauth !== 'fresh_login' ? (
          <div className="auth-error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="settings-actions">
          <button type="submit" className={`auth-submit ${mode === 'disable' ? 'auth-submit-danger' : ''}`} disabled={busy || !code}>
            {busy ? 'מעבד…' : mode === 'disable' ? 'כיבוי אימות דו-שלבי' : 'יצירת קודים חדשים'}
          </button>
          <button type="button" className="auth-link" onClick={() => setMode('')}>
            ביטול
          </button>
        </div>
      </form>
    );
  } else if (enabled) {
    content = (
      <div className="settings-form">
        <p className="auth-step-text">
          בכל כניסה תתבקשו לקוד מהאפליקציה. נותרו <strong>{security.backupCodesLeft}</strong> קודי גיבוי.
          {security.backupCodesLeft <= 3 ? ' מומלץ ליצור קודים חדשים.' : ''}
        </p>
        <div className="settings-actions">
          <button type="button" className="settings-button" onClick={() => setMode('regenerate')}>
            קודי גיבוי חדשים
          </button>
          <button type="button" className="settings-button is-danger" onClick={() => setMode('disable')}>
            כיבוי
          </button>
        </div>
      </div>
    );
  } else {
    content = (
      <div className="settings-form">
        <p className="auth-step-text">אימות דו-שלבי מוסיף לסיסמה קוד חד-פעמי מאפליקציה בטלפון, כך שסיסמה שדלפה לא מספיקה כדי להיכנס לחשבון.</p>
        {error ? (
          <div className="auth-error" role="alert">
            {error}
          </div>
        ) : null}
        <button type="button" className="auth-submit" onClick={startSetup} disabled={busy}>
          {busy ? 'מכין…' : 'הפעלת אימות דו-שלבי'}
        </button>
      </div>
    );
  }

  return (
    <SettingsCard title="אימות דו-שלבי (2FA)" badge={<StatusBadge on={enabled} />}>
      {content}
    </SettingsCard>
  );
}

function SessionsCard({ onSessionChange, onLogout }) {
  const toast = useToast();
  const [sessions, setSessions] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await getAccount('/api/account/sessions');
    if (r.ok) setSessions(r.data.sessions);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const revoke = async (s) => {
    setBusy(true);
    const r = await deleteAccount(`/api/account/sessions/${encodeURIComponent(s.id)}`);
    setBusy(false);
    if (!r.ok) {
      toast.error(r.data.error || 'הניתוק נכשל');
      return;
    }
    if (r.data.signedOut) {
      onLogout();
      return;
    }
    toast.success('המכשיר נותק');
    load();
  };

  const revokeOthers = async () => {
    setBusy(true);
    const r = await postAccount('/api/account/sessions/revoke-others');
    setBusy(false);
    if (!r.ok) {
      toast.error(r.data.error || 'הניתוק נכשל');
      return;
    }
    if (r.data.token) setAuthToken(r.data.token);
    onSessionChange(null, r.data.token);
    toast.success('כל שאר המכשירים נותקו');
    load();
  };

  return (
    <SettingsCard title="מכשירים מחוברים" description="המכשירים והדפדפנים שמחוברים כרגע לחשבון. לא מזהים מכשיר? נתקו אותו והחליפו סיסמה.">
      {!sessions ? (
        <p className="auth-hint" role="status">
          טוען…
        </p>
      ) : (
        <ul className="session-list">
          {sessions.map((s) => (
            <li key={s.id} className="session-item">
              <div className="session-main">
                <span className="session-device">
                  {s.browser} · {s.os}
                  {s.current ? <span className="security-badge is-on">המכשיר הזה</span> : null}
                </span>
                <span className="auth-hint">
                  פעילות אחרונה: {timeAgo(s.lastSeenAt)} · כניסה ב-{formatDateTime(s.createdAt)} · {METHOD_LABELS[s.method] || s.method}
                  {s.country ? ` · ${s.country}` : ''}
                  {s.ipPrefix ? <bdi dir="ltr"> · {s.ipPrefix}</bdi> : null}
                </span>
              </div>
              <button type="button" className="settings-button is-quiet" onClick={() => revoke(s)} disabled={busy}>
                {s.current ? 'יציאה' : 'ניתוק'}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="settings-actions">
        <button type="button" className="settings-button is-danger" onClick={revokeOthers} disabled={busy}>
          ניתוק מכל שאר המכשירים
        </button>
      </div>
    </SettingsCard>
  );
}

function ConnectedAccountsCard({ account, onChanged }) {
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const [oauthBase, setOauthBase] = useState('');
  useEffect(() => {
    fetch(apiUrl('/api/auth/options'))
      .then((r) => r.json())
      .then((d) => setOauthBase(d.oauthBaseUrl || ''))
      .catch(() => {});
  }, []);

  const linked = account.providers || [];
  const available = account.availableProviders || [];
  const ways = linked.length + (account.user.hasPassword ? 1 : 0);
  const all = [...new Set([...available, ...linked.map((p) => p.provider)])];

  const connect = async (provider) => {
    setBusy(provider);
    const r = await postAccount(`/api/account/providers/${provider}/link`);
    if (!r.ok) {
      setBusy('');
      toast.error(r.data.error || 'החיבור נכשל');
      return;
    }
    window.location.assign(`${oauthBase || getApiBase()}${r.data.url}`);
  };

  const disconnect = async (provider) => {
    setBusy(provider);
    const r = await deleteAccount(`/api/account/providers/${provider}`);
    setBusy('');
    if (!r.ok) {
      toast.error(r.data.error || 'הניתוק נכשל');
      return;
    }
    toast.success(`${PROVIDER_NAMES[provider]} נותק`);
    onChanged();
  };

  if (!all.length) return null;
  return (
    <SettingsCard title="חשבונות מחוברים" description="היכנסו עם Google או Facebook בלי סיסמה. אי אפשר לנתק את דרך הכניסה האחרונה לחשבון.">
      <ul className="session-list">
        {all.map((provider) => {
          const link = linked.find((p) => p.provider === provider);
          const last = link && ways <= 1;
          return (
            <li key={provider} className="session-item">
              <div className="session-main">
                <span className="session-device">{PROVIDER_NAMES[provider] || provider}</span>
                <span className="auth-hint">{link ? `מחובר${link.email ? ` (${link.email})` : ''}` : 'לא מחובר'}</span>
              </div>
              {link ? (
                <button
                  type="button"
                  className="settings-button is-quiet"
                  onClick={() => disconnect(provider)}
                  disabled={Boolean(busy) || last}
                  title={last ? 'זו דרך הכניסה היחידה. הגדירו סיסמה לפני הניתוק.' : undefined}
                >
                  ניתוק
                </button>
              ) : available.includes(provider) ? (
                <button type="button" className="settings-button" onClick={() => connect(provider)} disabled={Boolean(busy)}>
                  חיבור
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </SettingsCard>
  );
}

function SecurityLogCard() {
  const [events, setEvents] = useState(null);
  useEffect(() => {
    getAccount('/api/account/events').then((r) => r.ok && setEvents(r.data.events));
  }, []);
  return (
    <SettingsCard title="היסטוריית התחברויות ופעולות רגישות" description="100 הפעולות האחרונות בחשבון. כתובות ה-IP נשמרות בקיצור, בלי החלק האחרון.">
      {!events ? (
        <p className="auth-hint" role="status">
          טוען…
        </p>
      ) : !events.length ? (
        <p className="auth-hint">אין עדיין פעולות.</p>
      ) : (
        <ul className="event-list">
          {events.map((e) => (
            <li key={e.id} className={`event-item ${/failed/.test(e.type) ? 'is-warning' : ''}`}>
              <span className="event-type">
                {EVENT_LABELS[e.type] || e.type}
                {e.meta && e.meta.method ? ` · ${METHOD_LABELS[e.meta.method] || e.meta.method}` : ''}
                {e.meta && e.meta.provider ? ` · ${PROVIDER_NAMES[e.meta.provider] || e.meta.provider}` : ''}
              </span>
              <span className="auth-hint">
                {formatDateTime(e.createdAt)} · {e.browser} · {e.os}
                {e.ipPrefix ? <bdi dir="ltr"> · {e.ipPrefix}</bdi> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}

function SecuritySection({ account, onSessionChange, onLogout, onChanged, linkMessage }) {
  const user = account.user;
  return (
    <>
      {linkMessage ? (
        <div className={linkMessage.error ? 'auth-error' : 'auth-notice'} role="status">
          {linkMessage.text}
        </div>
      ) : null}
      <EmailCard user={user} onLogout={onLogout} />
      <PasswordCard user={user} onSessionChange={onSessionChange} onLogout={onLogout} />
      <TwoFactorCard user={user} security={account.security} onSessionChange={onSessionChange} onLogout={onLogout} onChanged={onChanged} />
      <SessionsCard onSessionChange={onSessionChange} onLogout={onLogout} />
      <ConnectedAccountsCard account={account} onChanged={onChanged} />
      <SecurityLogCard />
    </>
  );
}

export default SecuritySection;
