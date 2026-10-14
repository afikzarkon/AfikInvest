import { useState } from 'react';
import { render, fireEvent } from '@testing-library/react';
import FinancialAccountsTables from './FinancialAccountsTables';
import { applyLedgerValueEditPayload } from '../utils/portfolioMath';

// The money-market fund and current-account tables, wired the way App.js
// wires them: a 'currentValue' edit goes through applyLedgerValueEditPayload,
// anything else replaces the field.
function Harness({ initialCashFunds = [], initialBankBalances = [], onEditTransaction }) {
  const [cashFunds, setCashFunds] = useState(initialCashFunds);
  const [bankBalances, setBankBalances] = useState(initialBankBalances);
  const [editingField, setEditingField] = useState(null);

  const edit = (setItems) => (id, field, value) =>
    setItems((items) =>
      items.map((it) => {
        if (it.id !== id) return it;
        if (field === 'currentValue') return applyLedgerValueEditPayload(it, value);
        return { ...it, [field]: value };
      })
    );
  const handleInlineEdit = (id, field, value, exchange) =>
    exchange === 'bank' ? edit(setBankBalances)(id, field, value) : edit(setCashFunds)(id, field, value);

  return (
    <FinancialAccountsTables
      pensionFunds={[]}
      cashFunds={cashFunds}
      bankBalances={bankBalances}
      sections={['cash', 'bank']}
      cpi={null}
      showAdditionalData={true}
      isEditMode={true}
      editingField={editingField}
      handleCellClick={(id, field) => setEditingField(`${id}-${field}`)}
      handleInlineEdit={handleInlineEdit}
      finishInlineEdit={() => setEditingField(null)}
      handleKeyDown={() => {}}
      formatDate={(d) => d}
      formatPriceWithSign={(v) => String(v)}
      handleDelete={() => {}}
      onEditTransaction={onEditTransaction}
    />
  );
}

const recordValue = (cell, value, date) => {
  fireEvent.click(cell);
  fireEvent.change(cell.querySelector('input[type="number"]'), { target: { value } });
  const dateInput = cell.querySelector('input[type="date"]');
  fireEvent.change(dateInput, { target: { value: date } });
  fireEvent.keyDown(dateInput, { key: 'Enter' });
};

// Cash fund columns (extra data and edit mode on): 0 name, 1 security id,
// 2 total deposits, 3 value today, 4 value date, 5 return since previous
// update, 6 overall return, 7 previous value, 8 previous date, 9 actions.
describe('money-market fund (כספית שקלית)', () => {
  test('recording a statement value rolls the old value and date into previous', () => {
    const fund = { id: 10, fundName: 'כספית', securityId: '5119609', currentValue: 5000, currentValueDate: '2024-01-01', deposits: [{ date: '2024-01-01', amount: 5000 }] };
    const { container } = render(<Harness initialCashFunds={[fund]} />);
    const row = container.querySelector('tbody tr');
    recordValue(row.children[3], '5200', '2024-02-01');
    expect(row.children[3].textContent).toBe('5200 ₪');
    expect(row.children[4].textContent).toBe('2024-02-01');
    expect(row.children[7].textContent).toBe('5000 ₪');
  });

  // The reported case (moved into the past): 14,000 and 2,500 deposited the
  // same day, worth 15,000 the next. The balance before the statement was
  // 16,500 - not the 14,000 opening deposit - so this is a loss of 9.09%,
  // not a gain.
  test('the return since the previous update counts every deposit, same-day ones included', () => {
    const fund = {
      id: 13,
      fundName: 'כספית',
      securityId: '5119609',
      valueFromLedger: true,
      currentValue: 16500,
      amount: 16500,
      currentValueDate: '2026-10-04',
      previousValue: 0,
      previousValueDate: '',
      deposits: [
        { date: '2026-10-04', amount: 14000, txId: 'a' },
        { date: '2026-10-04', amount: 2500, txId: 'b' }
      ]
    };
    const { container } = render(<Harness initialCashFunds={[fund]} />);
    const row = container.querySelector('tbody tr');
    expect(row.children[2].textContent).toBe('16500 ₪');
    expect(row.children[4].textContent).toBe('לפי ההפקדות');
    expect(row.children[5].textContent).toBe('-');

    recordValue(row.children[3], '15000', '2026-10-05');
    expect(row.children[7].textContent).toBe('16500 ₪');
    expect(row.children[5].textContent).toBe('-9.09%');
    expect(row.children[6].textContent).toContain('-9.09%');
    expect(row.children[6].textContent).toContain('-1500 ₪');
  });

  test('a withdrawal shows in the expanded ledger labeled "(משיכה)"', () => {
    const fund = {
      id: 11,
      fundName: 'כספית',
      securityId: '5119609',
      currentValue: 2000,
      currentValueDate: '2024-02-01',
      deposits: [
        { date: '2024-01-01', amount: 5000 },
        { date: '2024-01-20', amount: -3000 }
      ]
    };
    const { container, getByText } = render(<Harness initialCashFunds={[fund]} />);
    fireEvent.click(container.querySelector('.expand-button'));
    expect(getByText((content) => content.includes('-3000') && content.includes('משיכה'))).toBeInTheDocument();
  });

  test('a legacy fund with only a typed balance renders, with no overall return', () => {
    const legacy = { id: 12, fundName: 'כספית ישנה', securityId: '123', amount: 800, updateDate: '2023-01-01' };
    const { container } = render(<Harness initialCashFunds={[legacy]} />);
    const row = container.querySelector('tbody tr');
    expect(row.children[3].textContent).toBe('800 ₪');
    expect(row.children[6].textContent).toBe('-');
    expect(row.children[7].textContent).toBe('0 ₪');
  });
});

