import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import TransactionsView, { buildTransactionPayload, heldSymbols, filterTransactions } from './TransactionsView';

const formatPriceWithSign = (v) => (v ?? 0).toFixed(2);

const israeliStocks = [
  { id: 1, stockName: '604611', officialName: 'לאומי', purchaseDate: '2023-01-01', purchasePrice: 20, quantity: 100 },
  { id: 2, stockName: '604611', officialName: 'לאומי', purchaseDate: '2024-01-01', purchasePrice: 30, quantity: 50 }
];
const pensionFunds = [{ id: 7, fundName: 'גמל מניות', deposits: [] }];
const holdings = { israeliStocks, americanStocks: [], pensionFunds, cashFunds: [], bankBalances: [], bankSavingsFunds: [] };

const year = new Date().toISOString().slice(0, 4);
const sale = {
  id: 't1', type: 'SELL', date: `${year}-01-02`, assetClass: 'israeli', assetId: '604611', units: 10, price: 30, fees: 0,
  currency: 'ILS', fxRate: 1, amountILS: 300,
  allocations: [{ lotId: 1, units: 10, purchaseDate: '2023-01-01', purchasePrice: 20, feeShare: 0, lotSnapshot: {} }]
};
const deposit = { id: 't2', type: 'DEPOSIT', date: `${year}-02-10`, assetClass: 'pension', assetId: '7', amount: 500, amountILS: 500, note: 'בונוס' };

function renderView(overrides = {}) {
  const props = {
    formatPriceWithSign,
    ...holdings,
    transactions: [],
    onNewTransaction: jest.fn(),
    onEditTransaction: jest.fn(),
    onDeleteTransaction: jest.fn().mockResolvedValue({ ok: true }),
    ...overrides
  };
  render(<TransactionsView {...props} />);
  return props;
}

test('heldSymbols groups lots by symbol', () => {
  expect(heldSymbols(israeliStocks)).toEqual([{ symbol: '604611', name: 'לאומי', units: 150 }]);
});

test('buildTransactionPayload shapes each type', () => {
  expect(
    buildTransactionPayload({ type: 'SELL', date: '2025-01-01', assetClass: 'american', assetId: 'AAPL', units: '3', price: '10', fees: '', fxRate: '3.6', lotMethod: 'HIFO', note: '' })
  ).toMatchObject({ units: 3, price: 10, fees: 0, fxRate: 3.6, lotMethod: 'HIFO' });
  expect(buildTransactionPayload({ type: 'WITHDRAWAL', date: '2025-01-01', assetClass: 'pension', assetId: '7', amount: '500', note: '' })).toEqual({
    type: 'WITHDRAWAL', date: '2025-01-01', assetClass: 'pension', assetId: '7', amount: 500, note: undefined
  });
});

// The page records nothing itself: new entries and corrections go through
// the one entry form.
test('has no creation form of its own - "+ רישום עסקה" opens the entry form', () => {
  const props = renderView();
  expect(screen.queryByRole('form', { name: 'רישום עסקה' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '+ רישום עסקה' }));
  expect(props.onNewTransaction).toHaveBeenCalled();
});

test('editing a line opens the entry form with that transaction', () => {
  const props = renderView({ transactions: [sale] });
  fireEvent.click(screen.getByRole('button', { name: `עריכת עסקה ${sale.date}` }));
  expect(props.onEditTransaction).toHaveBeenCalledWith(sale);
});

test('deleting a line asks first and reports the result', async () => {
  const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
  const props = renderView({ transactions: [sale] });
  fireEvent.click(screen.getByRole('button', { name: `מחיקת עסקה ${sale.date}` }));
  await waitFor(() => expect(props.onDeleteTransaction).toHaveBeenCalledWith('t1'));
  expect(await screen.findByText('העסקה נמחקה והתיק עודכן')).toBeInTheDocument();
  confirm.mockRestore();
});

