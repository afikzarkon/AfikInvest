import { render, screen, fireEvent, within } from '@testing-library/react';
import SideNav from './SideNav';
import AppShell from './AppShell';
import { NAV_GROUPS, ROUTES, routeByKey } from '../router/routes';

// Every destination the sidebar is supposed to offer, derived from the
// route table rather than restated here - so a route added there without a
// nav entry, or vice versa, fails rather than going unnoticed.
const NAV_KEYS = NAV_GROUPS.flatMap((group) => group.keys);

const noop = () => {};

function makeProps(overrides = {}) {
  return {
    activePage: 'home',
    onNavigate: noop,
    user: { email: 'test@example.com' },
    onLogout: noop,
    theme: 'dark',
    onToggleTheme: noop,
    ...overrides
  };
}

describe('SideNav', () => {
  test('renders every destination and marks the active one', () => {
    const { container } = render(<SideNav {...makeProps({ activePage: 'tax-offset' })} />);
    NAV_KEYS.forEach((key) => {
      expect(screen.getByText(routeByKey(key).label)).toBeInTheDocument();
    });
    expect(container.querySelectorAll('.side-nav-link.active').length).toBe(1);
  });

  // The nine pages the app was reorganised into all have to be reachable;
  // a page with no way in is a page that does not exist.
  test('offers a link for every non-hidden route', () => {
    render(<SideNav {...makeProps()} />);
    const linkable = ROUTES.filter((route) => !route.hidden);
    expect(NAV_KEYS).toHaveLength(linkable.length);
    linkable.forEach((route) => {
      expect(NAV_KEYS).toContain(route.key);
    });
  });

  test('groups the destinations rather than listing eleven of them flat', () => {
    const { container } = render(<SideNav {...makeProps()} />);
    expect(container.querySelectorAll('.side-nav-group').length).toBe(NAV_GROUPS.length);
  });

  // The highlight is invisible to a screen reader, so the current page has
  // to be stated rather than only styled.
  test('announces the current page to assistive tech, not only by styling', () => {
    render(<SideNav {...makeProps({ activePage: 'analytics' })} />);
    const current = screen.getByRole('button', { current: 'page' });
    expect(current).toHaveTextContent('ניתוח תיק');
  });

  test('clicking a destination navigates to it', () => {
    const onNavigate = jest.fn();
    render(<SideNav {...makeProps({ onNavigate })} />);

    // Every destination, not a sample of three - each one is a separate
    // wiring that can be wrong on its own.
    NAV_KEYS.forEach((key) => {
      fireEvent.click(screen.getByText(routeByKey(key).label));
      expect(onNavigate).toHaveBeenCalledWith(key);
    });
  });

  test('shows the signed-in user and logs out', () => {
    const onLogout = jest.fn();
    render(<SideNav {...makeProps({ onLogout })} />);
    expect(screen.getByText('test@example.com')).toBeInTheDocument();
    fireEvent.click(screen.getByText('התנתקות'));
    expect(onLogout).toHaveBeenCalled();
  });

  test('omits the user block entirely when nobody is signed in', () => {
    render(<SideNav {...makeProps({ user: null })} />);
    expect(screen.queryByText('test@example.com')).toBeNull();
    expect(screen.queryByText('התנתקות')).toBeNull();
  });

  test('carries the theme toggle', () => {
    const onToggleTheme = jest.fn();
    render(<SideNav {...makeProps({ onToggleTheme })} />);
    fireEvent.click(screen.getByRole('button', { name: 'עבור למצב בהיר' }));
    expect(onToggleTheme).toHaveBeenCalled();
  });

  test('is a landmark, so it can be skipped to and skipped over', () => {
    render(<SideNav {...makeProps()} />);
    expect(screen.getByRole('navigation', { name: 'ניווט ראשי' })).toBeInTheDocument();
  });

  // Icons are decorative next to their own visible labels; announcing them
  // would just repeat the label.
  test('hides the decorative icons from assistive tech', () => {
    const { container } = render(<SideNav {...makeProps()} />);
    const icons = container.querySelectorAll('.side-nav-icon');
    expect(icons.length).toBe(NAV_KEYS.length);
    icons.forEach((icon) => expect(icon).toHaveAttribute('aria-hidden', 'true'));
  });
});

