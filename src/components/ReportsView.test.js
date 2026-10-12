import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import ReportsView, { recentMonths, monthLabel } from './ReportsView';

const status = {
  month: '2026-08',
  state: 'IN_PROGRESS',
  updatedCount: 1,
  requiredCount: 2,
  accounts: [
    { key: 'pension:5', name: 'גמל מניות', category: 'pension', valueDate: '2026-07-01', updated: false, excluded: false },
    { key: 'bank:6', name: 'עו"ש #1', category: 'bank', valueDate: '2026-09-02', updated: true, excluded: false }
  ],
  pendingReport: null
};
const reports = [
  { id: 'r2', month: '2026-08', version: 2, status: 'ready', updatedAt: '2026-09-06T10:00:00Z' },
  { id: 'r1', month: '2026-07', version: 1, status: 'ready', updatedAt: '2026-08-06T10:00:00Z' }
];

function renderView(overrides = {}) {
  const props = {
    status,
    reports,
    onSelectMonth: jest.fn(),
    onSetExcluded: jest.fn().mockResolvedValue(),
    onComplete: jest.fn().mockResolvedValue({}),
    onRegenerate: jest.fn().mockResolvedValue({}),
    onDownload: jest.fn().mockResolvedValue(),
    onToggleEmail: jest.fn().mockResolvedValue(),
    ...overrides
  };
  render(<ReportsView {...props} />);
  return props;
}

test('helpers', () => {
  expect(recentMonths(new Date('2026-02-15T00:00:00Z'), 3)).toEqual(['2026-02', '2026-01', '2025-12']);
  expect(monthLabel('2026-08')).toBe('אוגוסט 2026');
});

test('shows which accounts are still missing', () => {
  renderView();
  expect(screen.getByText('1/2 חשבונות עודכנו')).toBeInTheDocument();
  const table = screen.getByRole('table', { name: 'חשבונות לעדכון' });
  expect(within(table).getByText('ממתין לעדכון')).toBeInTheDocument();
  expect(within(table).getByText('עודכן')).toBeInTheDocument();
});

test('excluding an account sends the full excluded list', async () => {
  const props = renderView();
  fireEvent.click(screen.getByLabelText('לא לחכות לגמל מניות'));
  await waitFor(() => expect(props.onSetExcluded).toHaveBeenCalledWith(['pension:5']));
});

test('"Finished monthly update" completes the month', async () => {
  const props = renderView();
  fireEvent.click(screen.getByRole('button', { name: 'סיימתי עדכון חודשי' }));
  await waitFor(() => expect(props.onComplete).toHaveBeenCalled());
  expect(await screen.findByRole('status')).toHaveTextContent('הדוח ייווצר בעוד כ-10 דקות');
});

test('a complete month offers a new version and hides the complete button; pending report time is shown', () => {
  renderView({ status: { ...status, state: 'COMPLETE', pendingReport: { version: 3, runAfter: '2026-09-06T10:10:00Z', status: 'queued' } } });
  expect(screen.queryByRole('button', { name: 'סיימתי עדכון חודשי' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'יצירת גרסה חדשה' })).toBeInTheDocument();
  expect(screen.getByText(/גרסה 3 של הדוח תיווצר/)).toBeInTheDocument();
});

test('lists this month and earlier reports with download', async () => {
  const props = renderView();
  const buttons = screen.getAllByRole('button', { name: 'הורדת PDF' });
  expect(buttons).toHaveLength(2);
  fireEvent.click(buttons[0]);
  await waitFor(() => expect(props.onDownload).toHaveBeenCalledWith(reports[0]));
  expect(screen.getByText('דוחות קודמים')).toBeInTheDocument();
});

test('e-mail opt-in', async () => {
  const props = renderView();
  fireEvent.click(screen.getByLabelText('לשלוח לי מייל עם קישור כשהדוח מוכן'));
  await waitFor(() => expect(props.onToggleEmail).toHaveBeenCalledWith(true));
});
