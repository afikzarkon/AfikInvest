/**
 * @jest-environment node
 */
const crypto = require('crypto');
const {
  ipPrefix,
  describeDevice,
  signupSchema,
  profileSchema,
  validate,
  isDisposableEmail,
  pwnedCount,
  verifyTurnstile,
  maskEmail,
  randomCode
} = require('./authHelpers');
const { normalizeProfile, parseSignedRequest, cookieStateStore } = require('./oauthRoutes');

describe('validation', () => {
  const base = { email: '  Dana@Example.COM ', password: 'long-enough-pass', acceptTerms: true };

  test('sign-up: email normalized, the rest optional, terms required', () => {
    const ok = validate(signupSchema, base);
    expect(ok).toMatchObject({ ok: true, data: { email: 'dana@example.com' } });
    expect(validate(signupSchema, { ...base, acceptTerms: false }).fieldErrors.acceptTerms).toMatch(/תנאי השימוש/);
    expect(validate(signupSchema, { ...base, email: 'not-an-email' }).fieldErrors.email).toMatch(/לא תקינה/);
    expect(validate(signupSchema, { ...base, referralCode: 'bad code!' }).fieldErrors.referralCode).toBeTruthy();
  });

  test('passwords: at least 8 characters and at most 72 bytes (what bcrypt reads)', () => {
    expect(validate(signupSchema, { ...base, password: '1234567' }).fieldErrors.password).toMatch(/8/);
    // 40 Hebrew letters are 80 bytes.
    expect(validate(signupSchema, { ...base, password: 'א'.repeat(40) }).fieldErrors.password).toMatch(/ארוכה/);
  });

  test('profile: every field optional, "" clears, unknown keys refused', () => {
    expect(validate(profileSchema, {}).ok).toBe(true);
    expect(validate(profileSchema, { phone: '', birthDate: '', country: 'il' }).data).toMatchObject({ country: 'IL' });
    expect(validate(profileSchema, { birthDate: '2001-02-30' }).ok).toBe(false);
    expect(validate(profileSchema, { timezone: 'Mars/Olympus' }).ok).toBe(false);
    expect(validate(profileSchema, { role: 'admin' }).ok).toBe(false);
  });
});

describe('checks', () => {
  test('disposable domains, including their subdomains', () => {
    expect(isDisposableEmail('x@mailinator.com')).toBe(true);
    expect(isDisposableEmail('x@sub.mailinator.com')).toBe(true);
    expect(isDisposableEmail('x@gmail.com')).toBe(false);
  });

  test('breached passwords by k-anonymity: only the hash prefix is sent', async () => {
    const sha1 = crypto.createHash('sha1').update('password123').digest('hex').toUpperCase();
    const fetchImpl = jest.fn(async (url) => ({ ok: true, text: async () => `0000000000000000000000000000000000A:1\r\n${sha1.slice(5)}:12345\r\n` }));
    const saved = process.env.HIBP_DISABLED;
    delete process.env.HIBP_DISABLED;
    try {
      expect(await pwnedCount('password123', { fetchImpl })).toBe(12345);
      expect(fetchImpl.mock.calls[0][0]).toBe(`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`);
      expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain(sha1.slice(5));
      expect(await pwnedCount('something-else', { fetchImpl })).toBe(0);
      // The service down: the password is let through (null), not blocked.
      expect(await pwnedCount('x', { fetchImpl: async () => { throw new Error('down'); } })).toBeNull();
    } finally {
      process.env.HIBP_DISABLED = saved;
    }
  });

  test('Turnstile: off without a secret; with one, the token is checked', async () => {
    expect(await verifyTurnstile('', '1.2.3.4')).toBe(true);
    process.env.TURNSTILE_SECRET_KEY = 'secret';
    try {
      expect(await verifyTurnstile('', '1.2.3.4')).toBe(false);
      const fetchImpl = jest.fn(async () => ({ json: async () => ({ success: true }) }));
      expect(await verifyTurnstile('tok', '1.2.3.4', { fetchImpl })).toBe(true);
      expect(fetchImpl.mock.calls[0][1].body).toContain('response=tok');
      expect(await verifyTurnstile('tok', '1.2.3.4', { fetchImpl: async () => ({ json: async () => ({ success: false }) }) })).toBe(false);
    } finally {
      delete process.env.TURNSTILE_SECRET_KEY;
    }
  });

  test('addresses are stored truncated; devices described', () => {
    expect(ipPrefix('203.0.113.77')).toBe('203.0.113.0');
    expect(ipPrefix('::ffff:203.0.113.77')).toBe('203.0.113.0');
    expect(ipPrefix('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::');
    expect(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Version/17.0 Mobile Safari/604.1')).toEqual({ browser: 'Safari', os: 'iOS', mobile: true });
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0) Chrome/124 Safari/537.36 Edg/124')).toMatchObject({ browser: 'Edge', os: 'Windows' });
    expect(maskEmail('dana@example.com')).toBe('d***@example.com');
    expect(randomCode()).toMatch(/^\d{6}$/);
  });
});

describe('sign-in providers', () => {
  test('only Google vouches for the address; Facebook never counts as verified', () => {
    const google = normalizeProfile('google', { id: '1', displayName: 'Dana', emails: [{ value: 'Dana@Gmail.com' }], _json: { email_verified: true } });
    expect(google).toEqual({ provider: 'google', id: '1', email: 'dana@gmail.com', emailVerified: true, name: 'Dana' });
    const unverified = normalizeProfile('google', { id: '2', emails: [{ value: 'x@y.com' }], _json: { email_verified: false } });
    expect(unverified.emailVerified).toBe(false);
    const facebook = normalizeProfile('facebook', { id: '3', displayName: 'Dana', emails: [{ value: 'd@fb.com' }], _json: {} });
    expect(facebook.emailVerified).toBe(false);
    expect(normalizeProfile('facebook', { id: '4', _json: {} }).email).toBe('');
  });

  test("Facebook's signed_request: accepted only with the app secret's signature", () => {
    const body = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: '42' })).toString('base64url');
    const sig = crypto.createHmac('sha256', 's3cret').update(body).digest('base64url');
    expect(parseSignedRequest(`${sig}.${body}`, 's3cret')).toMatchObject({ user_id: '42' });
    expect(parseSignedRequest(`${sig}.${body}`, 'other')).toBeNull();
    expect(parseSignedRequest('garbage', 's3cret')).toBeNull();
  });

  test('the OAuth state cookie round-trips once and rejects a mismatched state', (done) => {
    const store = cookieStateStore('k');
    const jar = {};
    const res = {
      cookie: (name, value) => {
        jar[name] = value;
      },
      clearCookie: (name) => {
        delete jar[name];
      }
    };
    const req = { res, cookies: jar };
    store.store(req, 'verifier-1', { mode: 'login', remember: true }, {}, (err, handle) => {
      expect(err).toBeNull();
      const cookie = jar.oauth_state;
      store.verify({ res, cookies: { oauth_state: cookie } }, 'wrong', (e1, ok1) => {
        expect(ok1).toBe(false);
        store.verify({ res, cookies: { oauth_state: cookie } }, handle, (e2, verifier, state) => {
          expect(verifier).toBe('verifier-1');
          expect(state).toEqual({ mode: 'login', remember: true });
          done();
        });
      });
    });
  });
});
