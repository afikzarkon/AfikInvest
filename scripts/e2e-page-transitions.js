// Where the logo sits while the app moves between pages - a real browser
// (Puppeteer) against the production build, on a phone (375px, 430px) and
// a desktop width:
//
//   npm run build && node scripts/e2e-page-transitions.js [--shots <folder>]
//
// Each page is opened the way a nav tap opens it (pushState + popstate),
// on a throttled connection so a page's code takes a moment to arrive and
// the loading state - the logo in its ring - is on screen long enough to
// measure. Every animation frame records each visible logo's box; the run
// fails when a logo is not centred in the content column, or when it moves
// sideways between frames. Self-contained like e2e-account-flows.js: a
// throwaway SQLite database, sign-up by the code the API prints, the demo
// portfolio.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const API_PORT = 5078;
const WEB_PORT = 3178;
const WEB = `http://localhost:${WEB_PORT}`;
const shotsArg = process.argv.indexOf('--shots');
const SHOTS = shotsArg > -1 ? path.resolve(process.argv[shotsArg + 1]) : path.join(os.tmpdir(), 'afikinvest-transitions');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A logo this far off the content column's centre, or moving this far
// sideways while on screen, is a jump.
const TOLERANCE_PX = 2;

const PAGES = [
  '/israeli-stocks', '/us-stocks', '/provident-funds', '/cash-and-checking', '/bank-savings', '/monthly-tracker',
  '/tax-offset', '/alerts', '/valuation', '/recommendations', '/transactions', '/analytics', '/review', '/settings', '/'
];
const VIEWPORTS = [
  { name: 'phone-375', width: 375, height: 812, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: 'phone-430', width: 430, height: 932, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: 'desktop-1280', width: 1280, height: 860 }
];

if (!fs.existsSync(path.join(ROOT, 'build', 'index.html'))) {
  console.error('transitions: no build/ - run `npm run build` first');
  process.exit(1);
}
fs.mkdirSync(SHOTS, { recursive: true });

const dbFile = path.join(os.tmpdir(), `afikinvest-transitions-${process.pid}.db`);
let apiOutput = '';
const api = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(API_PORT),
    DATABASE_PATH: dbFile,
    DATABASE_URL: '',
    NODE_ENV: 'development',
    APP_URL: WEB,
    JWT_SECRET: 'transitions-only-secret',
    JOBS_POLL: '0',
    HIBP_DISABLED: '1',
    EMAIL_USER: '',
    EMAIL_PASS: '',
    GMAIL_CLIENT_ID: '',
    TURNSTILE_SECRET_KEY: ''
  }
});
api.stdout.on('data', (d) => (apiOutput += d.toString()));
api.stderr.on('data', (d) => (apiOutput += d.toString()));

function latestCode(email) {
  const blocks = apiOutput.split('[email:dev]').filter((b) => b.includes(`to=${email}`));
  const m = /(\d{6})/.exec((blocks[blocks.length - 1] || '').split('subject:')[1] || '');
  return m ? m[1] : null;
}

const web = express();
web.use(createProxyMiddleware({ target: `http://localhost:${API_PORT}`, changeOrigin: false, pathFilter: '/api' }));
web.use(express.static(path.join(ROOT, 'build'), { index: false }));
web.get(/.*/, (req, res) => res.sendFile(path.join(ROOT, 'build', 'index.html')));
const webServer = web.listen(WEB_PORT);

async function waitForApi() {
  for (let i = 0; i < 60; i += 1) {
    if (apiOutput.includes(`http://localhost:${API_PORT}`)) return;
    await sleep(500);
  }
  throw new Error(`API did not start:\n${apiOutput}`);
}

async function clickText(page, selector, text) {
  await page.waitForFunction(
    (sel, t) => [...document.querySelectorAll(sel)].some((e) => e.textContent.trim().includes(t) && e.offsetParent !== null),
    { timeout: 15000 },
    selector,
    text
  );
  await page.evaluate((sel, t) => [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(t) && e.offsetParent !== null).click(), selector, text);
}

async function typeInto(page, selector, value) {
  await page.waitForSelector(selector, { visible: true, timeout: 15000 });
  await page.click(selector, { clickCount: 3 });
  await page.type(selector, value);
}

// Opens `to` like a nav tap and records, every frame for `ms`, each visible
// logo's box and the content column's box.
function navigateAndSample(page, to, ms) {
  return page.evaluate(
    (target, duration) =>
      new Promise((resolve) => {
        const frames = [];
        const t0 = performance.now();
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        const tick = () => {
          // The area the content column should span: the whole width on a
          // phone, the width beside the sidebar on a desktop. Measured from
          // the viewport, not from .app-main - the column shrinking is
          // exactly the fault to catch.
          const nav = document.querySelector('.side-nav:not(.bottom-nav)');
          const n = nav ? nav.getBoundingClientRect() : null;
          const left = n && n.left > window.innerWidth / 2 ? 0 : n ? n.right : 0;
          const right = n && n.left > window.innerWidth / 2 ? n.left : window.innerWidth;
          const m = { left, width: right - left };
          // The content column's logos only: the desktop sidebar's sits in
          // the sidebar by design.
          const logos = [...document.querySelectorAll('.app-main .brand-logo img, body > .loading-screen .brand-logo img')].filter(visible).map((img) => {
            const r = img.getBoundingClientRect();
            return { cls: img.closest('.brand-logo').className, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };
          });
          frames.push({ t: Math.round(performance.now() - t0), main: { x: m.left + m.width / 2, w: m.width }, vw: window.innerWidth, logos, loading: Boolean(document.querySelector('.loading-screen')) });
          if (performance.now() - t0 < duration) requestAnimationFrame(tick);
          else resolve(frames);
        };
        window.history.pushState({}, '', target);
        window.dispatchEvent(new PopStateEvent('popstate'));
        requestAnimationFrame(tick);
      }),
    to,
    ms
  );
}

