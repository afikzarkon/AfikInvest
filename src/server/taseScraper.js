// TASE (Tel Aviv Stock Exchange) price scraping: a Puppeteer-based scraper
// plus a short-TTL cache.
//
// This is now the LAST resort in quotesRoutes.js's source chain, behind two
// JSON APIs (taseQuoteApi.js and taseHistoryApi.js's fetchTaseQuoteFromEod).
// It is kept because it reads the same rendered page a human sees, so it
// survives an API being changed or withdrawn - but rendering a page in a
// headless browser and regexing its innerText is the most fragile and by
// far the most expensive way to get these two numbers, which is why nothing
// reaches it unless both APIs have already failed.
//
// An Axios/Cheerio fallback used to live here as the second source. It was
// removed after being measured against the live site: it returned null for
// every security tested, because major_data renders a static shell and
// fills in the numbers afterwards via JS (see the wait-condition comment in
// scrapeTaseWithPuppeteer below) - raw HTML never contains a price, so
// parsing it could only ever fail. It made the chain look two deep while
// leaving exactly one working source.
const puppeteer = require('puppeteer');

const TASE_CACHE_TTL_MS = 60 * 1000;
const taseQuoteCache = new Map();
let browserPromise = null;
/** Render/Linux containers: small /dev/shm often crashes Chrome without this flag. */
const TASE_PUPPETEER_GOTO_MS = Number(process.env.TASE_PUPPETEER_GOTO_MS) || 30000;
const TASE_PUPPETEER_WAIT_MS = Number(process.env.TASE_PUPPETEER_WAIT_MS) || 12000;

// The public page for a security's "נתונים עיקריים" tab. Lives here rather
// than in quotesRoutes.js so that everything tied to the scraped page's
// shape stays in one module - the other sources in the chain are addressed
// by security id alone.
function taseMajorDataUrl(stockId) {
  return `https://market.tase.co.il/he/market_data/security/${stockId}/major_data`;
}

// Chain-facing entry point: every source in quotesRoutes.js's TASE_SOURCES
// takes a security id, so the URL is built here instead of by the caller.
async function scrapeTaseQuote(stockId) {
  return scrapeTaseWithPuppeteer(taseMajorDataUrl(stockId));
}

function getPuppeteerExecutablePath() {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_BIN;
  if (fromEnv) return fromEnv;
  try {
    return puppeteer.executablePath();
  } catch {
    return undefined;
  }
}

function readCachedTaseQuote(stockId) {
  const cached = taseQuoteCache.get(stockId);
  if (!cached) return null;
  if (Date.now() - cached.ts > TASE_CACHE_TTL_MS) return null;
  return cached.data;
}

function readStaleTaseQuote(stockId) {
  const cached = taseQuoteCache.get(stockId);
  return cached ? cached.data : null;
}

// `ts` is when the quote was fetched: now, or for a quote restored from
// the database after a restart, when it was saved - so it is treated as
// stale and refreshed rather than as a minute-fresh answer.
function writeCachedTaseQuote(stockId, data, ts = Date.now()) {
  taseQuoteCache.set(stockId, { data, ts });
}

// Mirrors the parsePriceToken() closure inside scrapeTaseWithPuppeteer -
// duplicated for the same reason as hasUsableTasePriceText (Puppeteer
// serializes its copy to run in-browser, so it can't reference this
// module's code), kept here standalone so the logic is unit-testable. If
// either copy changes, update this one too.
function parseTasePriceToken(token) {
  if (!token) return null;
  const cleaned = token
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\s+/g, '')
    .replace(/,/g, '');
  const num = parseFloat(cleaned);
  if (!Number.isFinite(num)) return null;
  // NOT multiplied by *100 - see the full explanation on the in-browser
  // copy in scrapeTaseWithPuppeteer.
  return Math.round(num);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// Mirrors the condition inside scrapeTaseWithPuppeteer's page.waitForFunction
