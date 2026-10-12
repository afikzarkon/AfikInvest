import React from 'react';
import EditableCell from './EditableCell';
import PendingPriceValue from './PendingPriceValue';
import ValuePill from './ValuePill';
import AssetCell from './AssetCell';
import ScrollableTable from './ScrollableTable';
import { profitClass, formatDailyChangePercent } from '../utils/formatters';
import { effectiveDailyChangePercent } from '../utils/marketSession';

// The column headers, named once and used for BOTH the <th> row and each
// cell's data-label. Below 720px the table becomes one card per row and
// the header row is clipped away, so every value needs its own label or
// the card is an unlabelled column of numbers - which is exactly what
// this table was on a phone. Sourcing both from one object is what stops
// a renamed header from leaving a card labelled with the old name.
// See IsraeliStocksTable.js - a grouped row has several lots behind it,
// so the columns that differ per lot print an em dash rather than
// repeating the same "open the group" instruction on every one.
const PER_LOT = '—';
const PER_LOT_TITLE = 'ערך שונה לכל רכישה - הרחיבו את הקיבוץ כדי לראות את הפירוט';

const COL = {
  name: 'שם מנייה',
  date: 'תאריך קנייה',
  buyPrice: 'מחיר קנייה',
  quantity: 'כמות',
  totalBuyUSD: 'סה"כ רכישה בדולר',
  totalBuyILS: 'סה"כ רכישה בשקל',
  rateAtBuy: 'שער חליפין ביום הקנייה',
  rateToday: 'שער חליפין היום',
  currentPrice: 'מחיר נוכחי',
  totalValueUSD: 'סה"כ שווי בדולר',
  totalValueILS: 'סה"כ שווי בש"ח',
  profitUSD: 'סה"כ רווח/הפסד ($)',
  profitILS: 'סה"כ רווח/הפסד (₪)',
  profitPercent: 'אחוז רווח/הפסד',
  dailyPercent: 'אחוז שינוי יומי',
  dailyProfit: 'רווח/הפסד יומי בדולר',
  fxImpact: 'השפעת שער חליפין',
  tax: 'מס רווח הון (₪)',
  afterTax: 'רווח לאחר מס (₪)',
  inflationary: 'רווח אינפלציוני (₪)',
  realGain: 'רווח ריאלי (₪)',
  actions: 'פעולות'
};

// Renders the name/date/price/quantity editable fields for one American
// stock row — used for both the single-stock row and each expanded detail
// row. These are always visible (basic transaction info).
function AmericanEditableFields({ stock, editingField, isEditMode, handleCellClick, handleInlineEdit, finishInlineEdit, handleKeyDown, formatDate, formatPriceWithSign, nameCellStyle }) {
  return (
    <>
      <EditableCell
        id={stock.id}
        field="stockName"
        exchange="american"
        value={stock.stockName}
        editingField={editingField}
        isEditMode={isEditMode}
        handleCellClick={handleCellClick}
        handleInlineEdit={handleInlineEdit}
        finishInlineEdit={finishInlineEdit}
        handleKeyDown={handleKeyDown}
        displayValue={<AssetCell name={stock.stockName} />}
        style={nameCellStyle}
        label={COL.name}
      />
      <EditableCell
        id={stock.id}
        field="purchaseDate"
        exchange="american"
        value={stock.purchaseDate}
        type="date"
        editingField={editingField}
        isEditMode={isEditMode}
        handleCellClick={handleCellClick}
        handleInlineEdit={handleInlineEdit}
        finishInlineEdit={finishInlineEdit}
        handleKeyDown={handleKeyDown}
        displayValue={formatDate(stock.purchaseDate)}
        label={COL.date}
      />
      <EditableCell
        id={stock.id}
        field="purchasePrice"
        exchange="american"
        value={stock.purchasePrice}
        type="number"
        step="0.01"
        parse={(raw) => parseFloat(raw)}
        editingField={editingField}
        isEditMode={isEditMode}
        handleCellClick={handleCellClick}
        handleInlineEdit={handleInlineEdit}
        finishInlineEdit={finishInlineEdit}
        handleKeyDown={handleKeyDown}
        displayValue={`${formatPriceWithSign(stock.purchasePrice)} $`}
        label={COL.buyPrice}
      />
      <EditableCell
        id={stock.id}
        field="quantity"
        exchange="american"
        value={stock.quantity}
        type="number"
        min="1"
        parse={(raw) => parseInt(raw)}
        editingField={editingField}
        isEditMode={isEditMode}
        handleCellClick={handleCellClick}
        handleInlineEdit={handleInlineEdit}
        finishInlineEdit={finishInlineEdit}
        handleKeyDown={handleKeyDown}
        displayValue={stock.quantity}
        label={COL.quantity}
      />
    </>
  );
}

