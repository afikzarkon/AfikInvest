/**
 * @jest-environment node
 */
const { createMarketMemory, WRITE_INTERVAL_MS } = require('./marketMemory');

function fakeSql(rows = {}) {
  return {
    get: jest.fn(async (text, [key]) => rows[key] || null),
    run: jest.fn(async () => ({ changes: 1, rows: [] }))
  };
}

describe('marketMemory', () => {
  test('without a database it remembers nothing it was not told this run', async () => {
    const memory = createMarketMemory();
    expect(await memory.get('quote:us:AAPL')).toBeNull();
    await memory.set('quote:us:AAPL', { currentPrice: 1 });
    expect((await memory.get('quote:us:AAPL')).value).toEqual({ currentPrice: 1 });
  });

  test('reads a saved value with the time it was saved, and asks the database only once per key', async () => {
    const sql = fakeSql({ 'profile:NVDA': { value: '{"sector":{"sector":"Technology"}}', updated_at: '2026-10-19T08:00:00.000Z' } });
    const memory = createMarketMemory();
    memory.attach(sql);

    const first = await memory.get('profile:NVDA');
    expect(first).toEqual({ value: { sector: { sector: 'Technology' } }, savedAt: Date.parse('2026-10-19T08:00:00.000Z') });
    await memory.get('profile:NVDA');
    await memory.get('profile:NVDA');
    expect(sql.get).toHaveBeenCalledTimes(1);
  });

  // A quote refreshes every minute; the database copy only needs to be
  // recent enough to show after a restart.
  test('throttles writes per key', async () => {
    let t = 1_000_000;
    const sql = fakeSql();
    const memory = createMarketMemory({ now: () => t });
    memory.attach(sql);

    await memory.set('quote:tase:1', { currentPrice: 1 });
    t += 60 * 1000;
    await memory.set('quote:tase:1', { currentPrice: 2 });
    await memory.set('quote:tase:2', { currentPrice: 3 });
    expect(sql.run).toHaveBeenCalledTimes(2); // tase:1 once, tase:2 once

    t += WRITE_INTERVAL_MS;
    await memory.set('quote:tase:1', { currentPrice: 4 });
    expect(sql.run).toHaveBeenCalledTimes(3);
    // The in-process copy is always the latest, written or not.
    expect((await memory.get('quote:tase:1')).value).toEqual({ currentPrice: 4 });
  });

  test('a database error never throws, and a failed read is retried next time', async () => {
    const sql = { get: jest.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(null), run: jest.fn().mockRejectedValue(new Error('db down')) };
    const memory = createMarketMemory();
    memory.attach(sql);

    await expect(memory.get('quote:us:MSFT')).resolves.toBeNull();
    await expect(memory.get('quote:us:MSFT')).resolves.toBeNull();
    expect(sql.get).toHaveBeenCalledTimes(2);
    await expect(memory.set('quote:us:MSFT', { currentPrice: 1 })).resolves.toBeUndefined();
  });
});
