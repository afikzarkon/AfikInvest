import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import AlertsView from './AlertsView';

const alerts = [
  {
    id: 'a1',
    type: 'COMBINED_ANOMALY',
    severity: 'critical',
    title: 'NVDA ירדה 7.1% במחזור פי 2.8 מהממוצע',
    message: 'NVIDIA ירדה היום 7.1%.',
    recommendation: { action: 'REVIEW', text: 'בדקו חדשות' },
    createdAt: '2026-02-16T21:00:00Z',
    readAt: null
  },
  {
    id: 'a2',
    type: 'EVENT_UPCOMING',
    severity: 'info',
    title: 'KO: יום אקס דיבידנד בעוד 2 ימים',
    message: 'm',
    createdAt: '2026-02-15T21:00:00Z',
    readAt: '2026-02-15T22:00:00Z'
  }
];

function renderView(overrides = {}) {
  const props = {
    alerts,
    unreadCount: 1,
    onMarkRead: jest.fn(),
    onMarkAllRead: jest.fn(),
    loadCalendar: jest.fn().mockResolvedValue({
      events: [
        { symbol: 'KO', market: 'US', name: 'Coca-Cola', eventType: 'EX_DIVIDEND', eventDate: '2026-03-10', status: 'projected', confidence: 0.9, expectedGross: 50, currency: 'USD', expectedGrossILS: 180 }
      ]
    }),
    loadSettings: jest.fn().mockResolvedValue({ settings: { enabled: true, eventReminders: true, pctMove: 5, zWarn: 2, zCritical: 3, volWarn: 2, volCritical: 3, majorWeightPct: 15 } }),
    saveSettings: jest.fn().mockImplementation(async (s) => ({ settings: s })),
    refreshNow: jest.fn().mockResolvedValue({ scan: { scanned: 3, alertsCreated: 1 }, calendar: { remindersCreated: 1 } }),
    formatPriceWithSign: (v) => v.toFixed(2),
    ...overrides
  };
  render(<AlertsView {...props} />);
  return props;
}

test('lists alerts with severity, message and recommendation; mark read', () => {
  const props = renderView();
  expect(screen.getByText('NVDA ירדה 7.1% במחזור פי 2.8 מהממוצע')).toBeInTheDocument();
  expect(screen.getByText('קריטי', { selector: '.alert-severity-badge' })).toBeInTheDocument();
  expect(screen.getByText(/בדקו חדשות/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'סימון כנקרא' }));
  expect(props.onMarkRead).toHaveBeenCalledWith('a1');
  fireEvent.click(screen.getByRole('button', { name: 'סימון הכל כנקרא' }));
  expect(props.onMarkAllRead).toHaveBeenCalled();
});

test('filters by unread and severity', () => {
  renderView();
  fireEvent.change(screen.getByLabelText('הצגה'), { target: { value: 'info' } });
  expect(screen.queryByText(/NVDA/)).not.toBeInTheDocument();
  expect(screen.getByText(/KO: יום אקס/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('הצגה'), { target: { value: 'unread' } });
  expect(screen.getByText(/NVDA/)).toBeInTheDocument();
  expect(screen.queryByText(/KO: יום אקס/)).not.toBeInTheDocument();
});

test('calendar tab shows projected events with the expected payout', async () => {
  renderView();
  fireEvent.click(screen.getByRole('tab', { name: 'לוח אירועים' }));
  const table = await screen.findByRole('table', { name: 'לוח אירועים' });
  expect(within(table).getByText('Coca-Cola (KO)')).toBeInTheDocument();
  expect(within(table).getByText('משוער (90%)')).toBeInTheDocument();
  expect(within(table).getByText('50.00 USD · 180.00 ₪')).toBeInTheDocument();
});

test('settings tab saves numeric thresholds', async () => {
  const props = renderView();
  fireEvent.click(screen.getByRole('tab', { name: 'הגדרות' }));
  const input = await screen.findByLabelText('שינוי יומי חריג (%)');
  fireEvent.change(input, { target: { value: '3.5' } });
  fireEvent.click(screen.getByRole('button', { name: 'שמירה' }));
  await waitFor(() => expect(props.saveSettings).toHaveBeenCalled());
  expect(props.saveSettings.mock.calls[0][0]).toMatchObject({ pctMove: 3.5, enabled: true, volWarn: 2 });
  expect(await screen.findByRole('status')).toHaveTextContent('נשמר');
});

test('scan now reports what it found', async () => {
  renderView();
  fireEvent.click(screen.getByRole('button', { name: 'סריקה עכשיו' }));
  expect(await screen.findByText('נסרקו 3 ניירות, 2 התראות חדשות')).toBeInTheDocument();
});
