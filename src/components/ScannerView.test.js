import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import ScannerView from './ScannerView';

const RUN = {
  id: 'r1',
  runDate: '2026-10-19',
  asOf: '2026-10-19',
  universeSize: 5900,
  fetched: 5812,
  scanned: 1500,
  partial: true,
  filters: { minPrice: 5, minVolume: 1000000 }
};
const RESULTS = [
  { symbol: 'KO', name: 'Coca-Cola', setups: ['breakout_20d'], close: 93.9, changePct: 1.2, volume: 3680307, distHigh20Pct: 2.07, distMa20Pct: 3.1, rsi: 75.3, held: true },
  { symbol: 'BAC', name: 'Bank of America', setups: ['oversold'], close: 45.1, changePct: -0.8, volume: 40000000, distHigh20Pct: -9.5, distMa20Pct: -4.2, rsi: 24, held: false }
];

function mockFetch(body) {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => body });
}

afterEach(() => {
  delete global.fetch;
});

test('empty state before the first run', async () => {
  mockFetch({ run: null, results: [], counts: {}, total: 0 });
  render(<ScannerView user={{ id: 1 }} authHeader={() => ({})} />);
  expect(await screen.findByText(/הסריקה הראשונה עוד לא רצה/)).toBeInTheDocument();
  expect(screen.getByText(/אינו ייעוץ השקעות/)).toBeInTheDocument();
});

test('coverage, chips with counts, held badge, setup filter and sorting', async () => {
  mockFetch({ run: RUN, results: RESULTS, counts: { breakout_20d: 1, bull_flag: 0, reclaim_ma20: 0, oversold: 1, oversold_bounce: 0 }, total: 2 });
  render(<ScannerView user={{ id: 1 }} authHeader={() => ({ Authorization: 'Bearer t' })} />);
  const table = await screen.findByRole('table', { name: 'תוצאות הסריקה' });
  expect(screen.getByText(/נסרקו/).textContent).toMatch(/5,812 מתוך 5,900/);
  expect(screen.getByText(/סריקה חלקית/)).toBeInTheDocument();
  expect(within(table).getByText('בתיק')).toBeInTheDocument();
  expect(global.fetch.mock.calls[0][0]).toMatch(/\/api\/scanner$/);
  expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer t');

  // default sort: volume, most first
  let rows = within(table).getAllByRole('row').slice(1);
  expect(within(rows[0]).getByText('BAC')).toBeInTheDocument();
  fireEvent.click(within(table).getByRole('button', { name: /סימול/ }));
  rows = within(table).getAllByRole('row').slice(1);
  expect(within(rows[0]).getByText('BAC')).toBeInTheDocument(); // A-Z
  fireEvent.click(within(table).getByRole('button', { name: /RSI/ }));
  rows = within(table).getAllByRole('row').slice(1);
  expect(within(rows[0]).getByText('KO')).toBeInTheDocument(); // highest RSI first

  const chip = screen.getByRole('button', { name: /מכירת יתר 1/ });
  fireEvent.click(chip);
  expect(chip).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText(/מתחת ל-30: המניה ירדה מהר/)).toBeInTheDocument();
  rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
  expect(rows).toHaveLength(1);
  expect(within(rows[0]).getByText('BAC')).toBeInTheDocument();
});

test('price and volume floors go to the server', async () => {
  mockFetch({ run: RUN, results: RESULTS, counts: {}, total: 2 });
  render(<ScannerView user={{ id: 1 }} authHeader={() => ({})} />);
  await screen.findByRole('table');
  fireEvent.change(screen.getByLabelText('מחיר מינימלי ($)'), { target: { value: '10' } });
  fireEvent.change(screen.getByLabelText('מחזור מינימלי (מניות)'), { target: { value: '2000000' } });
  fireEvent.click(screen.getByRole('button', { name: 'סינון' }));
  await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
  expect(global.fetch.mock.calls[1][0]).toMatch(/minPrice=10&minVolume=2000000/);
});
