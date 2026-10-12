import { act, renderHook } from '@testing-library/react';
import { usePriceRefresh, refreshIsraeliStocks, refreshAmericanStocks } from './usePriceRefresh';
import { fetchAmericanStockPrices, fetchIsraeliStockPrices } from '../api/stockPrices';

jest.mock('../api/stockPrices', () => ({
  fetchIsraeliStockPrices: jest.fn(),
  fetchAmericanStockPrices: jest.fn()
}));

// The setters are React state setters, so the refresh functions call them
// with an updater function rather than a plain array. This applies that
// updater to a starting array, the way React would.
function applyUpdate(setter, current) {
  const updater = setter.mock.calls[0][0];
  return typeof updater === 'function' ? updater(current) : updater;
}

describe('refreshIsraeliStocks', () => {
  beforeEach(() => {
    fetchIsraeliStockPrices.mockReset();
  });

  test('does nothing when there are no Israeli stocks', async () => {
    const setIsraeliStocks = jest.fn();
    await refreshIsraeliStocks([], setIsraeliStocks);
    expect(setIsraeliStocks).not.toHaveBeenCalled();
    expect(fetchIsraeliStockPrices).not.toHaveBeenCalled();
  });

  // The batching fix: one request for the whole Israeli side of the
  // portfolio, with each unique security id asked for once - not one HTTP
  // request per unique symbol (which the browser then serializes six at a
  // time).
  test('asks for every unique security id in ONE request and applies each price to all its lots', async () => {
    fetchIsraeliStockPrices.mockResolvedValue({
      TEVA: { currentPrice: 1550, changePercent: 1.2, tradeDate: '2026-10-12' },
      ICL: { currentPrice: 800, changePercent: -0.4, tradeDate: '2026-10-12' }
    });
    const stocks = [
      { stockName: 'TEVA', quantity: 10 },
      { stockName: 'TEVA', quantity: 5 },
      { stockName: 'ICL', quantity: 3 }
    ];
    const setIsraeliStocks = jest.fn();
    await refreshIsraeliStocks(stocks, setIsraeliStocks);

    expect(fetchIsraeliStockPrices).toHaveBeenCalledTimes(1);
    expect(fetchIsraeliStockPrices).toHaveBeenCalledWith(['TEVA', 'ICL']);

    // Prices come back in agorot and are converted to shekels; the session
    // date rides along so a stale change can be told apart later.
    const traded = { dailyChangeTradeDate: '2026-10-12' };
    expect(applyUpdate(setIsraeliStocks, stocks)).toEqual([
      { stockName: 'TEVA', quantity: 10, currentPrice: 15.5, dailyChangePercent: 1.2, ...traded },
      { stockName: 'TEVA', quantity: 5, currentPrice: 15.5, dailyChangePercent: 1.2, ...traded },
      { stockName: 'ICL', quantity: 3, currentPrice: 8, dailyChangePercent: -0.4, ...traded }
    ]);
  });

  test('keeps a lot untouched when no price comes back for its security', async () => {
    fetchIsraeliStockPrices.mockResolvedValue({
      TEVA: { currentPrice: 1550, changePercent: 1.2 },
      ICL: { currentPrice: null, changePercent: null }
    });
    const stocks = [
      { stockName: 'TEVA', quantity: 10, currentPrice: 1 },
      { stockName: 'ICL', quantity: 3, currentPrice: 99 }
    ];
    const setIsraeliStocks = jest.fn();
    await refreshIsraeliStocks(stocks, setIsraeliStocks);

    expect(applyUpdate(setIsraeliStocks, stocks)).toEqual([
      { stockName: 'TEVA', quantity: 10, currentPrice: 15.5, dailyChangePercent: 1.2, dailyChangeTradeDate: null },
      { stockName: 'ICL', quantity: 3, currentPrice: 99 }
    ]);
  });

  // A failed refresh must never blank the prices already on screen - the
  // whole point of rendering from the persisted snapshot first.
  test('leaves state untouched entirely when the batched request comes back empty', async () => {
    fetchIsraeliStockPrices.mockResolvedValue({});
    const setIsraeliStocks = jest.fn();
    await refreshIsraeliStocks([{ stockName: 'TEVA', quantity: 10, currentPrice: 99 }], setIsraeliStocks);
    expect(setIsraeliStocks).not.toHaveBeenCalled();
  });
});

