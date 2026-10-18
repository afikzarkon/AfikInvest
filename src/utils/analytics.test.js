import { trackEvent, trackPageView } from './analytics';

describe('analytics', () => {
  afterEach(() => {
    delete window.gtag;
  });

  test('is a no-op without the Google tag', () => {
    expect(() => trackPageView('/')).not.toThrow();
    expect(() => trackEvent('login', { method: 'password' })).not.toThrow();
  });

  test('a page view carries the route path, not the address', () => {
    window.gtag = jest.fn();
    trackPageView('/valuation', 'הערכת שווי');
    const [, name, params] = window.gtag.mock.calls[0];
    expect(name).toBe('page_view');
    expect(params.page_path).toBe('/valuation');
    expect(params.page_location).toBe(`${window.location.origin}/valuation`);
  });

  test('events pass only allow-listed, short plain parameters', () => {
    window.gtag = jest.fn();
    trackEvent('login', { method: 'oauth', email: 'a@b.com', amount: 125000, feature: 'יוניקוד', user_id: '42' });
    expect(window.gtag).toHaveBeenCalledWith('event', 'login', { method: 'oauth' });
  });
});