test('filters by type, asset class, text and dates', () => {
  const all = [sale, deposit];
  expect(filterTransactions(all, { type: 'DEPOSIT' }, holdings)).toEqual([deposit]);
  expect(filterTransactions(all, { assetClass: 'israeli' }, holdings)).toEqual([sale]);
  expect(filterTransactions(all, { text: 'לאומי' }, holdings)).toEqual([sale]);
  expect(filterTransactions(all, { text: 'בונוס' }, holdings)).toEqual([deposit]);
  expect(filterTransactions(all, { from: `${year}-02-01` }, holdings)).toEqual([deposit]);
  expect(filterTransactions(all, { to: `${year}-01-31` }, holdings)).toEqual([sale]);

  renderView({ transactions: all });
  fireEvent.change(screen.getByLabelText('סוג'), { target: { value: 'DEPOSIT' } });
  const table = screen.getByRole('table', { name: 'עסקאות' });
  expect(within(table).queryByText('מכירה')).toBeNull();
  expect(within(table).getByText('הפקדה')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'ניקוי סינון' }));
  expect(within(screen.getByRole('table', { name: 'עסקאות' })).getByText('מכירה')).toBeInTheDocument();
});

test('lists transactions and the realized gain for the year', () => {
  renderView({ transactions: [sale] });
  const table = screen.getByRole('table', { name: 'עסקאות' });
  expect(within(table).getByText('מכירה')).toBeInTheDocument();
  expect(within(table).getByText('לאומי (604611)')).toBeInTheDocument();
  expect(screen.getByText(/1 מנות שמומשו/)).toBeInTheDocument();
  expect(screen.getAllByText('100.00 ₪').length).toBeGreaterThan(0);
});

// THE PAGE ON A PHONE: cards by month instead of the nine-column table,
// type buttons and a search in view, the rest of the filters in a sheet.
describe('TransactionsView on a phone', () => {
  let originalMatchMedia;
  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
    window.matchMedia = (query) => ({
      matches: /max-width:\s*768px/.test(query),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    });
  });
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  test('the history is cards grouped by month, newest first, with no table', () => {
    renderView({ transactions: [sale, deposit] });
    expect(screen.queryByRole('table')).toBeNull();
    const list = screen.getByLabelText('עסקאות');
    const months = within(list)
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(months[0]).toMatch(/פברואר/);
    expect(months[1]).toMatch(/ינואר/);
    expect(within(list).getByText('לאומי (604611)')).toBeInTheDocument();
    expect(within(list).getByText('בונוס')).toBeInTheDocument();
  });

  test('editing and deleting work from a card', async () => {
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const props = renderView({ transactions: [sale] });
    fireEvent.click(screen.getByRole('button', { name: `עריכת עסקה ${sale.date}` }));
    expect(props.onEditTransaction).toHaveBeenCalledWith(sale);
    fireEvent.click(screen.getByRole('button', { name: `מחיקת עסקה ${sale.date}` }));
    await waitFor(() => expect(props.onDeleteTransaction).toHaveBeenCalledWith('t1'));
    confirm.mockRestore();
  });

  test('the type buttons filter in place; asset class and dates are in the sheet', () => {
    renderView({ transactions: [sale, deposit] });
    const types = screen.getByRole('group', { name: 'סוג' });
    fireEvent.click(within(types).getByRole('button', { name: 'הפקדה' }));
    expect(screen.queryByText('לאומי (604611)')).toBeNull();
    fireEvent.click(within(types).getByRole('button', { name: 'הכול' }));
    expect(screen.getByText('לאומי (604611)')).toBeInTheDocument();

    expect(screen.queryByLabelText('סוג נכס')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'סינון' }));
    const sheet = screen.getByRole('dialog', { name: 'סינון עסקאות' });
    fireEvent.change(within(sheet).getByLabelText('סוג נכס'), { target: { value: 'pension' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'הצגת 1 עסקאות' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('לאומי (604611)')).toBeNull();
    expect(document.querySelector('.perf-filter-count')).toHaveTextContent('1');
  });

  test('the year\'s realized totals come before the history', () => {
    renderView({ transactions: [sale] });
    const titles = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(titles.indexOf(`רווח הון ממומש ${year}`)).toBeLessThan(titles.indexOf('כל העסקאות'));
  });
});
