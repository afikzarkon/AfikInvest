// One-time move of this browser's saved keys from the app's previous name to
// the current one: `stockview_<rest>` becomes `afikinvest_<rest>` - the
// sign-in token, the theme, and the per-user "already imported this
// browser's old portfolio" flag. Without it, renaming the keys would sign
// everyone out, reset their theme, and offer the old-portfolio import (which
// replaces the server portfolio) again.
//
// A key already present under the new name is kept as it is. Once nothing
// is left under the old prefix this does nothing, and the whole file can be
// deleted.
const OLD_PREFIX = 'stockview_';
const NEW_PREFIX = 'afikinvest_';

export function migrateStorageKeys(storage) {
  let moved = 0;
  try {
    const oldKeys = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && key.startsWith(OLD_PREFIX)) oldKeys.push(key);
    }
    oldKeys.forEach((oldKey) => {
      const newKey = NEW_PREFIX + oldKey.slice(OLD_PREFIX.length);
      if (storage.getItem(newKey) === null) storage.setItem(newKey, storage.getItem(oldKey));
      storage.removeItem(oldKey);
      moved += 1;
    });
  } catch {
    // Storage blocked (private mode, disabled cookies): nothing to move.
  }
  return moved;
}

export function migrateBrowserStorage() {
  if (typeof window === 'undefined') return;
  try {
    migrateStorageKeys(window.localStorage);
    migrateStorageKeys(window.sessionStorage);
  } catch {
    // Accessing the storage itself can throw when it is blocked.
  }
}
