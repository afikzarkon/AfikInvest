import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AssetEntryModal from './AssetEntryModal';
import { fetchHistoricalExchangeRate, fetchIsraeliSecurityMeta } from '../api/stockPrices';
import { todayISO } from '../utils/portfolioDates';

jest.mock('../api/stockPrices', () => ({
  fetchHistoricalExchangeRate: jest.fn(async () => 3.65),
  fetchIsraeliSecurityMeta: jest.fn(async () => null)
}));
jest.mock('../hooks/useIsraeliStockSearch', () => ({
  useIsraeliStockSearch: (q) => ({
    results: q ? [{ securityId: '629014', officialName: 'טבע', securityType: 'מניה', branch: 'פארמה', isFund: false, isForeignETF: false }] : [],
    loading: false
  })
}));
jest.mock('../hooks/useStockSearch', () => ({
  useStockSearch: (q) => ({ results: q ? [{ symbol: 'MSFT', name: 'Microsoft' }] : [], loading: false })
}));

const holdings = {
  israeliStocks: [{ id: 1, stockName: '604611', officialName: 'לאומי', purchaseDate: '2023-01-01', purchasePrice: 20, quantity: 100 }],
  americanStocks: [],
  pensionFunds: [{ id: 7, fundName: 'גמל מניות', currentValue: 1000, currentValueDate: '2026-01-31', deposits: [] }],
  cashFunds: [{ id: 3, fundName: 'כספית', securityId: '5119609', currentValue: 500, currentValueDate: '2026-01-01', deposits: [] }],
  bankBalances: [],
  bankSavingsFunds: []
};

function renderModal(props = {}) {
  const all = {
    initial: {},
    holdings,
    onClose: jest.fn(),
    onRecordTransaction: jest.fn(async () => ({ ok: true })),
    onUpdateTransaction: jest.fn(async () => ({ ok: true })),
    onPreviewTransaction: jest.fn(async () => ({ ok: true, transaction: { allocations: [] } })),
    onUpdateValue: jest.fn(async () => ({ ok: true })),
    ...props
  };
  render(<AssetEntryModal {...all} />);
  return all;
}

const change = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

// The project's Jest config resets mock implementations before each test.
beforeEach(() => {
  fetchHistoricalExchangeRate.mockImplementation(async () => 3.65);
  fetchIsraeliSecurityMeta.mockImplementation(async () => null);
});

test('a sale of a held security goes to the ledger, and the form closes', async () => {
  const props = renderModal({ initial: { assetClass: 'israeli', assetId: '604611' } });
  change('פעולה', 'SELL');
  change('כמות', '40');
  change(/מחיר ליחידה/, '35');
  fireEvent.click(screen.getByRole('button', { name: 'רישום מכירה' }));
  await waitFor(() => expect(props.onRecordTransaction).toHaveBeenCalled());
  expect(props.onRecordTransaction.mock.calls[0][0]).toMatchObject({
    type: 'SELL', assetClass: 'israeli', assetId: '604611', units: 40, price: 35, lotMethod: 'FIFO', date: todayISO()
  });
  expect(props.onClose).toHaveBeenCalled();
});

test('a security not held yet is picked by search and bought with its identity details', async () => {
  const props = renderModal();
  fireEvent.change(screen.getByLabelText('נייר ערך'), { target: { value: '__new__' } });
  change('חיפוש לפי שם או מספר נייר', 'טבע');
  fireEvent.click(screen.getByRole('button', { name: /טבע/ }));
  change('כמות', '10');
  change(/מחיר ליחידה/, '120');
  expect(screen.getByText(/החזקה חדשה/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'רישום קנייה' }));
  await waitFor(() => expect(props.onRecordTransaction).toHaveBeenCalled());
  expect(props.onRecordTransaction.mock.calls[0][0]).toMatchObject({
    type: 'BUY', assetId: '629014', units: 10, price: 120, lotDetails: expect.objectContaining({ officialName: 'טבע' })
  });
});

