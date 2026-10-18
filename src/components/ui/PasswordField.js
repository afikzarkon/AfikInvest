import React, { useId, useState } from 'react';
import { passwordStrength } from '../../utils/passwordStrength';

// A password input with a show/hide button and, for a new password, a
// strength meter with a hint or two. error: the field's message, linked to
// the input for screen readers.
function PasswordField({ label, value, onChange, autoComplete = 'current-password', showStrength = false, error = '', required = true, name, onBlur, autoFocus = false }) {
  const [visible, setVisible] = useState(false);
  const id = useId();
  const errorId = `${id}-error`;
  const strengthId = `${id}-strength`;
  const strength = showStrength ? passwordStrength(value) : null;
  const describedBy = [error ? errorId : '', strength && value ? strengthId : ''].filter(Boolean).join(' ') || undefined;

  return (
    <div className="auth-field">
      <label className="auth-label" htmlFor={id}>
        {label}
      </label>
      <div className="password-wrap">
        <input
          id={id}
          name={name}
          className={`auth-input password-input ${error ? 'has-error' : ''}`}
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          required={required}
          maxLength={128}
          dir="ltr"
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={describedBy}
          autoFocus={autoFocus}
        />
        <button type="button" className="password-toggle" onClick={() => setVisible((v) => !v)} aria-label={visible ? 'הסתרת הסיסמה' : 'הצגת הסיסמה'} aria-pressed={visible}>
          {visible ? 'הסתר' : 'הצג'}
        </button>
      </div>
      {strength && value ? (
        <div id={strengthId} className="password-strength" aria-live="polite">
          <div className="password-meter" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className={`password-meter-bar ${i < Math.max(1, strength.score) ? `level-${strength.score}` : ''}`} />
            ))}
          </div>
          <span className="password-strength-label">
            חוזק הסיסמה: {strength.label}
            {strength.hints.length ? ` · ${strength.hints.join(' · ')}` : ''}
          </span>
        </div>
      ) : null}
      {error ? (
        <span id={errorId} className="field-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export default PasswordField;
