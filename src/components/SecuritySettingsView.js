import React, { useState } from 'react';
import { postAuth } from '../authApi';
import PageToolbar from './PageToolbar';

// Two-factor authentication settings.
//
// Turning it on is two calls: setup returns a QR code for a new secret
// (stored as pending on the server), then the first code the app shows
// proves it was scanned and switches 2FA on. Turning it off needs the
// password and a current code.
//
// onSessionChange(user, token): enabling revokes every session, so the
// server hands this browser a fresh token; disabling only changes the user.
function SecuritySettingsView({ user, authHeader, onSessionChange }) {
  const enabled = Boolean(user && user.twoFactorEnabled);
  const [enrollment, setEnrollment] = useState(null); // { qrCodeDataUrl, secret }
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const call = async (path, body, onOk) => {
    setError('');
    setNotice('');
    setLoading(true);
    try {
      const r = await postAuth(path, body, authHeader());
      if (!r.ok) {
        setError(r.data.error || 'אירעה שגיאה, נסו שוב');
        return;
      }
      onOk(r.data);
    } catch {
      setError('לא ניתן להתחבר לשרת. נסו שוב.');
    } finally {
      setLoading(false);
    }
  };

  const startSetup = () =>
    call('/api/auth/2fa/setup', {}, (data) => {
      setEnrollment({ qrCodeDataUrl: data.qrCodeDataUrl, secret: data.secret });
      setCode('');
    });

  const confirmSetup = (e) => {
    e.preventDefault();
    call('/api/auth/2fa/enable', { code }, (data) => {
      setEnrollment(null);
      setCode('');
      onSessionChange(data.user, data.token);
      setNotice('אימות דו-שלבי הופעל. מעכשיו תתבקשו להזין קוד בכל התחברות. חיבורים פעילים במכשירים אחרים נותקו.');
    });
  };

  const disable = (e) => {
    e.preventDefault();
    call('/api/auth/2fa/disable', { password, code }, (data) => {
      setPassword('');
      setCode('');
      onSessionChange(data.user, '');
      setNotice('אימות דו-שלבי כובה.');
    });
  };

  const codeInput = (
    <label className="auth-label">
      קוד מהאפליקציה
      <input
        className="auth-input auth-code-input"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        value={code}
        onChange={(ev) => setCode(ev.target.value.replace(/\D/g, '').slice(0, 6))}
        required
      />
    </label>
  );

  let content;
  if (enabled) {
    content = (
      <form className="auth-form" onSubmit={disable}>
        <p className="auth-step-text">
          כדי לכבות אימות דו-שלבי הזינו את הסיסמה וקוד נוכחי מהאפליקציה. כיבוי מחליש את הגנת החשבון.
        </p>
        <label className="auth-label">
          סיסמה
          <input
            className="auth-input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(ev) => setPassword(ev.target.value)}
            required
            maxLength={128}
          />
        </label>
        {codeInput}
        <button type="submit" className="auth-submit auth-submit-danger" disabled={loading || code.length !== 6}>
          {loading ? 'מעבד…' : 'כיבוי אימות דו-שלבי'}
        </button>
      </form>
    );
  } else if (enrollment) {
    content = (
      <form className="auth-form" onSubmit={confirmSetup}>
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
        <button type="submit" className="auth-submit" disabled={loading || code.length !== 6}>
          {loading ? 'מאמת…' : 'אימות והפעלה'}
        </button>
        <button type="button" className="auth-link" onClick={() => setEnrollment(null)}>
          ביטול
        </button>
      </form>
    );
  } else {
    content = (
      <div className="auth-form">
        <p className="auth-step-text">
          אימות דו-שלבי מוסיף לסיסמה קוד חד-פעמי מאפליקציה בטלפון, כך שסיסמה שדלפה לא מספיקה כדי להיכנס לחשבון.
        </p>
        <button type="button" className="auth-submit" onClick={startSetup} disabled={loading}>
          {loading ? 'מכין…' : 'הפעלת אימות דו-שלבי'}
        </button>
      </div>
    );
  }

  return (
    <div className="security-page">
      <PageToolbar title="אבטחת החשבון" subtitle={user ? user.email : ''} sticky={false} />
      <section className="security-card" aria-label="אימות דו-שלבי">
        <div className="security-card-head">
          <h2 className="security-card-title">אימות דו-שלבי (2FA)</h2>
          <span className={`security-badge ${enabled ? 'is-on' : 'is-off'}`}>{enabled ? 'פעיל' : 'כבוי'}</span>
        </div>
        {notice ? (
          <div className="auth-notice" role="status">
            {notice}
          </div>
        ) : null}
        {error ? (
          <div className="auth-error" role="alert">
            {error}
          </div>
        ) : null}
        {content}
      </section>
    </div>
  );
}

export default SecuritySettingsView;
