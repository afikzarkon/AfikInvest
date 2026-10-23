// End-to-end browser test of the main account flows - a real browser
// (Puppeteer) against the real server and the production build:
//
//   sign-up -> verification by the emailed code -> onboarding (demo data)
//   -> privacy mode -> profile -> password change -> sign out / in
//   -> account deletion -> restore by signing in again.
//
//   npm run build && npm run e2e
//
// Self-contained: it starts the API on a throwaway SQLite database, serves
// build/ with /api proxied to it, and reads the "sent" emails from the
// API's output (in development they are printed instead of sent). Nothing
// touches a real database or mailbox. Screenshots of each step land in
// the folder named by --shots (default: the system temp folder).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const API_PORT = 5077;
const WEB_PORT = 3177;
const WEB = `http://localhost:${WEB_PORT}`;
const shotsArg = process.argv.indexOf('--shots');
const SHOTS = shotsArg > -1 ? path.resolve(process.argv[shotsArg + 1]) : path.join(os.tmpdir(), 'afikinvest-e2e');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(path.join(ROOT, 'build', 'index.html'))) {
  console.error('e2e: no build/ - run `npm run build` first');
  process.exit(1);
}
fs.mkdirSync(SHOTS, { recursive: true });

// ----- the API, on a throwaway database, its output captured -----
const dbFile = path.join(os.tmpdir(), `afikinvest-e2e-${process.pid}.db`);
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
    JWT_SECRET: 'e2e-only-secret',
    JOBS_POLL: '0',
    HIBP_DISABLED: '1',
    EMAIL_USER: '',
    EMAIL_PASS: '',
    GMAIL_CLIENT_ID: '',
    TURNSTILE_SECRET_KEY: ''
  }
});
api.stdout.on('data', (d) => {
  apiOutput += d.toString();
});
api.stderr.on('data', (d) => {
  apiOutput += d.toString();
});

// The newest 6-digit code printed in a verification email to `email`.
function latestCode(email) {
  const blocks = apiOutput.split('[email:dev]').filter((b) => b.includes(`to=${email}`));
  const last = blocks[blocks.length - 1] || '';
  const m = /(\d{6})/.exec(last.split('subject:')[1] || '');
  return m ? m[1] : null;
}

// ----- the web app: build/ with /api proxied -----
const web = express();
web.use(createProxyMiddleware({ target: `http://localhost:${API_PORT}`, changeOrigin: false, pathFilter: '/api' }));
web.use(express.static(path.join(ROOT, 'build'), { index: false }));
web.get(/.*/, (req, res) => res.sendFile(path.join(ROOT, 'build', 'index.html')));
const webServer = web.listen(WEB_PORT);

const results = [];
const step = async (name, fn) => {
  try {
    await fn();
    results.push(`PASS  ${name}`);
  } catch (err) {
    results.push(`FAIL  ${name} - ${err.message}`);
    throw err;
  }
};
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};

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
  await page.evaluate(
    (sel, t) => [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(t) && e.offsetParent !== null).click(),
    selector,
    text
  );
}

async function typeInto(page, selector, value) {
  await page.waitForSelector(selector, { visible: true, timeout: 15000 });
  await page.click(selector, { clickCount: 3 });
  await page.type(selector, value);
}

const bodyText = (page) => page.evaluate(() => document.body.innerText);
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

