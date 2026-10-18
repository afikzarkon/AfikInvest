import React from 'react';

// "Continue with Google / Facebook", drawn to each provider's brand rules:
// Google's white button with the four-colour G and a grey outline;
// Facebook's #1877F2 button with the white f. Only the providers the
// server has keys for are shown (GET /api/auth/options).
//
// href(provider): where the browser goes to start (the API, not this app).
const GoogleMark = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
    <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
    <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
  </svg>
);

const FacebookMark = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path fill="#ffffff" d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.95.93-1.95 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07z" />
  </svg>
);

const LABELS = { google: 'המשך עם Google', facebook: 'המשך עם Facebook' };

function SocialButtons({ providers, href, onStart }) {
  const enabled = ['google', 'facebook'].filter((p) => providers && providers[p]);
  if (!enabled.length) return null;
  return (
    <div className="social-buttons">
      {enabled.map((p) => (
        <a key={p} className={`social-button social-${p}`} href={href(p)} onClick={() => onStart && onStart(p)}>
          <span className="social-mark">{p === 'google' ? <GoogleMark /> : <FacebookMark />}</span>
          <span>{LABELS[p]}</span>
        </a>
      ))}
      <div className="auth-divider" role="separator">
        <span>או עם אימייל</span>
      </div>
    </div>
  );
}

export default SocialButtons;
