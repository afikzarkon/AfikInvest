import React, { useEffect, useRef } from 'react';

// Cloudflare Turnstile - the bot check on the sign-up and sign-in-link
// forms. Rendered only when the server has it configured (it sends the
// site key with /api/auth/options); without one, the forms work as before.
// onToken(token) runs when the check passes, onToken('') when it expires.
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

function loadScript() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!loadScript.promise) {
    loadScript.promise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SCRIPT_SRC;
      s.async = true;
      s.onload = () => resolve(window.turnstile);
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  return loadScript.promise;
}

function Turnstile({ siteKey, onToken, theme = 'auto' }) {
  const ref = useRef(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    if (!siteKey) return undefined;
    let widgetId = null;
    let cancelled = false;
    loadScript()
      .then((turnstile) => {
        if (cancelled || !ref.current || !turnstile) return;
        widgetId = turnstile.render(ref.current, {
          sitekey: siteKey,
          language: 'he',
          theme,
          callback: (token) => onTokenRef.current(token),
          'expired-callback': () => onTokenRef.current(''),
          'error-callback': () => onTokenRef.current('')
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (widgetId !== null && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [siteKey, theme]);

  if (!siteKey) return null;
  return <div className="turnstile-box" ref={ref} />;
}

export default Turnstile;
