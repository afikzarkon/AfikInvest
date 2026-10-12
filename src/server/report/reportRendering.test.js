/**
 * @jest-environment node
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { renderReportHtml, escapeHtml, monthLabel, loadAlefBase64 } = require('./reportHtml');
const { buildReportModel } = require('./reportModel');
const { createPdfRenderer } = require('./pdfRenderer');
const { createMemoryStorage, createLocalStorage, createSupabaseStorage, createReportStorage } = require('./reportStorage');

const model = () =>
  buildReportModel({
    userEmail: '<script>alert(1)</script>@x.com',
    month: '2026-08',
    snapshots: [
      { month: '2026-07', totalValueILS: 1000, breakdown: { israeli: [{ key: 'A', label: 'A<b>', value: 1000 }] } },
      { month: '2026-08', totalValueILS: 1100, breakdown: { israeli: [{ key: 'A', label: 'A<b>', value: 1100 }] } }
    ],
    portfolio: {},
    generatedAt: '2026-09-05T00:00:00Z'
  });

describe('reportHtml', () => {
  test('RTL Hebrew document with the embedded font and no external URLs', () => {
    const html = renderReportHtml(model());
    expect(html).toMatch(/<html lang="he" dir="rtl">/);
    expect(html).toMatch(/@font-face \{ font-family: 'Alef'; src: url\(data:font\/ttf;base64,/);
    expect(html).toContain('דוח חודשי - אוגוסט 2026');
    expect(html).not.toMatch(/(src|href)=["']https?:/);
    expect(html).not.toMatch(/url\(https?:/);
  });

  test('escapes everything that comes from data', () => {
    const html = renderReportHtml(model());
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;@x.com');
    expect(html).toContain('A&lt;b&gt;');
    expect(escapeHtml(`"'&`)).toBe('&quot;&#39;&amp;');
  });

  test('numbers are isolated LTR runs and signed', () => {
    const html = renderReportHtml(model());
    expect(html).toContain('<span class="num">+₪100</span>');
    expect(html).toContain('.num { direction: ltr; unicode-bidi: isolate;');
  });

  test('month labels and font loading', () => {
    expect(monthLabel('2026-01')).toBe('ינואר 2026');
    expect(loadAlefBase64()).toMatch(/^AAEAAA/);
    expect(renderReportHtml(model(), { fontBase64: null })).not.toContain('@font-face');
  });
});

describe('pdfRenderer (fake browser)', () => {
  function fakeLaunch(log) {
    return jest.fn(async () => ({
      async newPage() {
        const handlers = {};
        return {
          setJavaScriptEnabled: async (v) => log.push(['js', v]),
          setRequestInterception: async (v) => log.push(['intercept', v]),
          on: (evt, fn) => {
            handlers[evt] = fn;
          },
          setContent: async () => {
            // Simulate the page trying to load two resources.
            const req = (url) => ({ url: () => url, continue: () => log.push(['allow', url]), abort: () => log.push(['block', url]) });
            handlers.request(req('data:font/ttf;base64,AAA'));
            handlers.request(req('https://evil.example/x.png'));
          },
          evaluateHandle: async () => null,
          pdf: async () => {
            log.push(['pdf']);
            await new Promise((r) => setTimeout(r, 5));
            return Buffer.from('%PDF-1.7 fake');
          },
          close: async () => log.push(['close-page'])
        };
      },
      close: async () => log.push(['close-browser'])
    }));
  }

  test('blocks the network, disables JS, closes pages, recycles the browser', async () => {
    const log = [];
    const launch = fakeLaunch(log);
    const r = createPdfRenderer({ launch, recycleAfter: 2 });
    const [a, b, c] = await Promise.all([r.render('<p>1</p>'), r.render('<p>2</p>'), r.render('<p>3</p>')]);
    expect(a.toString()).toMatch(/^%PDF/);
    expect(b.length).toBe(c.length);
    expect(log).toContainEqual(['js', false]);
    expect(log).toContainEqual(['block', 'https://evil.example/x.png']);
    expect(log).toContainEqual(['allow', 'data:font/ttf;base64,AAA']);
    expect(log.filter((e) => e[0] === 'close-page')).toHaveLength(3);
    expect(launch).toHaveBeenCalledTimes(2); // recycled after 2 renders
    // Serialized: never two pdf() calls without a page close between them.
    const seq = log.filter((e) => e[0] === 'pdf' || e[0] === 'close-page').map((e) => e[0]);
    expect(seq).toEqual(['pdf', 'close-page', 'pdf', 'close-page', 'pdf', 'close-page']);
  });

  test('a failed launch is retried on the next render', async () => {
    let calls = 0;
    const r = createPdfRenderer({
      launch: async () => {
        calls += 1;
        if (calls === 1) throw new Error('no chrome');
        return fakeLaunch([])();
      }
    });
    await expect(r.render('x')).rejects.toThrow('no chrome');
    await expect(r.render('x')).resolves.toBeInstanceOf(Buffer);
  });
});

describe('reportStorage', () => {
  test('memory storage and key safety', async () => {
    const s = createMemoryStorage();
    await s.put('reports/1/2026-08/v1.pdf', Buffer.from('x'));
    expect((await s.downloadTarget('reports/1/2026-08/v1.pdf')).buffer.toString()).toBe('x');
    await expect(s.put('../etc/passwd', Buffer.from('x'))).rejects.toThrow(/unsafe/);
  });

  test('local storage writes under its root only', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reports-'));
    const s = createLocalStorage(dir);
    await s.put('reports/1/2026-08/v1.pdf', Buffer.from('pdf'));
    expect(fs.readFileSync(path.join(dir, 'reports/1/2026-08/v1.pdf'), 'utf8')).toBe('pdf');
    expect((await s.get('reports/1/2026-08/v1.pdf')).toString()).toBe('pdf');
    await expect(s.put('/abs/path.pdf', Buffer.from('x'))).rejects.toThrow();
  });

  test('supabase storage uploads privately and hands out signed URLs', async () => {
    const calls = [];
    const bucket = {
      upload: async (key, body, opts) => {
        calls.push(['upload', key, opts]);
        return { error: null };
      },
      createSignedUrl: async (key, seconds, opts) => {
        calls.push(['sign', key, seconds, opts]);
        return { data: { signedUrl: `https://sb/${key}?t=${seconds}` }, error: null };
      },
      download: async () => ({ data: { arrayBuffer: async () => new TextEncoder().encode('pdf').buffer }, error: null })
    };
    const s = createSupabaseStorage({ url: 'u', serviceKey: 'k', createClient: () => ({ storage: { from: (b) => (calls.push(['bucket', b]), bucket) } }) });
    await s.put('reports/1/a.pdf', Buffer.from('x'));
    expect(await s.downloadTarget('reports/1/a.pdf', 60)).toEqual({ type: 'redirect', url: 'https://sb/reports/1/a.pdf?t=60' });
    expect(calls).toContainEqual(['upload', 'reports/1/a.pdf', { contentType: 'application/pdf', upsert: true }]);
    expect(calls).toContainEqual(['bucket', 'reports']);
    expect((await s.get('reports/1/a.pdf')).toString()).toBe('pdf');
  });

  test('picks supabase only when configured', () => {
    expect(createReportStorage({ REPORTS_DIR: os.tmpdir() }).kind).toBe('local');
  });
});

// A real Chrome render, when one is available locally (CI skips the
// Chromium download, so this only runs where PDF_SMOKE_CHROME is set):
//   PDF_SMOKE_CHROME=/opt/pw-browsers/chromium npm test -- reportRendering
const chrome = process.env.PDF_SMOKE_CHROME;
(chrome ? test : test.skip)('real Chrome produces a PDF with the Hebrew font embedded', async () => {
  // CRA's Jest 27 node environment lacks this Node global that Puppeteer's
  // page.pdf() streams through (plain Node has it).
  if (typeof global.ReadableStream === 'undefined') global.ReadableStream = require('stream/web').ReadableStream;
  const puppeteer = require('puppeteer');
  const r = createPdfRenderer({ launch: () => puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox'] }) });
  try {
    const pdf = await r.render(renderReportHtml(model()));
    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('Alef');
  } finally {
    await r.close();
  }
}, 60000);
