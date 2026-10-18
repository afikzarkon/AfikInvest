import { useEffect, useRef } from 'react';
import { trackPageView } from '../utils/analytics';

// One Google Analytics page_view per screen the user actually sees.
//
// The app is a single page: only the first load reaches the server, and
// every later page is a pushState (useRoute.js) or a state change (the
// sign-in screen, a link from an email). So the page view is sent from
// here, whenever the screen's path changes, rather than by the tag on load.
//
// `path` is the screen's canonical path - a route from router/routes.js or
// a fixed name for the screens outside it - never window.location, which
// can still hold a token. null (while the session is being checked) sends
// nothing. The ref keeps one view per change, including under StrictMode's
// double-run effects in development.
export function usePageViews(path, title) {
  const lastSent = useRef(null);
  useEffect(() => {
    if (!path || lastSent.current === path) return;
    lastSent.current = path;
    trackPageView(path, title);
  }, [path, title]);
}

export default usePageViews;
