import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import ValuationView from './ValuationView';
import { evaluateDcf, reproduceFromCard } from '../shared/dcfRules';
import avgoSnapshot from '../shared/fixtures/dcf-snapshot-avgo.json';

const payload = (overrides = {}) => ({
  symbol: 'AVGO',
  name: 'Broadcom Inc.',
  sector: 'Technology',
  industry: 'Semiconductors',
  currency: 'USD',
  financialCurrency: 'USD',
  price: 328.75,
  marketCap: 1.569e12,
  multiples: [
    { metric: 'PE', current: 30, avg5y: 25, median5y: 24, min5y: 15, max5y: 40, percentile5y: 70, samples: 55, totalMonths: 60, sectorMedian: 28, peerCount: 4, vsHistoryPct: 20, vsSectorPct: 7 },
    { metric: 'PS', current: 5, avg5y: 4, median5y: 4, min5y: 3, max5y: 6, percentile5y: 80, samples: 60, totalMonths: 60, sectorMedian: 6, peerCount: 4, vsHistoryPct: 25, vsSectorPct: -17 },
    { metric: 'PFCF', current: null, avg5y: null, median5y: null, min5y: null, max5y: null, percentile5y: null, samples: 0, totalMonths: 60, sectorMedian: null, peerCount: 0, vsHistoryPct: null, vsSectorPct: null }
  ],
  warnings: [],
  sources: { statements: 'yahoo' },
  asOf: '2026-10-18T00:00:00Z',
  ...overrides
});

// The two endpoints the page reads: the multiples and the DCF snapshot.
function mockApi({ valuation = payload(), snapshot = avgoSnapshot } = {}) {
  global.fetch = jest.fn(async (url) => ({ ok: true, json: async () => (String(url).endsWith('/dcf') ? snapshot : valuation) }));
}

beforeEach(() => mockApi());

const expected = () => evaluateDcf({ mode: 'auto', snapshot: avgoSnapshot, valuationDate: new Date().toISOString().slice(0, 10) });
const money = (v) => `${v.toFixed(2)} USD`;

test('loads the first held symbol and shows its multiples', async () => {
  render(<ValuationView americanStocks={[{ stockName: 'xyz' }, { stockName: 'ABC' }]} />);
  expect(global.fetch.mock.calls[0][0]).toMatch(/\/api\/valuation\/ABC$/);
  const table = await screen.findByRole('table', { name: 'מכפילים' });
  expect(within(table).getByText('30.0x')).toBeInTheDocument();
  expect(within(table).getAllByText('N/M').length).toBeGreaterThan(0);
  expect(within(table).getByText('70')).toBeInTheDocument();
});

test('auto DCF: three scenarios and the weighted value, straight from the engine; centre of the grid = the result', async () => {
  render(<ValuationView americanStocks={[{ stockName: 'AVGO' }]} />);
  const e = expected();
  expect(await screen.findByTestId('dcf-value-base')).toHaveTextContent(money(e.results.base.perShare));
  expect(screen.getByTestId('dcf-value-bear')).toHaveTextContent(money(e.results.bear.perShare));
  expect(screen.getByTestId('dcf-value-bull')).toHaveTextContent(money(e.results.bull.perShare));
  expect(screen.getByTestId('dcf-value-weighted')).toHaveTextContent(money(e.weighted));
  const grid = screen.getByRole('table', { name: 'רגישות' });
  expect(within(grid).getByText(e.main.perShare.toFixed(2))).toHaveClass('cell-current');
  // The inputs are visible, not editable, in auto mode.
  expect(screen.getByLabelText('ריבית חסרת סיכון (rf)')).toHaveAttribute('readonly');
});

test('the summary reads the auto base case, with the implied return', async () => {
  render(<ValuationView americanStocks={[{ stockName: 'AVGO' }]} />);
  const summary = await screen.findByRole('region', { name: 'בשורה התחתונה' });
  const e = expected();
  await waitFor(() => expect(within(summary).getByText(/התשואה השנתית הצפויה היא כ-/)).toBeInTheDocument());
  expect(within(summary).getByText(new RegExp(`כ-${(e.irr * 100).toFixed(1)}%`))).toBeInTheDocument();
  expect(within(summary).getByText('יקרה מהרגיל')).toBeInTheDocument();
  expect(screen.getByText(/על כל דולר של רווח שנתי/)).toBeInTheDocument();
});

