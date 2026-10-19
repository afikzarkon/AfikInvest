import React from 'react';
import EditableCell from './EditableCell';
import PendingPriceValue from './PendingPriceValue';
import AssetCell from './AssetCell';
import ScrollableTable from './ScrollableTable';
import { formatPriceWithSign as maskedAmount } from '../utils/formatters';
import { effectiveDailyChangePercent } from '../utils/marketSession';
import { useCompactLayout } from '../hooks/useMediaQuery';
import { Merged, MergedHeader, Money, Pct } from './holdings/MergedValue';
import HoldingCards from './holdings/HoldingCards';
import { HoldingsViewToggle, useHoldingsView } from './holdings/useHoldingsView';

// See IsraeliStocksTable.js - a grouped row has several lots behind it,
// so the columns that differ per lot print an em dash rather than
// repeating the same "open the group" instruction on every one.
const PER_LOT = '—';
const PER_LOT_TITLE = 'ערך שונה לכל רכישה - הרחיבו את הקיבוץ כדי לראות את הפירוט';

// The columns. Each pair that reads together is one column: the dollar
// value over the shekel value, the purchase in dollars over shekels,
// today's rate over the purchase-day rate, the profit in dollars with its
// percent over the profit in shekels. 9 columns instead of 14 (12 instead
// of 21 with the extended data), with every figure still on the page. The
// purchase-day rate and the purchase in shekels used to be extended-only
// columns; as the second line of a column already shown they cost no
// space, so they are always there now.
const COL = {
  name: { title: 'שם מנייה' },
  date: { title: 'תאריך קנייה' },
  quantity: { title: 'כמות' },
  price: { title: 'מחיר נוכחי / קנייה', hint: '$' },
  rate: { title: 'שער חליפין היום / ביום הקנייה' },
  cost: { title: 'עלות', hint: '$ / ₪' },
  value: { title: 'שווי', hint: '$ / ₪' },
  profit: { title: 'רווח/הפסד', hint: '$ · % / ₪' },
  daily: { title: 'שינוי יומי', hint: '$ · %' },
  fx: { title: 'השפעת שער חליפין', hint: '₪' },
  real: { title: 'רווח ריאלי / אינפלציוני', hint: '₪' },
  tax: { title: 'מס רווח הון / רווח לאחר מס', hint: '₪' },
  actions: { title: 'פעולות' }
};

const usd = (v) => `${maskedAmount(v)} $`;
const ils = (v) => `${maskedAmount(v)} ₪`;

// Every figure for one lot, from portfolioMath's per-stock metrics.
function lotFigures(stock, { calculateAmericanStockMetrics, calculateProfitPercentage }) {
  const m = calculateAmericanStockMetrics(stock);
  const dailyPercent = effectiveDailyChangePercent(stock) || 0;
  return {
    quantity: stock.quantity,
    purchasePrice: stock.purchasePrice,
    currentPrice: stock.currentPrice,
    rateAtBuy: stock.exchangeRate,
    rateToday: m.currentExchangeRate,
    totalPurchaseUSD: m.totalPurchaseUSD,
    totalPurchaseILS: m.totalPurchaseILS,
    totalCurrentValueUSD: m.totalCurrentValueUSD,
    totalCurrentValueILS: m.totalCurrentValueILS,
    profitUSD: m.profitUSD,
    profitILS: m.profitILS,
    profitPercent: Number(calculateProfitPercentage(stock.purchasePrice || 0, stock.currentPrice || 0)),
    fxImpact: m.exchangeRateImpact,
    tax: m.taxILS,
    afterTax: m.afterTaxILS,
    inflationary: m.currencyExemptGainILS,
    realGain: m.realGainILS,
    dailyPercent,
    dailyProfit: (dailyPercent / 100) * m.totalCurrentValueUSD
  };
}

