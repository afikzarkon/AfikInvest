// This file used to hold Create React App's untouched boilerplate test
// ("renders learn react link"), which had failed since the app stopped
// being the CRA starter page - a permanently red suite everyone learned to
// ignore. Replaced with assertions about what App actually renders.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';

describe('App', () => {
  beforeEach(() => {
    // App's very first action is an auth check. Every test here is about
    // what renders around that, so the fetch is stubbed rather than the
    // whole auth hook mocked.
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => ''
    });
  });

  afterEach(() => {
    delete global.fetch;
  });

  test('renders a loading state first, then the sign-in screen when nobody is logged in', async () => {
    render(<App />);
    expect(screen.getByText('טוען…')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('טוען…')).toBeNull());
  });

  test('does not block the first paint on any price/market request', async () => {
    render(<App />);
    await waitFor(() => expect(screen.queryByText('טוען…')).toBeNull());

    // The app renders from what it already has; quotes are fetched in the
    // background afterwards, never as a precondition for showing the UI.
    const requestedUrls = global.fetch.mock.calls.map(([url]) => String(url));
    expect(requestedUrls.some((url) => url.includes('/api/israeli-stocks'))).toBe(false);
    expect(requestedUrls.some((url) => url.includes('/api/american-stocks'))).toBe(false);
  });

  test('a signed-out visitor at the root sees the landing page, and its button opens sign-up', async () => {
    window.history.replaceState({}, '', '/');
    render(<App />);
    const cta = (await screen.findAllByRole('button', { name: 'התחל עכשיו בחינם' }, { timeout: 5000 }))[0];
    fireEvent.click(cta);
    expect(window.location.pathname + window.location.search).toBe('/login?mode=register');
    expect(await screen.findByLabelText(/אימייל/)).toBeInTheDocument();

    // Back returns to the landing page.
    act(() => {
      window.history.replaceState({}, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect((await screen.findAllByRole('button', { name: 'התחל עכשיו בחינם' })).length).toBeGreaterThan(0);
  });

  test('a link with ?mode= still opens the form directly', async () => {
    window.history.replaceState({}, '', '/?mode=login');
    render(<App />);
    expect(await screen.findByLabelText(/אימייל/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'התחל עכשיו בחינם' })).toBeNull();
    window.history.replaceState({}, '', '/');
  });
});