// Renders the computed (mostly non-editable, except purchase exchangeRate)
// figures for one single American stock row. showAdditionalData gates only
// the deeper ILS/tax analysis columns - basic USD figures are always shown.
function AmericanSingleStockComputedCells({
  stock,
  showAdditionalData,
  calculateAmericanStockMetrics,
  calculateProfitPercentage,
  formatPrice,
  formatPriceWithSign,
  isEditMode,
  editingField,
  handleCellClick,
  handleInlineEdit,
  finishInlineEdit,
  handleKeyDown,
  handleDelete,
  pricesPending
}) {
  const {
    totalPurchaseUSD,
    totalPurchaseILS,
    totalCurrentValueUSD,
    currentExchangeRate,
    totalCurrentValueILS,
    profitUSD,
    profitILS,
    realGainILS,
    currencyExemptGainILS,
    taxILS,
    afterTaxILS,
    exchangeRateImpact
  } = calculateAmericanStockMetrics(stock);
  const profitPercentage = calculateProfitPercentage(stock.purchasePrice || 0, stock.currentPrice || 0);

  return (
    <>
      <td data-label={COL.totalBuyUSD}>{formatPriceWithSign(totalPurchaseUSD)} $</td>
      {showAdditionalData && <td data-label={COL.totalBuyILS}>{formatPriceWithSign(totalPurchaseILS)} ₪</td>}
      {showAdditionalData && (
        <EditableCell
          id={stock.id}
          field="exchangeRate"
          exchange="american"
          value={stock.exchangeRate}
          type="number"
          step="0.0001"
          parse={(raw) => parseFloat(raw)}
          editingField={editingField}
          isEditMode={isEditMode}
          handleCellClick={handleCellClick}
          handleInlineEdit={handleInlineEdit}
          finishInlineEdit={finishInlineEdit}
          handleKeyDown={handleKeyDown}
          displayValue={formatPrice(stock.exchangeRate)}
          label={COL.rateAtBuy}
        />
      )}
      <td data-label={COL.rateToday}>{formatPrice(currentExchangeRate)}</td>
      <td data-label={COL.currentPrice}>
        <PendingPriceValue
          value={stock.currentPrice}
          pending={pricesPending}
          format={formatPriceWithSign}
          suffix=" $"
        />
      </td>
      <td data-label={COL.totalValueUSD}>
        <PendingPriceValue
          value={totalCurrentValueUSD}
          pending={pricesPending}
          format={formatPriceWithSign}
          suffix=" $"
        />
      </td>
      <td data-label={COL.totalValueILS}>
        <PendingPriceValue
          value={totalCurrentValueILS}
          pending={pricesPending}
          format={formatPriceWithSign}
          suffix=" ₪"
        />
      </td>
      <td className={profitClass(profitUSD)} data-label={COL.profitUSD}>{formatPriceWithSign(profitUSD)} $</td>
      <td className={profitClass(profitILS)} data-label={COL.profitILS}>{formatPriceWithSign(profitILS)} ₪</td>
      <td data-label={COL.profitPercent}>
        <ValuePill value={profitPercentage}>{profitPercentage}%</ValuePill>
      </td>
      <td data-label={COL.dailyPercent}>
        <ValuePill value={effectiveDailyChangePercent(stock)}>
          {formatDailyChangePercent(effectiveDailyChangePercent(stock))}%
        </ValuePill>
      </td>
      <td className={profitClass(effectiveDailyChangePercent(stock))} data-label={COL.dailyProfit}>
        {formatPriceWithSign((effectiveDailyChangePercent(stock) / 100) * totalCurrentValueUSD)} $
      </td>
      {showAdditionalData && <td className={profitClass(exchangeRateImpact)} data-label={COL.fxImpact}>{formatPriceWithSign(exchangeRateImpact)} ₪</td>}
      {showAdditionalData && <td className="profit-negative" data-label={COL.tax}>{formatPriceWithSign(-taxILS)} ₪</td>}
      {showAdditionalData && <td className={profitClass(afterTaxILS)} data-label={COL.afterTax}>{formatPriceWithSign(afterTaxILS)} ₪</td>}
      {showAdditionalData && <td className={profitClass(currencyExemptGainILS)} data-label={COL.inflationary}>{formatPriceWithSign(currencyExemptGainILS)} ₪</td>}
      {showAdditionalData && <td className={profitClass(realGainILS)} data-label={COL.realGain}>{formatPriceWithSign(realGainILS)} ₪</td>}
      {isEditMode && (
        <td data-label={COL.actions}>
          <button onClick={() => handleDelete(stock.id, 'american')} className="delete-button">מחק</button>
        </td>
      )}
    </>
  );
}

