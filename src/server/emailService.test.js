/**
 * @jest-environment node
 */
const { createGmailApiTransport, createEmailService } = require('./emailService');

function jsonResponse(status, body) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe('Gmail API transport', () => {
  const env = process.env;
  beforeEach(() => {
    process.env = { ...env, GMAIL_CLIENT_ID: 'cid', GMAIL_CLIENT_SECRET: 'csecret', GMAIL_REFRESH_TOKEN: 'rtoken' };
  });
  afterEach(() => {
    process.env = env;
  });

  test('refreshes an access token once, then sends the MIME message base64url-encoded', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'at-1', expires_in: 3600 }))
      .mockResolvedValue(jsonResponse(200, { id: 'msg' }));
    const transport = createGmailApiTransport({ fetchImpl });

    await transport.sendMail({ from: 'a@example.com', to: 'b@example.com', subject: 'איפוס סיסמה', text: 'hi', html: '<b>hi</b>' });
    await transport.sendMail({ from: 'a@example.com', to: 'b@example.com', subject: 'שוב', text: 'hi' });

    const [tokenUrl, tokenInit] = fetchImpl.mock.calls[0];
    expect(tokenUrl).toBe('https://oauth2.googleapis.com/token');
    expect(new URLSearchParams(tokenInit.body).get('refresh_token')).toBe('rtoken');

    const sends = fetchImpl.mock.calls.slice(1);
    expect(sends).toHaveLength(2); // the token was reused
    const [sendUrl, sendInit] = sends[0];
    expect(sendUrl).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect(sendInit.headers.Authorization).toBe('Bearer at-1');
    const raw = Buffer.from(JSON.parse(sendInit.body).raw, 'base64url').toString('utf8');
    expect(raw).toMatch(/^To: b@example.com$/m);
    expect(raw).toMatch(/^Subject: =\?UTF-8\?/m);
  });

  test('a rejected refresh token surfaces as an error naming the cause', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(400, { error: 'invalid_grant' }));
    const transport = createGmailApiTransport({ fetchImpl });
    await expect(transport.sendMail({ to: 'b@example.com', subject: 's', text: 't' })).rejects.toThrow(/invalid_grant/);
  });

  test('the email service picks the Gmail API when its credentials are set', () => {
    process.env.EMAIL_PASS = '';
    expect(createEmailService().configured).toBe(true);
  });
});

describe('checkHealth - what would stop mail from arriving', () => {
  const env = process.env;
  afterEach(() => {
    process.env = env;
  });

  test('in production, no credentials and no APP_URL are both reported', async () => {
    process.env = { ...env, NODE_ENV: 'production', GMAIL_CLIENT_ID: '', GMAIL_CLIENT_SECRET: '', GMAIL_REFRESH_TOKEN: '', EMAIL_USER: '', EMAIL_PASS: '', APP_URL: '' };
    const problems = await createEmailService().checkHealth();
    expect(problems.some((p) => p.startsWith('no mail credentials'))).toBe(true);
    expect(problems.some((p) => p.startsWith('APP_URL is not set'))).toBe(true);
  });

  test('an expired Gmail refresh token is named, with what to do', async () => {
    process.env = { ...env, NODE_ENV: 'production', APP_URL: 'https://afikinvest.com' };
    const transport = { verify: jest.fn().mockRejectedValue(new Error('Gmail token refresh failed: 400 {"error":"invalid_grant"}')), sendMail: jest.fn() };
    const problems = await createEmailService({ transport }).checkHealth();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/invalid_grant/);
    expect(problems[0]).toMatch(/refresh token was revoked or expired/);
  });

  test('working credentials and an APP_URL: nothing to report', async () => {
    process.env = { ...env, NODE_ENV: 'production', APP_URL: 'https://afikinvest.com' };
    const transport = { verify: jest.fn().mockResolvedValue(true), sendMail: jest.fn() };
    expect(await createEmailService({ transport }).checkHealth()).toEqual([]);
  });

  test('a mail skipped for want of credentials is an error, so the admin panel records it', async () => {
    process.env = { ...env, NODE_ENV: 'production', GMAIL_CLIENT_ID: '', EMAIL_USER: '', EMAIL_PASS: '' };
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await createEmailService().send('a@example.com', { subject: 'אימות', text: 't', html: 'h' });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('no mail credentials'));
    spy.mockRestore();
  });

  test('the Gmail API transport can be verified without sending', async () => {
    process.env = { ...env, GMAIL_CLIENT_ID: 'cid', GMAIL_CLIENT_SECRET: 'cs', GMAIL_REFRESH_TOKEN: 'rt' };
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { access_token: 'at', expires_in: 3600 }));
    await expect(createGmailApiTransport({ fetchImpl }).verify()).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
