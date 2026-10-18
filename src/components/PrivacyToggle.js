import React, { createContext, useContext } from 'react';

// The eye in the page header: hides or shows money amounts across the site
// (privacy mode, see utils/formatters.js) without opening the settings.
// App.js provides the state; outside a provider (a page rendered on its
// own, e.g. in a test) nothing is drawn.
export const PrivacyContext = createContext(null);

const EyeOpen = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const EyeClosed = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
    <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);

function PrivacyToggle() {
  const privacy = useContext(PrivacyContext);
  if (!privacy) return null;
  const { hideAmounts, toggle } = privacy;
  return (
    <button
      type="button"
      className={`privacy-toggle ${hideAmounts ? 'is-on' : ''}`}
      onClick={toggle}
      aria-pressed={hideAmounts}
      aria-label={hideAmounts ? 'הצגת הסכומים' : 'הסתרת הסכומים'}
      title={hideAmounts ? 'הסכומים מוסתרים - לחצו להצגה' : 'הסתרת הסכומים (מצב פרטיות)'}
    >
      {hideAmounts ? <EyeClosed /> : <EyeOpen />}
    </button>
  );
}

export default PrivacyToggle;
