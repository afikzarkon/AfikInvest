import { render, screen, fireEvent, within } from '@testing-library/react';
import NewsView, { formatRelative } from './NewsView';

const NOW = new Date('2026-10-14T12:00:00Z');

const payload = {
  items: [
    {
      id: 'rss:1',
      source: 'yahoo',
      kind: 'headline',
      ticker: 'KO',
      touches: ['CVX', 'KO'],
      title: 'Coca-Cola or Chevron: The One Dividend Stock',
      summary: 'Two dividend payers.',
      link: 'https://finance.yahoo.com/a',
      time: '2026-10-14T10:00:00Z',
      tags: ['capital']
    },
    {
      id: 'rss:2',
      source: 'yahoo',
      kind: 'headline',
      ticker: 'AAPL',
      touches: ['AAPL'],
      title: 'Apple may have a way to dominate the smart home space',
      summary: '',
      link: 'https://finance.yahoo.com/b',
      time: '2026-10-14T09:00:00Z',
      tags: []
    },
    {
      id: 'sec:1',
      source: 'sec',
      kind: 'filing',
      form: '8-K',
      ticker: 'AAPL',
      touches: ['AAPL'],
      title: 'Apple Inc. הגישה דיווח 8-K: תוצאות כספיות',
      summary: 'Current report',
      link: 'https://www.sec.gov/x',
      time: '2026-10-10T20:30:28Z',
      tags: ['earnings'],
      important: true
    }
  ],
  symbols: ['AAPL', 'KO'],
  unsupported: [],
  secConfigured: true,
  errors: []
};

function mockFetch(body, ok = true) {
  global.fetch = jest.fn().mockResolvedValue({ ok, statusText: ok ? 'OK' : 'Error', json: async () => body });
}

const user = { id: 'u1' };
const us = [{ stockName: 'AAPL' }, { stockName: 'KO' }];

afterEach(() => {
  delete global.fetch;
});

test('lists items grouped by day with source badges, links out, and filters by ticker and tag', async () => {
  mockFetch(payload);
  render(<NewsView user={user} authHeader={() => ({ Authorization: 'Bearer t' })} americanStocks={us} now={NOW} />);
  const link = await screen.findByRole('link', { name: /Coca-Cola or Chevron/ });
  expect(link).toHaveAttribute('target', '_blank');
  expect(link.getAttribute('rel')).toContain('noopener');
  expect(global.fetch.mock.calls[0][0]).toContain('/api/news?hours=72');
  expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer t');
  expect(screen.getByRole('heading', { name: 'היום' })).toBeInTheDocument();
  expect(screen.getAllByText('SEC · 8-K')).toHaveLength(1);
  expect(screen.getAllByText('Yahoo')).toHaveLength(2);
  expect(screen.getByText("לפני 2 שע'")).toBeInTheDocument();

  const tickerChips = screen.getByRole('group', { name: 'סינון לפי מניה' });
  fireEvent.click(within(tickerChips).getByRole('button', { name: 'AAPL' }));
  expect(screen.queryByRole('link', { name: /Coca-Cola/ })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Apple may have/ })).toBeInTheDocument();

  const tagChips = screen.getByRole('group', { name: 'סינון לפי נושא' });
  fireEvent.click(within(tagChips).getByRole('button', { name: 'דוחות' }));
  expect(screen.queryByRole('link', { name: /Apple may have/ })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: /תוצאות כספיות/ })).toHaveAttribute('href', 'https://www.sec.gov/x');
  expect(screen.getByText(/אין לראות בכך ייעוץ השקעות/)).toBeInTheDocument();
});

test('notices: SEC not configured; TASE-only portfolio', async () => {
  mockFetch({ ...payload, secConfigured: false, items: payload.items.slice(0, 2) });
  const { unmount } = render(<NewsView user={user} americanStocks={us} now={NOW} />);
  expect(await screen.findByText(/חסר SEC_USER_AGENT/)).toBeInTheDocument();
  unmount();

  mockFetch({ items: [], symbols: [], unsupported: [{ symbol: '1081124', market: 'TASE', name: 'אלביט' }], secConfigured: true, errors: [] });
  render(<NewsView user={user} israeliStocks={[{ stockName: '1081124' }]} now={NOW} />);
  expect(await screen.findByText(/רק ניירות שנסחרים בבורסת תל אביב/)).toBeInTheDocument();
});

test('loading, then error state', async () => {
  mockFetch({ error: 'שגיאת שרת' }, false);
  render(<NewsView user={user} americanStocks={us} now={NOW} />);
  expect(screen.getByText('טוען חדשות…')).toBeInTheDocument();
  expect(await screen.findByRole('alert')).toHaveTextContent('שגיאת שרת');
});

test('empty window', async () => {
  mockFetch({ ...payload, items: [] });
  render(<NewsView user={user} americanStocks={us} now={NOW} />);
  expect(await screen.findByText(/אין חדשות להצגה/)).toBeInTheDocument();
});

test('formatRelative', () => {
  expect(formatRelative('2026-10-14T11:55:00Z', NOW)).toBe("לפני 5 דק'");
  expect(formatRelative('2026-10-13T11:00:00Z', NOW)).toBe('אתמול');
  expect(formatRelative('2026-10-10T12:00:00Z', NOW)).toBe('לפני 4 ימים');
  expect(formatRelative(null, NOW)).toBe('זמן לא ידוע');
});
