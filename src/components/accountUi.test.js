import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AuthView from './AuthView';
import PrivacyToggle, { PrivacyContext } from './PrivacyToggle';
import { displayNameOf } from './ui/Avatar';
import { securityScore } from './settings/SettingsView';
import { profileCompletion } from './settings/ProfileSection';
import { passwordStrength } from '../utils/passwordStrength';
import { formatPriceWithSign, setAmountsHidden, AMOUNT_MASK } from '../utils/formatters';
import { setUnsaved, hasUnsaved, confirmLeave } from '../utils/unsavedChanges';

// fetch for the AuthView: /api/auth/options, then whatever a test queues.
function mockFetch(options = {}, replies = []) {
  const queue = [...replies];
  global.fetch = jest.fn(async (url) => {
    if (String(url).includes('/api/auth/options')) {
      return { ok: true, status: 200, json: async () => ({ providers: {}, magicLink: true, turnstileSiteKey: '', ...options }) };
    }
    const next = queue.shift() || { status: 200, body: {} };
    return {
      ok: next.status < 400,
      status: next.status,
      headers: { get: () => 'application/json' },
      json: async () => next.body
    };
  });
}

afterEach(() => {
  delete global.fetch;
  setAmountsHidden(false);
});

describe('helpers', () => {
  test('password strength rises with length and variety, falls for patterns', () => {
    expect(passwordStrength('').score).toBe(0);
    expect(passwordStrength('abc').score).toBeLessThanOrEqual(1);
    expect(passwordStrength('password123').score).toBeLessThanOrEqual(1);
    expect(passwordStrength('Kx9!vR2#mL7q').score).toBeGreaterThanOrEqual(3);
    expect(passwordStrength('aaaaaaaaaaaa').score).toBe(0);
  });

  test('a user is never shown as an empty name', () => {
    expect(displayNameOf({ displayName: 'דנה' }, 'd@x.com')).toBe('דנה');
    expect(displayNameOf({ firstName: 'דנה', lastName: 'כהן' }, 'd@x.com')).toBe('דנה כהן');
    expect(displayNameOf({ providerName: 'Dana G' }, 'd@x.com')).toBe('Dana G');
    expect(displayNameOf(null, 'dana.c@example.com')).toBe('dana.c');
  });

  test('privacy mode masks money amounts and nothing else', () => {
    expect(formatPriceWithSign(1234.5)).not.toBe(AMOUNT_MASK);
    setAmountsHidden(true);
    expect(formatPriceWithSign(1234.5)).toBe(AMOUNT_MASK);
    expect(formatPriceWithSign(-5)).toBe(AMOUNT_MASK);
  });

  test('the security score credits 2FA most and lists the missing steps', () => {
    const base = { emailVerified: true, twoFactorEnabled: false, backupCodesLeft: 0, hasPassword: true, providerCount: 0, sessionCount: 1 };
    const weak = securityScore({ security: base });
    expect(weak.score).toBeLessThanOrEqual(60);
    expect(weak.steps.map((s) => s.text)).toContain('הפעלת אימות דו-שלבי');
    const strong = securityScore({ security: { ...base, twoFactorEnabled: true, backupCodesLeft: 10, providerCount: 1 } });
    expect(strong.score).toBe(100);
    expect(strong.steps).toEqual([]);
  });

  test('profile completion counts only what was filled in', () => {
    expect(profileCompletion({}, false)).toBe(0);
    expect(profileCompletion({ firstName: 'a', lastName: 'b', displayName: 'c', phone: '1', country: 'IL', timezone: 'UTC' }, true)).toBe(100);
  });

  test('unsaved changes ask before leaving, and leaving drops them', () => {
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
    expect(confirmLeave()).toBe(true);
    setUnsaved('profile', true);
    expect(confirmLeave()).toBe(false);
    confirm.mockReturnValue(true);
    expect(confirmLeave()).toBe(true);
    expect(hasUnsaved()).toBe(false);
    confirm.mockRestore();
  });
});

