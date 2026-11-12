import { render, screen, fireEvent, within } from '@testing-library/react';
import CongressView from './CongressView';

const row = (over) => ({
  owner: 'SP',
  ownerName: 'spouse',
  asset: 'Bloom Energy Corporation Class A Common Stock',
  ticker: 'BE',
  assetType: 'OP',
  type: 'P',
  typeName: 'purchase',
  date: '2026-07-24',
  amount: '$1,000,001 - $5,000,000',
  amountLow: 1000001,
  amountHigh: 5000000,
  daysToDisclose: 28,
  late: false,
  ...over
});

const body = {
  filings: [
    {
      docId: '20035590',
      memberName: 'Hon. Josh Gottheimer',
      stateDistrict: 'NJ05',
      filedDate: '2026-10-07',
      pdfUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20035590.pdf',
      parseStatus: 'parsed',
      rows: [row({ owner: 'JT', ownerName: 'joint', ticker: 'AMAT', asset: 'Applied Materials, Inc. - Common Stock', type: 'S', amountLow: 1001, amountHigh: 15000, daysToDisclose: 52, late: true })]
    },
    {
      docId: '20035580',
      memberName: 'Hon. Lloyd Doggett',
      stateDistrict: 'TX37',
      filedDate: '2026-10-05',
      pdfUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20035580.pdf',
      parseStatus: 'no_text',
      rows: []
    },
    {
      docId: '20035143',
      memberName: 'Hon. Nancy Pelosi',
      stateDistrict: 'CA11',
      filedDate: '2026-08-21',
      pdfUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20035143.pdf',
      parseStatus: 'parsed',
      rows: [row({ option: { contracts: 100, kind: 'call', strike: 100, expires: '2027-06-17', exercised: false } })]
    }
  ],
  heldTickers: [{ ticker: 'AMAT', name: 'Applied Materials', trades: 1, lastTradeDate: '2026-09-15', members: ['Hon. Josh Gottheimer'] }],
  lastScanAt: '2026-10-13T10:00:00.000Z'
};

beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, statusText: 'OK', json: async () => body });
});

test('lists trades with held tickers highlighted, filters by member and holdings', async () => {
  render(<CongressView user={{ id: 1 }} authHeader={() => ({ Authorization: 'Bearer t' })} americanStocks={[]} />);
  const table = await screen.findByRole('table', { name: 'עסקאות חברי קונגרס' });
  expect(global.fetch.mock.calls[0][0]).toContain('/api/congress?days=90');
  expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer t');

  // Three lines: two trades and the scanned filing that needs a manual read.
  expect(within(table).getAllByRole('row')).toHaveLength(4);
  expect(screen.getByText('הדיווח הוא מסמך סרוק - יש לפתוח את ה-PDF')).toBeInTheDocument();
  expect(within(table).getAllByRole('link', { name: 'PDF' })[0]).toHaveAttribute('href', body.filings[0].pdfUrl);
  expect(screen.getByText('מכירה')).toHaveClass('value-pill', 'is-negative');
  expect(screen.getByText('קנייה')).toHaveClass('is-positive');
  expect(screen.getByText(/100 אופציות CALL, מימוש \$100, פקיעה 17\/06\/2027/)).toBeInTheDocument();
  expect(screen.getByText('52 (באיחור)', { exact: false })).toBeInTheDocument();

  const amatCell = within(table).getAllByText('AMAT')[0].closest('tr');
  expect(amatCell).toHaveClass('congress-row-held');
  expect(screen.getByText('מניות שבתיק שלך בדיווחים')).toBeInTheDocument();
  expect(screen.getByText(/STOCK/)).toHaveTextContent('הסנאט אינם כלולים');

  fireEvent.change(screen.getByLabelText('חבר/ת קונגרס'), { target: { value: 'pelosi' } });
  expect(within(table).getAllByRole('row')).toHaveLength(2);
  expect(within(table).getByText('BE')).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('חבר/ת קונגרס'), { target: { value: '' } });
  fireEvent.click(screen.getByLabelText('רק מניות שבתיק'));
  expect(within(table).getAllByRole('row')).toHaveLength(2);
  expect(within(table).getByText('AMAT')).toBeInTheDocument();
});

test('a lot in the live portfolio counts as held too', async () => {
  render(<CongressView user={{ id: 1 }} authHeader={() => ({})} americanStocks={[{ stockName: 'be', quantity: 5 }]} />);
  const table = await screen.findByRole('table', { name: 'עסקאות חברי קונגרס' });
  fireEvent.click(screen.getByLabelText('רק מניות שבתיק'));
  expect(within(table).getAllByRole('row')).toHaveLength(3);
});