(async () => {
  let browser;
  try {
    await waitForApi();
    browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    page.on('dialog', (d) => d.accept());
    await page.setViewport({ width: 1280, height: 860 });
    const email = `e2e-${Date.now()}@example.com`;

    await step('sign-up: address, password and the terms', async () => {
      await page.goto(`${WEB}/login?mode=register`, { waitUntil: 'networkidle0' });
      await shot(page, '01-signup');
      await typeInto(page, '#auth-email', email);
      await typeInto(page, 'input[autocomplete="new-password"]', 'first-pass-123!');
      await page.click('.auth-check input[type="checkbox"]');
      await clickText(page, 'button', 'יצירת חשבון');
      await page.waitForSelector('#auth-code', { timeout: 15000 });
      await shot(page, '02-verify-code');
    });

    await step('verification by the emailed code signs in', async () => {
      let code = null;
      for (let i = 0; i < 20 && !code; i += 1) {
        code = latestCode(email);
        if (!code) await sleep(250);
      }
      assert(code, 'no verification code in the API output');
      await typeInto(page, '#auth-code', code);
      await clickText(page, 'button', 'אימות והמשך');
      await page.waitForSelector('.beta-modal-button', { timeout: 15000 });
      await page.click('.beta-modal-button');
    });

    await step('onboarding: steps can be skipped, the demo loaded', async () => {
      await page.waitForSelector('.onboarding-card', { timeout: 15000 });
      await shot(page, '03-onboarding');
      await clickText(page, '.onboarding-card button', 'דילוג');
      await clickText(page, '.onboarding-card button', 'דילוג');
      await clickText(page, '.onboarding-card button', 'טעינת נתוני דמו');
      await page.waitForSelector('.kpi-tile', { timeout: 15000 });
    });

    await step('privacy mode masks the amounts and keeps the percentages', async () => {
      await page.click('.privacy-toggle');
      await page.waitForFunction(() => document.querySelector('.kpi-tile').innerText.includes('••••'), { timeout: 10000 });
      const tiles = await page.evaluate(() => [...document.querySelectorAll('.kpi-tile')].map((t) => t.innerText).join(' | '));
      assert(/%/.test(tiles), 'percentages hidden too');
      await shot(page, '04-privacy-mode');
      await page.click('.privacy-toggle');
      await page.waitForFunction(() => !document.querySelector('.kpi-tile').innerText.includes('••••'), { timeout: 10000 });
    });

    await step('profile: an optional name, shown in the menu', async () => {
      await clickText(page, '.side-nav-logout', 'הגדרות');
      await page.waitForSelector('.settings-layout', { timeout: 15000 });
      await page.evaluate(() => {
        const label = [...document.querySelectorAll('label')].find((l) => l.textContent.startsWith('שם פרטי'));
        document.getElementById(label.htmlFor).focus();
      });
      await page.keyboard.type('בודק');
      await clickText(page, 'button', 'שמירת שינויים');
      await page.waitForFunction(() => document.body.innerText.includes('הפרופיל נשמר'), { timeout: 10000 });
      await page.waitForFunction(() => (document.querySelector('.side-nav-user-name') || {}).textContent === 'בודק', { timeout: 10000 });
      await shot(page, '05-settings-profile');
    });

    await step('password change signs the other devices out and works for sign-in', async () => {
      await clickText(page, '.settings-nav-item', 'חשבון ואבטחה');
      await page.waitForSelector('.session-list', { timeout: 15000 });
      const fields = await page.$$('input[type="password"]');
      // [email confirmation password, current password, new password]
      await fields[1].type('first-pass-123!');
      await fields[2].type('second-pass-456?');
      await clickText(page, 'button', 'שינוי סיסמה');
      await page.waitForFunction(() => document.body.innerText.includes('הסיסמה שונתה'), { timeout: 10000 });
      await sleep(800);
      // The page stays where it was - the new session does not reload it.
      const title = await page.$eval('.settings-detail-title', (el) => el.textContent);
      assert(title === 'חשבון ואבטחה', `the settings page jumped to "${title}"`);
      await shot(page, '06-settings-security');
      await clickText(page, '.side-nav-logout', 'התנתקות');
      await page.waitForSelector('#auth-email', { timeout: 15000 });
      await clickText(page, '.auth-tab', 'התחברות');
      await typeInto(page, '#auth-email', email);
      await typeInto(page, 'input[autocomplete="current-password"]', 'second-pass-456?');
      await clickText(page, 'button[type="submit"]', 'התחברות');
      await page.waitForSelector('.beta-modal-button', { timeout: 15000 });
      await page.click('.beta-modal-button');
      await page.waitForSelector('.side-nav', { timeout: 15000 });
    });

    await step('deletion: confirmed, then restorable by signing in', async () => {
      await clickText(page, '.side-nav-logout', 'הגדרות');
      await clickText(page, '.settings-nav-item', 'מחיקת חשבון');
      await clickText(page, 'button', 'אני רוצה למחוק את החשבון');
      const pw = await page.waitForSelector('.settings-card input[type="password"]');
      await pw.type('second-pass-456?');
      await page.evaluate(() => {
        const label = [...document.querySelectorAll('label')].find((l) => l.textContent.includes('לאישור, הקלידו'));
        document.getElementById(label.htmlFor).focus();
      });
      await page.keyboard.type('מחק');
      await clickText(page, 'button[type="submit"]', 'מחיקת החשבון');
      await page.waitForFunction(() => document.body.innerText.includes('החשבון ימחק'), { timeout: 10000 });
      await shot(page, '07-deleted');
      await clickText(page, 'button', 'סיום');
      await page.waitForSelector('#auth-email', { timeout: 15000 });
      await clickText(page, '.auth-tab', 'התחברות');
      await typeInto(page, '#auth-email', email);
      await typeInto(page, 'input[autocomplete="current-password"]', 'second-pass-456?');
      await clickText(page, 'button[type="submit"]', 'התחברות');
      await page.waitForFunction(() => document.body.innerText.includes('שחזור החשבון'), { timeout: 10000 });
      await shot(page, '08-restore');
      await clickText(page, 'button', 'שחזור החשבון');
      await page.waitForSelector('.beta-modal-button', { timeout: 15000 });
    });

    await step('phone width: the settings list, then a category', async () => {
      await page.click('.beta-modal-button');
      await page.setViewport({ width: 375, height: 812 });
      await page.goto(`${WEB}/settings`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.beta-modal-button', { timeout: 15000 });
      await page.click('.beta-modal-button');
      await page.waitForSelector('.settings-nav', { timeout: 15000 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      assert(!overflow, 'the page scrolls sideways at 375px');
      await shot(page, '09-mobile-settings-list');
      await clickText(page, '.settings-nav-item', 'חשבון ואבטחה');
      await page.waitForSelector('.settings-back', { timeout: 10000 });
      await shot(page, '10-mobile-settings-security');
      assert((await bodyText(page)).includes('כל ההגדרות'), 'no way back to the list');
    });
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    webServer.close();
    api.kill();
    await sleep(500);
    [dbFile, `${dbFile}-wal`, `${dbFile}-shm`].forEach((f) => fs.rmSync(f, { force: true }));
    console.log(results.join('\n'));
    console.log(`screenshots: ${SHOTS}`);
  }
})();
