/**
 * @jest-environment node
 */
const nodemailer = require('nodemailer');
const { buildWelcomeEmail, STEPS } = require('./welcomeEmail');
const { welcomeMessage } = require('../emailService');

const base = { name: 'דנה', email: 'dana@example.com', appUrl: 'https://app.example.com', contactEmail: 'help@example.com' };

test('greets by name, in Hebrew, right to left, in one 600px table layout', () => {
  const { subject, html } = buildWelcomeEmail(base);
  expect(subject).toBe('דנה, ברוכים הבאים ל-StockView!');
  expect(html).toMatch(/<html lang="he" dir="rtl">/);
  expect(html).toMatch(/<meta charset="utf-8">/);
  expect(html).toContain('שלום דנה,');
  expect(html).toContain('max-width:600px');
  expect(html).not.toMatch(/<script|<link|<style/i);
});

test('links each step image and the button from APP_URL, with Hebrew alt text', () => {
  const { html } = buildWelcomeEmail(base);
  STEPS.forEach((step) => {
    expect(html).toContain(`src="https://app.example.com/email/${step.image}"`);
    expect(html).toContain(`alt="${step.alt.replace(/"/g, '&quot;')}"`);
  });
  expect(html).toContain('max-width:560px;height:auto');
  expect(html).toContain('href="https://app.example.com"');
  expect(html).toContain('mailto:help@example.com');
});

test('without an app address there are no images or buttons pointing nowhere', () => {
  const { html, text } = buildWelcomeEmail({ ...base, appUrl: '' });
  expect(html).not.toMatch(/<img|href="\/|href=""/);
  expect(text).not.toMatch(/מעבר לאתר:/);
});

test("the user's name and email cannot add markup", () => {
  const { html } = buildWelcomeEmail({ ...base, name: '<img src=x onerror=alert(1)>', email: 'a"><script>@x.com' });
  expect(html).not.toContain('<img src=x');
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
});

test('a plain-text version carries the same content', () => {
  const { text } = buildWelcomeEmail(base);
  expect(text).toMatch(/^שלום דנה,/);
  STEPS.forEach((step, i) => expect(text).toContain(`${i + 1}. ${step.title}`));
  expect(text).toContain('מעבר לאתר: https://app.example.com');
  expect(text).toContain('help@example.com');
});

test('without a name the greeting stays general', () => {
  const { subject, html } = buildWelcomeEmail({ ...base, name: '  ' });
  expect(subject).toBe('ברוכים הבאים ל-StockView!');
  expect(html).toContain('שלום,');
});

test('as sent: multipart/alternative, UTF-8 subject and body, no password', async () => {
  const env = process.env;
  process.env = { ...env, APP_URL: 'https://app.example.com/', EMAIL_USER: 'sender@example.com' };
  try {
    const message = welcomeMessage('dana@example.com');
    expect(message.html).toContain('src="https://app.example.com/email/'); // trailing slash trimmed
    expect(message.html).toContain('mailto:sender@example.com');
    expect(message.html.toLowerCase()).not.toContain('password');
    expect(message.text).not.toMatch(/סיסמה:/);

    const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    const { message: raw } = await composer.sendMail({ from: 'sender@example.com', to: 'dana@example.com', ...message });
    const mime = raw.toString('utf8');
    expect(mime).toMatch(/Content-Type: multipart\/alternative/);
    expect(mime).toMatch(/^Subject: =\?UTF-8\?/m);
    expect(mime).toMatch(/Content-Type: text\/plain; charset=utf-8/);
    expect(mime).toMatch(/Content-Type: text\/html; charset=utf-8/);
  } finally {
    process.env = env;
  }
});