// below - duplicated rather than shared, because Puppeteer serializes that
// function to run inside the browser's own JS context, which can't call out
// to this module's code. Kept here, standalone, purely so the logic is
// unit-testable without a real browser; if the wait condition changes,
// update both copies.
function hasUsableTasePriceText(text) {
  const t = (text || '').replace(/\s+/g, ' ');
  return (
    /שער\s*אחרון[^\d]{0,80}\d/.test(t) ||
    /שווי\s*יחידה[^\d]{0,80}\d/.test(t) ||
    /-?\d[\d.,]*\s*%/.test(t)
  );
}

function isUsableTasePayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  return isFiniteNumber(payload.currentPrice) && isFiniteNumber(payload.changePercent);
}

async function getBrowser() {
  if (!browserPromise) {
    const executablePath = getPuppeteerExecutablePath();
    const launchOpts = {
      headless: process.env.PUPPETEER_HEADLESS === '0' ? false : 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check'
      ]
    };
    if (executablePath) launchOpts.executablePath = executablePath;
    browserPromise = puppeteer.launch(launchOpts);
  }
  try {
    return await browserPromise;
  } catch (err) {
    browserPromise = null;
    throw err;
  }
}

async function scrapeTaseWithPuppeteer(taseUrl) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.goto(taseUrl, { waitUntil: 'domcontentloaded', timeout: TASE_PUPPETEER_GOTO_MS });
    try {
      // Wait for an actual price VALUE, not just the label. TASE's page
      // renders its labels ("שער אחרון", "שווי יחידה" etc.) immediately as
      // static UI shell, then fills in the real numbers a moment later via
      // an async data fetch. The original condition only checked whether a
      // label or a bare '%' appeared anywhere on the page - which is true
      // the instant the shell renders, well before the numbers arrive - so
      // extraction below would run against a still-loading page and see
      // "undefined" where a number should be. Requiring a label followed
      // by an actual digit (mirroring the extraction regexes further down)
      // waits for real data, not just the presence of the shell.
      await page.waitForFunction(
        () => {
          const t = (document.body.innerText || '').replace(/\s+/g, ' ');
          return /שער\s*אחרון[^\d]{0,80}\d/.test(t) || /שווי\s*יחידה[^\d]{0,80}\d/.test(t) || /-?\d[\d.,]*\s*%/.test(t);
        },
        { timeout: TASE_PUPPETEER_WAIT_MS }
      );
    } catch (_) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    return await page.evaluate(() => {
      // Normalize Unicode minus (U+2212) to ASCII '-', remove bidi/control chars
      const normalizeText = (t) => (t || '')
        .replace(/[\u2212\u2012\u2013\u2014]/g, '-')
        .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
        .replace(/\s+/g, ' ');

      const parsePercentToken = (token) => {
        if (!token) return null;
        const s = token.replace(/[\u2212\u2012\u2013\u2014]/g, '-');
        // Detect minus anywhere (prefix or suffix or inside parentheses)
        const isNegative = /-/.test(s) || (/\(\s*\d/.test(s) && /\)/.test(s) && /-/.test(s));
        // Extract numeric part
        const numMatch = s.match(/\d+(?:\.\d+)?/);
        if (!numMatch) return null;
        const val = parseFloat(numMatch[0]);
        return isNegative ? -val : val;
      };
      const parsePriceToken = (token) => {
        if (!token) return null;
        // remove bidi/control chars and whitespace, drop thousands separators
        const cleaned = token
          .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
          .replace(/\s+/g, '')
          .replace(/,/g, '');
        const num = parseFloat(cleaned);
        if (!Number.isFinite(num)) return null;
        // NOT multiplied by *100 - confirmed directly against the live
        // TASE page (the field is explicitly labeled "שער אחרון (באגורות)",
        // i.e. "last price IN AGOROT"), so the scraped text is already the
        // agorot value. Multiplying it again was the actual source of a
        // real 100x-too-large price bug (a ₪2,476.70 holding scraped as
        // "247,670" on the page, correctly parsed to 247670 here, then
        // wrongly multiplied to 24,767,000).
        return Math.round(num);
      };

      const text = normalizeText(document.body.innerText || '');
      const priceNumberRx = '(\\d[\\d\\s,.]*)';
      const priceRx = new RegExp(`שווי\\s*יחידה[^\\d]{0,80}${priceNumberRx}`);
      const lastPriceRx = new RegExp(`שער\\s*אחרון[^\\d]{0,80}${priceNumberRx}`);
      const openRx = new RegExp(`שער\\s*פתיחה[^\\d]{0,80}${priceNumberRx}`);
      // Capture flexible percent token (handles trailing minus and parentheses)
      const percentToken = '([()\\-\\u2212\\d.\u2012\u2013\u2014\u200E\u200F]+?)';
      const changeDailyRx = new RegExp(`שינוי\\s*יומי[^%]{0,30}${percentToken}%`);
      const anyPercentRx = new RegExp(`${percentToken}%`);

      let priceMatch = text.match(lastPriceRx) || text.match(priceRx) || text.match(openRx);
      let percentMatch = text.match(changeDailyRx) || text.match(anyPercentRx);

      const priceAgorot = priceMatch ? parsePriceToken(priceMatch[1]) : null;
      const currentPrice = priceAgorot !== null ? priceAgorot : null; // return in agorot
      const rawToken = percentMatch ? percentMatch[1] : null;
      let changePercent = percentMatch ? parsePercentToken(rawToken) : null;

      // Heuristic: if no explicit minus parsed but DOM styling suggests negative, flip sign
      if (changePercent !== null && changePercent > 0 && rawToken && !/-/.test(rawToken)) {
        try {
          const needle = (rawToken + '%').replace(/\s+/g, '');
          const candidates = Array.from(document.querySelectorAll('*'))
            .filter(el => el.childElementCount === 0 && /%/.test(el.textContent || ''))
            .map(el => ({ el, txt: (el.textContent || '').replace(/\s+/g, '') }))
            .filter(item => item.txt.includes(needle));
          const looksNegative = (el) => {
            const cs = window.getComputedStyle(el);
            const color = ((cs && cs.color) || '').toLowerCase();
            const cls = (el.className || '').toString().toLowerCase();
            const title = (el.getAttribute('title') || '').toLowerCase();
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            const txt = (el.textContent || '').toLowerCase();
            const negWord = /(ירידה|שלילי|minus|neg|down|ירד|אדום)/.test(cls + ' ' + title + ' ' + aria + ' ' + txt);
            const redish = /rgb\(\s*(1?5\d|2[0-5]\d)\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)/.test(color) || /#(d[0-9a-f]{5}|c[0-9a-f]{5})/.test(color);
            return negWord || redish;
          };
          const negByStyle = candidates.some(c => looksNegative(c.el) || (c.el.parentElement && looksNegative(c.el.parentElement)));
          if (negByStyle) {
            changePercent = -Math.abs(changePercent);
          }
        } catch (_) {}
      }

      return {
        currentPrice,
        changePercent,
        _debugTextSnippet: text.slice(0, 400),
        // Diagnostics only - not used by any calculation. Shows exactly
        // which label matched and what raw text was captured as the price
        // BEFORE parsePriceToken's *100 conversion, so a scaling bug (the
        // captured token already being a large/agorot-looking number, a
        // different field being matched than intended, etc.) can be seen
        // directly instead of guessed at.
        _debugPriceMatch: priceMatch
          ? {
              matchedLabel: text.match(lastPriceRx)
                ? 'שער אחרון'
                : text.match(priceRx)
                ? 'שווי יחידה'
                : 'שער פתיחה',
              rawToken: priceMatch[1],
              fullMatch: priceMatch[0]
            }
          : null
      };
    });
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = {
  readCachedTaseQuote,
  readStaleTaseQuote,
  writeCachedTaseQuote,
  isUsableTasePayload,
  hasUsableTasePriceText,
  parseTasePriceToken,
  taseMajorDataUrl,
  scrapeTaseQuote,
  scrapeTaseWithPuppeteer
};
