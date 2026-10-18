import { render, screen, fireEvent } from '@testing-library/react';
import BetaNoticeModal from './BetaNoticeModal';
import BetaBanner from './BetaBanner';

describe('BetaNoticeModal', () => {
  const noop = () => {};

  // The things the notice exists to say. Asserted by their substance
  // rather than by exact sentence, so rewording the copy does not fail the
  // test but dropping one of them does.
  test('states that the system is a beta and that nothing in it is investment advice', () => {
    render(<BetaNoticeModal onAcknowledge={noop} />);
    expect(screen.getByText(/נמצאת כרגע בשלב בדיקות/)).toBeInTheDocument();
    expect(screen.getByText(/אין כאן ייעוץ השקעות או המלצה/)).toBeInTheDocument();
    expect(screen.getByText(/ההחלטות והאחריות שלכם/)).toBeInTheDocument();
  });

  // The site is no longer described as unsecured or as a place for dummy
  // data only - it says how the data is kept instead.
  test('promises confidentiality rather than warning off real data', () => {
    const { container } = render(<BetaNoticeModal onAcknowledge={noop} />);
    expect(screen.getByText(/המידע שלכם נשמר בסודיות/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/סייבר|נתוני דמה|אין להזין/);
  });

  test('links the terms and the privacy policy it asks the user to accept', () => {
    render(<BetaNoticeModal onAcknowledge={noop} />);
    expect(screen.getByRole('link', { name: 'תנאי השימוש' })).toHaveAttribute('href', '/terms');
    expect(screen.getByRole('link', { name: 'מדיניות הפרטיות' })).toHaveAttribute('href', '/privacy');
  });

  test('warns that the tax figures are an estimate and points at a professional', () => {
    render(<BetaNoticeModal onAcknowledge={noop} />);
    expect(screen.getByText(/חישובי המס הם אומדן בלבד/)).toBeInTheDocument();
    expect(screen.getByText(/Tax-Loss Harvesting/)).toBeInTheDocument();
    expect(screen.getByText(/התייעצו עם איש מקצוע מוסמך/)).toBeInTheDocument();
  });

  // It is a decision, not a notification: assistive tech has to interrupt
  // for it rather than announce it in passing.
  test('is an alert dialog, labelled and described by its own content', () => {
    render(<BetaNoticeModal onAcknowledge={noop} />);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('המערכת נמצאת בשלב בדיקות');
  });

  test('the acknowledgement is what dismisses it', () => {
    const onAcknowledge = jest.fn();
    render(<BetaNoticeModal onAcknowledge={onAcknowledge} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onAcknowledge).toHaveBeenCalled();
  });

  // Acknowledging is the only way out on purpose - see the component's own
  // note. A click on the backdrop or an Escape is the gesture for closing
  // something optional, and this is not.
  test('offers exactly one way out, and it is the acknowledgement', () => {
    render(<BetaNoticeModal onAcknowledge={noop} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  test('focus lands on the acknowledgement rather than behind the overlay', () => {
    render(<BetaNoticeModal onAcknowledge={noop} />);
    expect(screen.getByRole('button')).toHaveFocus();
  });

  // A modal the page scrolls behind is a banner with extra steps.
  test('locks the page behind it while it is up, and releases it on unmount', () => {
    const { unmount } = render(<BetaNoticeModal onAcknowledge={noop} />);
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).not.toBe('hidden');
  });
});

describe('BetaBanner', () => {
  test('says the typed-in figures are kept confidential, where figures are typed', () => {
    const { container } = render(<BetaBanner tone="data" />);
    expect(screen.getByText(/נשמרים בסודיות/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/סייבר|נתוני דמה|אין להזין/);
  });

  test('says a valuation is not a recommendation to buy or sell', () => {
    render(<BetaBanner tone="invest" />);
    expect(screen.getByText(/אין זו המלצה/)).toBeInTheDocument();
    expect(screen.getByText(/אינם ייעוץ השקעות, המלצה או הצעה לקנות או למכור/)).toBeInTheDocument();
  });

  test('says suggested actions are not advice, and the tax in them an estimate', () => {
    render(<BetaBanner tone="advice" />);
    expect(screen.getByText(/ואינן ייעוץ השקעות, ייעוץ מס או המלצה לבצע פעולה/)).toBeInTheDocument();
    expect(screen.getByText(/חישובי המס הם אומדן בלבד/)).toBeInTheDocument();
  });

  test('leads with the estimate warning where a tax figure is being claimed', () => {
    render(<BetaBanner tone="tax" />);
    expect(screen.getByText(/חישובי המס הם אומדן/)).toBeInTheDocument();
    expect(screen.getByText(/יועץ מס או איש מקצוע מוסמך/)).toBeInTheDocument();
  });

  test('falls back to the general warning, including for an unknown tone', () => {
    const { rerender } = render(<BetaBanner />);
    expect(screen.getByText(/המערכת בשלב בדיקות \(Beta\)/)).toBeInTheDocument();

    rerender(<BetaBanner tone="nonsense" />);
    expect(screen.getByText(/המערכת בשלב בדיקות \(Beta\)/)).toBeInTheDocument();
  });

  test('is a note rather than an alert - it is a standing condition, not an event', () => {
    render(<BetaBanner />);
    expect(screen.getByRole('note')).toBeInTheDocument();
  });
});
