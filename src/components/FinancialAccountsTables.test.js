import { useState } from 'react';
import { render, fireEvent } from '@testing-library/react';
import FinancialAccountsTables from './FinancialAccountsTables';
import { applyAccountFieldEdit } from '../utils/portfolioMath';

// Mirrors how App.js actually wires editingField/handleInlineEdit for
// ledger items - pension funds, cash funds, and bank balances all route
// every field edit through applyAccountFieldEdit (see handleInlineEdit in
// App.js) - so this test exercises the real
// end-to-end contract, not just the component's isolated rendering.
function Harness({ initialFund, initialCashFunds = [], initialBankBalances = [], transactions = [], onUpdateTransaction }) {
  const [pensionFunds, setPensionFunds] = useState(initialFund ? [initialFund] : []);
  const [cashFunds, setCashFunds] = useState(initialCashFunds);
  const [bankBalances, setBankBalances] = useState(initialBankBalances);
  const [editingField, setEditingField] = useState(null);

  const handleCellClick = (id, field) => setEditingField(`${id}-${field}`);
  const finishInlineEdit = () => setEditingField(null);
  const makeHandleInlineEdit = (setItems) => (id, field, value) => {
    setItems((items) => items.map((it) => (it.id === id ? applyAccountFieldEdit(it, field, value) : it)));
  };
  const handleInlineEdit = (id, field, value, exchange) => {
    if (exchange === 'cash_fund') return makeHandleInlineEdit(setCashFunds)(id, field, value);
    if (exchange === 'bank') return makeHandleInlineEdit(setBankBalances)(id, field, value);
    return makeHandleInlineEdit(setPensionFunds)(id, field, value);
  };

  return (
    <FinancialAccountsTables
      pensionFunds={pensionFunds}
      cashFunds={cashFunds}
      bankBalances={bankBalances}
      cpi={null}
      showAdditionalData={true}
      isEditMode={true}
      editingField={editingField}
      handleCellClick={handleCellClick}
      handleInlineEdit={handleInlineEdit}
      finishInlineEdit={finishInlineEdit}
      handleKeyDown={() => {}}
      formatDate={(d) => d}
      formatPriceWithSign={(v) => String(v)}
      handleDelete={() => {}}
      transactions={transactions}
      onUpdateTransaction={onUpdateTransaction}
    />
  );
}

// Column order in the pension table (merged columns): 0=fundName,
// 1=initialInvestment, 2=currentValue with its date under it,
// 3=previousValue with its date under it, 4=deposit index with today's
// index under it (showAdditionalData is true in these tests). Read afresh
// after each action - an edit replaces the cell's contents.
function pensionRowCells(container) {
  const row = container.querySelector('tbody tr');
  const main = (cell) => cell.querySelector('.mv-main') || cell;
  return {
    currentValue: row.children[2],
    currentValueText: main(row.children[2]),
    currentValueDate: row.children[2].querySelector('.merged-date'),
    previousValue: row.children[3],
    previousValueText: main(row.children[3]),
    previousValueDate: row.children[3].querySelector('.merged-date'),
    todaysIndex: row.children[4].querySelector('.cpi-today'),
    depositIndex: main(row.children[4])
  };
}

