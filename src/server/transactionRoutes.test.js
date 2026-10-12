/**
 * @jest-environment node
 */
// Integration: the real routes on the real SQLite store (in memory).
const express = require('express');
const { mountTransactionRoutes } = require('./transactionRoutes');
const { request, tokenFor, listen } = require('./testUtils/http');
const { STORE_FACTORIES } = require('./testUtils/stores');

describe.each(STORE_FACTORIES)('transactions API (%s store)', (_name, makeStore) => {
  let store;
  let server;
  let baseUrl;
  let token;
  let userId;

  beforeEach(async () => {
    store = await makeStore();
    ({ id: userId } = await store.insertUser('a@b.com', 'x'));
    token = tokenFor(userId);
    await store.upsertPortfolio(
      userId,
      JSON.stringify({
        israeliStocks: [],
        americanStocks: [
          { id: 1, stockName: 'AAPL', purchaseDate: '2024-01-02', purchasePrice: 180, quantity: 10, exchangeRate: 3.7 },
          { id: 2, stockName: 'AAPL', purchaseDate: '2024-06-03', purchasePrice: 200, quantity: 5, exchangeRate: 3.72 }
        ],
        pensionFunds: [{ id: 5, fundName: 'גמל', currentValue: 1000, deposits: [] }],
        bankBalances: [],
        cashFunds: [],
        bankSavingsFunds: []
      })
    );
    const app = express();
    app.use(express.json());
    mountTransactionRoutes(app, store, { now: () => '2025-06-30' });
    ({ server, baseUrl } = await listen(app));
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  });

  const sale = { type: 'SELL', date: '2025-03-10', assetClass: 'american', assetId: 'AAPL', units: 12, price: 220, fees: 2, fxRate: 3.6 };

  test('requires auth', async () => {
    const res = await request(baseUrl, 'GET', '/api/transactions');
    expect(res.status).toBe(401);
  });

  test('a sale is stored with its allocations and the lots are reduced atomically', async () => {
    const res = await request(baseUrl, 'POST', '/api/transactions', { body: sale, token });
    expect(res.status).toBe(201);
    expect(res.body.transaction.allocations.map((a) => [a.lotId, a.units])).toEqual([[1, 10], [2, 2]]);
    expect(res.body.portfolio.americanStocks.map((l) => [l.id, l.quantity])).toEqual([[2, 3]]);

    const stored = JSON.parse(await store.getPortfolioPayload(userId));
    expect(stored.americanStocks.map((l) => [l.id, l.quantity])).toEqual([[2, 3]]);

    const list = await request(baseUrl, 'GET', '/api/transactions', { token });
    expect(list.body.transactions).toHaveLength(1);
    expect(list.body.transactions[0]).toMatchObject({ type: 'SELL', assetId: 'AAPL', units: 12, fees: 2, fxRate: 3.6, currency: 'USD', lotMethod: 'FIFO' });
    expect(list.body.transactions[0].allocations).toHaveLength(2);
  });

  test('preview shows the allocations without saving anything', async () => {
    const res = await request(baseUrl, 'POST', '/api/transactions/preview', { body: { ...sale, lotMethod: 'HIFO' }, token });
    expect(res.status).toBe(200);
    expect(res.body.transaction.allocations.map((a) => a.lotId)).toEqual([2, 1]);
    expect(await store.listTransactions(userId)).toEqual([]);
  });

  test('overselling is refused and changes nothing', async () => {
    const res = await request(baseUrl, 'POST', '/api/transactions', { body: { ...sale, units: 16 }, token });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INSUFFICIENT_UNITS');
    expect(await store.listTransactions(userId)).toEqual([]);
    const stored = JSON.parse(await store.getPortfolioPayload(userId));
    expect(stored.americanStocks.map((l) => l.quantity)).toEqual([10, 5]);
  });

  test('invalid input and future dates are rejected with 400', async () => {
    expect((await request(baseUrl, 'POST', '/api/transactions', { body: { ...sale, date: '2025-07-01' }, token })).status).toBe(400);
    expect((await request(baseUrl, 'POST', '/api/transactions', { body: { ...sale, fxRate: 0 }, token })).status).toBe(400);
  });

  test('deleting a sale restores the lots', async () => {
    const created = await request(baseUrl, 'POST', '/api/transactions', { body: sale, token });
    const del = await request(baseUrl, 'DELETE', `/api/transactions/${created.body.transaction.id}`, { token });
    expect(del.status).toBe(200);
    const stored = JSON.parse(await store.getPortfolioPayload(userId));
    expect(stored.americanStocks.map((l) => [l.id, l.quantity]).sort()).toEqual([[1, 10], [2, 5]]);
    expect(await store.listTransactions(userId)).toEqual([]);
  });

  test('a withdrawal lands in the account ledger; unknown ids 404', async () => {
    const res = await request(baseUrl, 'POST', '/api/transactions', {
      body: { type: 'WITHDRAWAL', date: '2025-04-01', assetClass: 'pension', assetId: '5', amount: 250 },
      token
    });
    expect(res.status).toBe(201);
    expect(res.body.portfolio.pensionFunds[0].deposits).toEqual([{ date: '2025-04-01', amount: -250, txId: res.body.transaction.id }]);
    expect((await request(baseUrl, 'DELETE', '/api/transactions/nope', { token })).status).toBe(404);
  });

  test('users cannot see or delete each other\'s transactions', async () => {
    const created = await request(baseUrl, 'POST', '/api/transactions', { body: sale, token });
    const { id: otherId } = await store.insertUser('c@d.com', 'x');
    const other = tokenFor(otherId);
    expect((await request(baseUrl, 'GET', '/api/transactions', { token: other })).body.transactions).toEqual([]);
    expect((await request(baseUrl, 'DELETE', `/api/transactions/${created.body.transaction.id}`, { token: other })).status).toBe(404);
  });
});
