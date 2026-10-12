import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import TransactionsView, { buildTransactionPayload, heldSymbols } from './TransactionsView';

const formatPriceWithSign = (v) => (v ?? 0).toFixed(2);

const israeliStocks = [
  { id: 1, stockName: '604611', officialName: 'לאומי', purchaseDate: '2023-01-01', purchasePrice: 20, quantity: 100 },
  { id: 2, stockName: '604611', officialName: 'לאומי', purchaseDate: '2024-01-01', purchasePrice: 30, quantity: 50 }
];
const pensionFunds = [{ id: 7, fundName: 'גמל מניות', deposits: [] }];

function renderView(overrides = {}) {
  const props = {
    formatPriceWithSign,
    israeliStocks,
    americanStocks: [],
    pensionFunds,
    transactions: [],
    onRecordTransaction: jest.fn().mockResolvedValue({ ok: true }),
    onPreviewTransaction: jest.fn(),
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
  ).toEqual({ type: 'SELL', date: '2025-01-01', assetClass: 'american', assetId: 'AAPL', units: 3, price: 10, fees: 0, fxRate: 3.6, lotMethod: 'HIFO', note: undefined });
  expect(buildTransactionPayload({ type: 'WITHDRAWAL', date: '2025-01-01', assetClass: 'pension', assetId: '7', amount: '500', note: '' })).toEqual({
    type: 'WITHDRAWAL', date: '2025-01-01', assetClass: 'pension', assetId: '7', amount: 500, note: undefined
  });
});

test('recording a sale sends the payload and confirms', async () => {
  const props = renderView();
  fireEvent.change(screen.getByLabelText('מספר נייר'), { target: { value: '604611' } });
  expect(screen.getByText('מוחזקות כרגע 150 יחידות')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('תאריך'), { target: { value: '2025-03-01' } });
  fireEvent.change(screen.getByLabelText('כמות'), { target: { value: '120' } });
  fireEvent.change(screen.getByLabelText(/מחיר ליחידה/), { target: { value: '40' } });
  fireEvent.click(screen.getByRole('button', { name: 'רישום מכירה' }));
  await waitFor(() => expect(props.onRecordTransaction).toHaveBeenCalled());
  expect(props.onRecordTransaction.mock.calls[0][0]).toMatchObject({
    type: 'SELL', assetClass: 'israeli', assetId: '604611', date: '2025-03-01', units: 120, price: 40, lotMethod: 'FIFO'
  });
  expect(await screen.findByRole('status')).toHaveTextContent('מכירה נרשמה');
});

test('a withdrawal is chosen against an account', async () => {
  const props = renderView();
  fireEvent.change(screen.getByLabelText('סוג'), { target: { value: 'WITHDRAWAL' } });
  fireEvent.change(screen.getByLabelText('חשבון'), { target: { value: '7' } });
  fireEvent.change(screen.getByLabelText('סכום (₪)'), { target: { value: '1000' } });
  fireEvent.click(screen.getByRole('button', { name: 'רישום משיכה' }));
  await waitFor(() => expect(props.onRecordTransaction).toHaveBeenCalled());
  expect(props.onRecordTransaction.mock.calls[0][0]).toMatchObject({ type: 'WITHDRAWAL', assetClass: 'pension', assetId: '7', amount: 1000 });
});

test('a server refusal is shown', async () => {
  renderView({ onRecordTransaction: jest.fn().mockResolvedValue({ ok: false, error: 'cannot sell 999 units' }) });
  fireEvent.change(screen.getByLabelText('מספר נייר'), { target: { value: '604611' } });
  fireEvent.change(screen.getByLabelText('כמות'), { target: { value: '999' } });
  fireEvent.change(screen.getByLabelText(/מחיר ליחידה/), { target: { value: '40' } });
  fireEvent.click(screen.getByRole('button', { name: 'רישום מכירה' }));
  expect(await screen.findByRole('status')).toHaveTextContent('cannot sell 999 units');
});

test('lists transactions and the realized gain for the year', () => {
  const year = new Date().toISOString().slice(0, 4);
  const sale = {
    id: 't1', type: 'SELL', date: `${year}-01-02`, assetClass: 'israeli', assetId: '604611', units: 10, price: 30, fees: 0,
    currency: 'ILS', fxRate: 1, amountILS: 300,
    allocations: [{ lotId: 1, units: 10, purchaseDate: '2023-01-01', purchasePrice: 20, feeShare: 0, lotSnapshot: {} }]
  };
  renderView({ transactions: [sale] });
  const table = screen.getByRole('table', { name: 'עסקאות' });
  expect(within(table).getByText('מכירה')).toBeInTheDocument();
  expect(screen.getByText(/1 מנות שמומשו/)).toBeInTheDocument();
  expect(screen.getAllByText('100.00 ₪').length).toBeGreaterThan(0);
});
