import React from 'react';
import EditableCell from './EditableCell';
import PendingPriceValue from './PendingPriceValue';
import AssetCell from './AssetCell';
import ScrollableTable from './ScrollableTable';
import { formatPriceWithSign as maskedAmount } from '../utils/formatters';
import { changeFromPercent, effectiveDailyChangePercent } from '../utils/marketSession';
import { calculateStockRealGainTax, monthKeyFromDate } from '../utils/cpiTax';
import { sectorLabelHe } from '../utils/sectorLabels';
import { effectiveExchangeForIsraeliStock, resolveIsraeliSector } from '../utils/israeliEtfClassifier';
import { sectorFromTaseBranch } from '../utils/israeliSectorMapping';
import { useCompactLayout } from '../hooks/useMediaQuery';
import { LastSessionChange, Merged, MergedHeader, Money, Pct } from './holdings/MergedValue';
import HoldingCards from './holdings/HoldingCards';
import { HoldingsViewToggle, useHoldingsView } from './holdings/useHoldingsView';

// A grouped row has several lots behind it, so the columns that differ
// per lot have no single value to print. An em dash says that; the row
// expands to show the lots themselves.
const PER_LOT = '—';
const PER_LOT_TITLE = 'ערך שונה לכל רכישה - הרחיבו את הקיבוץ כדי לראות את הפירוט';