describe('refreshAmericanStocks', () => {
  beforeEach(() => {
    fetchAmericanStockPrices.mockReset();
  });

  test('does nothing when there are no American stocks', async () => {
    const setAmericanStocks = jest.fn();
    await refreshAmericanStocks([], setAmericanStocks);
    expect(setAmericanStocks).not.toHaveBeenCalled();
    expect(fetchAmericanStockPrices).not.toHaveBeenCalled();
  });

  test('applies price and the shared exchange rate (which rides on the same response) to every lot', async () => {
    fetchAmericanStockPrices.mockResolvedValue({
      quotes: { AAPL: { currentPrice: 190, changePercent: 0.8, tradeDate: '2026-10-09' } },
      exchangeRate: 3.7
    });
    const stocks = [
      { stockName: 'AAPL', quantity: 10, exchangeRate: 3.6 },
      { stockName: 'AAPL', quantity: 2, exchangeRate: 3.5 }
    ];
    const setAmericanStocks = jest.fn();
    await refreshAmericanStocks(stocks, setAmericanStocks);

    expect(fetchAmericanStockPrices).toHaveBeenCalledTimes(1);
    expect(fetchAmericanStockPrices).toHaveBeenCalledWith(['AAPL']);
    expect(applyUpdate(setAmericanStocks, stocks)).toEqual([
      { stockName: 'AAPL', quantity: 10, exchangeRate: 3.6, currentPrice: 190, dailyChangePercent: 0.8, dailyChangeTradeDate: '2026-10-09', currentExchangeRate: 3.7 },
      { stockName: 'AAPL', quantity: 2, exchangeRate: 3.5, currentPrice: 190, dailyChangePercent: 0.8, dailyChangeTradeDate: '2026-10-09', currentExchangeRate: 3.7 }
    ]);
  });

  test("falls back to the lot's own exchange rate when no fresh rate came back, and keeps its existing price", async () => {
    fetchAmericanStockPrices.mockResolvedValue({
      quotes: { AAPL: { currentPrice: null, changePercent: 0 } },
      exchangeRate: null
    });
    const stocks = [{ stockName: 'AAPL', quantity: 10, currentPrice: 150, currentExchangeRate: 3.6 }];
    const setAmericanStocks = jest.fn();
    await refreshAmericanStocks(stocks, setAmericanStocks);

    expect(applyUpdate(setAmericanStocks, stocks)).toEqual([
      { stockName: 'AAPL', quantity: 10, currentPrice: 150, currentExchangeRate: 3.6 }
    ]);
  });

  test('degrades gracefully instead of throwing when the batched request returns nothing at all', async () => {
    fetchAmericanStockPrices.mockResolvedValue({ quotes: {}, exchangeRate: null });
    const setAmericanStocks = jest.fn();
    await expect(
      refreshAmericanStocks([{ stockName: 'AAPL', quantity: 10 }], setAmericanStocks)
    ).resolves.toBeUndefined();
    expect(setAmericanStocks).not.toHaveBeenCalled();
  });
});

