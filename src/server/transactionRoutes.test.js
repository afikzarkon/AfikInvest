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

  // A deposit can open the account it goes into, so creating an account is
  // a ledger entry too - listed, and undone by deleting it.
  test('a deposit with newAccount opens the account; deleting it removes the account again', async () => {
    const open = {
      type: 'DEPOSIT',
      date: '2025-02-01',
      assetClass: 'cashFunds',
      amount: 5000,
      newAccount: { fundName: 'כספית', securityId: '5119609' }
    };
    const res = await request(baseUrl, 'POST', '/api/transactions', { body: open, token });
    expect(res.status).toBe(201);
    const [fund] = res.body.portfolio.cashFunds;
    expect(fund).toMatchObject({ fundName: 'כספית', securityId: '5119609', currentValue: 5000, currentValueDate: '2025-02-01' });
    expect(fund.deposits).toEqual([{ date: '2025-02-01', amount: 5000, txId: res.body.transaction.id }]);
    expect(res.body.transaction).toMatchObject({ assetId: String(fund.id), createdAccountId: fund.id });

    const del = await request(baseUrl, 'DELETE', `/api/transactions/${res.body.transaction.id}`, { token });
    expect(del.status).toBe(200);
    expect(del.body.portfolio.cashFunds).toEqual([]);
  });

  test('a new account needs what identifies it', async () => {
    const res = await request(baseUrl, 'POST', '/api/transactions', {
      body: { type: 'DEPOSIT', date: '2025-02-01', assetClass: 'pension', amount: 10, newAccount: {} },
      token
    });
    expect(res.status).toBe(400);
  });

  // An edit is an undo + redo in ONE database transaction.
  test('editing a sale replaces it atomically; an edit the ledger refuses changes nothing', async () => {
    const first = await request(baseUrl, 'POST', '/api/transactions', { body: sale, token });
    const id = first.body.transaction.id;

    const edited = await request(baseUrl, 'PUT', `/api/transactions/${id}`, { body: { ...sale, units: 4 }, token });
    expect(edited.status).toBe(200);
    const lots = (p) => p.americanStocks.map((l) => [l.id, l.quantity]).sort((a, b) => a[0] - b[0]);
    expect(lots(edited.body.portfolio)).toEqual([[1, 6], [2, 5]]);
    const list = (await request(baseUrl, 'GET', '/api/transactions', { token })).body.transactions;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ units: 4, id: edited.body.transaction.id });

    const refused = await request(baseUrl, 'PUT', `/api/transactions/${edited.body.transaction.id}`, { body: { ...sale, units: 99 }, token });
    expect(refused.status).toBe(409);
    const stored = JSON.parse(await store.getPortfolioPayload(userId));
    expect(lots(stored)).toEqual([[1, 6], [2, 5]]);
    expect((await request(baseUrl, 'GET', '/api/transactions', { token })).body.transactions[0].units).toBe(4);
  });

  test('an edit cannot change the type', async () => {
    const first = await request(baseUrl, 'POST', '/api/transactions', { body: sale, token });
    const res = await request(baseUrl, 'PUT', `/api/transactions/${first.body.transaction.id}`, {
      body: { ...sale, type: 'BUY' },
      token
    });
    expect(res.status).toBe(400);
  });

  test("editing an account's opening deposit keeps the same account", async () => {
    const open = { type: 'DEPOSIT', date: '2025-02-01', assetClass: 'pension', amount: 1000, newAccount: { fundName: 'השתלמות' } };
    const created = await request(baseUrl, 'POST', '/api/transactions', { body: open, token });
    const accountId = created.body.transaction.createdAccountId;
    const edited = await request(baseUrl, 'PUT', `/api/transactions/${created.body.transaction.id}`, {
      body: { ...open, amount: 1500 },
      token
    });
    expect(edited.status).toBe(200);
    const funds = edited.body.portfolio.pensionFunds.filter((f) => f.fundName === 'השתלמות');
    expect(funds).toHaveLength(1);
    expect(funds[0]).toMatchObject({ id: accountId, currentValue: 1500 });
    expect(funds[0].deposits.map((d) => d.amount)).toEqual([1500]);
  });

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
