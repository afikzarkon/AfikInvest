import React from 'react';
import EditableCell from './EditableCell';
import PendingPriceValue from './PendingPriceValue';
import ValuePill from './ValuePill';
import AssetCell from './AssetCell';
import ScrollableTable from './ScrollableTable';
import { profitClass, formatDailyChangePercent } from '../utils/formatters';
import { effectiveDailyChangePercent } from '../utils/marketSession';
import { calculateStockRealGainTax, monthKeyFromDate } from '../utils/cpiTax';
import { sectorLabelHe } from '../utils/sectorLabels';
import { effectiveExchangeForIsraeliStock, resolveIsraeliSector } from '../utils/israeliEtfClassifier';
import { sectorFromTaseBranch } from '../utils/israeliSectorMapping';

// The column headers, named once and used for BOTH the <th> row and each
// cell's data-label. Mobile turns every row into a card whose values each
// need their own label; sourcing them from the same object is what stops a
// renamed header from leaving a card labelled with the old name.
// A grouped row has several lots behind it, so the columns that differ
// per lot have no single value to print. An em dash says that; the row
// expands to show the lots themselves.
const PER_LOT = '—';
const PER_LOT_TITLE = 'ערך שונה לכל רכישה - הרחיבו את הקיבוץ כדי לראות את הפירוט';

const COL = {
  name: 'שם מנייה',
  date: 'תאריך קנייה',
  buyPrice: 'מחיר קנייה (₪)',
  quantity: 'כמות',
  sector: 'סקטור',
  totalBuy: 'סה"כ קנייה בש"ח',
  currentPrice: 'מחיר נוכחי (₪)',
  totalValue: 'סה"כ שווי היום (₪)',
  profit: 'סה"כ רווח/הפסד בש"ח',
  indexAtBuy: 'מדד ביום הקנייה',
  indexToday: 'מדד היום (הידוע)',
  tax: 'מס רווח הון (₪)',
  afterTax: 'רווח לאחר מס (₪)',
  inflationary: 'רווח אינפלציוני (₪)',
  realGain: 'רווח ריאלי (₪)',
  profitPercent: 'אחוז רווח/הפסד',
  dailyPercent: 'אחוז שינוי יומי',
  dailyProfit: 'רווח/הפסד יומי בש"ח',
  actions: 'פעולות'
};

// The security's name AND its security id ("מספר נייר"), which is what
// identifies it on the exchange and what every price/history lookup in
// this app is keyed by.
//
// Returned as parts rather than one string so the cell can set them on two
// lines - the name reading normally, the number in mono beneath it (see
// AssetCell). A holding whose name was never resolved has only the number,
// which on its own reads as nothing, so it is labelled.
export function israeliStockNameParts(stock) {
  const securityId = String(stock.stockName || '').trim();
  const name = String(stock.officialName || '').trim();
  if (!name) return { name: `נייר ${securityId}`, securityId: null };
  return { name, securityId };
}

// The same identity as a single string, for the places that need plain
// text rather than markup (title attributes, exports).
export function israeliStockNameLabel(stock) {
  const { name, securityId } = israeliStockNameParts(stock);
  return securityId ? `${name} (${securityId})` : name;
}

function IsraeliAssetCell({ stock, prefix = null }) {
  const { name, securityId } = israeliStockNameParts(stock);
  return <AssetCell name={name} securityId={securityId} prefix={prefix} />;
}

// "סקטור" - resolved automatically (fund/ETF vs. the exchange's own branch
// classification for a share, see israeliEtfClassifier.js's
// resolveIsraeliSector), so it's plain text rather than an input.
//
// The "נכס זר?" dropdown that used to sit beside it is gone: whether a
// holding is foreign exposure is now derived from its name and the
// exchange's instrument type (a name containing "חוץ" is a foreign
// tracking fund by the exchange's own naming), not something to ask the
// user to classify by hand. The badge below shows what was derived, so the
// classification driving the pie chart is still visible rather than hidden.
function IsraeliClassificationFields({ stock }) {
  const sectorKey = resolveIsraeliSector(stock, sectorFromTaseBranch);
  const isForeign = effectiveExchangeForIsraeliStock(stock) === 'american';
  return (
    <td title={stock.branch || undefined} data-label={COL.sector}>
      {sectorLabelHe(sectorKey)}
      {isForeign && <span className="israeli-foreign-badge"> · נכס חוץ</span>}
    </td>
  );
}