describe('correcting a ledger row', () => {
  test('a row recorded through the ledger opens the entry form on its transaction', () => {
    const onEditTransaction = jest.fn();
    const fund = {
      id: 14,
      fundName: 'כספית',
      securityId: '1',
      valueFromLedger: true,
      currentValue: 500,
      currentValueDate: '2026-10-01',
      deposits: [{ date: '2026-10-01', amount: 500, txId: 'tx-1' }]
    };
    const { container, getByRole } = render(<Harness initialCashFunds={[fund]} onEditTransaction={onEditTransaction} />);
    fireEvent.click(container.querySelector('.expand-button'));
    fireEvent.click(getByRole('button', { name: 'עריכת התנועה מ-2026-10-01' }));
    expect(onEditTransaction).toHaveBeenCalledWith('tx-1');
  });

  test('a row from before the ledger is corrected in place - its date and its amount', () => {
    const account = { id: 23, amount: 1000, updateDate: '2024-01-01', deposits: [{ date: '2024-02-01', amount: 300 }] };
    const { container, getByRole, getByLabelText } = render(<Harness initialBankBalances={[account]} />);
    fireEvent.click(container.querySelector('.expand-button'));
    fireEvent.click(getByRole('button', { name: 'עריכת התנועה מ-2024-02-01' }));
    fireEvent.change(getByLabelText('תאריך התנועה'), { target: { value: '2024-02-05' } });
    fireEvent.change(getByLabelText('סכום התנועה (משיכה במינוס)'), { target: { value: '450' } });
    fireEvent.click(getByRole('button', { name: 'שמירה' }));
    expect(container.querySelector('tbody tr').children[0].textContent).toContain('1450 ₪');
    expect(getByRole('button', { name: 'עריכת התנועה מ-2024-02-05' })).toBeInTheDocument();
  });
});

// A current account does not grow: no value to record, no previous value,
// no return - its balance is its movements.
describe('current account (עו"ש)', () => {
  test('shows the balance and the last movement, with no value to edit', () => {
    const account = {
      id: 20,
      valueFromLedger: true,
      currentValue: 7000,
      currentValueDate: '2024-01-15',
      updateDate: '2024-01-15',
      deposits: [
        { date: '2024-01-01', amount: 10000, txId: 'o' },
        { date: '2024-01-15', amount: -3000, txId: 'w' }
      ]
    };
    const { container } = render(<Harness initialBankBalances={[account]} />);
    const headers = [...container.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(headers).toEqual(['יתרה (₪)', 'תנועה אחרונה', 'תנועות', 'פעולות']);

    const row = container.querySelector('tbody tr');
    fireEvent.click(row.children[0]);
    expect(row.children[0].querySelector('input')).toBeNull();
    expect(row.children[0].textContent).toContain('7000 ₪');
    expect(row.children[1].textContent).toBe('2024-01-15');
    expect(row.children[2].textContent).toBe(String(2));
  });

  test('a legacy account with only a typed balance renders it, dated', () => {
    const legacy = { id: 22, amount: 2000, updateDate: '2023-01-01' };
    const { container } = render(<Harness initialBankBalances={[legacy]} />);
    const row = container.querySelector('tbody tr');
    expect(row.children[0].textContent).toContain('2000 ₪');
    expect(row.children[1].textContent).toBe('2023-01-01');
  });
});