// The columns. Pairs that always read together are one column now - the
// amount with its percent, the current price over the purchase price, the
// value over the cost - so the table is 7 columns instead of 11 (11
// instead of 18 with the extended data), and nothing that was shown is
// gone. `title` heads the column; `hint` says what its figures are. The
// same names label the fields in the phone's cards.
const COL = {
  name: { title: 'שם מנייה' },
  date: { title: 'תאריך קנייה' },
  quantity: { title: 'כמות' },
  sector: { title: 'סקטור' },
  price: { title: 'מחיר נוכחי / קנייה', hint: '₪' },
  value: { title: 'שווי היום / עלות', hint: '₪' },
  profit: { title: 'רווח/הפסד', hint: '₪ · %' },
  daily: { title: 'שינוי יומי', hint: '₪ · % · ומתחת: אתמול' },
  index: { title: 'מדד ביום הקנייה / היום' },
  real: { title: 'רווח ריאלי / אינפלציוני', hint: '₪' },
  tax: { title: 'מס רווח הון / רווח לאחר מס', hint: '₪' },
  actions: { title: 'פעולות' }
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
// resolveIsraeliSector), with a badge when the holding is foreign exposure.
function SectorValue({ stock }) {
  const sectorKey = resolveIsraeliSector(stock, sectorFromTaseBranch);
  const isForeign = effectiveExchangeForIsraeliStock(stock) === 'american';
  return (
    <span title={stock.branch || undefined}>
      {sectorLabelHe(sectorKey)}
      {isForeign && <span className="israeli-foreign-badge"> · נכס חוץ</span>}
    </span>
  );
}

// Every figure the table shows for one lot. Real-gain tax is CPI-linked by
// the purchase date when the index is known (the same logic as
// portfolioSummary.js, so a row always agrees with the summary above it),
// and falls back to a flat tax on the nominal gain without an index. The
// inflationary gain is what remains of the nominal gain after the real
// gain - the asymmetric rule from the Moses ruling.
function lotFigures(stock, { normalizeIsraeliPrice, calculateProfitPercentage, TAX_RATE, cpi, lastSession }) {
  const currentPrice = normalizeIsraeliPrice(stock.currentPrice);
  const totalPurchase = (stock.purchasePrice || 0) * (stock.quantity || 0);
  const totalCurrentValue = (currentPrice || 0) * (stock.quantity || 0);
  const profit = totalCurrentValue - totalPurchase;
  const indexAtPurchase = cpi && cpi.indexByMonth ? cpi.indexByMonth[monthKeyFromDate(stock.purchaseDate)] : null;
  const currentIndex = cpi ? cpi.currentIndex : null;
  let tax;
  let realGain;
  if (currentIndex && indexAtPurchase) {
    const result = calculateStockRealGainTax({
      purchasePrice: stock.purchasePrice,
      quantity: stock.quantity,
      currentValue: totalCurrentValue,
      indexAtPurchase,
      currentIndex
    });
    tax = result.tax;
    realGain = result.realGain;
  } else {
    tax = profit > 0 ? profit * TAX_RATE : 0;
    realGain = profit;
  }
  const dailyPercent = effectiveDailyChangePercent(stock) || 0;
  return {
    quantity: stock.quantity,
    purchasePrice: stock.purchasePrice,
    currentPrice,
    totalPurchase,
    totalCurrentValue,
    profit,
    profitPercent: Number(calculateProfitPercentage(totalPurchase, totalCurrentValue)),
    indexAtPurchase,
    currentIndex,
    tax,
    realGain,
    inflationaryGain: profit - realGain,
    afterTax: profit - tax,
    dailyPercent,
    dailyProfit: changeFromPercent(totalCurrentValue, dailyPercent),
    lastSession: lastSession ? lastSession.byLot[stock.id] || null : null
  };
}

// A grouped holding: the lots' figures summed (tax and real gain per lot,
// since each lot has its own purchase date and index).
function groupFigures(stocks, lots, summary) {
  const sum = (k) => lots.reduce((s, f) => s + f[k], 0);
  return {
    quantity: summary.totalQuantity,
    purchasePrice: summary.averagePurchasePrice,
    currentPrice: summary.averageCurrentPrice,
    totalPurchase: summary.totalPurchaseValue,
    totalCurrentValue: summary.totalCurrentValue,
    profit: summary.totalProfit,
    profitPercent: Number(summary.profitPercentage),
    indexAtPurchase: null,
    currentIndex: lots[0] ? lots[0].currentIndex : null,
    tax: sum('tax'),
    realGain: sum('realGain'),
    inflationaryGain: summary.totalProfit - sum('realGain'),
    afterTax: summary.totalProfit - sum('tax'),
    dailyPercent: effectiveDailyChangePercent(stocks[0]) || 0,
    dailyProfit: changeFromPercent(summary.totalCurrentValue, effectiveDailyChangePercent(stocks[0]) || 0)
  };
}

const priceText = (formatPrice) => (v) => formatPrice(v);
const amountText = (v) => `${maskedAmount(v)} ₪`;

// The cells that read the same in a single row, a group's row and a lot's
// row. `buyPrice` is the purchase-price node - an editable field for a
// lot, the average for a group.
function FigureCells({ f, pending, showAdditionalData, formatPrice, buyPrice, isGroup }) {
  return (
    <>
      <td>
        <Merged
          main={<PendingPriceValue value={f.currentPrice} pending={pending} format={priceText(formatPrice)} />}
          sub={<>{isGroup ? 'ממוצע ' : 'קנייה '}{buyPrice}</>}
        />
      </td>
      <td>
        <Merged
          main={<span className="mv-num"><PendingPriceValue value={f.totalCurrentValue} pending={pending} format={amountText} /></span>}
          sub={<>עלות <Money value={f.totalPurchase} /></>}
        />
      </td>
      <td>
        <Merged main={<><Money value={f.profit} signed /> <Pct value={f.profitPercent} /></>} />
      </td>
      <td>
        <Merged main={<><Money value={f.dailyProfit} signed /> <Pct value={f.dailyPercent} /></>} sub={<LastSessionChange result={f.lastSession} />} />
      </td>
      {showAdditionalData && (
        <td title={isGroup ? PER_LOT_TITLE : undefined}>
          <Merged main={isGroup ? PER_LOT : f.indexAtPurchase ?? '-'} sub={`היום ${f.currentIndex ?? '-'}`} />
        </td>
      )}
      {showAdditionalData && (
        <td>
          <Merged main={<Money value={f.realGain} signed />} sub={<>אינפלציוני <Money value={f.inflationaryGain} /></>} />
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
  formatPriceWithSign, // eslint-disable-line no-unused-vars -- amounts go through MergedValue's masked formatter
  handleDelete,
  toggleGroup,
  editingField,
  // True until the first live price cycle completes - drives the skeleton
  // placeholders on cells that have no price to show yet (see
  // PendingPriceValue.js). Nothing here waits on it; the table renders
  // immediately either way.
  pricesPending = false,
  // utils/lastSessionChange.js's result ({ bySymbol, byLot }): "אתמול".
  lastSession = null
}) {
  const compact = useCompactLayout();
  const [view, setView] = useHoldingsView();
  if (israeliStocks.length === 0) return null;

  const ctx = { normalizeIsraeliPrice, calculateProfitPercentage, TAX_RATE, cpi, lastSession };
  const editProps = { editingField, isEditMode, handleCellClick, handleInlineEdit, finishInlineEdit, handleKeyDown };
  const field = (stock, name, extra) => (
    <EditableCell id={stock.id} exchange="israeli" field={name} value={stock[name]} {...editProps} {...extra} />
  );
  // In the table the name sits in a fixed column beside the expand slot,
  // so names line up whether or not the row has one; a lot's row marks its
  // indent. In a card the name stands alone.
  const nameField = (stock, as, { lot = false } = {}) =>
    field(stock, 'stockName', {
      displayValue:
        as === 'span' ? (
          <IsraeliAssetCell stock={stock} />
        ) : (
          <span className={`name-cell ${lot ? 'is-lot' : ''}`}>
            <span className="expand-slot" aria-hidden="true" />
            <IsraeliAssetCell stock={stock} />
          </span>
        ),
      label: COL.name.title,
      as
    });
  const dateField = (stock, as) =>
    field(stock, 'purchaseDate', { type: 'date', displayValue: formatDate(stock.purchaseDate), label: COL.date.title, as });
  const priceField = (stock, as = 'span') =>
    field(stock, 'purchasePrice', {
      type: 'number',
      step: '0.01',
      parse: (raw) => parseFloat(raw),
      displayValue: formatPrice(stock.purchasePrice),
      label: 'מחיר קנייה (₪)',
      as
    });
  const quantityField = (stock, as) =>
    field(stock, 'quantity', { type: 'number', min: '1', parse: (raw) => parseInt(raw), displayValue: stock.quantity, label: COL.quantity.title, as });
  const deleteButton = (stock) => (
    <button type="button" onClick={() => handleDelete(stock.id, 'israeli')} className="delete-button">
      מחק
    </button>
  );

  const groups = Object.entries(groupStocksByName(israeliStocks)).map(([stockName, stocks]) => {
    const lots = stocks.map((s) => lotFigures(s, ctx));
    const figures = stocks.length === 1 ? lots[0] : groupFigures(stocks, lots, calculateGroupSummary(stocks));
    // The holding's own figure, which also counts a slice sold that day.
    const total = { ...figures, lastSession: lastSession ? lastSession.bySymbol[`israeli:${String(stockName).trim()}`] || null : null };
    return { stockName, stocks, lots, total };
  });

  // ---------- the phone: cards ----------
  if (compact && view === 'cards') {
    const extFields = (stock, f, isGroup) => [
      { label: COL.sector.title, value: <SectorValue stock={stock} /> },
      { label: 'מדד ביום הקנייה', value: isGroup ? PER_LOT : f.indexAtPurchase ?? '-' },
      { label: 'מדד היום (הידוע)', value: f.currentIndex ?? '-' },
      { label: 'רווח ריאלי', value: <Money value={f.realGain} signed /> },
      { label: 'רווח אינפלציוני', value: <Money value={f.inflationaryGain} /> },
      { label: 'מס רווח הון', value: <Money value={-f.tax} signed /> },
      { label: 'רווח לאחר מס', value: <Money value={f.afterTax} signed /> }
    ];
    // In edit mode the name is edited here, in the details - the card's
    // header is a button, and an input cannot live inside one.
    const lotDetails = (stock, f) => [
      ...(isEditMode ? [{ label: COL.name.title, value: nameField(stock, 'span') }] : []),
      { label: COL.date.title, value: dateField(stock, 'span') },
      { label: COL.quantity.title, value: quantityField(stock, 'span') },
      { label: 'מחיר קנייה', value: priceField(stock) },
      { label: 'מחיר נוכחי', value: <PendingPriceValue value={f.currentPrice} pending={pricesPending} format={priceText(formatPrice)} /> },
      { label: 'עלות', value: <Money value={f.totalPurchase} /> },
      { label: 'שווי היום', value: <Money value={f.totalCurrentValue} /> },
      { label: COL.profit.title, value: <><Money value={f.profit} signed /> <Pct value={f.profitPercent} /></> },
      { label: COL.daily.title, value: <><Money value={f.dailyProfit} signed /> <Pct value={f.dailyPercent} /></> },
      { label: 'שינוי אתמול', value: <LastSessionChange result={f.lastSession} label="" /> }
    ];
    const items = groups.map(({ stockName, stocks, lots, total }) => {
      const multi = stocks.length > 1;
      const first = stocks[0];
      const { name, securityId } = israeliStockNameParts(first);
      return {
        key: stockName,
        name,
        idLine: `${securityId ? `${securityId} · ` : ''}${total.quantity} יח׳`,
        lotsCount: stocks.length,
        value: <PendingPriceValue value={total.totalCurrentValue} pending={pricesPending} format={amountText} />,
        pl: <><Money value={total.profit} signed /> <Pct value={total.profitPercent} /></>,
        daily: <><Money value={total.dailyProfit} signed /> <Pct value={total.dailyPercent} /></>,
        yesterday: <LastSessionChange result={total.lastSession} label="" />,
        details: multi
          ? [
              { label: 'מחיר נוכחי', value: <PendingPriceValue value={total.currentPrice} pending={pricesPending} format={priceText(formatPrice)} /> },
              { label: 'מחיר קנייה ממוצע', value: formatPrice(total.purchasePrice) },
              { label: 'עלות', value: <Money value={total.totalPurchase} /> }
            ]
          : lotDetails(first, total).filter((d) => ![COL.profit.title, COL.daily.title, 'שינוי אתמול', 'שווי היום'].includes(d.label)),
        ext: extFields(first, total, multi),
        actions: isEditMode && !multi ? deleteButton(first) : null,
        lots: multi
          ? stocks.map((stock, i) => ({
              key: String(stock.id),
              title: (
                <>
                  <span>{formatDate(stock.purchaseDate)}</span>
                  <bdi dir="ltr" className="hc-lot-qty">
                    {stock.quantity} × {formatPrice(stock.purchasePrice)}
                  </bdi>
                </>
              ),
              pl: <><Money value={lots[i].profit} signed /> <Pct value={lots[i].profitPercent} /></>,
              details: lotDetails(stock, lots[i]),
              ext: extFields(stock, lots[i], false),
              actions: isEditMode ? deleteButton(stock) : null
            }))
          : null
      };
    });
    return (
      <div className="stocks-section holdings-cards-section">
        <div className="holdings-section-head">
          <h2 className="section-title">בורסה ישראלית</h2>
          <HoldingsViewToggle view={view} onChange={setView} />
        </div>
        <HoldingCards items={items} showExtended={showAdditionalData} label="בורסה ישראלית" />
      </div>
    );
  }

  // ---------- the table ----------
  const headers = [
    COL.name,
    COL.date,
    COL.quantity,
    showAdditionalData && COL.sector,
    COL.price,
    COL.value,
    COL.profit,
    COL.daily,
    showAdditionalData && COL.index,
    showAdditionalData && COL.real,
    showAdditionalData && COL.tax,
    isEditMode && COL.actions
  ].filter(Boolean);
  const cellProps = { pending: pricesPending, showAdditionalData, formatPrice };

  return (
    <div className="stocks-section">
      <div className="holdings-section-head">
        <h2 className="section-title">בורסה ישראלית</h2>
        {compact && <HoldingsViewToggle view={view} onChange={setView} />}
      </div>
      <ScrollableTable label="בורסה ישראלית">
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
                  {showAdditionalData && (
                    <td>
                      <SectorValue stock={stock} />
                    </td>
                  )}
                  <FigureCells f={total} buyPrice={priceField(stock)} {...cellProps} />
                  {isEditMode && <td>{deleteButton(stock)}</td>}
                </tr>
              );
            }
            const isExpanded = expandedGroups[`israeli-${stockName}`];
            return (
              <React.Fragment key={stockName}>
                <tr className={`${isEditMode ? 'editable-row' : ''} ${isExpanded ? 'summary-row-expanded' : ''}`}>
                  <td
                    onClick={() => handleCellClick(stocks[0].id, 'stockName', 'israeli')}
                    className={isEditMode ? 'editable-cell' : ''}
                  >
                    <span className="name-cell">
                      <button
                        type="button"
                        onClick={() => toggleGroup(stockName, 'israeli')}
                        className="expand-button"
                        aria-expanded={Boolean(isExpanded)}
                        aria-label={isExpanded ? 'סגירת הקניות' : 'פתיחת הקניות'}
                      >
                        {isExpanded ? '▾' : '◂'}
                      </button>
                      <span>
                        <IsraeliAssetCell stock={stocks[0]} />
                        <span className="lots-count">{stocks.length} קניות</span>
                      </span>
                    </span>
                  </td>
                  <td title={PER_LOT_TITLE}>{PER_LOT}</td>
                  <td>{total.quantity}</td>
                  {showAdditionalData && (
                    <td>
                      <SectorValue stock={stocks[0]} />
                    </td>
                  )}
                  <FigureCells f={total} buyPrice={formatPrice(total.purchasePrice)} isGroup {...cellProps} />
                  {isEditMode && <td></td>}
                </tr>
                {isExpanded &&
                  stocks.map((stock, i) => (
                    <tr key={stock.id} className={`${isEditMode ? 'editable-row' : ''} detail-row`}>
                      {nameField(stock, 'td', { lot: true })}
                      {dateField(stock)}
                      {quantityField(stock)}
                      {showAdditionalData && (
                        <td>
                          <SectorValue stock={stock} />
                        </td>
                      )}
                      <FigureCells f={lots[i]} buyPrice={priceField(stock)} {...cellProps} />
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

export default IsraeliStocksTable;
