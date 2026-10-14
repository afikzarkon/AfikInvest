import React from 'react';
import { formatDate, formatPriceWithSign } from '../../utils/formatters';
import FinancialAccountsTables from '../FinancialAccountsTables';
import AssetPageLayout from './AssetPageLayout';

// The shared body of the three ledger-account pages - provident funds, cash
// and checking, and bank savings.
//
// All three render the same component with a different `sections` list, so
// the only real difference between them is their title, their card and
// which arrays decide whether the page is empty. Those are the props.
function AccountsPage({
  title,
  subtitle,
  sections,
  summaryCard,
  emptyMessage,
  isEmpty,
  pensionFunds,
  cashFunds,
  bankBalances,
  bankSavingsFunds = [],
  summary,
  cpi,
  isEditMode,
  showAmericanColumns,
  editingField,
  handleCellClick,
  handleInlineEdit,
  finishInlineEdit,
  handleKeyDown,
  handleDelete,
  onOpenLedgerEntry,
  onDeleteTransaction,
  onEditTransaction,
  ...toolbarProps
}) {
  return (
    <AssetPageLayout
      {...toolbarProps}
      title={title}
      subtitle={subtitle}
      isEditMode={isEditMode}
      showAmericanColumns={showAmericanColumns}
      hasAnyData={!isEmpty}
      isEmpty={isEmpty}
      emptyMessage={emptyMessage}
      summaryCard={summaryCard}
    >
      <FinancialAccountsTables
        sections={sections}
        pensionFunds={pensionFunds}
        cashFunds={cashFunds}
        bankBalances={bankBalances}
        bankSavingsFunds={bankSavingsFunds}
        cpi={cpi}
        showAdditionalData={showAmericanColumns}
        isEditMode={isEditMode}
        editingField={editingField}
        handleCellClick={handleCellClick}
        handleInlineEdit={handleInlineEdit}
        finishInlineEdit={finishInlineEdit}
        handleKeyDown={handleKeyDown}
        formatDate={formatDate}
        formatPriceWithSign={formatPriceWithSign}
        handleDelete={handleDelete}
        onOpenLedgerEntry={onOpenLedgerEntry}
        onDeleteTransaction={onDeleteTransaction}
        onEditTransaction={onEditTransaction}
      />
    </AssetPageLayout>
  );
}

export default AccountsPage;
