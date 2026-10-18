import { migrateStorageKeys } from './storageKeyMigration';

beforeEach(() => localStorage.clear());

test("moves the previous name's keys to the current one and removes them", () => {
  localStorage.setItem('stockview_auth_token', 'tok');
  localStorage.setItem('stockview_theme', 'dark');
  localStorage.setItem('stockview_legacy_import_done_7', '1');
  localStorage.setItem('israeliStocks', '[]');

  expect(migrateStorageKeys(localStorage)).toBe(3);
  expect(localStorage.getItem('afikinvest_auth_token')).toBe('tok');
  expect(localStorage.getItem('afikinvest_theme')).toBe('dark');
  expect(localStorage.getItem('afikinvest_legacy_import_done_7')).toBe('1');
  expect(localStorage.getItem('stockview_theme')).toBeNull();
  expect(localStorage.getItem('israeliStocks')).toBe('[]'); // other keys untouched
});

test('a value already saved under the new name wins, and a second run does nothing', () => {
  localStorage.setItem('afikinvest_theme', 'light');
  localStorage.setItem('stockview_theme', 'dark');
  migrateStorageKeys(localStorage);
  expect(localStorage.getItem('afikinvest_theme')).toBe('light');
  expect(migrateStorageKeys(localStorage)).toBe(0);
});
