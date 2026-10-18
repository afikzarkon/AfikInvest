// Development only: renders the welcome email to an HTML file (and its plain
// text beside it) to open in a browser - nothing is sent.
//
//   npm run email:preview
//   npm run email:preview -- --name "דנה" --email dana@example.com --out preview.html
//   npm run email:preview -- --app-url https://your-app.vercel.app
//
// Images are linked from public/email/ on disk unless --app-url is given,
// so the preview shows them without a server running.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { buildWelcomeEmail } = require('../src/server/emails/welcomeEmail');

if (process.env.NODE_ENV === 'production') {
  console.error('render-welcome-email: a development tool - not run with NODE_ENV=production');
  process.exit(1);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

// public/email/ as a file URL stands in for `${APP_URL}/email`.
const localRoot = pathToFileURL(path.join(__dirname, '..', 'public')).href;
const appUrl = String(arg('app-url', localRoot)).replace(/\/+$/, '');
const out = path.resolve(arg('out', path.join(os.tmpdir(), 'afikinvest-welcome-email.html')));

const { subject, html, text } = buildWelcomeEmail({
  name: arg('name', 'משתמש לדוגמה'),
  email: arg('email', 'demo@example.com'),
  appUrl,
  contactEmail: arg('contact', process.env.EMAIL_USER || 'support@example.com')
});

fs.writeFileSync(out, html, 'utf8');
fs.writeFileSync(out.replace(/\.html?$/i, '') + '.txt', `Subject: ${subject}\n\n${text}\n`, 'utf8');
console.log(`subject: ${subject}`);
console.log(`html:    ${out}`);
console.log(`text:    ${out.replace(/\.html?$/i, '')}.txt`);