// Renders the 4 editable fields (name/date/price/quantity), plus (under
// showAdditionalData) the classification fields, for one Israeli stock
// row — used for both the single-stock row and each expanded detail row,
// since they're identical apart from an optional style prop.
function IsraeliEditableFields({ stock, editingField, isEditMode, handleCellClick, handleInlineEdit, finishInlineEdit, handleKeyDown, formatDate, formatPrice, nameCellStyle, showAdditionalData }) {
  return (
    <>
      <EditableCell
        id={stock.id}
        field="stockName"
        exchange="israeli"
        value={stock.stockName}
        editingField={editingField}
        isEditMode={isEditMode}
        handleCellClick={handleCellClick}
        handleInlineEdit={handleInlineEdit}
        finishInlineEdit={finishInlineEdit}
        handleKeyDown={handleKeyDown}
        displayValue={<IsraeliAssetCell stock={stock} />}
        style={nameCellStyle}
        label={COL.name}
      />
      <EditableCell
        id={stock.id}
        field="purchaseDate"
        exchange="israeli"
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
        exchange="israeli"
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
        displayValue={formatPrice(stock.purchasePrice)}
        label={COL.buyPrice}
      />
      <EditableCell
        id={stock.id}
        field="quantity"
        exchange="israeli"
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
      {showAdditionalData && <IsraeliClassificationFields stock={stock} />}
    </>
  );
}

// Renders the computed (non-editable) figures for one Israeli stock row —
// used for both the single-stock row and each expanded detail row.
function IsraeliComputedCells({ stock, normalizeIsraeliPrice, calculateProfitPercentage, TAX_RATE, cpi, showAdditionalData, formatPrice, formatPriceWithSign, isEditMode, handleDelete, pricesPending }) {
  const displayCurrentPrice = normalizeIsraeliPrice(stock.currentPrice);
  const totalPurchase = (stock.purchasePrice || 0) * (stock.quantity || 0);
  const totalCurrentValue = (displayCurrentPrice || 0) * (stock.quantity || 0);
  const profit = totalCurrentValue - totalPurchase;
  const profitPercentage = calculateProfitPercentage(totalPurchase, totalCurrentValue);

  // מס רווח הון ריאלי: מוצמד למדד לפי תאריך הקנייה כשהמדד זמין (אותה
  // לוגיקה בדיוק כמו ב-portfolioSummary.js, כדי שהמספר בשורה הזו יהיה
  // תמיד עקבי עם הסכום המצטבר שמוצג בסיכום התיק). אם אין מדד לתאריך
  // הקנייה - נופלים חזרה למס שטוח על הרווח הנומינלי, בלי הצמדה.
  const indexAtPurchase = cpi && cpi.indexByMonth ? cpi.indexByMonth[monthKeyFromDate(stock.purchaseDate)] : null;
  const currentIndex = cpi ? cpi.currentIndex : null;
  let capitalGainsTaxILS;
  let realGain;
  if (currentIndex && indexAtPurchase) {
    const result = calculateStockRealGainTax({
      purchasePrice: stock.purchasePrice,
      quantity: stock.quantity,
      currentValue: totalCurrentValue,
      indexAtPurchase,
      currentIndex
    });
    capitalGainsTaxILS = result.tax;
    realGain = result.realGain;
  } else {
    capitalGainsTaxILS = profit > 0 ? profit * TAX_RATE : 0;
    realGain = profit;
  }
  // רווח אינפלציוני נגזר כ"מה שנשאר" מהנומינלי אחרי הרווח הריאלי - עקבי
  // תמיד עם הכלל האסימטרי מפסק דין מוזס, בדיוק כמו ב-portfolioSummary.js.
  const inflationaryGain = profit - realGain;
  const afterTaxProfitILS = profit - capitalGainsTaxILS;

  return (
    <>
      <td data-label={COL.totalBuy}>{formatPrice(totalPurchase)}</td>
      <td data-label={COL.currentPrice}>
        <PendingPriceValue value={displayCurrentPrice} pending={pricesPending} format={formatPrice} />
      </td>
      <td data-label={COL.totalValue}>
        <PendingPriceValue value={totalCurrentValue} pending={pricesPending} format={formatPrice} />
      </td>
      <td className={profitClass(profit)} data-label={COL.profit}>{formatPriceWithSign(profit)}</td>
      {showAdditionalData && <td data-label={COL.indexAtBuy}>{indexAtPurchase != null ? indexAtPurchase : '-'}</td>}
      {showAdditionalData && <td data-label={COL.indexToday}>{currentIndex != null ? currentIndex : '-'}</td>}
      {showAdditionalData && <td className="profit-negative" data-label={COL.tax}>{formatPriceWithSign(-capitalGainsTaxILS)}</td>}
      {showAdditionalData && <td className={profitClass(afterTaxProfitILS)} data-label={COL.afterTax}>{formatPriceWithSign(afterTaxProfitILS)}</td>}
      {showAdditionalData && <td className={profitClass(inflationaryGain)} data-label={COL.inflationary}>{formatPriceWithSign(inflationaryGain)}</td>}
      {showAdditionalData && <td className={profitClass(realGain)} data-label={COL.realGain}>{formatPriceWithSign(realGain)}</td>}
      <td data-label={COL.profitPercent}>
        <ValuePill value={profit}>{profitPercentage}%</ValuePill>
      </td>
      <td data-label={COL.dailyPercent}>
        <ValuePill value={effectiveDailyChangePercent(stock)}>
          {formatDailyChangePercent(effectiveDailyChangePercent(stock))}%
        </ValuePill>
      </td>
      <td className={profitClass(effectiveDailyChangePercent(stock))} data-label={COL.dailyProfit}>
        {formatPriceWithSign((effectiveDailyChangePercent(stock) / 100) * totalCurrentValue)} ₪
      </td>
      {isEditMode && (
        <td data-label={COL.actions}>
          <button onClick={() => handleDelete(stock.id, 'israeli')} className="delete-button">
            מחק
          </button>
        </td>
      )}
    </>
  );
}

