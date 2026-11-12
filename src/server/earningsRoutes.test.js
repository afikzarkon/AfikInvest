/**
 * @jest-environment node
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const { mountEarningsRoutes } = require('./earningsRoutes');
const { createEarningsService, EarningsError, TICKERS_URL } = require('./earningsService');
const { request, tokenFor, listen } = require('./testUtils/http');

const DIR = path.join(__dirname, 'fixtures', 'earnings');
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));

function fixtureFetch() {
  return async (url) => {
    if (url === TICKERS_URL) return load('company_tickers.json');
    const cik = (url.match(/(CIK\d{10})\.json$/) || [])[1];
    if (cik && url.includes('companyfacts')) {
      if (!fs.existsSync(path.join(DIR, `companyfacts-${cik}.json`))) throw new EarningsError('404', 'NOT_FOUND');
      return load(`companyfacts-${cik}.json`);
    }
    if (cik && url.includes('submissions')) return load(`submissions-${cik}.json`);
    const acc = (url.match(/\/(\d{18})\/index\.json$/) || [])[1];
    if (acc && fs.existsSync(path.join(DIR, acc, 'index.json'))) return load(path.join(acc, 'index.json'));
    throw new EarningsError('404', 'NOT_FOUND');
  };
}

async function start(deps) {
  const app = express();
  app.use(express.json());
  mountEarningsRoutes(app, Object.assign({ now: () => new Date('2026-10-01T12:00:00Z') }, deps));
  return listen(app);
}

describe('GET /api/earnings/:symbol', () => {
  let server;
  let baseUrl;
  const token = tokenFor('u1');
  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    server = null;
  });

  test('needs auth, validates the symbol, answers from SEC facts', async () => {
    const getNextEarningsDate = jest.fn(async () => ({ date: '2026-10-29', dateEnd: null, status: 'estimated' }));
    ({ server, baseUrl } = await start({ service: createEarningsService({ fetchJson: fixtureFetch() }), getNextEarningsDate }));
    expect((await request(baseUrl, 'GET', '/api/earnings/AAPL')).status).toBe(401);
    expect((await request(baseUrl, 'GET', '/api/earnings/AAPL123', { token })).status).toBe(400);
    expect((await request(baseUrl, 'GET', '/api/earnings/TOOLONG', { token })).status).toBe(400);

    const res = await request(baseUrl, 'GET', '/api/earnings/aapl', { token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ symbol: 'AAPL', name: 'Apple Inc.', cik: '0000320193', secConfigured: true, nextEarningsDate: '2026-10-29' });
    expect(res.body.quarters[0]).toMatchObject({ end: '2026-06-27', revenueYoy: 16.4, epsDiluted: 2.02 });
    expect(res.body.ttm).toMatchObject({ revenue: 466823000000, epsDiluted: 8.71 });
    expect(res.body.latest8k.exhibit).toMatch(/a8-kex991q3202606272026\.htm$/);
    expect(res.body.summary[0]).toContain('עלייה של 16.4%');
    expect(getNextEarningsDate).toHaveBeenCalledWith('AAPL');
  });

  test('KO: stale note; past next-earnings date dropped; next-date failure tolerated', async () => {
    ({ server, baseUrl } = await start({
      service: createEarningsService({ fetchJson: fixtureFetch() }),
      getNextEarningsDate: async () => ({ date: '2026-07-28', dateEnd: null })
    }));
    const res = await request(baseUrl, 'GET', '/api/earnings/KO', { token });
    expect(res.status).toBe(200);
    expect(res.body.staleNote).toMatchObject({ factsEnd: '2026-04-03', period: '2026-07-03' });
    expect(res.body.nextEarningsDate).toBeNull();
  });

  test('unknown ticker / no facts -> 404, upstream failure -> 502', async () => {
    const fetchJson = fixtureFetch();
    let fail = false;
    const service = createEarningsService({
      fetchJson: async (url) => {
        if (fail && url.includes('companyfacts')) throw new EarningsError('down', 'UPSTREAM');
        return fetchJson(url);
      }
    });
    ({ server, baseUrl } = await start({
      service,
      getNextEarningsDate: async () => {
        throw new Error('yahoo down');
      }
    }));
    expect((await request(baseUrl, 'GET', '/api/earnings/ZZZZ', { token })).status).toBe(404);
    expect((await request(baseUrl, 'GET', '/api/earnings/BAC', { token })).status).toBe(404); // no facts fixture
    fail = true;
    const res = await request(baseUrl, 'GET', '/api/earnings/AAPL', { token });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/SEC/);
  });

  test('not configured: no SEC call, clear state', async () => {
    ({ server, baseUrl } = await start({ service: createEarningsService({ userAgent: null }), getNextEarningsDate: null }));
    const res = await request(baseUrl, 'GET', '/api/earnings/AAPL', { token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ symbol: 'AAPL', secConfigured: false, quarters: [] });
    expect(res.body.message).toMatch(/SEC_USER_AGENT/);
  });
});