test('editing turns the model manual ("custom"), and the value follows the edit at once', async () => {
  render(<ValuationView americanStocks={[{ stockName: 'AVGO' }]} />);
  const before = (await screen.findByTestId('dcf-value-base')).textContent;
  fireEvent.click(screen.getByRole('button', { name: /^ידני/ }));
  expect(screen.getByRole('button', { name: 'ידני - מותאם אישית' })).toHaveAttribute('aria-pressed', 'true');
  const firstGrowth = screen.getByLabelText('צמיחת הכנסות, FY27');
  fireEvent.change(firstGrowth, { target: { value: '90' } });
  expect(screen.getByTestId('dcf-value-base').textContent).not.toBe(before);
  expect(Number.parseFloat(screen.getByTestId('dcf-value-base').textContent)).toBeGreaterThan(Number.parseFloat(before));
});

test('the AVGO preset gives DCF_METHOD.md\'s 117 / 234 / 326', async () => {
  render(<ValuationView americanStocks={[{ stockName: 'AVGO' }]} />);
  await screen.findByTestId('dcf-value-base');
  fireEvent.click(screen.getByRole('button', { name: 'פריסט AVGO (DCF_METHOD.md)' }));
  expect(screen.getByTestId('dcf-value-conservative')).toHaveTextContent('117.10 USD');
  expect(screen.getByTestId('dcf-value-base')).toHaveTextContent('233.98 USD');
  expect(screen.getByTestId('dcf-value-management')).toHaveTextContent('325.78 USD');
  expect(screen.getAllByText('11.25%', { selector: 'bdi' }).length).toBeGreaterThan(0);
});

test('the exported input card reproduces the page\'s numbers offline', async () => {
  let blob;
  global.URL.createObjectURL = jest.fn((b) => {
    blob = b;
    return 'blob:card';
  });
  global.URL.revokeObjectURL = jest.fn();
  render(<ValuationView americanStocks={[{ stockName: 'AVGO' }]} />);
  const shown = (await screen.findByTestId('dcf-value-base')).textContent;
  fireEvent.click(screen.getByRole('button', { name: 'ייצוא כרטיס קלטים' }));
  const text = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsText(blob);
  });
  const card = JSON.parse(text);
  expect(card).toMatchObject({ ticker: 'AVGO', mode: 'auto', price: 328.75 });
  expect(money(card.results.scenarios.base.perShare)).toBe(shown.trim());
  const { fromInputs, fromRaw } = reproduceFromCard(card);
  expect(fromInputs.results.base.perShare).toBe(card.results.scenarios.base.perShare);
  expect(fromRaw.results.base.perShare).toBe(card.results.scenarios.base.perShare);
});

test('a bank is not valued by DCF: a reason, no number', async () => {
  mockApi({ snapshot: { ...avgoSnapshot, profile: { sector: 'Financial Services', industry: 'Banks - Diversified' } } });
  render(<ValuationView americanStocks={[{ stockName: 'AVGO' }]} />);
  expect(await screen.findByText(/מודל DCF על תזרים חופשי אינו מתאים לבנקים/, { selector: '.dcf-unsuitable' })).toBeInTheDocument();
  expect(screen.queryByTestId('dcf-value-base')).toBeNull();
  const summary = screen.getByRole('region', { name: 'בשורה התחתונה' });
  expect(within(summary).getByText('לא מתאים ל-DCF')).toBeInTheDocument();
});

test('any symbol can be typed; errors are shown', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, json: async () => ({ error: 'לא ניתן היה לטעון' }) }));
  render(<ValuationView americanStocks={[]} />);
  fireEvent.change(screen.getByLabelText('סימול אחר'), { target: { value: 'msft' } });
  fireEvent.click(screen.getByRole('button', { name: 'הצגה' }));
  await waitFor(() => expect(global.fetch.mock.calls[0][0]).toMatch(/\/api\/valuation\/MSFT$/));
  expect(await screen.findByText('לא ניתן היה לטעון')).toBeInTheDocument();
});

test('a P/E driven by tiny earnings is called out instead of read', async () => {
  const base = payload();
  mockApi({ valuation: payload({ multiples: [{ ...base.multiples[0], current: 911, avg5y: 184, min5y: 46, max5y: 988, vsHistoryPct: 394 }, ...base.multiples.slice(1)] }) });
  render(<ValuationView americanStocks={[{ stockName: 'AVGO' }]} />);
  const card = await screen.findByRole('article', { name: 'מחיר מול רווח' });
  expect(within(card).getByText(/לא משמעותי כרגע/)).toBeInTheDocument();
  expect(within(card).queryByText('יקר מהרגיל')).toBeNull();
});
