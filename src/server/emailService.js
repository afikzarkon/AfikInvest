// Outgoing mail from the Gmail account EMAIL_USER, two ways:
//
// - Gmail API over HTTPS, when GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and
//   GMAIL_REFRESH_TOKEN are set. Needed on Render's free plan, which blocks
//   outbound SMTP ports (25/465/587) - the SMTP route just times out there.
//   nodemailer still builds the message; only the delivery is an API call.
// - SMTP (nodemailer, service: 'gmail') with EMAIL_PASS, a Gmail App
//   Password - fine locally or on a host that allows SMTP.
//
// With neither, the service is "unconfigured": in development it prints the
// message to the console so the reset flow can still be exercised locally;
// in production it skips the send and logs a warning.
const nodemailer = require('nodemailer');
const { escapeHtml } = require('./emails/html');
const { buildWelcomeEmail } = require('./emails/welcomeEmail');
const accountEmails = require('./emails/accountEmails');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const HTTP_TIMEOUT_MS = 15000;

function gmailApiConfigured() {
  return Boolean(
    process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN
  );
}

async function readGoogleError(res) {
  const body = await res.text().catch(() => '');
  return `${res.status} ${body.slice(0, 300)}`;
}

// A nodemailer-shaped transport ({ sendMail }) that delivers through the
// Gmail API. The access token lasts about an hour and is reused until a
// minute before it expires.
// fetchImpl defaults to Node's global fetch, looked up at call time (CRA's
// Jest environment has none).
function createGmailApiTransport({ fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  let accessToken = '';
  let expiresAt = 0;

  async function getAccessToken() {
    if (accessToken && Date.now() < expiresAt - 60 * 1000) return accessToken;
    const res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GMAIL_CLIENT_ID,
        client_secret: process.env.GMAIL_CLIENT_SECRET,
        refresh_token: process.env.GMAIL_REFRESH_TOKEN,
        grant_type: 'refresh_token'
      }).toString(),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
    });
    // invalid_grant here means the refresh token was revoked or expired
    // (e.g. the OAuth app was left in "Testing", where tokens last 7 days).
    if (!res.ok) throw new Error(`Gmail token refresh failed: ${await readGoogleError(res)}`);
    const data = await res.json();
    accessToken = data.access_token;
    expiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
    return accessToken;
  }

  return {
    async sendMail(mail) {
      const { message } = await composer.sendMail(mail);
      const res = await fetchImpl(GMAIL_SEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await getAccessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: message.toString('base64url') }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
      });
      if (!res.ok) throw new Error(`Gmail send failed: ${await readGoogleError(res)}`);
      return res.json();
    }
  };
}

function buildTransport(user, pass) {
  if (gmailApiConfigured()) return createGmailApiTransport();
  if (user && pass) return nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  return null;
}

const APP_NAME = 'AfikInvest';

// The public address of the web app, used to build links in emails. Taken
// only from configuration - never from the request's Host header, which an
// attacker controls and could use to point a reset link at their own site.
function getAppUrl() {
  const configured = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') return '';
  return 'http://localhost:3000';
}

// The welcome email's words and markup live in emails/welcomeEmail.js. Its
// contact address is the account the mail is sent from - the one address
// the system is configured with.
function welcomeMessage(email, { name = '', unsubscribeUrl = '' } = {}) {
  return buildWelcomeEmail({ name, email, appUrl: getAppUrl(), contactEmail: String(process.env.EMAIL_USER || '').trim(), unsubscribeUrl });
}

// One-click unsubscribe (RFC 8058): mail clients show an "unsubscribe"
// button that POSTs to the link. Only for mail people can opt out of.
function unsubscribeHeaders(url) {
  if (!url) return undefined;
  return { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}

// transport: a nodemailer transport (or anything with sendMail) - tests pass
// a fake; normally built from the environment.
function createEmailService({ transport } = {}) {
  const user = String(process.env.EMAIL_USER || '').trim();
  // Google shows App Passwords in groups of four ("abcd efgh ijkl mnop").
  const pass = String(process.env.EMAIL_PASS || '').replace(/\s+/g, '');
  const transporter = transport || buildTransport(user, pass);
  const configured = Boolean(transporter);

  // options.headers: extra message headers (List-Unsubscribe);
  // options.replyTo: where a reply goes (the support form).
  async function send(to, { subject, html, text }, { headers, replyTo } = {}) {
    if (!transporter) {
      if (process.env.NODE_ENV === 'production') {
        console.warn(`email: no mail credentials (GMAIL_* or EMAIL_PASS) - skipped "${subject}"`);
      } else if (process.env.NODE_ENV !== 'test') {
        console.log(`\n[email:dev] to=${to}\nsubject: ${subject}\n${text}\n`);
      }
      return { skipped: true };
    }
    return transporter.sendMail({
      from: `"${APP_NAME}" <${user || 'no-reply@afikinvest.local'}>`,
      to,
      subject,
      html,
      text,
      ...(headers ? { headers } : {}),
      ...(replyTo ? { replyTo } : {})
    });
  }

  return {
    configured,
    send,
    // options.name: the user's name, when the signup collects one;
    // options.unsubscribeUrl: the opt-out page, for the footer;
    // options.oneClickUrl: the API address for one-click unsubscribe.
    sendWelcomeEmail: (to, options = {}) => send(to, welcomeMessage(to, options), { headers: unsubscribeHeaders(options.oneClickUrl) }),
    sendPasswordResetEmail: (to, resetUrl, minutes) => send(to, accountEmails.passwordReset({ link: resetUrl, minutes })),
    // template: a builder in emails/accountEmails.js, by name.
    sendAccountEmail: (to, template, params = {}) => {
      if (typeof accountEmails[template] !== 'function') return Promise.reject(new Error(`unknown email template ${template}`));
      return send(to, accountEmails[template](params));
    }
  };
}

module.exports = { createEmailService, createGmailApiTransport, gmailApiConfigured, getAppUrl, escapeHtml, welcomeMessage };
