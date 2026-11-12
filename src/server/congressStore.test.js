/**
 * @jest-environment node
 */
const fs = require('fs');
const path = require('path');
const { initFeatureStore } = require('./featureStore');
const { initCongressStore } = require('./congressStore');
const { createCongressJobHandlers, PTR_URL } = require('./congressService');
const { STORE_FACTORIES } = require('./testUtils/stores');

const DIR = path.join(__dirname, 'fixtures', 'congress');
const ZIP = fs.readFileSync(path.join(DIR, '2026FD.zip'));
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');

// pdftotext-style text -> positioned items, the shape pdfjs gives the
// service: every 2+-space-separated chunk at its column, one line per row.
function textToItems(text) {
  const items = [];
  text.split('\n').forEach((line, i) => {
    const re = /\S+(?: \S+)*/g;
    let m;
    while ((m = re.exec(line))) items.push({ str: m[0], x: m.index * 5, y: 1000 - i * 10, width: m[0].length * 5, fontSize: 8 });
  });
  return [items];
}

const PDF_ITEMS = {
  20035143: JSON.parse(read('ptr-20035143.pdfjs-items.json')),
  20035590: textToItems(read('ptr-20035590.txt')),
  20035562: textToItems(read('ptr-20035562-excerpt.txt')),
  20033725: [[]] // a scanned image: no text layer
};

function makeFetchers() {
  const calls = { index: [], pdf: [] };
  return {
    calls,
    async fetchIndexZip(year, { ifModifiedSince } = {}) {
      calls.index.push({ year, ifModifiedSince });
      if (ifModifiedSince) return { notModified: true, data: null, lastModified: ifModifiedSince };
      return { notModified: false, data: ZIP, lastModified: 'Tue, 13 Oct 2026 21:29:00 GMT' };
    },
    async fetchPdf(url) {
      calls.pdf.push(url);
      const docId = /(\d+)\.pdf$/.exec(url)[1];
      if (!PDF_ITEMS[docId]) throw new Error('HTTP 404');
      return Buffer.from(`%PDF-1.7 ${docId}`);
    }
  };
}

const extractItems = async (buf) => ({ pages: PDF_ITEMS[/(\d+)$/.exec(buf.toString('latin1'))[1]] });