// A grouped holding: the lots summed. Tax and the real / FX-exempt split
// are per lot (each purchase has its own date and rate), as on Israeli
// holdings with a different index per purchase date.
function groupFigures(stocks, lots, summary, calculateProfitPercentage) {
  const sum = (k) => lots.reduce((s, f) => s + (f[k] || 0), 0);
  const qty = summary.totalQuantity;
  const totalPurchaseUSD = sum('totalPurchaseUSD');
  const totalCurrentValueUSD = sum('totalCurrentValueUSD');
  const totalPurchaseILS = stocks.reduce((s, st) => s + (st.purchasePrice || 0) * (st.quantity || 0) * (st.exchangeRate || 0), 0);
  const totalCurrentValueILS = stocks.reduce(
    (s, st) => s + (st.currentPrice || 0) * (st.quantity || 0) * (st.currentExchangeRate || st.exchangeRate || 0),
    0
  );
  const averagePurchasePrice = qty > 0 ? totalPurchaseUSD / qty : 0;
  const averageCurrentPrice = qty > 0 ? totalCurrentValueUSD / qty : 0;
  const profitILS = totalCurrentValueILS - totalPurchaseILS;
  const dailyPercent = effectiveDailyChangePercent(stocks[0]) || 0;
  return {
    quantity: qty,
    purchasePrice: averagePurchasePrice,
    currentPrice: averageCurrentPrice,
    rateAtBuy: null,
    rateToday: stocks[0].currentExchangeRate || stocks[0].exchangeRate || 0,
    totalPurchaseUSD,
    totalPurchaseILS,
    totalCurrentValueUSD,
    totalCurrentValueILS,
    profitUSD: totalCurrentValueUSD - totalPurchaseUSD,
    profitILS,
    profitPercent: Number(calculateProfitPercentage(averagePurchasePrice, averageCurrentPrice)),
    fxImpact: stocks.reduce(
      (s, st) => s + (st.purchasePrice || 0) * (st.quantity || 0) * ((st.currentExchangeRate || st.exchangeRate || 0) - (st.exchangeRate || 0)),
      0
    ),
    tax: sum('tax'),
    afterTax: profitILS - sum('tax'),
    inflationary: profitILS - sum('realGain'),
    realGain: sum('realGain'),
    dailyPercent,
    dailyProfit: (dailyPercent / 100) * totalCurrentValueUSD
  };
}

