import React, { useState } from 'react';
import { getApiBase } from '../apiBase';
import { postAuth } from '../authApi';
import { setAuthToken } from '../authToken';

function vercelMissingApiHint() {
  if (typeof window === 'undefined') return '';
  const host = window.location.hostname || '';
  const noBase = !getApiBase();
  if (noBase && (host.endsWith('vercel.app') || host.includes('vercel')))
    return ' חסרה כתובת השרת: ב-Vercel הוסף משתנה REACT_APP_API_URL (כתובת ה-API) ועשה Redeploy.';
  return '';
}

const NETWORK_ERROR = () =>
  'לא ניתן להתחבר לשרת. בפיתוח מקומי ודא שהשרת רץ על פורט 5000.' + vercelMissingApiHint();

const NO_API_ERROR =
  'לא נמצא שרת API בכתובת הזו. אם האתר על Vercel, הגדר REACT_APP_API_URL בפרויקט והרץ Deploy מחדש.';

// Screens: 'register' and 'login' (the two tabs), 'twoFactor' (the code
// step after a correct password on a 2FA account) and 'forgot'.
function AuthView({ onAuthenticated, initialMode = 'register', initialNotice = '' }) {
  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challengeToken, setChallengeToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(initialNotice);

  const switchMode = (next) => {
    setMode(next);
    setError('');
    setNotice('');
    setCode('');
    if (next !== 'twoFactor') setChallengeToken('');
  };

  const finish = (data) => {
    if (data.user) {
      if (data.token) setAuthToken(data.token);
      onAuthenticated(data.user, data.token || '');
    } else {
      setError('תגובת שרת לא תקינה. נסה שוב או בדוק הגדרות API.' + vercelMissingApiHint());
    }
  };

  // Runs one request with the shared loading/error handling; `onOk` gets
  // the parsed body of a 2xx reply.
  const run = async (path, body, onOk) => {
    setError('');
    setLoading(true);
    try {
      const r = await postAuth(path, body);
      if (!r.ok) {
        if (r.status === 404 && !r.isJson) {
          setError(NO_API_ERROR);
          return;
        }
        if (r.data.restart) {
          switchMode('login');
        }
        setError(r.data.error || 'אירעה שגיאה, נסה שוב');
        return;
      }
      onOk(r.data);
    } catch {
      setError(NETWORK_ERROR());
    } finally {
      setLoading(false);
    }
  };

  const submitCredentials = (e) => {
    e.preventDefault();
    const path = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
    run(path, { email, password }, (data) => {
      if (data.twoFactorRequired) {
        setChallengeToken(data.challengeToken);
        setPassword('');
        setMode('twoFactor');
        return;
      }
      finish(data);
    });
  };

  const submitCode = (e) => {
    e.preventDefault();
    run('/api/auth/login/2fa', { challengeToken, code }, finish);
  };

  const submitForgot = (e) => {
    e.preventDefault();
    run('/api/auth/forgot-password', { email }, (data) => {
      setNotice(data.message || 'אם הכתובת רשומה במערכת, נשלח אליה קישור לאיפוס הסיסמה');
    });
  };

  const errorBox = error ? (
    <div className="auth-error" role="alert">
      {error}
    </div>
  ) : null;
  const noticeBox = notice ? (
    <div className="auth-notice" role="status">
      {notice}
    </div>
  ) : null;

  const emailField = (
    <label className="auth-label">
      אימייל
      <input
        className="auth-input"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(ev) => setEmail(ev.target.value)}
        required
        maxLength={254}
      />
    </label>
  );

  let body;
  if (mode === 'twoFactor') {
    body = (
      <form className="auth-form" onSubmit={submitCode}>
        <p className="auth-step-text">הזינו את הקוד בן 6 הספרות מאפליקציית האימות (Google Authenticator וכדומה).</p>
        <label className="auth-label">
          קוד אימות
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
            autoFocus
          />
        </label>
        {errorBox}
        <button type="submit" className="auth-submit" disabled={loading || code.length !== 6}>
          {loading ? 'מאמת…' : 'אימות והתחברות'}
        </button>
        <button type="button" className="auth-link" onClick={() => switchMode('login')}>
          חזרה להתחברות
        </button>
      </form>
    );
  } else if (mode === 'forgot') {
    body = (
      <form className="auth-form" onSubmit={submitForgot}>
        <p className="auth-step-text">הזינו את כתובת האימייל של החשבון ונשלח קישור לבחירת סיסמה חדשה.</p>
        {emailField}
        {errorBox}
        {noticeBox}
        <button type="submit" className="auth-submit" disabled={loading}>
          {loading ? 'שולח…' : 'שליחת קישור איפוס'}
        </button>
        <button type="button" className="auth-link" onClick={() => switchMode('login')}>
          חזרה להתחברות
        </button>
      </form>
    );
  } else {
    body = (
      <>
        <div className="auth-tabs">
          <button
            type="button"
            className={`auth-tab ${mode === 'register' ? 'active' : ''}`}
            onClick={() => switchMode('register')}
          >
            הרשמה
          </button>
          <button
            type="button"
            className={`auth-tab ${mode === 'login' ? 'active' : ''}`}
            onClick={() => switchMode('login')}
          >
            התחברות
          </button>
        </div>

        <form className="auth-form" onSubmit={submitCredentials}>
          {emailField}
          <label className="auth-label">
            סיסמה {mode === 'register' && <span className="auth-hint">(מינ׳ 8 תווים)</span>}
            <input
              className="auth-input"
              type="password"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(ev) => setPassword(ev.target.value)}
              required
              minLength={mode === 'register' ? 8 : undefined}
              maxLength={128}
            />
          </label>

          {noticeBox}
          {errorBox}

          <button type="submit" className="auth-submit" disabled={loading}>
            {loading ? 'מעבד…' : mode === 'register' ? 'צור חשבון' : 'התחבר'}
          </button>
          {mode === 'login' && (
            <button type="button" className="auth-link" onClick={() => switchMode('forgot')}>
              שכחתי סיסמה
            </button>
          )}
        </form>
      </>
    );
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1 className="auth-title">StockView</h1>
        <p className="auth-subtitle">
          {mode === 'twoFactor'
            ? 'אימות דו-שלבי'
            : mode === 'forgot'
              ? 'איפוס סיסמה'
              : 'ניהול תיק השקעות — היכנסו או הירשמו'}
        </p>
        {body}
      </div>
    </div>
  );
}

export default AuthView;
