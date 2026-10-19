// Whether a CSS media query currently matches, kept live as the viewport
// changes (a phone rotating, a desktop window being narrowed).
//
// For the few layout decisions CSS cannot make on its own - chiefly
// Recharts, which takes its geometry and labels as props rather than
// reading styles. False wherever matchMedia is unavailable (jsdom, very
// old browsers), so the wide layout is the default.
import { useEffect, useState } from 'react';

function matches(query) {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query).matches
    : false;
}

export function useMediaQuery(query) {
  const [isMatch, setIsMatch] = useState(() => matches(query));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const list = window.matchMedia(query);
    const onChange = () => setIsMatch(list.matches);
    onChange();
    // Safari before 14 only has the deprecated addListener.
    if (list.addEventListener) {
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    }
    list.addListener(onChange);
    return () => list.removeListener(onChange);
  }, [query]);

  return isMatch;
}

// The phone / narrow-tablet layout: below this width the sidebar becomes a
// bottom bar (App.css, SHELL RESPONSIVENESS) and the pages switch to their
// compact forms. One definition, so every component flips at the same width.
export const COMPACT_QUERY = '(max-width: 960px)';

export function useCompactLayout() {
  return useMediaQuery(COMPACT_QUERY);
}