function FigureCells({ f, pending, showAdditionalData, formatPrice, buyPrice, rateAtBuy, isGroup }) {
  return (
    <>
      <td>
        <Merged
          main={<span className="mv-num"><PendingPriceValue value={f.currentPrice} pending={pending} format={formatPrice} /></span>}
          sub={<>{isGroup ? 'ממוצע ' : 'קנייה '}{buyPrice}</>}
        />
      </td>
      <td title={isGroup ? PER_LOT_TITLE : undefined}>
        <Merged main={formatPrice(f.rateToday)} sub={<>ביום הקנייה {rateAtBuy}</>} />
      </td>
      <td>
        <Merged main={<Money value={f.totalPurchaseUSD} currency="$" />} sub={<Money value={f.totalPurchaseILS} />} />
      </td>
      <td>
        <Merged
          main={<span className="mv-num"><PendingPriceValue value={f.totalCurrentValueUSD} pending={pending} format={usd} /></span>}
          sub={<span className="mv-num"><PendingPriceValue value={f.totalCurrentValueILS} pending={pending} format={ils} /></span>}
        />
      </td>
      <td>
        <Merged main={<><Money value={f.profitUSD} currency="$" signed /> <Pct value={f.profitPercent} /></>} sub={<Money value={f.profitILS} signed />} />
      </td>
      <td>
        <Merged main={<><Money value={f.dailyProfit} currency="$" signed /> <Pct value={f.dailyPercent} /></>} />
      </td>
      {showAdditionalData && (
        <td>
          <Merged main={<Money value={f.fxImpact} signed />} />
        </td>
      )}
      {showAdditionalData && (
        <td>
          <Merged main={<Money value={f.realGain} signed />} sub={<>אינפלציוני <Money value={f.inflationary} /></>} />
        </td>
      )}
      {showAdditionalData && (
        <td>
          <Merged main={<Money value={-f.tax} signed />} sub={<>לאחר מס <Money value={f.afterTax} signed /></>} />
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
  TAX_RATE, // eslint-disable-line no-unused-vars -- tax comes from calculateAmericanStockMetrics
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
  const compact = useCompactLayout();
  const [view, setView] = useHoldingsView();
  if (americanStocks.length === 0) return null;

  const ctx = { calculateAmericanStockMetrics, calculateProfitPercentage };
  const editProps = { editingField, isEditMode, handleCellClick, handleInlineEdit, finishInlineEdit, handleKeyDown };
  const field = (stock, name, extra) => (
    <EditableCell id={stock.id} exchange="american" field={name} value={stock[name]} {...editProps} {...extra} />
  );
  // In the table the name sits in a fixed column beside the expand slot,
  // so names line up whether or not the row has one; a lot's row marks its
  // indent. In a card the name stands alone.
  const nameField = (stock, as, { lot = false } = {}) =>
    field(stock, 'stockName', {
      displayValue:
        as === 'span' ? (
          <AssetCell name={stock.stockName} />
        ) : (
          <span className={`name-cell ${lot ? 'is-lot' : ''}`}>
            <span className="expand-slot" aria-hidden="true" />
            <AssetCell name={stock.stockName} />
          </span>
        ),
      label: COL.name.title,
      as
    });
  const dateField = (stock, as) => field(stock, 'purchaseDate', { type: 'date', displayValue: formatDate(stock.purchaseDate), label: COL.date.title, as });
  // In the table the column's header carries the "$"; in a card the
  // figure stands alone, so it carries its own.
  const priceField = (stock, as = 'span', withCurrency = true) =>
    field(stock, 'purchasePrice', {
      type: 'number',
      step: '0.01',
      parse: (raw) => parseFloat(raw),
      displayValue: withCurrency ? `${formatPriceWithSign(stock.purchasePrice)} $` : formatPrice(stock.purchasePrice),
      label: 'מחיר קנייה',
      as
    });
  const quantityField = (stock, as) =>
    field(stock, 'quantity', { type: 'number', min: '1', parse: (raw) => parseInt(raw), displayValue: stock.quantity, label: COL.quantity.title, as });
  const rateField = (stock, as = 'span') =>
    field(stock, 'exchangeRate', {
      type: 'number',
      step: '0.0001',
      parse: (raw) => parseFloat(raw),
      displayValue: formatPrice(stock.exchangeRate),
      label: 'שער חליפין ביום הקנייה',
      as
    });
  const deleteButton = (stock) => (
    <button type="button" onClick={() => handleDelete(stock.id, 'american')} className="delete-button">
      מחק
    </button>
  );

  const groups = Object.entries(groupStocksByName(americanStocks)).map(([stockName, stocks]) => {
    const lots = stocks.map((s) => lotFigures(s, ctx));
    const total = stocks.length === 1 ? lots[0] : groupFigures(stocks, lots, calculateGroupSummary(stocks), calculateProfitPercentage);
    return { stockName, stocks, lots, total };
  });

  // ---------- the phone: cards ----------
  if (compact && view === 'cards') {
    const extFields = (f) => [
      { label: 'השפעת שער חליפין', value: <Money value={f.fxImpact} signed /> },
      { label: 'רווח ריאלי', value: <Money value={f.realGain} signed /> },
      { label: 'רווח אינפלציוני', value: <Money value={f.inflationary} /> },
      { label: 'מס רווח הון', value: <Money value={-f.tax} signed /> },
      { label: 'רווח לאחר מס', value: <Money value={f.afterTax} signed /> }
    ];
    // In edit mode the name is edited here - the card's header is a button.
    const lotDetails = (stock, f) => [
      ...(isEditMode ? [{ label: COL.name.title, value: nameField(stock, 'span') }] : []),
      { label: COL.date.title, value: dateField(stock, 'span') },
      { label: COL.quantity.title, value: quantityField(stock, 'span') },
      { label: 'מחיר קנייה', value: priceField(stock) },
      { label: 'מחיר נוכחי', value: <PendingPriceValue value={f.currentPrice} pending={pricesPending} format={usd} /> },
      { label: 'שער חליפין ביום הקנייה', value: rateField(stock) },
      { label: 'שער חליפין היום', value: formatPrice(f.rateToday) },
      { label: 'עלות', value: <><Money value={f.totalPurchaseUSD} currency="$" /> · <Money value={f.totalPurchaseILS} /></> },
      { label: 'שווי', value: <><Money value={f.totalCurrentValueUSD} currency="$" /> · <Money value={f.totalCurrentValueILS} /></> },
      { label: COL.profit.title, value: <><Money value={f.profitUSD} currency="$" signed /> <Pct value={f.profitPercent} /></> },
      { label: 'רווח/הפסד בשקלים', value: <Money value={f.profitILS} signed /> },
      { label: COL.daily.title, value: <><Money value={f.dailyProfit} currency="$" signed /> <Pct value={f.dailyPercent} /></> }
    ];
    const headerOnly = ['שווי', COL.profit.title, COL.daily.title];
    const items = groups.map(({ stockName, stocks, lots, total }) => {
      const multi = stocks.length > 1;
      const first = stocks[0];
      return {
        key: stockName,
        name: stockName,
        idLine: `${total.quantity} יח׳`,
        lotsCount: stocks.length,
        value: <PendingPriceValue value={total.totalCurrentValueUSD} pending={pricesPending} format={usd} />,
        valueSub: <Money value={total.totalCurrentValueILS} />,
        pl: <><Money value={total.profitUSD} currency="$" signed /> <Pct value={total.profitPercent} /></>,
        daily: <><Money value={total.dailyProfit} currency="$" signed /> <Pct value={total.dailyPercent} /></>,
        details: multi
          ? [
              { label: 'מחיר נוכחי', value: <PendingPriceValue value={total.currentPrice} pending={pricesPending} format={usd} /> },
              { label: 'מחיר קנייה ממוצע', value: usd(total.purchasePrice) },
              { label: 'שער חליפין היום', value: formatPrice(total.rateToday) },
              { label: 'עלות', value: <><Money value={total.totalPurchaseUSD} currency="$" /> · <Money value={total.totalPurchaseILS} /></> },
              { label: 'רווח/הפסד בשקלים', value: <Money value={total.profitILS} signed /> }
            ]
          : lotDetails(first, total).filter((d) => !headerOnly.includes(d.label)),
        ext: extFields(total),
        actions: isEditMode && !multi ? deleteButton(first) : null,
        lots: multi
          ? stocks.map((stock, i) => ({
              key: String(stock.id),
              title: (
                <>
                  <span>{formatDate(stock.purchaseDate)}</span>
                  <bdi dir="ltr" className="hc-lot-qty">
                    {stock.quantity} × {usd(stock.purchasePrice)}
                  </bdi>
                </>
              ),
              pl: <><Money value={lots[i].profitUSD} currency="$" signed /> <Pct value={lots[i].profitPercent} /></>,
              details: lotDetails(stock, lots[i]),
              ext: extFields(lots[i]),
              actions: isEditMode ? deleteButton(stock) : null
            }))
          : null
      };
    });
    return (
      <div className="stocks-section holdings-cards-section">
        <div className="holdings-section-head">
          <h2 className="section-title">בורסה אמריקאית</h2>
          <HoldingsViewToggle view={view} onChange={setView} />
        </div>
        <HoldingCards items={items} showExtended={showAdditionalData} label="בורסה אמריקאית" />
      </div>
    );
  }

  // ---------- the table ----------
  const headers = [
    COL.name,
    COL.date,
    COL.quantity,
    COL.price,
    COL.rate,
    COL.cost,
    COL.value,
    COL.profit,
    COL.daily,
    showAdditionalData && COL.fx,
    showAdditionalData && COL.real,
    showAdditionalData && COL.tax,
    isEditMode && COL.actions
  ].filter(Boolean);
  const cellProps = { pending: pricesPending, showAdditionalData, formatPrice };

  return (
    <div className="stocks-section">
      <div className="holdings-section-head">
        <h2 className="section-title">בורסה אמריקאית</h2>
        {compact && <HoldingsViewToggle view={view} onChange={setView} />}
      </div>
      <ScrollableTable label="בורסה אמריקאית" tableClassName="american-stocks-table">
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h.title}>
                <MergedHeader title={h.title} hint={h.hint} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map(({ stockName, stocks, lots, total }) => {
            if (stocks.length === 1) {
              const stock = stocks[0];
              return (
                <tr key={stock.id} className={isEditMode ? 'editable-row' : ''}>
                  {nameField(stock)}
                  {dateField(stock)}
                  {quantityField(stock)}
                  <FigureCells f={total} buyPrice={priceField(stock, 'span', false)} rateAtBuy={rateField(stock)} {...cellProps} />
                  {isEditMode && <td>{deleteButton(stock)}</td>}
                </tr>
              );
            }
            const isExpanded = expandedGroups[`american-${stockName}`];
            return (
              <React.Fragment key={stockName}>
                <tr className={`${isEditMode ? 'editable-row' : ''} ${isExpanded ? 'summary-row-expanded' : ''}`}>
                  <td onClick={() => handleCellClick(stocks[0].id, 'stockName', 'american')} className={isEditMode ? 'editable-cell' : ''}>
                    <span className="name-cell">
                      <button
                        type="button"
                        onClick={() => toggleGroup(stockName, 'american')}
                        className="expand-button"
                        aria-expanded={Boolean(isExpanded)}
                        aria-label={isExpanded ? 'סגירת הקניות' : 'פתיחת הקניות'}
                      >
                        {isExpanded ? '▾' : '◂'}
                      </button>
                      <span>
                        <AssetCell name={stockName} />
                        <span className="lots-count">{stocks.length} קניות</span>
                      </span>
                    </span>
                  </td>
                  <td title={PER_LOT_TITLE}>{PER_LOT}</td>
                  <td>{total.quantity}</td>
                  <FigureCells f={total} buyPrice={formatPrice(total.purchasePrice)} rateAtBuy={PER_LOT} isGroup {...cellProps} />
                  {isEditMode && <td></td>}
                </tr>
                {isExpanded &&
                  stocks.map((stock, i) => (
                    <tr key={stock.id} className={`${isEditMode ? 'editable-row' : ''} detail-row`}>
                      {nameField(stock, 'td', { lot: true })}
                      {dateField(stock)}
                      {quantityField(stock)}
                      <FigureCells f={lots[i]} buyPrice={priceField(stock, 'span', false)} rateAtBuy={rateField(stock)} {...cellProps} />
                      {isEditMode && <td>{deleteButton(stock)}</td>}
                    </tr>
                  ))}
              </React.Fragment>
            );
          })}
        </tbody>
      </ScrollableTable>
    </div>
  );
}

export default AmericanStocksTable;