(async () => {
  let browser;
  const problems = [];
  const lines = [];
  try {
    await waitForApi();
    browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    page.on('dialog', (d) => d.accept());
    await page.setViewport({ width: 1280, height: 860 });
    const email = `transitions-${Date.now()}@example.com`;
    await page.goto(`${WEB}/login?mode=register`, { waitUntil: 'networkidle0' });
    await typeInto(page, '#auth-email', email);
    await typeInto(page, 'input[autocomplete="new-password"]', 'first-pass-123!');
    await page.click('.auth-check input[type="checkbox"]');
    await clickText(page, 'button', 'יצירת חשבון');
    await page.waitForSelector('#auth-code', { timeout: 15000 });
    let code = null;
    for (let i = 0; i < 20 && !code; i += 1) {
      code = latestCode(email);
      if (!code) await sleep(250);
    }
    if (!code) throw new Error('no verification code in the API output');
    await typeInto(page, '#auth-code', code);
    await clickText(page, 'button', 'אימות והמשך');
    await page.waitForSelector('.beta-modal-button', { timeout: 15000 });
    await page.click('.beta-modal-button');
    await page.waitForSelector('.onboarding-card', { timeout: 15000 });
    await clickText(page, '.onboarding-card button', 'דילוג');
    await clickText(page, '.onboarding-card button', 'דילוג');
    await clickText(page, '.onboarding-card button', 'טעינת נתוני דמו');
    await page.waitForSelector('.kpi-tile', { timeout: 15000 });
    await page.setCacheEnabled(false);
    const cdp = await page.target().createCDPSession();
    const throttle = (on) =>
      cdp.send('Network.emulateNetworkConditions', on
        ? { offline: false, latency: 600, downloadThroughput: 40 * 1024, uploadThroughput: 40 * 1024 }
        : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

    for (const vp of VIEWPORTS) {
      // A reload per width, without the cache, so every page's code is
      // fetched again and its loading state shows.
      await page.setViewport(vp);
      await throttle(false);
      await page.goto(WEB, { waitUntil: 'networkidle0' });
      // The demo portfolio is not saved, so a reload starts empty: load it
      // again from the dashboard's button.
      await page.waitForSelector('.app-shell', { timeout: 30000 });
      await sleep(1000);
      // The beta notice is shown again after a reload; it covers the page.
      if (await page.$('.beta-modal-button')) await page.click('.beta-modal-button');
      if (!(await page.$('.kpi-tile, .home-kpis'))) {
        await clickText(page, 'button', 'טען תיק לדוגמה');
        await page.waitForSelector('.kpi-tile, .home-kpis', { timeout: 30000 });
      }
      await throttle(true);

      for (const to of PAGES) {
        const frames = await navigateAndSample(page, to, 2500);
        const withLogo = frames.filter((f) => f.logos.length);
        let worstOff = 0;
        let drift = 0;
        let minX = Infinity;
        let maxX = -Infinity;
        withLogo.forEach((f) =>
          f.logos.forEach((l) => {
            worstOff = Math.max(worstOff, Math.abs(l.x - f.main.x));
            minX = Math.min(minX, l.x);
            maxX = Math.max(maxX, l.x);
          })
        );
        if (withLogo.length) drift = maxX - minX;
        const loadingFrames = frames.filter((f) => f.loading).length;
        lines.push(`${vp.name.padEnd(13)} ${to.padEnd(19)} frames ${String(frames.length).padStart(3)}  loading ${String(loadingFrames).padStart(3)}  logo frames ${String(withLogo.length).padStart(3)}  off-centre ${worstOff.toFixed(1).padStart(6)}px  sideways ${drift.toFixed(1).padStart(6)}px`);
        if (withLogo.length && (worstOff > TOLERANCE_PX || drift > TOLERANCE_PX)) {
          problems.push(`${vp.name} ${to}: logo ${worstOff.toFixed(1)}px off the content centre, moved ${drift.toFixed(1)}px sideways`);
        }
        // Mid-way, then the page settled - before the next one is opened.
        await page.screenshot({ path: path.join(SHOTS, `${vp.name}${to.replace(/\//g, '_') || '_home'}-loading.png`) });
        await page.waitForFunction(() => !document.querySelector('.loading-screen'), { timeout: 60000 }).catch(() => {});
        await page.screenshot({ path: path.join(SHOTS, `${vp.name}${to.replace(/\//g, '_') || '_home'}.png`), fullPage: true });
        // No horizontal scroll on any page.
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 1) problems.push(`${vp.name} ${to}: page scrolls sideways by ${overflow}px`);
      }
    }
  } catch (err) {
    problems.push(`run failed: ${err.stack || err.message}`);
  } finally {
    console.log(lines.join('\n'));
    console.log(problems.length ? `\nPROBLEMS:\n${problems.join('\n')}` : '\nlogo centred and steady on every page, at every width');
    console.log(`screenshots: ${SHOTS}`);
    if (browser) await browser.close();
    webServer.close();
    api.kill();
    try {
      fs.unlinkSync(dbFile);
    } catch {
      // already gone
    }
    process.exit(problems.length ? 1 : 0);
  }
})();
