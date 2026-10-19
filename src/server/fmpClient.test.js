/**
 * @jest-environment node
 */
const { fetchFmpProfile, fmpRefusedUntil, fmpPlanState, resetFmpBudget } = require('./fmpClient');

const refused402 = () => Object.assign(new Error('Request failed with status code 402'), { response: { status: 402 } });

describe('fmpClient', () => {
  const originalKey = process.env.FMP_API_KEY;

  beforeEach(() => {
    process.env.FMP_API_KEY = 'test-key';
    resetFmpBudget();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    console.warn.mockRestore();
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.FMP_API_KEY;
    else process.env.FMP_API_KEY = originalKey;
  });

  test('reads a profile row', async () => {
    const get = jest.fn().mockResolvedValue({
      data: [{ companyName: 'Apple Inc.', currency: 'USD', price: 230, marketCap: 3.4e12, beta: 1.2, sector: 'Technology', industry: 'Consumer Electronics', isEtf: false }]
    });
    await expect(fetchFmpProfile('AAPL', { get })).resolves.toMatchObject({ name: 'Apple Inc.', sector: 'Technology', price: 230 });
  });

  // THE PRODUCTION REPORT: "fmp is failing: 5 failures in a row - 402".
  // A plan refusal is permanent until the plan changes, so it is asked once,
  // then not again for a day.
  test('a 402 pauses that endpoint: the next call fails at once, with no request', async () => {
    const get = jest.fn().mockRejectedValue(refused402());
    await expect(fetchFmpProfile('AAPL', { get })).rejects.toMatchObject({ response: { status: 402 } });
    expect(fmpRefusedUntil('profile')).not.toBeNull();

    await expect(fetchFmpProfile('MSFT', { get })).rejects.toMatchObject({ code: 'FMP_PLAN' });
    expect(get).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(fmpPlanState().refusedEndpoints).toEqual(['profile']);
  });

  test('an ordinary failure (a timeout, a 500) does not pause anything', async () => {
    const get = jest.fn().mockRejectedValue(Object.assign(new Error('boom'), { response: { status: 500 } }));
    await expect(fetchFmpProfile('AAPL', { get })).rejects.toBeTruthy();
    await expect(fetchFmpProfile('AAPL', { get })).rejects.toBeTruthy();
    expect(get).toHaveBeenCalledTimes(2);
    expect(fmpRefusedUntil('profile')).toBeNull();
  });
});
