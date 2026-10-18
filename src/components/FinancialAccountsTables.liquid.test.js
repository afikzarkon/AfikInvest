import { useState } from 'react';
import { render, fireEvent } from '@testing-library/react';
import FinancialAccountsTables from './FinancialAccountsTables';
import { applyAccountFieldEdit } from '../utils/portfolioMath';

// The money-market fund and current-account tables, wired the way App.js
// wires them: every field edit goes through applyAccountFieldEdit, so a
// 'currentValue' edit closes a period and a 'deposits' write re-derives a
// ledger-made balance, exactly as App.js's handleInlineEdit does.
function Harness({ initialCashFunds = [], initialBankBalances = [], transactions = [], onUpdateTransaction, isEditMode = true }) {
  const [cashFunds, setCashFunds] = useState(initialCashFunds);
  const [bankBalances, setBankBalances] = useState(initialBankBalances);
  const [editingField, setEditingField] = useState(null);

  const edit = (setItems) => (id, field, value) =>
    setItems((items) =>
      items.map((it) => (it.id === id ? applyAccountFieldEdit(it, field, value) : it))
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
      isEditMode={isEditMode}
      editingField={editingField}
      handleCellClick={(id, field) => setEditingField(`${id}-${field}`)}
      handleInlineEdit={handleInlineEdit}
      finishInlineEdit={() => setEditingField(null)}
      handleKeyDown={() => {}}
      formatDate={(d) => d}
      formatPriceWithSign={(v) => String(v)}
      handleDelete={() => {}}
      transactions={transactions}
      onUpdateTransaction={onUpdateTransaction}
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
    // The previous value is the deposits' own sum, so it says so, and the
    // return is measured from the opening.
    expect(row.children[7].textContent).toBe('16500 ₪סכום ההפקדות');
    expect(row.children[5].textContent).toBe('-9.09%-1500 ₪מאז הפתיחה (2026-10-04)');
    expect(row.children[6].textContent).toContain('-9.09%');
    expect(row.children[6].textContent).toContain('-1500 ₪');
  });

  // 40,000 on 02/04 and 20,000 on 10/10, worth 70,000 on 14/10: the 10,000
  // gain is measured against the money AS IT WAS INVESTED - the 40,000 for
  // all 195 days, the 20,000 for only the last 4:
  //   10,000 / (40,000 + 20,000 x 4/195) = 24.75%
  // not against the 60,000 total as if it had all been in since 10/10
  // (+16.67% in four days).
  test('a deposit made late in the period counts only for the days it was invested', () => {
    const fund = {
      id: 15,
      fundName: 'כספית',
      securityId: '5119609',
      valueFromLedger: true,
      currentValue: 60000,
      amount: 60000,
      currentValueDate: '2026-10-10',
      previousValue: 0,
      previousValueDate: '',
      deposits: [
        { date: '2026-04-02', amount: 40000, txId: 'a' },
        { date: '2026-10-10', amount: 20000, txId: 'b' }
      ]
    };
    const { container } = render(<Harness initialCashFunds={[fund]} />);
    const row = container.querySelector('tbody tr');
    recordValue(row.children[3], '70000', '2026-10-14');
    expect(row.children[5].textContent).toBe('24.75%10000 ₪מאז הפתיחה (2026-04-02)');
    expect(row.children[6].textContent).toContain('16.67%'); // overall: 10,000 on 60,000 paid in
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

describe('correcting a movement row', () => {
  const depositCell = (container, label) => container.querySelector(`td[data-label="${label}"]`);
  const expand = (container) => fireEvent.click(container.querySelector('.expand-button'));
  const typeInto = (cell, value) => {
    fireEvent.click(cell);
    const input = cell.querySelector('input');
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: 'Enter' });
  };

  const ledgerTx = { id: 'tx-1', type: 'DEPOSIT', date: '2026-10-01', assetClass: 'cashFunds', assetId: '14', amount: 500 };
  const ledgerFund = {
    id: 14,
    fundName: 'כספית',
    securityId: '1',
    valueFromLedger: true,
    currentValue: 500,
    currentValueDate: '2026-10-01',
    deposits: [{ date: '2026-10-01', amount: 500, txId: 'tx-1' }]
  };

  // Like every other value in the app, a movement is corrected from the
  // page's "מצב עריכה" - the cell itself becomes the input. There is no
  // button beside the row and no editor next to it.
  test('the cells are click-to-edit in edit mode, and plain text outside it', () => {
    const viewing = render(<Harness initialCashFunds={[ledgerFund]} transactions={[ledgerTx]} onUpdateTransaction={jest.fn()} isEditMode={false} />);
    expand(viewing.container);
    expect(viewing.queryByRole('button', { name: /עריכ/ })).toBeNull();
    expect(depositCell(viewing.container, 'תאריך הפקדה').className).not.toContain('editable-cell');
    fireEvent.click(depositCell(viewing.container, 'תאריך הפקדה'));
    expect(depositCell(viewing.container, 'תאריך הפקדה').querySelector('input')).toBeNull();
    viewing.unmount();

    const editing = render(<Harness initialCashFunds={[ledgerFund]} transactions={[ledgerTx]} onUpdateTransaction={jest.fn()} />);
    expand(editing.container);
    expect(editing.queryByRole('button', { name: /עריכ/ })).toBeNull();
    expect(depositCell(editing.container, 'תאריך הפקדה').className).toContain('editable-cell');
    fireEvent.click(depositCell(editing.container, 'תאריך הפקדה'));
    expect(editing.getByLabelText('תאריך התנועה')).toBeInTheDocument();
  });

  test('a row recorded through the ledger is corrected through its transaction', () => {
    const onUpdateTransaction = jest.fn();
    const { container } = render(<Harness initialCashFunds={[ledgerFund]} transactions={[ledgerTx]} onUpdateTransaction={onUpdateTransaction} />);
    expand(container);
    typeInto(depositCell(container, 'תאריך הפקדה'), '2026-10-05');
    expect(onUpdateTransaction).toHaveBeenCalledWith('tx-1', { ...ledgerTx, date: '2026-10-05', amount: 500 });
  });

  // tx.amount is a magnitude - the direction is the transaction's TYPE
  // (transactionLedger.js's DEPOSIT/WITHDRAWAL branch), so a withdrawal
  // shown as -300 is sent as 450, not -450.
  test('a withdrawal sends its magnitude, keeping its direction', () => {
    const onUpdateTransaction = jest.fn();
    const tx = { id: 'tx-9', type: 'WITHDRAWAL', date: '2026-10-02', assetClass: 'cashFunds', assetId: '14', amount: 300 };
    const fund = { ...ledgerFund, deposits: [{ date: '2026-10-02', amount: -300, txId: 'tx-9' }] };
    const { container } = render(<Harness initialCashFunds={[fund]} transactions={[tx]} onUpdateTransaction={onUpdateTransaction} />);
    expand(container);
    typeInto(depositCell(container, 'סכום'), '-450');
    expect(onUpdateTransaction).toHaveBeenCalledWith('tx-9', { ...tx, date: '2026-10-02', amount: 450 });
  });

  // The server refuses an edit that changes the transaction type, so the
  // sign is not ours to flip here (server/transactionRoutes.js's PUT).
  test('turning a deposit into a withdrawal by typing a minus is refused', () => {
    const alerted = jest.spyOn(window, 'alert').mockImplementation(() => {});
    const onUpdateTransaction = jest.fn();
    const { container } = render(<Harness initialCashFunds={[ledgerFund]} transactions={[ledgerTx]} onUpdateTransaction={onUpdateTransaction} />);
    expand(container);
    typeInto(depositCell(container, 'סכום'), '-500');
    expect(onUpdateTransaction).not.toHaveBeenCalled();
    expect(alerted).toHaveBeenCalledWith(expect.stringContaining('לא ניתן להפוך הפקדה למשיכה'));
    alerted.mockRestore();
  });

  // Without somewhere to send the correction, a ledger row stays read-only.
  test('a ledger row is not editable when there is no way to edit its transaction', () => {
    const { container, queryByLabelText } = render(<Harness initialCashFunds={[ledgerFund]} transactions={[ledgerTx]} />);
    expand(container);
    expect(depositCell(container, 'תאריך הפקדה').className).not.toContain('editable-cell');
    fireEvent.click(depositCell(container, 'תאריך הפקדה'));
    expect(queryByLabelText('תאריך התנועה')).toBeNull();
  });

  test('a row from before the ledger is corrected in place - its date and its amount', () => {
    const account = { id: 23, amount: 1000, updateDate: '2024-01-01', deposits: [{ date: '2024-02-01', amount: 300 }] };
    const { container } = render(<Harness initialBankBalances={[account]} />);
    expand(container);
    typeInto(depositCell(container, 'סכום'), '450');
    expect(container.querySelector('tbody tr').children[0].textContent).toContain('1450 ₪');
    typeInto(depositCell(container, 'תאריך הפקדה'), '2024-02-05');
    expect(depositCell(container, 'תאריך הפקדה').textContent).toContain('2024-02-05');
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
