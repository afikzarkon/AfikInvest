import React from 'react';
import BrandLogo from './BrandLogo';

// The app's loading state: the logo, breathing, with a ring turning around
// it and a line saying what is being loaded.
//
// `fullScreen` while the session or the portfolio itself is loading, when
// nothing else is on screen; without it, the smaller version that holds a
// page's place inside the shell while that page's code arrives.
//
// role="status" so a screen reader announces the message; the animation
// is decoration only, and stops for anyone who asks for reduced motion
// (App.css).
export default function LoadingScreen({ message = 'טוען…', fullScreen = false }) {
  return (
    <div className={`loading-screen ${fullScreen ? 'is-full' : ''}`} role="status" aria-live="polite">
      <div className="loading-logo" aria-hidden="true">
        <span className="loading-logo-glow" />
        <span className="loading-logo-ring" />
        <BrandLogo variant="mark" className="loading-logo-mark" />
      </div>
      <p className="loading-message">{message}</p>
    </div>
  );
}