function IsraeliStocksTable({
  israeliStocks,
  isEditMode,
  showAdditionalData,
  expandedGroups,
  groupStocksByName,
  calculateGroupSummary,
  normalizeIsraeliPrice,
  calculateProfitPercentage,
  TAX_RATE,
  cpi,
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
  // placeholders on cells that have no price to show yet (see
  // PendingPriceValue.js). Nothing here waits on it; the table renders
  // immediately either way.
  pricesPending = false
}) {
  return (
    <>
      {israeliStocks.length > 0 && (
        <div className="stocks-section">
          <h2 className="section-title">בורסה ישראלית</h2>
          <ScrollableTable label="בורסה ישראלית">
              <thead>
                <tr>
                  <th>{COL.name}</th>
                  <th>{COL.date}</th>
                  <th>{COL.buyPrice}</th>
                  <th>{COL.quantity}</th>
                  {showAdditionalData && <th>{COL.sector}</th>}
                  <th>{COL.totalBuy}</th>
                  <th>{COL.currentPrice}</th>
                  <th>{COL.totalValue}</th>
                  <th>{COL.profit}</th>
                  {showAdditionalData && <th>{COL.indexAtBuy}</th>}
                  {showAdditionalData && <th>{COL.indexToday}</th>}
                  {showAdditionalData && <th>{COL.tax}</th>}
                  {showAdditionalData && <th>{COL.afterTax}</th>}
                  {showAdditionalData && <th>{COL.inflationary}</th>}
                  {showAdditionalData && <th>{COL.realGain}</th>}
                  <th>{COL.profitPercent}</th>
                  <th>{COL.dailyPercent}</th>
                  <th>{COL.dailyProfit}</th>
                  {isEditMode && <th>{COL.actions}</th>}
                </tr>
              </thead>
              <tbody>
                {Object.entries(groupStocksByName(israeliStocks)).map(([stockName, stocks]) => {
                  const isExpanded = expandedGroups[`israeli-${stockName}`];
                  const summary = calculateGroupSummary(stocks);
                  const editableFieldProps = {
                    editingField,
                    isEditMode,
                    handleCellClick,
                    handleInlineEdit,
                    finishInlineEdit,
                    handleKeyDown,
                    formatDate,
                    formatPrice,
                    showAdditionalData
                  };
                  const computedCellProps = {
                    normalizeIsraeliPrice,
                    calculateProfitPercentage,
                    TAX_RATE,
                    cpi,
                    showAdditionalData,
                    formatPrice,
                    formatPriceWithSign,
                    isEditMode,
                    handleDelete,
                    pricesPending
                  };

                  if (stocks.length === 1) {
                    const stock = stocks[0];
                    return (
                      <tr key={stock.id} className={isEditMode ? 'editable-row' : ''}>
                        <IsraeliEditableFields stock={stock} {...editableFieldProps} />
                        <IsraeliComputedCells stock={stock} {...computedCellProps} />
                      </tr>
                    );
                  }

                  return (
                    <React.Fragment key={stockName}>
                      <tr className={`${isEditMode ? 'editable-row' : ''} ${isExpanded ? 'summary-row-expanded' : ''}`}>
                        <td
                          onClick={() => handleCellClick(stocks[0].id, 'stockName', 'israeli')}
                          className={isEditMode ? 'editable-cell' : ''}
                        >
                          <button
                            onClick={() => toggleGroup(stockName, 'israeli')}
                            className="expand-button"
                            style={{ marginRight: '8px', background: 'none', border: 'none', cursor: 'pointer' }}
                          >
                            {isExpanded ? '▼' : '▶'}
                          </button>
                          <IsraeliAssetCell stock={stocks[0]} />
                        </td>
                        <td data-label={COL.date} title={PER_LOT_TITLE}>{PER_LOT}</td>
                        <td data-label={COL.buyPrice} title={PER_LOT_TITLE}>{PER_LOT}</td>
                        <td data-label={COL.quantity}>{summary.totalQuantity}</td>
                        {showAdditionalData && <IsraeliClassificationFields stock={stocks[0]} />}
                        <td data-label={COL.totalBuy}>{formatPrice(summary.totalPurchaseValue)}</td>
                        <td data-label={COL.currentPrice}>
                          <PendingPriceValue
                            value={summary.averageCurrentPrice}
                            pending={pricesPending}
                            format={formatPrice}
                          />
                        </td>
                        <td data-label={COL.totalValue}>
                          <PendingPriceValue
                            value={summary.totalCurrentValue}
                            pending={pricesPending}
                            format={formatPrice}
                          />
                        </td>
                        <td className={profitClass(summary.totalProfit)} data-label={COL.profit}>{formatPriceWithSign(summary.totalProfit)}</td>
                        {showAdditionalData && (
                          <td colSpan={2} data-label={COL.indexAtBuy} title={PER_LOT_TITLE} style={{ color: 'var(--sw-text-secondary)', fontSize: '0.85em' }}>{PER_LOT}</td>
                        )}
                        {showAdditionalData && (() => {
                          // סכימה per-lot של המס/הרווח הריאלי (לא על הרווח המצרפי),
                          // כי לכל lot יש תאריך קנייה ומדד שונים.
                          let tax = 0;
                          let realGainSum = 0;
                          stocks.forEach((stock) => {
                            const displayCurrentPrice = normalizeIsraeliPrice(stock.currentPrice);
                            const totalCurrentValueLot = (displayCurrentPrice || 0) * (stock.quantity || 0);
                            const profitLot = totalCurrentValueLot - (stock.purchasePrice || 0) * (stock.quantity || 0);
                            const indexAtPurchase = cpi && cpi.indexByMonth ? cpi.indexByMonth[monthKeyFromDate(stock.purchaseDate)] : null;
                            if (cpi && cpi.currentIndex && indexAtPurchase) {
                              const result = calculateStockRealGainTax({
                                purchasePrice: stock.purchasePrice,
                                quantity: stock.quantity,
                                currentValue: totalCurrentValueLot,
                                indexAtPurchase,
                                currentIndex: cpi.currentIndex
                              });
                              tax += result.tax;
                              realGainSum += result.realGain;
                            } else {
                              tax += profitLot > 0 ? profitLot * TAX_RATE : 0;
                              realGainSum += profitLot;
                            }
                          });
                          const after = summary.totalProfit - tax;
                          const inflationarySum = summary.totalProfit - realGainSum;
                          return (
                            <>
                              <td className="profit-negative" data-label={COL.tax}>{formatPriceWithSign(-tax)}</td>
                              <td className={profitClass(after)} data-label={COL.afterTax}>{formatPriceWithSign(after)}</td>
                              <td className={profitClass(inflationarySum)} data-label={COL.inflationary}>{formatPriceWithSign(inflationarySum)}</td>
                              <td className={profitClass(realGainSum)} data-label={COL.realGain}>{formatPriceWithSign(realGainSum)}</td>
                            </>
                          );
                        })()}
                        <td data-label={COL.profitPercent}>
                          <ValuePill value={summary.totalProfit}>{summary.profitPercentage}%</ValuePill>
                        </td>
                        <td data-label={COL.dailyPercent}>
                          <ValuePill value={effectiveDailyChangePercent(stocks[0])}>
                            {formatDailyChangePercent(effectiveDailyChangePercent(stocks[0]))}%
                          </ValuePill>
                        </td>
                        <td className={profitClass(effectiveDailyChangePercent(stocks[0]))} data-label={COL.dailyProfit}>
                          {formatPriceWithSign((effectiveDailyChangePercent(stocks[0]) / 100) * summary.totalCurrentValue)} ₪
                        </td>
                        {isEditMode && <td></td>}
                      </tr>

                      {isExpanded && stocks.map((stock) => (
                        <tr key={stock.id} className={`${isEditMode ? 'editable-row' : ''} detail-row`}>
                          <IsraeliEditableFields
                            stock={stock}
                            {...editableFieldProps}
                            nameCellStyle={{ paddingLeft: '20px' }}
                          />
                          <IsraeliComputedCells stock={stock} {...computedCellProps} />
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

export default IsraeliStocksTable;
