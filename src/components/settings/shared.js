import React, { useId } from 'react';

// The pieces every settings section is built from, so the sections share
// one look: a card per topic, a labelled field, an on/off switch.

export function SettingsCard({ title, description, badge, children, tone }) {
  const id = useId();
  return (
    <section className={`settings-card ${tone === 'danger' ? 'is-danger' : ''}`} aria-labelledby={`${id}-t`}>
      <div className="settings-card-head">
        <h3 id={`${id}-t`} className="settings-card-title">
          {title}
        </h3>
        {badge}
      </div>
      {description ? <p className="settings-card-desc">{description}</p> : null}
      {children}
    </section>
  );
}

// A text-like input with its label, an optional hint, and its error tied
// to it for screen readers.
export function Field({ label, hint, error, children, optional = false }) {
  const id = useId();
  const child = React.Children.only(children);
  const describedBy = [hint ? `${id}-h` : '', error ? `${id}-e` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="auth-field">
      <label className="auth-label" htmlFor={id}>
        {label}
        {optional ? <span className="auth-hint"> (לא חובה)</span> : null}
      </label>
      {React.cloneElement(child, {
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? 'true' : undefined,
        className: `${child.props.className || 'auth-input'} ${error ? 'has-error' : ''}`
      })}
      {hint ? (
        <span id={`${id}-h`} className="auth-hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${id}-e`} className="field-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

// An accessible on/off switch (role="switch"), with its label beside it.
export function Switch({ checked, onChange, label, description, disabled = false }) {
  const id = useId();
  return (
    <div className="switch-row">
      <div className="switch-text">
        <span id={`${id}-l`} className="switch-label">
          {label}
        </span>
        {description ? (
          <span id={`${id}-d`} className="switch-desc">
            {description}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={Boolean(checked)}
        aria-labelledby={`${id}-l`}
        aria-describedby={description ? `${id}-d` : undefined}
        className={`switch ${checked ? 'is-on' : ''}`}
        onClick={() => onChange(!checked)}
        disabled={disabled}
      >
        <span className="switch-thumb" aria-hidden="true" />
      </button>
    </div>
  );
}

export function StatusBadge({ on, onText = 'פעיל', offText = 'כבוי' }) {
  return <span className={`security-badge ${on ? 'is-on' : 'is-off'}`}>{on ? onText : offText}</span>;
}

export function formatDateTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('he-IL', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return String(iso);
  }
}

// "לפני 5 דקות" - for "last active".
export function timeAgo(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const minutes = Math.round((Date.now() - t) / 60000);
  if (minutes < 2) return 'עכשיו';
  if (minutes < 60) return `לפני ${minutes} דקות`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? 'לפני שעה' : `לפני ${hours} שעות`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'אתמול' : `לפני ${days} ימים`;
}
