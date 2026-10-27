import { renderHook, waitFor } from '@testing-library/react';
import { useIsraeliStockSearch } from './useIsraeliStockSearch';

describe('useIsraeliStockSearch', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
    delete global.fetch;
  });

  test('does not call the endpoint for a query shorter than 2 characters', () => {
    renderHook(() => useIsraeliStockSearch('ט'));
    jest.advanceTimersByTime(500);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('debounces: only issues one request after the user stops typing, using the final value', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ securityId: '629014', officialName: 'טבע', symbol: 'TEVA' }] })
    });

    const { result, rerender } = renderHook(({ query }) => useIsraeliStockSearch(query), {
      initialProps: { query: 'ט' }
    });
    rerender({ query: 'טב' });
    jest.advanceTimersByTime(100);
    rerender({ query: 'טבע' });

    jest.advanceTimersByTime(300);
    await waitFor(() => expect(result.current.results).toHaveLength(1));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining(encodeURIComponent('טבע')));
    expect(result.current.results).toEqual([{ securityId: '629014', officialName: 'טבע', symbol: 'TEVA' }]);
  });

  test('degrades to an empty result list (not throwing) when the request fails', async () => {
    global.fetch.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useIsraeliStockSearch('טבע'));
    jest.advanceTimersByTime(300);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.results).toEqual([]);
  });
});