describe('sign-up screen', () => {
  test('only the address and password are required; terms must be accepted; name and marketing are optional', async () => {
    mockFetch({}, [{ status: 202, body: { verificationRequired: true, email: 'dana@example.com' } }]);
    render(<AuthView onAuthenticated={jest.fn()} initialMode="register" />);
    expect(screen.getByLabelText(/שם/)).not.toBeRequired();
    const marketing = screen.getByLabelText(/עדכונים וטיפים/);
    expect(marketing).not.toBeChecked();

    fireEvent.change(screen.getByLabelText('אימייל'), { target: { value: 'dana@example.com' } });
    fireEvent.change(screen.getByLabelText('סיסמה'), { target: { value: 'long-enough-pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'יצירת חשבון' }));
    expect(await screen.findByText(/יש לאשר את תנאי השימוש/, { selector: '.field-error' })).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(1); // options only

    fireEvent.click(screen.getByLabelText(/קראתי ואני מסכים/));
    fireEvent.click(screen.getByRole('button', { name: 'יצירת חשבון' }));
    // Then the code step.
    expect(await screen.findByLabelText('קוד אימות (6 ספרות)')).toBeInTheDocument();
    const [, init] = global.fetch.mock.calls[1];
    expect(JSON.parse(init.body)).toMatchObject({ email: 'dana@example.com', acceptTerms: true, marketingOptIn: false });
  });

  test('the address is checked as soon as the field is left, in Hebrew', async () => {
    mockFetch();
    render(<AuthView onAuthenticated={jest.fn()} initialMode="login" />);
    const email = screen.getByLabelText('אימייל');
    fireEvent.change(email, { target: { value: 'not-an-email' } });
    fireEvent.blur(email);
    expect(screen.getByText('כתובת האימייל אינה תקינה')).toBeInTheDocument();
    expect(email).toHaveAttribute('aria-invalid', 'true');
  });

  test('provider buttons appear only for the providers the server offers', async () => {
    mockFetch({ providers: { google: true, facebook: false }, oauthBaseUrl: 'https://api.example.com' });
    render(<AuthView onAuthenticated={jest.fn()} initialMode="login" />);
    const google = await screen.findByRole('link', { name: 'המשך עם Google' });
    expect(google).toHaveAttribute('href', 'https://api.example.com/api/auth/oauth/google?remember=1');
    expect(screen.queryByRole('link', { name: 'המשך עם Facebook' })).toBeNull();
  });

  test('the password can be shown and hidden', () => {
    mockFetch();
    render(<AuthView onAuthenticated={jest.fn()} initialMode="login" />);
    const field = screen.getByLabelText('סיסמה');
    expect(field).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: 'הצגת הסיסמה' }));
    expect(field).toHaveAttribute('type', 'text');
  });

  test('a 2FA account can sign in with a backup code instead', async () => {
    mockFetch({}, [{ status: 200, body: { twoFactorRequired: true, challengeToken: 'c' } }]);
    render(<AuthView onAuthenticated={jest.fn()} initialMode="login" />);
    fireEvent.change(screen.getByLabelText('אימייל'), { target: { value: 'dana@example.com' } });
    fireEvent.change(screen.getByLabelText('סיסמה'), { target: { value: 'whatever-pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'התחברות' }));
    fireEvent.click(await screen.findByRole('button', { name: /קוד גיבוי/ }));
    expect(screen.getByLabelText('קוד גיבוי')).toBeInTheDocument();
  });
});

test('the eye toggles privacy mode and reports its state', () => {
  const toggle = jest.fn();
  const { rerender } = render(
    <PrivacyContext.Provider value={{ hideAmounts: false, toggle }}>
      <PrivacyToggle />
    </PrivacyContext.Provider>
  );
  const button = screen.getByRole('button', { name: 'הסתרת הסכומים' });
  expect(button).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(button);
  expect(toggle).toHaveBeenCalled();
  rerender(
    <PrivacyContext.Provider value={{ hideAmounts: true, toggle }}>
      <PrivacyToggle />
    </PrivacyContext.Provider>
  );
  expect(screen.getByRole('button', { name: 'הצגת הסכומים' })).toHaveAttribute('aria-pressed', 'true');
});

test('without the privacy context, no eye is drawn', async () => {
  const { container } = render(<PrivacyToggle />);
  await waitFor(() => expect(container).toBeEmptyDOMElement());
});

describe('legal pages', () => {
  const LegalPage = require('./LegalPage').default;

  test('the terms say plainly that nothing is investment or tax advice', () => {
    render(<LegalPage path="/terms" onBack={jest.fn()} />);
    expect(screen.getByRole('heading', { name: /אין ייעוץ השקעות ואין המלצה/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /אין ייעוץ מס/ })).toBeInTheDocument();
    expect(screen.getByText(/חוק הסדרת העיסוק בייעוץ השקעות/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /הגבלת אחריות/ })).toBeInTheDocument();
  });

  test('the privacy policy commits to confidentiality and drops the old warnings', () => {
    const { container } = render(<LegalPage path="/privacy" onBack={jest.fn()} />);
    expect(screen.getByRole('heading', { name: 'סודיות' })).toBeInTheDocument();
    expect(screen.getByText(/איננו מוכרים, משכירים או סוחרים במידע/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/סייבר|אל תזינו|אין להזין/);
  });
});
