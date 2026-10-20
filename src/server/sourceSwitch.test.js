/**
 * @jest-environment node
 */
const axios = require('axios');
const { createSourceSwitch, installSourceSwitch, providerOfHost, providerOfSource, PROVIDERS } = require('./sourceSwitch');
const { createSourceHealth, SOURCES } = require('./sourceHealth');

function fakeAdmin(initial = null) {
  const settings = new Map(initial ? [['disabled_sources', initial]] : []);
  return {
    setSetting: jest.fn(async (key, value) => {
      settings.set(key, value);
      return value;
    }),
    getSetting: jest.fn(async (key) => settings.get(key) || { disabled: [] })
  };
}

describe('providerOfHost', () => {
  test('matches a provider host and its subdomains only', () => {
    expect(providerOfHost('query1.finance.yahoo.com')).toBe('yahoo');
    expect(providerOfHost('fc.yahoo.com')).toBe('yahoo');
    expect(providerOfHost('api.tase.co.il')).toBe('tase');
    expect(providerOfHost('market.tase.co.il')).toBe('tase-page');
    expect(providerOfHost('www.bizportal.co.il')).toBe('bizportal');
    expect(providerOfHost('notyahoo.com')).toBe(null);
    expect(providerOfHost('oauth2.googleapis.com')).toBe(null);
  });

  test('every health row belongs to a provider', () => {
    Object.keys(SOURCES).forEach((name) => expect([name, Boolean(providerOfSource(name))]).toEqual([name, true]));
  });
});

describe('createSourceSwitch', () => {
  test('starts with everything on and loads the saved list on attach', async () => {
    const sw = createSourceSwitch();
    expect(sw.isProviderDisabled('yahoo')).toBe(false);
    await sw.attach(fakeAdmin({ disabled: ['yahoo', 'not-a-provider'] }));
    expect(sw.disabledList()).toEqual(['yahoo']);
    expect(sw.isSourceDisabled('yahoo-summary')).toBe(true);
    expect(sw.isSourceDisabled('finnhub')).toBe(false);
  });

  test('save stores the cleaned list and applies it at once', async () => {
    const sw = createSourceSwitch();
    const admin = fakeAdmin();
    const providers = await sw.save(['tase-page', 'tase-page', 'bogus'], { email: 'a@example.com' }, admin);
    expect(admin.setSetting).toHaveBeenCalledWith('disabled_sources', { disabled: ['tase-page'] }, { email: 'a@example.com' });
    expect(sw.isSourceDisabled('puppeteer')).toBe(true);
    expect(providers).toHaveLength(Object.keys(PROVIDERS).length);
    expect(providers.find((p) => p.name === 'tase-page').disabled).toBe(true);
  });

  test('keeps its list when the database cannot be read', async () => {
    const sw = createSourceSwitch({ logger: { warn: () => {} } });
    sw.apply(['bizportal']);
    await sw.attach({ getSetting: async () => { throw new Error('db down'); } });
    expect(sw.isProviderDisabled('bizportal')).toBe(true);
  });
});

describe('installSourceSwitch', () => {
  test('refuses a request to a switched-off provider before it is sent', async () => {
    const sw = createSourceSwitch();
    const instance = axios.create();
    const adapter = jest.fn(async (config) => ({ data: 'ok', status: 200, statusText: 'OK', headers: {}, config }));
    instance.defaults.adapter = adapter;
    installSourceSwitch(instance, sw);

    await expect(instance.get('https://query1.finance.yahoo.com/v8/finance/chart/AAPL')).resolves.toMatchObject({ data: 'ok' });

    sw.apply(['yahoo']);
    await expect(instance.get('https://query1.finance.yahoo.com/v8/finance/chart/AAPL')).rejects.toMatchObject({ code: 'SOURCE_DISABLED' });
    // Other hosts still go out.
    await expect(instance.get('https://finnhub.io/api/v1/quote')).resolves.toMatchObject({ data: 'ok' });
    expect(adapter).toHaveBeenCalledTimes(2);
  });
});

describe('sourceHealth and a switched-off source', () => {
  test('a SOURCE_DISABLED refusal is not counted as a failure', () => {
    const health = createSourceHealth({ logger: { warn: () => {}, error: () => {} } });
    const err = new Error('off');
    err.code = 'SOURCE_DISABLED';
    health.failure('yahoo-chart', err);
    expect(health.snapshot().find((s) => s.name === 'yahoo-chart').failures).toBe(0);
  });
});
