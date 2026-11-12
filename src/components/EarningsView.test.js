import { render, screen, fireEvent, within } from '@testing-library/react';
import EarningsView, { heldUsSymbols, fmtUsd } from './EarningsView';

const payload = (symbol = 'AAPL', overrides = {}) => ({
  symbol,
  name: 'Apple Inc.',
  cik: '0000320193',
  secConfigured: true,
  quarters: [
    { end: '2026-06-27', fiscal: 'Q3 2026', derived: false, revenue: 109417000000, netIncome: 29789000000, operatingIncome: 35695000000, epsDiluted: 2.02, grossMargin: 50.1, operatingMargin: 32.6, netMargin: 27.2, revenueYoy: 16.4, netIncomeYoy: 27.1, epsYoy: 28.7, operatingMarginYoyPt: 2.6 },
    { end: '2026-03-28', fiscal: 'Q2 2026', derived: false, revenue: 100000000000, netIncome: 25000000000, operatingIncome: 30000000000, epsDiluted: 1.7, grossMargin: 49.3, operatingMargin: 30, netMargin: 25, revenueYoy: -2.5, netIncomeYoy: null, epsYoy: null },
    { end: '2025-09-27', fiscal: 'Q4 2025', derived: true, revenue: 102466000000, netIncome: 27000000000, operatingIncome: 32000000000, epsDiluted: 1.8, grossMargin: 47, operatingMargin: 31, netMargin: 26, revenueYoy: 7.9 }
  ],
  ttm: { revenue: 466823000000, netIncome: 128930000000, epsDiluted: 8.71 },
  latest8k: { filed: '2026-07-30', exhibit: 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000018/a8-kex991q3202606272026.htm', index: 'https://www.sec.gov/x-index.htm' },
  nextEarningsDate: '2026-10-29',
  ...overrides
});

beforeEach(() => {
  global.fetch = jest.fn(async (url) => {
    const symbol = decodeURIComponent(String(url).split('/').pop());
    return { ok: true, json: async () => payload(symbol) };
  });
});

test('helpers', () => {
  expect(heldUsSymbols([{ stockName: 'aapl' }, { stockName: 'AAPL ' }, { stockName: '' }, { stockName: 'ko' }])).toEqual(['AAPL', 'KO']);
  expect(fmtUsd(109417000000)).toBe('$109.42B');
  expect(fmtUsd(-12500000)).toBe('-$12.5M');
});

test('defaults to the first held US stock and shows cards, summary, table and the 8-K link', async () => {
  render(<EarningsView americanStocks={[{ stockName: 'aapl' }, { stockName: 'KO' }]} authHeader={() => ({ Authorization: 'Bearer t' })} />);
  expect(global.fetch.mock.calls[0][0]).toMatch(/\/api\/earnings\/AAPL$/);
  expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer t');

  const table = await screen.findByRole('table', { name: 'רבעון אחר רבעון' });
  expect(within(table).getByText('109,417')).toBeInTheDocument();
  expect(within(table).getByText('+16.4%').closest('td')).toHaveClass('profit-positive');
  expect(within(table).getByText('-2.5%').closest('td')).toHaveClass('profit-negative');
  expect(within(table).getByText('מחושב', { exact: false })).toBeInTheDocument();

  expect(screen.getByText('$466.82B')).toBeInTheDocument();
  // summary generated from the numbers when the server sent none
  expect(screen.getByText(/עלייה של 16.4% לעומת הרבעון המקביל אשתקד/)).toBeInTheDocument();
  expect(screen.getByText(/שולי הרווח התפעולי 32.6%, עלייה של 2.6 נקודות אחוז/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'הודעה לעיתונות' })).toHaveAttribute('href', expect.stringContaining('a8-kex991'));
  expect(screen.getByText(/אינו ייעוץ השקעות/)).toBeInTheDocument();
});

test('free-text ticker and the not-configured state', async () => {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ symbol: 'MSFT', secConfigured: false, quarters: [], message: 'לא מוגדר בשרת' }) }));
  render(<EarningsView americanStocks={[]} authHeader={() => ({})} />);
  expect(global.fetch).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('או הקלידו סימול של מניה'), { target: { value: 'msft' } });
  fireEvent.click(screen.getByRole('button', { name: 'הצגה' }));
  expect(await screen.findByText('לא מוגדר בשרת')).toBeInTheDocument();
  expect(global.fetch.mock.calls[0][0]).toMatch(/\/api\/earnings\/MSFT$/);
});

test('server error is shown', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, json: async () => ({ error: 'לא נמצאו דוחות' }) }));
  render(<EarningsView americanStocks={[{ stockName: 'SPY' }]} authHeader={() => ({})} />);
  expect(await screen.findByText('לא נמצאו דוחות')).toBeInTheDocument();
});
