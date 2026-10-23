import { fireEvent, render, screen, within } from '@testing-library/react';
import LandingPage from './LandingPage';

const renderPage = (props = {}) => {
  const onRegister = jest.fn();
  const onLogin = jest.fn();
  render(<LandingPage theme="dark" onToggleTheme={() => {}} onRegister={onRegister} onLogin={onLogin} {...props} />);
  return { onRegister, onLogin };
};

describe('LandingPage', () => {
  test('says it is free, and both ways in work', () => {
    const { onRegister, onLogin } = renderPage();
    expect(screen.getByText(/חינם לחלוטין – ללא עלות וללא דמי מנוי/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'התחל עכשיו בחינם' })[0]);
    expect(onRegister).toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'התחברות' })[0]);
    expect(onLogin).toHaveBeenCalled();
  });

  test("shows the demo's computed tiles, and switches to the phone cards", () => {
    renderPage();
    const preview = screen.getByRole('tabpanel');
    ['שווי תיק כולל', 'שינוי יומי', 'שינוי אתמול', 'תשואה פנימית (XIRR)'].forEach((label) => {
      expect(within(preview).getByText(label)).toBeInTheDocument();
    });
    // No placeholder where a computed figure should be.
    expect(within(preview).queryByText('—')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'נייד' }));
    expect(screen.getByRole('tab', { name: 'נייד' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('list', { name: 'אחזקות לדוגמה' })).toBeInTheDocument();
  });

  test('names the product AfikInvest only', () => {
    const { container } = render(<LandingPage theme="dark" onToggleTheme={() => {}} onRegister={() => {}} onLogin={() => {}} />);
    expect(container.textContent).not.toMatch(/stockview/i);
  });
});
