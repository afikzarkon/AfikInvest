import React from 'react';

// The user's picture, or - without one - a circle with the first letter of
// the name shown for them. Decorative beside a visible name (alt=""), so a
// screen reader does not read the name twice.
function Avatar({ src, name, size = 32, className = '' }) {
  const letter = (String(name || '').trim()[0] || '?').toUpperCase();
  const style = { width: size, height: size, fontSize: Math.round(size * 0.45) };
  if (src) {
    return <img className={`avatar ${className}`} src={src} alt="" width={size} height={size} style={style} />;
  }
  return (
    <span className={`avatar avatar-letter ${className}`} style={style} aria-hidden="true">
      {letter}
    </span>
  );
}

// The name to show for a user who may have set none: the display name, a
// first name, the name a provider gave, or the part of the address before
// the @ - never an empty field.
export function displayNameOf(profile, email) {
  const p = profile || {};
  const full = [p.firstName, p.lastName].filter(Boolean).join(' ');
  return p.displayName || full || p.providerName || String(email || '').split('@')[0] || '';
}

export default Avatar;