function AmericanStocksTable({
  americanStocks,
  isEditMode,
  showAdditionalData,
  expandedGroups,
  groupStocksByName,
  calculateGroupSummary,
  calculateAmericanStockMetrics,
  calculateProfitPercentage,
  TAX_RATE,
  handleCellClick,
  handleInlineEdit,
  finishInlineEdit,
  handleKeyDown,
  formatDate,
  formatPrice,
  formatPriceWithSign,
  handleDelete,
  toggleGroup,
  editingField,
  // True until the first live price cycle completes - drives the skeleton
  // placeholders on cells with no price to show yet (see
  // PendingPriceValue.js). Nothing here waits on it; the table renders
  // immediately either way.
  pricesPending = false
}) {
  return (
    <>
      {americanStocks.length > 0 && (
        <div className="stocks-section">
          <h2 className="section-title">בורסה אמריקאית</h2>
          <ScrollableTable label="בורסה אמריקאית" tableClassName="american-stocks-table">
              <thead>
                <tr>
                  <th>{COL.name}</th>
                  <th>{COL.date}</th>
                  <th>{COL.buyPrice}</th>
                  <th>{COL.quantity}</th>
                  <th>{COL.totalBuyUSD}</th>
                  {showAdditionalData && <th>{COL.totalBuyILS}</th>}
                  {showAdditionalData && <th>{COL.rateAtBuy}</th>}
                  <th>{COL.rateToday}</th>
                  <th>{COL.currentPrice}</th>
                  <th>{COL.totalValueUSD}</th>
                  <th>{COL.totalValueILS}</th>
                  <th>{COL.profitUSD}</th>
                  <th>{COL.profitILS}</th>
                  <th>{COL.profitPercent}</th>
                  <th>{COL.dailyPercent}</th>
                  <th>{COL.dailyProfit}</th>
                  {showAdditionalData && <th>{COL.fxImpact}</th>}
                  {showAdditionalData && <th>{COL.tax}</th>}
                  {showAdditionalData && <th>{COL.afterTax}</th>}
                  {showAdditionalData && <th>{COL.inflationary}</th>}
                  {showAdditionalData && <th>{COL.realGain}</th>}
                  {isEditMode && <th>{COL.actions}</th>}
                </tr>
              </thead>
              <tbody>
                {Object.entries(groupStocksByName(americanStocks)).map(([stockName, stocks]) => {
                  const isExpanded = expandedGroups[`american-${stockName}`];
                  const summary = calculateGroupSummary(stocks);
                  const editableFieldProps = {
                    editingField,
                    isEditMode,
                    handleCellClick,
                    handleInlineEdit,
                    finishInlineEdit,
                    handleKeyDown,
                    formatDate,
                    formatPriceWithSign
                  };
                  const computedCellProps = {
                    showAdditionalData,
                    calculateAmericanStockMetrics,
                    calculateProfitPercentage,
                    formatPrice,
                    formatPriceWithSign,
                    isEditMode,
                    editingField,
                    handleCellClick,
                    handleInlineEdit,
                    finishInlineEdit,
                    handleKeyDown,
                    handleDelete,
                    pricesPending
                  };

                  if (stocks.length === 1) {
                    const stock = stocks[0];
                    return (
                      <tr key={stock.id} className={isEditMode ? 'editable-row' : ''}>
                        <AmericanEditableFields stock={stock} {...editableFieldProps} />
                        <AmericanSingleStockComputedCells stock={stock} {...computedCellProps} />
                      </tr>
                    );
                  }

                  const totalPurchaseUSD = stocks.reduce((sum, stock) => sum + ((stock.purchasePrice || 0) * (stock.quantity || 0)), 0);
                  const totalPurchaseILS = stocks.reduce((sum, stock) => sum + ((stock.purchasePrice || 0) * (stock.quantity || 0) * (stock.exchangeRate || 0)), 0);
                  const totalCurrentValueUSD = stocks.reduce((sum, stock) => sum + ((stock.currentPrice || 0) * (stock.quantity || 0)), 0);
                  const totalCurrentValueILS = stocks.reduce((sum, stock) => {
                    const currentExchangeRate = stock.currentExchangeRate || stock.exchangeRate || 0;
                    return sum + ((stock.currentPrice || 0) * (stock.quantity || 0) * currentExchangeRate);
                  }, 0);
                  const averagePurchasePrice = summary.totalQuantity > 0 ? totalPurchaseUSD / summary.totalQuantity : 0;
                  const averageCurrentPrice = summary.totalQuantity > 0 ? totalCurrentValueUSD / summary.totalQuantity : 0;
                  const profitPercentage = calculateProfitPercentage(averagePurchasePrice, averageCurrentPrice);
                  const totalProfitUSD = totalCurrentValueUSD - totalPurchaseUSD;
                  // רווח נומינלי אמיתי (לא "הרווח הריאלי") - ראו הערה ב-portfolioMath.js
                  const totalProfitILS = totalCurrentValueILS - totalPurchaseILS;
                  // מס וסכום ריאלי/פטור-משער מסוכמים per-lot (לא על הרווח המצרפי),
                  // כי לכל רכישה יש תאריך/שער קנייה משלה - בדיוק כמו במניות
                  // ישראליות עם מדד שונה לכל תאריך קנייה.
                  const perLotMetrics = stocks.map((stock) => calculateAmericanStockMetrics(stock));
                  const totalTaxILS = perLotMetrics.reduce((sum, m) => sum + m.taxILS, 0);
                  const totalRealGainILS = perLotMetrics.reduce((sum, m) => sum + m.realGainILS, 0);
                  const totalAfterTaxILS = totalProfitILS - totalTaxILS;
                  const totalInflationaryGainILS = totalProfitILS - totalRealGainILS;
                  const totalExchangeRateImpact = stocks.reduce((sum, stock) => {
                    const stockPurchaseUSD = (stock.purchasePrice || 0) * (stock.quantity || 0);
                    const stockCurrentExchangeRate = stock.currentExchangeRate || stock.exchangeRate || 0;
                    return sum + (stockPurchaseUSD * (stockCurrentExchangeRate - (stock.exchangeRate || 0)));
                  }, 0);
                  const averageCurrentPriceUSD = summary.totalQuantity > 0 ? totalCurrentValueUSD / summary.totalQuantity : 0;

                  return (
                    <React.Fragment key={stockName}>
                      <tr className={`${isEditMode ? 'editable-row' : ''} ${isExpanded ? 'summary-row-expanded' : ''}`}>
                        <td onClick={() => handleCellClick(stocks[0].id, 'stockName', 'american')} className={isEditMode ? 'editable-cell' : ''}>
                          <button onClick={() => toggleGroup(stockName, 'american')} className="expand-button" style={{ marginRight: '8px', background: 'none', border: 'none', cursor: 'pointer' }}>
                            {isExpanded ? '▼' : '▶'}
                          </button>
                          <AssetCell name={stockName} />
                        </td>
                        <td data-label={COL.date} title={PER_LOT_TITLE}>{PER_LOT}</td>
                        <td data-label={COL.buyPrice} title={PER_LOT_TITLE}>{PER_LOT}</td>
                        <td data-label={COL.quantity}>{summary.totalQuantity}</td>
                        <td data-label={COL.totalBuyUSD}>{formatPriceWithSign(totalPurchaseUSD)} $</td>
                        {showAdditionalData && <td data-label={COL.totalBuyILS}>{formatPriceWithSign(totalPurchaseILS)} ₪</td>}
                        {showAdditionalData && <td data-label={COL.rateAtBuy} title={PER_LOT_TITLE}>{PER_LOT}</td>}
                        <td data-label={COL.rateToday}>{formatPrice(stocks[0].currentExchangeRate || stocks[0].exchangeRate || 0)}</td>
                        <td data-label={COL.currentPrice}>{formatPriceWithSign(averageCurrentPriceUSD)} $</td>
                        <td data-label={COL.totalValueUSD}>{formatPriceWithSign(totalCurrentValueUSD)} $</td>
                        <td data-label={COL.totalValueILS}>{formatPriceWithSign(totalCurrentValueILS)} ₪</td>
                        <td className={profitClass(totalProfitUSD)} data-label={COL.profitUSD}>{formatPriceWithSign(totalProfitUSD)} $</td>
                        <td className={profitClass(totalProfitILS)} data-label={COL.profitILS}>{formatPriceWithSign(totalProfitILS)} ₪</td>
                        <td data-label={COL.profitPercent}>
                          <ValuePill value={profitPercentage}>{profitPercentage}%</ValuePill>
                        </td>
                        <td data-label={COL.dailyPercent}>
                          <ValuePill value={effectiveDailyChangePercent(stocks[0])}>
                            {formatDailyChangePercent(effectiveDailyChangePercent(stocks[0]))}%
                          </ValuePill>
                        </td>
                        <td className={profitClass(effectiveDailyChangePercent(stocks[0]))} data-label={COL.dailyProfit}>
                          {formatPriceWithSign((effectiveDailyChangePercent(stocks[0]) / 100) * totalCurrentValueUSD)} $
                        </td>
                        {showAdditionalData && <td className={profitClass(totalExchangeRateImpact)} data-label={COL.fxImpact}>{formatPriceWithSign(totalExchangeRateImpact)} ₪</td>}
                        {showAdditionalData && <td className="profit-negative" data-label={COL.tax}>{formatPriceWithSign(-totalTaxILS)} ₪</td>}
                        {showAdditionalData && <td className={profitClass(totalAfterTaxILS)} data-label={COL.afterTax}>{formatPriceWithSign(totalAfterTaxILS)} ₪</td>}
                        {showAdditionalData && <td className={profitClass(totalInflationaryGainILS)} data-label={COL.inflationary}>{formatPriceWithSign(totalInflationaryGainILS)} ₪</td>}
                        {showAdditionalData && <td className={profitClass(totalRealGainILS)} data-label={COL.realGain}>{formatPriceWithSign(totalRealGainILS)} ₪</td>}
                        {isEditMode && <td></td>}
                      </tr>

                      {isExpanded && stocks.map((stock) => (
                        <tr key={stock.id} className={`${isEditMode ? 'editable-row' : ''} detail-row`}>
                          <AmericanEditableFields
                            stock={stock}
                            {...editableFieldProps}
                            nameCellStyle={{ paddingLeft: '20px' }}
                          />
                          <AmericanSingleStockComputedCells stock={stock} {...computedCellProps} />
                        </tr>
                      ))}
                    </React.Fragment>
                  );
                })}
              </tbody>
          </ScrollableTable>
        </div>
      )}
    </>
  );
}

export default AmericanStocksTable;
