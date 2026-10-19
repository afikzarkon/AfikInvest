/**
 * @jest-environment node
 */
const { createSymbolCache, FAILURE_RETRY_MS } = require('./symbolCache');

const NULLS = { sector: null, industry: null };
const makeCache = (fetchOne, ttlMs = 60_000) =>
  createSymbolCache({ name: 'test', ttlMs, fetchOne, fallback: () => ({ ...NULLS }) });

describe('createSymbolCache', () => {
  test('resolves a symbol and serves it from cache afterwards', async () => {
    const fetchOne = jest.fn().mockResolvedValue({ sector: 'Technology', industry: 'Semiconductors' });
    const cache = makeCache(fetchOne);

    expect(await cache.get('NVDA')).toEqual({ sector: 'Technology', industry: 'Semiconductors' });
    expect(await cache.get('NVDA')).toEqual({ sector: 'Technology', industry: 'Semiconductors' });
    expect(fetchOne).toHaveBeenCalledTimes(1);
  });

  test('asks upstream once however many callers arrive at the same time', async () => {
    let release;
    const fetchOne = jest.fn(() => new Promise((r) => { release = () => r({ sector: 'Tech', industry: 'X' }); }));
    const cache = makeCache(fetchOne);

    const all = Promise.all([cache.get('NVDA'), cache.get('NVDA'), cache.get('NVDA')]);
    release();
    const results = await all;

    expect(fetchOne).toHaveBeenCalledTimes(1);
    results.forEach((r) => expect(r.sector).toBe('Tech'));
  });

  // THE BUG THIS MODULE EXISTS FOR. Yahoo answers a burst with a 429 often
  // enough to be routine; the old per-route caches wrote the null
  // placeholder over the good value, so one rate-limited refresh blanked a
  // portfolio that had been showing real sectors all day.
  test('a failed refresh serves the last known value instead of nulls', async () => {
    const fetchOne = jest
      .fn()
      .mockResolvedValueOnce({ sector: 'Technology', industry: 'Semiconductors' })
      .mockRejectedValue(new Error('429 Too Many Requests'));

    // ttl 0 so the second call is always a refresh attempt.
    const cache = makeCache(fetchOne, 0);

    expect(await cache.get('NVDA')).toEqual({ sector: 'Technology', industry: 'Semiconductors' });
    expect(await cache.get('NVDA')).toEqual({ sector: 'Technology', industry: 'Semiconductors' });
    expect(fetchOne).toHaveBeenCalledTimes(2); // it did try, and it did fail
  });

  // A symbol that has never resolved has nothing better to offer, so the
  // caller's own placeholder is the honest answer.
  test('falls back to nulls only when there has never been a good value', async () => {
    const fetchOne = jest.fn().mockRejectedValue(new Error('down'));
    const cache = makeCache(fetchOne);

    expect(await cache.get('NOPE')).toEqual(NULLS);
  });

  test('a failed symbol is not retried on every call', async () => {
    const fetchOne = jest.fn().mockRejectedValue(new Error('down'));
    const cache = makeCache(fetchOne);

    await cache.get('NOPE');
    await cache.get('NOPE');
    await cache.get('NOPE');

    expect(fetchOne).toHaveBeenCalledTimes(1);
  });

  // After a failed refresh the good value stays, but its clock is moved so
  // the next caller waits out the retry window rather than re-requesting a
  // failing upstream on every render.
  test('a failed refresh backs off before trying upstream again', async () => {
    const fetchOne = jest
      .fn()
      .mockResolvedValueOnce({ sector: 'Technology', industry: 'Semiconductors' })
      .mockRejectedValue(new Error('429'));
    const cache = makeCache(fetchOne, 0);

    await cache.get('NVDA'); // resolves
    await cache.get('NVDA'); // refresh fails, serves stale
    await cache.get('NVDA'); // inside the retry window - no new request

    expect(fetchOne).toHaveBeenCalledTimes(2);

    // The entry still holds the real value, not the placeholder.
    expect(cache._peek('NVDA').data).toEqual({ sector: 'Technology', industry: 'Semiconductors' });
    expect(FAILURE_RETRY_MS).toBeGreaterThan(0);
  });

  test('a symbol that recovers upstream picks the fresh value back up', async () => {
    const fetchOne = jest
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue({ sector: 'Technology', industry: 'Semiconductors' });
    const cache = makeCache(fetchOne, 0);

    expect(await cache.get('NVDA')).toEqual(NULLS);
    cache._clear();
    expect(await cache.get('NVDA')).toEqual({ sector: 'Technology', industry: 'Semiconductors' });
  });

  test('keeps symbols independent of one another', async () => {
    const fetchOne = jest.fn((symbol) =>
      symbol === 'BAD' ? Promise.reject(new Error('down')) : Promise.resolve({ sector: 'Tech', industry: symbol })
    );
    const cache = makeCache(fetchOne);

    expect(await cache.get('BAD')).toEqual(NULLS);
    expect(await cache.get('NVDA')).toEqual({ sector: 'Tech', industry: 'NVDA' });
  });

  // Persistence: after a restart the cache starts from the database, so a
  // value saved within its TTL costs no upstream request at all.
  describe('with a database (memory)', () => {
    const memoryWith = (saved) => {
      const store = new Map(Object.entries(saved));
      return {
        get: jest.fn(async (key) => store.get(key) || null),
        set: jest.fn(async (key, value) => {
          store.set(key, { value, savedAt: Date.now() });
        })
      };
    };
    const makePersisted = (fetchOne, memory, ttlMs = 60_000) =>
      createSymbolCache({ name: 'test', ttlMs, fetchOne, fallback: () => ({ ...NULLS }), memory, memoryKey: (s) => `p:${s}` });

    test('a value saved within its TTL is served without asking upstream', async () => {
      const memory = memoryWith({ 'p:NVDA': { value: { sector: 'Technology', industry: 'Semis' }, savedAt: Date.now() - 1000 } });
      const fetchOne = jest.fn();
      const cache = makePersisted(fetchOne, memory);

      expect(await cache.get('NVDA')).toEqual({ sector: 'Technology', industry: 'Semis' });
      expect(fetchOne).not.toHaveBeenCalled();
    });

    test('an older saved value is the fallback when the refresh fails', async () => {
      const memory = memoryWith({ 'p:NVDA': { value: { sector: 'Technology', industry: 'Semis' }, savedAt: Date.now() - 10 * 60_000 } });
      const fetchOne = jest.fn().mockRejectedValue(new Error('429'));
      const cache = makePersisted(fetchOne, memory);

      expect(await cache.get('NVDA')).toEqual({ sector: 'Technology', industry: 'Semis' });
      expect(fetchOne).toHaveBeenCalledTimes(1);
    });

    test('good values are saved, placeholders are not', async () => {
      const memory = memoryWith({});
      const fetchOne = jest.fn((s) => (s === 'BAD' ? Promise.reject(new Error('down')) : Promise.resolve({ sector: 'Tech', industry: s })));
      const cache = makePersisted(fetchOne, memory);

      await cache.get('NVDA');
      await cache.get('BAD');
      expect(memory.set).toHaveBeenCalledTimes(1);
      expect(memory.set).toHaveBeenCalledWith('p:NVDA', { sector: 'Tech', industry: 'NVDA' });
    });
  });
});
