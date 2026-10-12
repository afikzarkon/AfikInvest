// HTML -> PDF with headless Chrome (Puppeteer, already a dependency for the
// TASE scraper).
//
// Memory is the constraint on the free hosting plan, so:
//   * one browser for the whole process, launched lazily;
//   * one render at a time (a promise chain), each in a fresh page that is
//     always closed;
//   * the browser is recycled every RECYCLE_AFTER renders;
//   * JavaScript is disabled and every network request is blocked - the
//     report HTML is self-contained, so nothing it needs is refused.
//
// `launch` is injectable so tests can run without Chrome.

const RECYCLE_AFTER = 25;

function defaultLaunch() {
  const puppeteer = require('puppeteer');
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_BIN || undefined;
  return puppeteer.launch({
    headless: 'new',
    executablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--no-first-run']
  });
}

function createPdfRenderer({ launch = defaultLaunch, recycleAfter = RECYCLE_AFTER } = {}) {
  let browserPromise = null;
  let renders = 0;
  let queue = Promise.resolve();

  async function browser() {
    if (!browserPromise) {
      browserPromise = launch().catch((err) => {
        browserPromise = null;
        throw err;
      });
    }
    return browserPromise;
  }

  async function close() {
    const current = browserPromise;
    browserPromise = null;
    renders = 0;
    if (current) {
      try {
        await (await current).close();
      } catch {
        // already gone
      }
    }
  }

  async function renderOnce(html) {
    const b = await browser();
    const page = await b.newPage();
    try {
      await page.setJavaScriptEnabled(false);
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const url = req.url();
        if (url.startsWith('data:') || url === 'about:blank') req.continue();
        else req.abort();
      });
      await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
      await page.evaluateHandle('document.fonts.ready');
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: true,
        headerTemplate: '<div></div>',
        footerTemplate:
          '<div style="width:100%;font-size:8px;color:#6b7280;text-align:center;direction:ltr"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
        margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' }
      });
      return Buffer.from(pdf);
    } finally {
      await page.close().catch(() => {});
      renders += 1;
      if (renders >= recycleAfter) await close();
    }
  }

  // Serialized: at most one page open at a time.
  function render(html) {
    const run = queue.then(() => renderOnce(html));
    queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  return { render, close };
}

module.exports = { createPdfRenderer };