describe('FinancialAccountsTables - pension "שווי נוכחי" edit', () => {
  test('editing the value asks for the date in the same action, and both commit together (not today)', () => {
    const fund = { id: 1, fundName: 'קופה לבדיקה', currentValue: 100000, currentValueDate: '2024-03-31', deposits: [] };
    const { container } = render(<Harness initialFund={fund} />);
    const cells = pensionRowCells(container);

    fireEvent.click(cells.currentValue);

    const numberInput = cells.currentValue.querySelector('input[type="number"]');
    const dateInput = cells.currentValue.querySelector('input[type="date"]');
    expect(numberInput).not.toBeNull();
    expect(dateInput).not.toBeNull();
    // the date field starts pre-filled with the fund's existing date, not today
    expect(dateInput.value).toBe('2024-03-31');

    fireEvent.change(numberInput, { target: { value: '111000' } });
    fireEvent.change(dateInput, { target: { value: '2024-06-30' } });
    fireEvent.keyDown(dateInput, { key: 'Enter' });

    // editing closed after the single commit
    expect(cells.currentValue.querySelector('input[type="number"]')).toBeNull();

    // the new value and the user-entered date landed together
    const after = pensionRowCells(container);
    expect(after.currentValueText.textContent).toBe('111000 ₪');
    expect(after.currentValueDate.textContent).toBe('2024-06-30');
    // the old value/date rolled into "previous", not overwritten
    expect(after.previousValueText.textContent).toBe('100000 ₪');
    expect(after.previousValueDate.textContent).toBe('2024-03-31');
  });

  test('defaults the date field to today for a fund with no prior currentValueDate', () => {
    const fund = { id: 2, fundName: 'קופה חדשה', currentValue: 5000, currentValueDate: '', deposits: [] };
    const { container } = render(<Harness initialFund={fund} />);
    const cells = pensionRowCells(container);

    fireEvent.click(cells.currentValue);

    const dateInput = cells.currentValue.querySelector('input[type="date"]');
    const today = new Date().toISOString().slice(0, 10);
    expect(dateInput.value).toBe(today);
  });

  test('blurring the edit group without pressing Enter also commits the change', () => {
    const fund = { id: 3, fundName: 'קופה', currentValue: 200000, currentValueDate: '2024-01-01', deposits: [] };
    const { container } = render(<Harness initialFund={fund} />);
    const cells = pensionRowCells(container);

    fireEvent.click(cells.currentValue);
    const numberInput = cells.currentValue.querySelector('input[type="number"]');
    const dateInput = cells.currentValue.querySelector('input[type="date"]');
    fireEvent.change(numberInput, { target: { value: '210000' } });
    fireEvent.change(dateInput, { target: { value: '2024-05-01' } });

    fireEvent.blur(cells.currentValue.querySelector('.pension-value-edit-group'));

    expect(cells.currentValue.querySelector('input[type="number"]')).toBeNull();
    const after = pensionRowCells(container);
    expect(after.currentValueText.textContent).toBe('210000 ₪');
    expect(after.currentValueDate.textContent).toBe('2024-05-01');
  });
});

describe('FinancialAccountsTables - pension previousValue/previousValueDate are read-only', () => {
  // Regression test for the exact bug this closes: previousValue/
  // previousValueDate used to be independently click-to-edit, bypassing
  // applyPensionValueUpdate's history-preserving flow entirely. They must
  // now only ever change as a side effect of editing "שווי נוכחי" (covered
  // by the describe block above) - clicking them directly must do nothing.
  test('clicking the previousValue cell does not open an editable input', () => {
    const fund = {
      id: 4,
      fundName: 'קופה',
      currentValue: 111000,
      currentValueDate: '2024-06-30',
      previousValue: 100000,
      previousValueDate: '2024-03-31',
      deposits: []
    };
    const { container } = render(<Harness initialFund={fund} />);
    const cells = pensionRowCells(container);

    fireEvent.click(cells.previousValue);
    expect(cells.previousValue.querySelector('input')).toBeNull();
    expect(cells.previousValueText.textContent).toBe('100000 ₪');

    fireEvent.click(cells.previousValueDate);
    expect(cells.previousValueDate.querySelector('input')).toBeNull();
    expect(cells.previousValueDate.textContent).toBe('2024-03-31');
  });
});

describe('FinancialAccountsTables - pension CPI columns', () => {
  test("shows today's known CPI index once per fund, and each deposit's own month index in its expanded row", () => {
    const fund = {
      id: 5,
      fundName: 'קופה עם הפקדות',
      currentValue: 111000,
      currentValueDate: '2024-06-30',
      previousValue: 100000,
      previousValueDate: '2024-01-01',
      deposits: [{ date: '2024-02-15', amount: 10000 }]
    };
    const cpi = { currentIndex: 105.3, indexByMonth: { '2024-02': 104.1 } };
    const { container, getByText } = render(
      <FinancialAccountsTables
        pensionFunds={[fund]}
        cashFunds={[]}
        bankBalances={[]}
        cpi={cpi}
        showAdditionalData={true}
        isEditMode={false}
        editingField={null}
        handleCellClick={() => {}}
        handleInlineEdit={() => {}}
        finishInlineEdit={() => {}}
        handleKeyDown={() => {}}
        formatDate={(d) => d}
        formatPriceWithSign={(v) => String(v)}
        handleDelete={() => {}}
      />
    );
    const cells = pensionRowCells(container);
    expect(cells.todaysIndex.textContent).toBe('היום 105.3');
    // the summary row doesn't show a single deposit-month index (a fund
    // can have deposits from several different months)
    expect(cells.depositIndex.textContent).toBe('-');

    // expand the fund to reveal its one deposit row
    fireEvent.click(container.querySelector('.expand-button'));
    expect(getByText('104.1')).toBeInTheDocument();
  });
});
