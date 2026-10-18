import { useCallback, useEffect, useState } from 'react';
import { keyForPath, pathForKey } from '../router/routes';
import { confirmLeave } from '../utils/unsavedChanges';

// Real-URL routing on top of the History API, without pulling in a router
// dependency for what is a flat list of pages with no nested layouts, route
// params or data loaders.
//
// Paths rather than hashes so a page can be linked, bookmarked and shared,
// and so the address bar says what the user is looking at. That needs the
// host to serve index.html for unknown paths - public/_redirects does this
// in production; CRA's dev server already does.
//
// `popstate` covers the browser's back/forward buttons; navigate() pushes,
// so those buttons walk the pages the user actually visited.
export function useRoute() {
  const [page, setPage] = useState(() => keyForPath(window.location.pathname));

  useEffect(() => {
    const onPopState = () => setPage(keyForPath(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((key) => {
    // A form with unsaved changes (the settings page) asks first.
    if (!confirmLeave()) return;
    const path = pathForKey(key);
    // Re-navigating to the page already open would otherwise stack identical
    // history entries, so back would appear to do nothing.
    if (window.location.pathname !== path) {
      window.history.pushState({}, '', path);
    }
    setPage(keyForPath(path));
    // A page switch is a new screen, not a continuation of the last one's
    // scroll - without this, opening a short page from halfway down a long
    // one lands the user below its content.
    window.scrollTo(0, 0);
  }, []);

  return { page, navigate };
}

export default useRoute;
