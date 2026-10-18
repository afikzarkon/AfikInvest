// "You have unsaved changes" for forms that are not saved as you type (the
// settings page): a form marks itself dirty, and every way out - another
// page from the menu (useRoute.navigate), another settings category,
// closing or reloading the tab - asks before leaving.
const dirtySources = new Set();
const MESSAGE = 'יש שינויים שלא נשמרו. לצאת בלי לשמור?';

export function setUnsaved(source, dirty) {
  if (dirty) dirtySources.add(source);
  else dirtySources.delete(source);
}

export const hasUnsaved = () => dirtySources.size > 0;

// true when it is fine to leave (nothing unsaved, or the user agreed - in
// which case the changes are dropped).
export function confirmLeave() {
  if (!hasUnsaved()) return true;
  // eslint-disable-next-line no-alert
  const ok = window.confirm(MESSAGE);
  if (ok) dirtySources.clear();
  return ok;
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (!hasUnsaved()) return undefined;
    e.preventDefault();
    e.returnValue = MESSAGE;
    return MESSAGE;
  });
}
