import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import ValuationView from './ValuationView';
import { computeDcf } from '../utils/dcfValuation';

const payload = (overrides = {}) => ({
  symbol: 'XYZ',
  name: 'XYZ Corp',
  sector: 'Technology',
  industry: 'Software',
  currency: 'USD',
  financialCurrency: 'USD',
  price: 15,
  marketCap: 1500,
  multiples: [
    { metric: 'PE', current: 30, avg5y: 25, median5y: 24, min5y: 15, max5y: 40, percentile5y: 70, samples: 55, totalMonths: 60, sectorMedian: 28, peerCount: 4, vsHistoryPct: 20, vsSectorPct: 7 },
    { metric: 'PS', current: 5, avg5y: 4, median5y: 4, min5y: 3, max5y: 6, percentile5y: 80, samples: 60, totalMonths: 60, sectorMedian: 6, peerCount: 4, vsHistoryPct: 25, vsSectorPct: -17 },
    { metric: 'PFCF', current: null, avg5y: null, median5y: null, min5y: null, max5y: null, percentile5y: null, samples: 0, totalMonths: 60, sectorMedian: null, peerCount: 0, vsHistoryPct: null, vsSectorPct: null }
  ],
  dcfInputs: {
    fcfHistory: [{ fcf: 90 }, { fcf: 100 }, { fcf: 110 }],
    cash: 200,
    debt: 500,
    sharesDiluted: 100,
    marketPrice: 15,
    beta: 1,
    analystGrowth5y: 0.08,
    riskFreeRate: 0.04,
    riskFreeRateIsDefault: false
  },
  warnings: [],
  sources: { statements: 'yahoo' },
  asOf: '2026-09-24T00:00:00Z',
  ...overrides
});

beforeEach(() => {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => payload() }));
});

test('loads the first held symbol and shows its multiples', async () => {
  render(<ValuationView americanStocks={[{ stockName: 'xyz' }, { stockName: 'ABC' }]} />);
  expect(global.fetch.mock.calls[0][0]).toMatch(/\/api\/valuation\/ABC$/);
  const table = await screen.findByRole('table', { name: 'מכפילים' });
  expect(within(table).getByText('30.0x')).toBeInTheDocument();
  expect(within(table).getAllByText('N/M').length).toBeGreaterThan(0);
  expect(within(table).getByText('70')).toBeInTheDocument();
});

test('DCF: suggested inputs, verdict and sensitivity grid match the engine', async () => {
  render(<ValuationView americanStocks={[{ stockName: 'XYZ' }]} />);
  const verdict = await screen.findByTestId('dcf-verdict');
  // suggested g = 8% (analysts), r = 4% + 1 x 5% = 9% -> the hand-checked case
  const expected = computeDcf({ fcfHistory: [90, 100, 110], growthRate: 0.08, discountRate: 0.09, terminalGrowth: 0.025, cash: 200, debt: 500, sharesDiluted: 100, marketPrice: 15 });
  expect(verdict).toHaveTextContent('מתומחרת בחסר');
  expect(screen.getByText(`${expected.intrinsicPerShare.toFixed(2)} USD`)).toBeInTheDocument();
  const grid = screen.getByRole('table', { name: 'רגישות' });
  expect(within(grid).getByText(expected.intrinsicPerShare.toFixed(2))).toHaveClass('cell-current');
});

test('moving the discount-rate slider recomputes instantly', async () => {
  render(<ValuationView americanStocks={[{ stockName: 'XYZ' }]} />);
  await screen.findByTestId('dcf-verdict');
  fireEvent.change(screen.getByLabelText(/שיעור היוון/), { target: { value: '0.14' } });
  expect(screen.getByTestId('dcf-verdict')).toHaveTextContent('מתומחרת ביתר');
});

test('negative FCF is refused with an explanation', async () => {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => payload({ dcfInputs: { ...payload().dcfInputs, fcfHistory: [{ fcf: -5 }, { fcf: -1 }] } }) }));
  render(<ValuationView americanStocks={[{ stockName: 'XYZ' }]} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('אינו חיובי');
});

test('any symbol can be typed; errors are shown', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, json: async () => ({ error: 'לא ניתן היה לטעון' }) }));
  render(<ValuationView americanStocks={[]} />);
  fireEvent.change(screen.getByLabelText('סימול אחר'), { target: { value: 'msft' } });
  fireEvent.click(screen.getByRole('button', { name: 'הצגה' }));
  await waitFor(() => expect(global.fetch.mock.calls[0][0]).toMatch(/\/api\/valuation\/MSFT$/));
  expect(await screen.findByText('לא ניתן היה לטעון')).toBeInTheDocument();
});
