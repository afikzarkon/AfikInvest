import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { render, screen, fireEvent, within } from '@testing-library/react';
import TradeSimView from './TradeSimView';
import { runTradeSim } from '../shared/tradeSim';

// A real API answer: the shared engine on the recorded TSLA bars (the reel's plan at 10:15 ET).
const RESULT = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'server', 'fixtures', 'trade-sim', 'TSLA-60d5m.json.gz'))).toString('utf8')).chart.result[0];
const ANSWER = runTradeSim(
  RESULT,
  { symbol: 'TSLA', entry: 364.18, stop: { type: 'or_mid' }, target: { type: 'r', value: 1 }, account: 5000, maxLossPerTrade: 50, sims: 2000 },
  Date.UTC(2026, 9, 19, 14, 15)
);

const user = { id: 'u1' };
const authHeader = () => ({ Authorization: 'Bearer t' });

afterEach(() => {
  delete global.fetch;
});

test('the disclaimer is on the page before anything runs; held US stocks are suggested', () => {
  render(<TradeSimView user={user} authHeader={authHeader} americanStocks={[{ stockName: 'tsla' }, { stockName: 'AAPL' }, { stockName: 'tsla' }]} />);
  expect(screen.getByRole('note', { name: 'הבהרה' })).toHaveTextContent('לא תחזית');
  expect(screen.getByRole('note', { name: 'הבהרה' })).toHaveTextContent('אינה ייעוץ השקעות');
  expect(screen.getByRole('note', { name: 'הבהרה' })).toHaveTextContent('סטופ אינו הבטחה');
  expect(screen.getByLabelText('סימול')).toHaveValue('AAPL');
  const options = Array.from(document.querySelectorAll('#ts-held option')).map((o) => o.value);
  expect(options).toEqual(['AAPL', 'TSLA']);
});

test('submits the plan and shows the plan, odds, history, shares and verdict', async () => {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ANSWER }));
  render(<TradeSimView user={user} authHeader={authHeader} americanStocks={[{ stockName: 'TSLA' }]} />);
  fireEvent.change(screen.getByLabelText('מחיר כניסה'), { target: { value: '364.18' } });
  fireEvent.change(screen.getByLabelText('סטופ'), { target: { value: 'or_mid' } });
  expect(screen.queryByLabelText(/ערך הסטופ/)).toBeNull(); // the opening range needs no number
  fireEvent.change(screen.getByLabelText('ערך היעד'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: 'הריצו סימולציה' }));

  expect(await screen.findByTestId('ts-shares')).toHaveTextContent('8 מניות');
  const [url, opts] = global.fetch.mock.calls[0];
  expect(url).toMatch(/\/api\/trade-sim$/);
  expect(opts.headers.Authorization).toBe('Bearer t');
  expect(JSON.parse(opts.body)).toMatchObject({ symbol: 'TSLA', entry: 364.18, stop: { type: 'or_mid' }, target: { type: 'r', value: 1 }, account: 5000, maxLossPerTrade: 50 });

  expect(screen.getByTestId('ts-entry')).toHaveTextContent('$364.18');
  expect(screen.getByTestId('ts-rr')).toHaveTextContent('1 : 1');
  const sizing = screen.getByRole('region', { name: 'כמה מניות' });
  expect(within(sizing).getByText('הפסד מרבי לעסקה')).toBeInTheDocument();
  expect(within(sizing).getAllByText('$46.88').length).toBeGreaterThan(0);
  expect(screen.getByTestId('ts-odds-target')).toHaveTextContent(`${(100 * ANSWER.odds.target).toFixed(1)}%`);
  expect(screen.getByTestId('ts-odds-stop')).toHaveTextContent(`${(100 * ANSWER.odds.stop).toFixed(1)}%`);
  expect(screen.getByTestId('ts-history')).toHaveTextContent('הופעל 33 פעמים ב-59 ימי מסחר');
  expect(screen.getByTestId('ts-verdict')).toHaveTextContent(ANSWER.verdict);
  expect(screen.getByTestId('ts-coverage')).toHaveTextContent('59 ימי מסחר מלאים');
});

test('a refused plan shows the server\'s Hebrew reason', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, json: async () => ({ error: 'הסטופ $365.00 נמצא בגובה הכניסה', code: 'stop_above_entry' }) }));
  render(<TradeSimView user={user} authHeader={authHeader} americanStocks={[]} />);
  fireEvent.change(screen.getByLabelText('סימול'), { target: { value: 'tsla' } });
  fireEvent.click(screen.getByRole('button', { name: 'הריצו סימולציה' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('הסטופ $365.00');
});
