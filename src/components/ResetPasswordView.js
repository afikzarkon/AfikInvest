import React, { useEffect, useState } from 'react';
import { postAuth } from '../authApi';

// The page a reset email links to (/reset-password?token=...). App.js reads
// the token out of the URL and strips it from the address bar before this
// renders, so it is not left in history or sent on as a Referer.
//
// onDone(notice): back to the login screen, optionally with a message.
function ResetPasswordView({ token, onDone }) {
  const [status, setStatus] = useState('checking'); // checking | ready | invalid
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setStatus('invalid');
      return undefined;
    }
    postAuth('/api/auth/reset-password/verify', { token })
      .then((r) => {
        if (!cancelled) setStatus(r.ok && r.data.valid ? 'ready' : 'invalid');
      })
      .catch(() => {
        if (!cancelled) setStatus('invalid');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('הסיסמאות אינן תואמות');
      return;
    }
    setLoading(true);
    try {
      const r = await postAuth('/api/auth/reset-password', { token, password });
      if (!r.ok) {
        setError(r.data.error || 'אירעה שגיאה, נסו שוב');
        return;
      }
      onDone('הסיסמה עודכנה. אפשר להתחבר עם הסיסמה החדשה.');
    } catch {
      setError('לא ניתן להתחבר לשרת. נסו שוב.');
    } finally {
      setLoading(false);
    }
  };

  let body;
  if (status === 'checking') {
    body = <p className="auth-step-text">בודק את הקישור…</p>;
  } else if (status === 'invalid') {
    body = (
      <div className="auth-form">
        <div className="auth-error" role="alert">
          קישור האיפוס אינו תקין, פג תוקפו או שכבר נוצל. אפשר לבקש קישור חדש ממסך ההתחברות.
        </div>
        <button type="button" className="auth-submit" onClick={() => onDone('')}>
          למסך ההתחברות
        </button>
      </div>
    );
  } else {
    body = (
      <form className="auth-form" onSubmit={submit}>
        <label className="auth-label">
          סיסמה חדשה <span className="auth-hint">(מינ׳ 8 תווים)</span>
          <input
            className="auth-input"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(ev) => setPassword(ev.target.value)}
            required
            minLength={8}
            maxLength={128}
            autoFocus
          />
        </label>
        <label className="auth-label">
          אימות סיסמה
          <input
            className="auth-input"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(ev) => setConfirm(ev.target.value)}
            required
            minLength={8}
            maxLength={128}
          />
        </label>
        {error ? (
          <div className="auth-error" role="alert">
            {error}
          </div>
        ) : null}
        <button type="submit" className="auth-submit" disabled={loading}>
          {loading ? 'שומר…' : 'שמירת סיסמה חדשה'}
        </button>
        <button type="button" className="auth-link" onClick={() => onDone('')}>
          ביטול
        </button>
      </form>
    );
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1 className="auth-title">StockView</h1>
        <p className="auth-subtitle">בחירת סיסמה חדשה</p>
        {body}
      </div>
    </div>
  );
}

export default ResetPasswordView;