describe('usePriceRefresh', () => {
  const baseArgs = {
    setIsraeliStocks: jest.fn(),
    setAmericanStocks: jest.fn(),
    isEditMode: false,
    editingField: null,
    isAddingNewStock: false
  };

  // Flushes the microtask hops between a refresh cycle starting and its
  // state updates landing.
  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 10; i++) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
    });
  };

  beforeEach(() => {
    jest.useFakeTimers();
    fetchIsraeliStockPrices.mockReset();
    fetchAmericanStockPrices.mockReset();
    fetchIsraeliStockPrices.mockResolvedValue({ TEVA: { currentPrice: 1000, changePercent: 0 } });
    fetchAmericanStockPrices.mockResolvedValue({
      quotes: { AAPL: { currentPrice: 100, changePercent: 0 } },
      exchangeRate: 3.7
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // The first live prices used to be unobtainable for a full polling
  // interval after load, because the only trigger was setInterval.
  test('fires a refresh immediately on mount, without waiting for a polling interval', async () => {
    renderHook(() =>
      usePriceRefresh({
        ...baseArgs,
        israeliStocks: [{ stockName: 'TEVA', quantity: 1 }],
        americanStocks: []
      })
    );
    await flush();
    expect(fetchIsraeliStockPrices).toHaveBeenCalledTimes(1);
  });

  test('refreshes Israeli and American stocks concurrently, not one gated behind the other', async () => {
    let resolveIsraeli;
    fetchIsraeliStockPrices.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveIsraeli = resolve;
        })
    );

    renderHook(() =>
      usePriceRefresh({
        ...baseArgs,
        israeliStocks: [{ stockName: 'TEVA', quantity: 1 }],
        americanStocks: [{ stockName: 'AAPL', quantity: 1 }]
      })
    );
    await flush();

    // The American request was issued WITHOUT waiting for the still-pending
    // Israeli one to resolve.
    expect(fetchIsraeliStockPrices).toHaveBeenCalled();
    expect(fetchAmericanStockPrices).toHaveBeenCalled();

    resolveIsraeli({ TEVA: { currentPrice: 1000, changePercent: 0.1 } });
    await flush();
  });

  test('skips the refresh entirely while the user is editing or adding a stock', async () => {
    renderHook(() =>
      usePriceRefresh({
        ...baseArgs,
        israeliStocks: [{ stockName: 'TEVA', quantity: 1 }],
        americanStocks: [],
        isEditMode: true
      })
    );
    await flush();
    act(() => {
      jest.advanceTimersByTime(60000);
    });
    await flush();
    expect(fetchIsraeliStockPrices).not.toHaveBeenCalled();
  });

  test('makes no request at all for an empty portfolio', async () => {
    renderHook(() => usePriceRefresh({ ...baseArgs, israeliStocks: [], americanStocks: [] }));
    await flush();
    act(() => {
      jest.advanceTimersByTime(60000);
    });
    await flush();
    expect(fetchIsraeliStockPrices).not.toHaveBeenCalled();
    expect(fetchAmericanStockPrices).not.toHaveBeenCalled();
  });

  test('calls onFirstCycleComplete exactly once, after the first cycle actually settles', async () => {
    const onFirstCycleComplete = jest.fn();
    renderHook(() =>
      usePriceRefresh({
        ...baseArgs,
        israeliStocks: [{ stockName: 'TEVA', quantity: 1 }],
        americanStocks: [],
        onFirstCycleComplete
      })
    );

    await flush();
    expect(onFirstCycleComplete).toHaveBeenCalledTimes(1);

    // A later poll must not fire it again.
    act(() => {
      jest.advanceTimersByTime(60000);
    });
    await flush();
    expect(onFirstCycleComplete).toHaveBeenCalledTimes(1);
  });

  test('does not call onFirstCycleComplete on a cycle skipped for being mid-edit', async () => {
    const onFirstCycleComplete = jest.fn();
    renderHook(() =>
      usePriceRefresh({
        ...baseArgs,
        israeliStocks: [{ stockName: 'TEVA', quantity: 1 }],
        americanStocks: [],
        isEditMode: true,
        onFirstCycleComplete
      })
    );
    await flush();
    expect(onFirstCycleComplete).not.toHaveBeenCalled();
  });

  // The progress flags the home view uses to say whether the prices on
  // screen are live yet or still the last persisted ones.
  test('reports refresh progress so the UI can show a loading indicator instead of passing stale prices off as live', async () => {
    let resolveIsraeli;
    fetchIsraeliStockPrices.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveIsraeli = resolve;
        })
    );

    const { result } = renderHook(() =>
      usePriceRefresh({
        ...baseArgs,
        israeliStocks: [{ stockName: 'TEVA', quantity: 1 }],
        americanStocks: []
      })
    );

    await flush();
    expect(result.current.refreshing).toBe(true);
    expect(result.current.hasLoadedLivePrices).toBe(false);
    expect(result.current.lastRefreshAt).toBeNull();

    resolveIsraeli({ TEVA: { currentPrice: 1000, changePercent: 0 } });
    await flush();

    expect(result.current.refreshing).toBe(false);
    expect(result.current.hasLoadedLivePrices).toBe(true);
    expect(result.current.lastRefreshAt).toBeInstanceOf(Date);
  });

  test('keeps polling on an interval after the first cycle', async () => {
    renderHook(() =>
      usePriceRefresh({
        ...baseArgs,
        israeliStocks: [{ stockName: 'TEVA', quantity: 1 }],
        americanStocks: []
      })
    );
    await flush();
    expect(fetchIsraeliStockPrices).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(60000);
    });
    await flush();
    expect(fetchIsraeliStockPrices).toHaveBeenCalledTimes(2);
  });
});
