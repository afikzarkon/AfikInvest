/**
 * @jest-environment node
 */
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const { mountAuthRoutes } = require('./authRoutes');

// Jest's node test environment doesn't expose global fetch, so use Node's
// built-in http module for these requests instead of adding a dependency.
function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request(
      url,
      {
        method: 'POST',
        agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsedBody = null;
          try {
            parsedBody = JSON.parse(raw);
          } catch {
            parsedBody = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsedBody });
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function makeStore() {
  return {
    findUserIdByEmail: jest.fn().mockResolvedValue(null),
    insertUser: jest.fn().mockResolvedValue({ id: 1 }),
    findUserForLogin: jest.fn().mockResolvedValue(null)
  };
}

// Only what sign-up touches; nothing is stored.
function makeAccounts() {
  return {
    setConsent: jest.fn().mockResolvedValue(),
    updateProfile: jest.fn().mockResolvedValue(),
    updateProfileExtra: jest.fn().mockResolvedValue({}),
    logEvent: jest.fn().mockResolvedValue(),
    createToken: jest.fn().mockResolvedValue(),
    latestToken: jest.fn().mockResolvedValue(null)
  };
}

const mailer = { sendAccountEmail: jest.fn().mockResolvedValue({}), sendWelcomeEmail: jest.fn(), sendPasswordResetEmail: jest.fn() };
const signupBody = (email) => ({ email, password: 'password123', acceptTerms: true });

describe('authRoutes rate limiting', () => {
  let app;
  let server;
  let baseUrl;
  let store;

  beforeEach((done) => {
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    store = makeStore();
    mountAuthRoutes(app, store, { accounts: makeAccounts(), mailer });
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      done();
    });
  });

  afterEach((done) => {
    server.close(done);
  });

  test('POST /api/auth/login returns 429 after exceeding the attempt limit', async () => {
    store.findUserForLogin.mockResolvedValue(null);

    let lastRes;
    for (let i = 0; i < 10; i += 1) {
      lastRes = await post(`${baseUrl}/api/auth/login`, { email: 'a@b.com', password: 'wrong-pass' });
      expect(lastRes.status).toBe(401);
    }

    const blocked = await post(`${baseUrl}/api/auth/login`, { email: 'a@b.com', password: 'wrong-pass' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBeTruthy();
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  test('POST /api/auth/register returns 429 after exceeding the attempt limit', async () => {
    // Every address already has an account - answered like a new one.
    store.findUserForLogin.mockResolvedValue({ id: 1, email: 'x@b.com', email_verified_at: '2026-01-01' });

    let lastRes;
    for (let i = 0; i < 10; i += 1) {
      lastRes = await post(`${baseUrl}/api/auth/register`, signupBody(`user${i}@b.com`));
      expect(lastRes.status).toBe(202);
    }

    const blocked = await post(`${baseUrl}/api/auth/register`, signupBody('new@b.com'));
    expect(blocked.status).toBe(429);
  });

  test('rate limiting on login does not block register from the same client', async () => {
    store.findUserForLogin.mockResolvedValue(null);
    for (let i = 0; i < 11; i += 1) {
      await post(`${baseUrl}/api/auth/login`, { email: 'a@b.com', password: 'wrong-pass' });
    }

    store.findUserIdByEmail.mockResolvedValue(null);
    const res = await post(`${baseUrl}/api/auth/register`, signupBody('fresh@b.com'));
    expect(res.status).toBe(202);
  });
});
