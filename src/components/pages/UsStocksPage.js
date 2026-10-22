import React from 'react';
import { TAX_RATE, calculateAmericanStockMetrics } from '../../utils/portfolioMath';
import {
  formatDate,
  formatPrice,
  formatPriceWithSign,
  calculateProfitPercentage
} from '../../utils/formatters';
import { groupStocksByName, calculateGroupSummary } from '../../utils/stockGrouping';
import { AmericanMarketCard } from '../PortfolioSummary';
import AmericanStocksTable from '../AmericanStocksTable';
import AssetPageLayout from './AssetPageLayout';

// /us-stocks - the Wall Street holdings and the figures that describe them.
function UsStocksPage({
  americanStocks,
  summary,
  isEditMode,
  showAmericanColumns,
  expandedGroups,
  editingField,
  handleCellClick,
  handleInlineEdit,
  finishInlineEdit,
  handleKeyDown,
  handleDelete,
  toggleGroup,
  hasLoadedLivePrices = false,
  lastSession = null,
  ...toolbarProps
}) {
  return (
    <AssetPageLayout
      {...toolbarProps}
      title="בורסה אמריקאית"
      subtitle="מניות וקרנות סל הנסחרות בדולר"
      isEditMode={isEditMode}
      showAmericanColumns={showAmericanColumns}
      hasAnyData={americanStocks.length > 0}
      hasLoadedLivePrices={hasLoadedLivePrices}
      isEmpty={americanStocks.length === 0}
      emptyMessage="עדיין לא נוספו מניות מהבורסה האמריקאית"
      summaryCard={
        <AmericanMarketCard summary={summary} formatPriceWithSign={formatPriceWithSign} />
      }
    >
      <AmericanStocksTable
        americanStocks={americanStocks}
        isEditMode={isEditMode}
        showAdditionalData={showAmericanColumns}
        expandedGroups={expandedGroups}
        groupStocksByName={groupStocksByName}
        calculateGroupSummary={calculateGroupSummary}
        calculateAmericanStockMetrics={calculateAmericanStockMetrics}
        calculateProfitPercentage={calculateProfitPercentage}
        TAX_RATE={TAX_RATE}
        handleCellClick={handleCellClick}
        handleInlineEdit={handleInlineEdit}
        finishInlineEdit={finishInlineEdit}
        handleKeyDown={handleKeyDown}
        formatDate={formatDate}
        formatPrice={formatPrice}
        formatPriceWithSign={formatPriceWithSign}
        handleDelete={handleDelete}
        toggleGroup={toggleGroup}
        editingField={editingField}
        pricesPending={!hasLoadedLivePrices}
        lastSession={lastSession}
      />
    </AssetPageLayout>
  );
}

export default UsStocksPage;
