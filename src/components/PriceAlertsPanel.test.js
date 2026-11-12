import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import AlertsView from './AlertsView';

const rules = [
  {
    id: 'r1',
    symbol: 'TSLA',
    market: 'US',
    name: 'Tesla',
    ruleType: 'pct_up',
    value: 3,
    note: 'מומנטום',
    status: 'triggered',
    triggeredAt: '2026-10-19T14:53:00Z',
    triggeredPrice: 366.475,
    lastPrice: 366.475,
    lastCheckedAt: '2026-10-19T14:53:00Z'
  },
  { id: 'r2', symbol: '629014', market: 'TASE', name: 'טבע', ruleType: 'below', value: 110, note: '', status: 'active', lastPrice: 119.6 },
  { id: 'r3', symbol: 'KO', market: 'US', name: '', ruleType: 'above', value: 95, note: '', status: 'active', lastPrice: null }
];

function renderPrices(overrides = {}) {
  const priceAlerts = {
    rules,
    max: 50,
    loading: false,
    error: '',
    create: jest.fn().mockResolvedValue({ rule: {}, currentPrice: 90.11, alreadyMet: false }),
    rearm: jest.fn().mockResolvedValue({}),
    remove: jest.fn().mockResolvedValue({}),
    ...overrides
  };
  render(<AlertsView alerts={[]} unreadCount={0} priceAlerts={priceAlerts} />);
  fireEvent.click(screen.getByRole('tab', { name: 'התראות מחיר' }));
  return priceAlerts;
}

test('lists rules with condition, status, last price; re-arm and delete', async () => {
  const api = renderPrices();
  const table = screen.getByRole('table', { name: 'התראות מחיר' });
  expect(within(table).getByText('Tesla (TSLA)')).toBeInTheDocument();
  expect(within(table).getByText('עלייה של 3% מהסגירה הקודמת')).toBeInTheDocument();
  expect(within(table).getByText(/הופעלה .* ב-366.48 \$/)).toBeInTheDocument();
  expect(within(table).getByText('מחיר מתחת ל-110 ₪')).toBeInTheDocument();
  expect(within(table).getByText('119.6 ₪')).toBeInTheDocument();
  expect(within(table).getAllByText('פעילה')).toHaveLength(2);
  expect(screen.getByText(/\(3\/50\)/)).toBeInTheDocument();
  expect(screen.getByText(/לא ייעוץ השקעות/)).toBeInTheDocument();

  // Only the triggered rule can be re-armed.
  expect(screen.getAllByRole('button', { name: /^הפעלה מחדש/ })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'הפעלה מחדש TSLA' }));
  await waitFor(() => expect(api.rearm).toHaveBeenCalledWith('r1'));
  fireEvent.click(screen.getByRole('button', { name: 'מחיקה KO' }));
  await waitFor(() => expect(api.remove).toHaveBeenCalledWith('r3'));
});

test('form validates in Hebrew before sending, then creates', async () => {
  const api = renderPrices();
  fireEvent.change(screen.getByLabelText('בורסה'), { target: { value: 'TASE' } });
  fireEvent.change(screen.getByLabelText('מספר נייר ערך'), { target: { value: 'TEVA' } });
  fireEvent.change(screen.getByLabelText('מחיר (₪)'), { target: { value: '110' } });
  fireEvent.click(screen.getByRole('button', { name: 'הוספת התראה' }));
  expect(await screen.findByRole('status')).toHaveTextContent('מספר נייר ערך');
  expect(api.create).not.toHaveBeenCalled();

  fireEvent.change(screen.getByLabelText('בורסה'), { target: { value: 'US' } });
  fireEvent.change(screen.getByLabelText('סימול'), { target: { value: 'ko' } });
  fireEvent.change(screen.getByLabelText('תנאי'), { target: { value: 'pct_down' } });
  fireEvent.change(screen.getByLabelText('אחוז (%)'), { target: { value: '2.5' } });
  fireEvent.change(screen.getByLabelText('הערה (לא חובה)'), { target: { value: 'לקנות עוד' } });
  fireEvent.click(screen.getByRole('button', { name: 'הוספת התראה' }));
  await waitFor(() => expect(api.create).toHaveBeenCalled());
  expect(api.create.mock.calls[0][0]).toMatchObject({ market: 'US', symbol: 'KO', ruleType: 'pct_down', value: 2.5, note: 'לקנות עוד' });
  expect(await screen.findByRole('status')).toHaveTextContent('ההתראה נוספה. מחיר אחרון: 90.11 $.');
});

test('server errors are shown', async () => {
  renderPrices({ create: jest.fn().mockRejectedValue(new Error('לא נמצא מחיר לנייר הזה - בדקו את הסימול')) });
  fireEvent.change(screen.getByLabelText('סימול'), { target: { value: 'ZZZZ' } });
  fireEvent.change(screen.getByLabelText('מחיר ($)'), { target: { value: '5' } });
  fireEvent.click(screen.getByRole('button', { name: 'הוספת התראה' }));
  expect(await screen.findByRole('status')).toHaveTextContent('לא נמצא מחיר');
});

test('a full list disables the form', () => {
  renderPrices({ max: 3 });
  expect(screen.getByRole('button', { name: 'הוספת התראה' })).toBeDisabled();
  expect(screen.getByText(/מספר ההתראות המרבי/)).toBeInTheDocument();
});

test('without a priceAlerts prop the view loads the rules itself', async () => {
  const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ rules: [rules[1]], max: 50 }) });
  const original = global.fetch;
  global.fetch = fetchMock;
  try {
    render(<AlertsView alerts={[]} unreadCount={0} />);
    expect(fetchMock).not.toHaveBeenCalled(); // only when the tab opens
    fireEvent.click(screen.getByRole('tab', { name: 'התראות מחיר' }));
    expect(await screen.findByText('טבע (629014)')).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/price-alerts$/);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'include' });
  } finally {
    global.fetch = original;
  }
});