test('a US purchase gets the USD rate for its date automatically', async () => {
  renderModal({ initial: { assetClass: 'american' } });
  await waitFor(() => expect(fetchHistoricalExchangeRate).toHaveBeenCalledWith(todayISO()));
  await waitFor(() => expect(screen.getByLabelText('שער דולר ביום העסקה')).toHaveValue(3.65));
});

test('opening a new account is a deposit that carries the account details, through the ledger', async () => {
  const props = renderModal({ initial: { assetClass: 'pension' } });
  change('חשבון', 'new');
  change('שם', 'השתלמות חדשה');
  change('סכום (₪)', '2000');
  fireEvent.click(screen.getByRole('button', { name: 'פתיחת החשבון' }));
  await waitFor(() => expect(props.onRecordTransaction).toHaveBeenCalled());
  const tx = props.onRecordTransaction.mock.calls[0][0];
  expect(tx).toMatchObject({ type: 'DEPOSIT', assetClass: 'pension', amount: 2000, newAccount: { fundName: 'השתלמות חדשה' } });
  expect(tx.assetId).toBeUndefined();
});

test('a new account that duplicates an existing one is refused, with a way to use the existing one', () => {
  renderModal({ initial: { assetClass: 'pension' } });
  change('חשבון', 'new');
  change('שם', '  גמל  מניות ');
  expect(screen.getByRole('alert')).toHaveTextContent('כבר קיים חשבון כזה');
  expect(screen.getByRole('button', { name: 'פתיחת החשבון' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'לרשום בו את הפעולה' }));
  expect(screen.getByLabelText('חשבון')).toHaveValue('7');
});

test("opened from an account's ledger it is pointed at that account, and records a statement value", async () => {
  const props = renderModal({ initial: { assetClass: 'cashFunds', assetId: 3, action: 'DEPOSIT' } });
  expect(screen.getByLabelText('חשבון')).toHaveValue('3');
  change('פעולה', 'VALUE');
  change('השווי נכון לתאריך', '2026-02-28');
  change('שווי לפי הדוח (₪)', '512.5');
  fireEvent.click(screen.getByRole('button', { name: /רישום עדכון שווי/ }));
  await waitFor(() => expect(props.onUpdateValue).toHaveBeenCalledWith({ kind: 'value', assetClass: 'cashFunds', assetId: '3', value: 512.5, date: '2026-02-28' }));
  expect(props.onRecordTransaction).not.toHaveBeenCalled();
});

test('editing a recorded transaction submits the correction for that id', async () => {
  const tx = { id: 'tx9', type: 'DEPOSIT', date: '2026-02-01', assetClass: 'pension', assetId: '7', amount: 300, note: '' };
  const props = renderModal({ initial: { transaction: tx } });
  expect(screen.getByRole('heading', { name: 'עריכת עסקה' })).toBeInTheDocument();
  expect(screen.getByLabelText('סוג נכס')).toBeDisabled();
  expect(screen.getByLabelText('פעולה')).toBeDisabled();
  change('סכום (₪)', '350');
  fireEvent.click(screen.getByRole('button', { name: 'שמירת התיקון' }));
  await waitFor(() => expect(props.onUpdateTransaction).toHaveBeenCalled());
  expect(props.onUpdateTransaction.mock.calls[0]).toEqual(['tx9', expect.objectContaining({ type: 'DEPOSIT', assetId: '7', amount: 350 })]);
});

test("the server's refusal is shown and the form stays open", async () => {
  const props = renderModal({
    initial: { assetClass: 'israeli', assetId: '604611' },
    onRecordTransaction: jest.fn(async () => ({ ok: false, error: 'cannot sell 999 units of 604611' }))
  });
  change('פעולה', 'SELL');
  change('כמות', '999');
  change(/מחיר ליחידה/, '35');
  fireEvent.click(screen.getByRole('button', { name: 'רישום מכירה' }));
  expect(await screen.findByText('cannot sell 999 units of 604611')).toBeInTheDocument();
  expect(props.onClose).not.toHaveBeenCalled();
});

test('Escape closes it', () => {
  const props = renderModal();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(props.onClose).toHaveBeenCalled();
});
