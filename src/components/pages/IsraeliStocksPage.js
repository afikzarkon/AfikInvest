import React from 'react';
import { TAX_RATE } from '../../utils/portfolioMath';
import {
  formatDate,
  formatPrice,
  formatPriceWithSign,
  normalizeIsraeliPrice,
  calculateProfitPercentage
} from '../../utils/formatters';
import { groupStocksByName, calculateGroupSummary } from '../../utils/stockGrouping';
import { IsraeliMarketCard } from '../PortfolioSummary';
import IsraeliStocksTable from '../IsraeliStocksTable';
import AssetPageLayout from './AssetPageLayout';

// /israeli-stocks - the Tel Aviv holdings and the figures that describe
// them, on their own page instead of as one block among five on the home
// dashboard.
function IsraeliStocksPage({
  israeliStocks,
  summary,
  cpi,
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
      title="בורסה ישראלית"
      subtitle="מניות, קרנות סל וקרנות נאמנות בבורסת תל אביב"
      isEditMode={isEditMode}
      showAmericanColumns={showAmericanColumns}
      hasAnyData={israeliStocks.length > 0}
      hasLoadedLivePrices={hasLoadedLivePrices}
      isEmpty={israeliStocks.length === 0}
      emptyMessage="עדיין לא נוספו ניירות ערך מהבורסה הישראלית"
      summaryCard={<IsraeliMarketCard summary={summary} formatPriceWithSign={formatPriceWithSign} />}
    >
      <IsraeliStocksTable
        israeliStocks={israeliStocks}
        isEditMode={isEditMode}
        showAdditionalData={showAmericanColumns}
        expandedGroups={expandedGroups}
        groupStocksByName={groupStocksByName}
        calculateGroupSummary={calculateGroupSummary}
        normalizeIsraeliPrice={normalizeIsraeliPrice}
        calculateProfitPercentage={calculateProfitPercentage}
        TAX_RATE={TAX_RATE}
        cpi={cpi}
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

export default IsraeliStocksPage;