describe.each(STORE_FACTORIES)('congress store + congress.scan job (%s)', (_name, makeStore) => {
  let store;
  let features;
  let congress;

  beforeEach(async () => {
    store = await makeStore();
    features = await initFeatureStore(store);
    congress = await initCongressStore(store);
  });
  afterEach(async () => {
    await store.close();
  });

  test('store: insert once, pending newest first, parse results, meta', async () => {
    const f = (docId, filed) => ({ docId, year: 2026, name: 'Hon. A B', first: 'A', last: 'B', district: 'CA11', filed, url: PTR_URL(2026, docId) });
    expect(await congress.insertFilings([f('1', '2026-10-01'), f('2', '2026-10-03')])).toBe(2);
    expect(await congress.insertFilings([f('2', '2026-10-03'), f('3', '2026-09-01')])).toBe(1);
    expect((await congress.listPendingFilings(10)).map((x) => x.docId)).toEqual(['2', '1', '3']);
    expect((await congress.listPendingFilings(1)).map((x) => x.docId)).toEqual(['2']);

    await congress.saveParseResult('2', { status: 'parsed', rows: [{ ticker: 'AAPL' }] });
    await congress.saveParseResult('1', { status: 'no_text', rows: [] });
    await congress.saveParseResult('3', { status: 'error', rows: [], error: 'HTTP 500' });
    expect((await congress.listPendingFilings(10)).map((x) => x.docId)).toEqual(['3']);
    await congress.saveParseResult('3', { status: 'error', rows: [], error: 'HTTP 500' });
    await congress.saveParseResult('3', { status: 'error', rows: [], error: 'HTTP 500' });
    expect(await congress.listPendingFilings(10)).toEqual([]);

    const two = await congress.getFiling('2');
    expect(two).toMatchObject({ docId: '2', memberName: 'Hon. A B', stateDistrict: 'CA11', parseStatus: 'parsed', rows: [{ ticker: 'AAPL' }], parseAttempts: 1 });
    expect((await congress.listFilings({ since: '2026-10-01' })).map((x) => x.docId)).toEqual(['2', '1']);

    expect(await congress.getMeta('last-scan-at')).toBeNull();
    await congress.setMeta('last-scan-at', '2026-10-13T00:00:00.000Z');
    await congress.setMeta('last-scan-at', '2026-10-14T00:00:00.000Z');
    expect(await congress.getMeta('last-scan-at')).toBe('2026-10-14T00:00:00.000Z');
  });

  test('scan: stores PTRs, reads PDFs politely, alerts holders once', async () => {
    const { id: a } = await store.insertUser('a@b.com', 'x');
    const { id: b } = await store.insertUser('b@b.com', 'x');
    const lot = (stockName) => ({ stockName, quantity: 10, purchasePrice: 100, exchangeRate: 3.7, purchaseDate: '2026-01-01' });
    await store.upsertPortfolio(a, JSON.stringify({ americanStocks: [lot('BE'), lot('amat')] }));
    await store.upsertPortfolio(b, JSON.stringify({ americanStocks: [lot('BRK-B'), lot('AMAT')], israeliStocks: [{ stockName: '1081124', quantity: 5, purchasePrice: 10 }] }));

    const fetchers = makeFetchers();
    const sleep = jest.fn(async () => {});
    const handlers = createCongressJobHandlers({
      store,
      features,
      congress,
      fetchers,
      scanOptions: { now: new Date('2026-10-13T20:00:00Z'), sleep, extractItems, logger: { warn() {} } }
    });

    const first = await handlers['congress.scan']({});
    expect(first).toMatchObject({ years: [2026], indexed: 13, newFilings: 13, parsed: 3, noText: 1, failed: 9, alertsCreated: 3 });
    expect(fetchers.calls.pdf).toHaveLength(13);
    expect(fetchers.calls.pdf[0]).toBe('https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20035635.pdf');
    expect(sleep).toHaveBeenCalledTimes(12);

    // BE was traded in a filing older than the 30-day alert window: no alert.
    const alertsA = await features.listAlerts(a);
    expect(alertsA.map((x) => [x.type, x.instrument.symbol])).toEqual([['CONGRESS_TRADE', 'AMAT']]);
    expect(alertsA[0]).toMatchObject({ severity: 'info', congress: { docId: '20035590', ticker: 'AMAT', rowIndex: 0 } });
    expect(alertsA[0].title).toContain('Gottheimer');
    expect(alertsA[0].message).toContain('STOCK');
    const alertsB = await features.listAlerts(b);
    expect(alertsB.map((x) => x.instrument.symbol).sort()).toEqual(['AMAT', 'BRK-B']);

    const pelosi = await congress.getFiling('20035143');
    expect(pelosi.rows).toHaveLength(7);
    expect(pelosi.rows[1].option).toMatchObject({ kind: 'call', strike: 100 });
    expect((await congress.getFiling('20033725')).parseStatus).toBe('no_text');
    expect((await congress.getFiling('20035635')).parseStatus).toBe('error');
    expect(await congress.getMeta('last-scan-at')).toBe('2026-10-13T20:00:00.000Z');

    // Second run: index unchanged (If-Modified-Since), failed PDFs retried
    // with a smaller batch, no duplicate alerts.
    const second = await handlers['congress.scan']({ maxParse: 2 });
    expect(fetchers.calls.index[1]).toEqual({ year: 2026, ifModifiedSince: 'Tue, 13 Oct 2026 21:29:00 GMT' });
    expect(second).toMatchObject({ notModified: [2026], newFilings: 0, parsed: 0, failed: 2, alertsCreated: 0 });
    expect(await features.countUnreadAlerts(b)).toBe(2);
  });

  test('scan: an index outage still reads what is stored', async () => {
    const fetchers = Object.assign(makeFetchers(), {
      async fetchIndexZip() {
        throw new Error('timeout of 30000ms exceeded');
      }
    });
    const handlers = createCongressJobHandlers({ store, features, congress, fetchers, scanOptions: { now: new Date('2026-01-05T15:00:00Z'), sleep: async () => {}, extractItems } });
    const r = await handlers['congress.scan']({});
    // January: last year's index is read too.
    expect(r.years).toEqual([2026, 2025]);
    expect(r.errors).toHaveLength(2);
    expect(r.parsed).toBe(0);
  });
});