describe('AppShell', () => {
  test('mounts the navigation once alongside the page content', () => {
    render(
      <AppShell {...makeProps()}>
        <p>תוכן הדף</p>
      </AppShell>
    );
    expect(screen.getAllByRole('navigation').length).toBe(1);
    expect(screen.getByText('תוכן הדף')).toBeInTheDocument();
  });

  test('puts the page content in a main landmark, separate from the nav', () => {
    const { container } = render(
      <AppShell {...makeProps()}>
        <p>תוכן הדף</p>
      </AppShell>
    );
    const main = screen.getByRole('main');
    expect(within(main).getByText('תוכן הדף')).toBeInTheDocument();
    expect(within(main).queryByText('דף הבית')).toBeNull();
    expect(container.querySelector('.app-shell')).not.toBeNull();
  });
});

describe('SideNav - flags and the phone layout', () => {
  test('a page hidden by a flag is left out of the nav, not greyed', () => {
    render(<SideNav {...makeProps({ hiddenRoutes: ['valuation'] })} />);
    expect(screen.queryByText(routeByKey('valuation').label)).toBeNull();
    expect(screen.getByText(routeByKey('home').label)).toBeInTheDocument();
  });

  test('showAccount=false drops the footer; the admin link only for admins', () => {
    const { rerender } = render(<SideNav {...makeProps({ showAccount: false })} />);
    expect(screen.queryByText('התנתקות')).toBeNull();
    rerender(<SideNav {...makeProps()} />);
    expect(screen.queryByText('ניהול')).toBeNull();
    rerender(<SideNav {...makeProps({ isAdmin: true })} />);
    expect(screen.getByText('ניהול')).toBeInTheDocument();
  });
});

describe('SideNav - the account controls on a phone', () => {
  const openMore = () => fireEvent.click(screen.getByRole('button', { name: /עוד/ }));

  test('the bottom bar holds only pages; the account block is in "עוד"', () => {
    render(<SideNav {...makeProps({ compact: true, showAccount: false })} />);
    expect(screen.queryByText('התנתקות')).toBeNull();
    openMore();
    const sheet = screen.getByRole('dialog', { name: 'כל הדפים' });
    expect(within(sheet).getByText('test@example.com')).toBeInTheDocument();
  });

  test('settings, theme and sign-out each work from the sheet, and close it', () => {
    const onLogout = jest.fn();
    const onNavigate = jest.fn();
    const onToggleTheme = jest.fn();
    render(<SideNav {...makeProps({ compact: true, onLogout, onNavigate, onToggleTheme })} />);
    openMore();
    fireEvent.click(screen.getByRole('button', { name: 'עבור למצב בהיר' }));
    expect(onToggleTheme).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'הגדרות' }));
    expect(onNavigate).toHaveBeenCalledWith('settings');
    expect(screen.queryByRole('dialog')).toBeNull();
    openMore();
    fireEvent.click(screen.getByRole('button', { name: 'התנתקות' }));
    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'ניהול' })).toBeNull();
  });

  test('the admin link is offered to admins only', () => {
    render(<SideNav {...makeProps({ compact: true, isAdmin: true })} />);
    openMore();
    expect(screen.getByRole('button', { name: 'ניהול' })).toBeInTheDocument();
  });

  test('the assets sheet has no account block', () => {
    render(<SideNav {...makeProps({ compact: true })} />);
    fireEvent.click(screen.getByRole('button', { name: 'נכסים' }));
    expect(screen.queryByText('test@example.com')).toBeNull();
  });

  test('signed out, the sheet lists pages only', () => {
    render(<SideNav {...makeProps({ compact: true, user: null })} />);
    openMore();
    expect(screen.queryByText('התנתקות')).toBeNull();
  });
});
