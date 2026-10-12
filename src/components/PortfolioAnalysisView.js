import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  ComposedChart,
  Line,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend
} from 'recharts';
import { getChartTheme, tooltipStyles, AREA_GRADIENT_ID } from '../utils/chartTheme';
import {
  buildSeriesFromHistoricalValues,
  computeStatsFromSeries,
  summarizePartialPoints
} from '../utils/portfolioStats';
import { buildPortfolioCashFlows } from '../utils/portfolioCashFlows';
import { expandHoldingsWithClosedLots } from '../shared/transactionLedger';
import { computeExactTwr, computeMoneyWeightedReturn } from '../utils/performanceReturns';
import { buildComparisonSeries, benchmarkPointsInILS } from '../utils/benchmarkComparison';
import {
  MARKET_SEGMENTS,
  FX_MODES,
  DEFAULT_SEGMENT,
  defaultFxModeForSegment,
  segmentSupportsFxToggle,
  resolveFxMode,
  selectSegmentHoldings,
  isSegmentEmpty,
  describeSelection,
  benchmarksForSegment,
  resolveBenchmarkForSegment,
  benchmarkCurrency
} from '../utils/portfolioSegments';
import { computeSectorDistribution } from '../utils/sectorAnalysis';
import { sectorLabelHe } from '../utils/sectorLabels';
import { computeReceivedDividends } from '../utils/dividendAnalysis';
import {
  recommendationLabelHe,
  recommendationSentiment,
  computeUpsidePercent,
  actionLabelHe,
  formatEpochDateISO
} from '../utils/analystData';
import { useBenchmarkHistory } from '../hooks/useBenchmarkHistory';
import { useStockSectors } from '../hooks/useStockSectors';
import { useAnalystRecommendations } from '../hooks/useAnalystRecommendations';
import { useDividendData } from '../hooks/useDividendData';
import { useHistoricalPortfolioValue } from '../hooks/useHistoricalPortfolioValue';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { layoutSliceCallouts, makeTextMeasurer, wrapLabel } from '../utils/pieCalloutLayout';
import { formatDate } from '../utils/formatters';
import {
  computeFirstStockPurchaseDate,
  formatMonthLabel,
  todayISO,
  startDateForPeriod,
  periodKeyForRange,
  RETURN_PERIODS,
  DEFAULT_RETURN_PERIOD
} from '../utils/portfolioDates';
import PageToolbar from './PageToolbar';
import RebalancingSection from './RebalancingSection';
import BetaBanner from './BetaBanner';


// In-page sidebar nav (same sectionRefs/scrollToSection mechanics as
// StockResearchView.js's sidebar, and reusing its .sw-layout/.sw-sidebar/
// .sw-main CSS as-is - those are already theme-aware, page-agnostic
// classes, not scoped to .sw-page).
//
// Grouped by what the reader is asking, in the order the page answers it:
// how did the portfolio do, what is it made of, what do the American
// holdings pay and what are they worth, and what should be done about any
// of it. The monthly tracker and the tax-loss calculator used to sit in
// this list; both are tasks rather than read-outs and now have their own
// pages in the main sidebar.
// The tab strip's contents. Still grouped, because the order carries an
// argument - how did it do, what is it made of, what do the American
// holdings pay, what should be done about it - but the group names are now
// separators in the strip rather than headings above a column.
//
// Labels are shorter than the section headings they lead to: a tab is a
// signpost read at a glance, and the heading it lands on says the full
// thing. The icons carry the grouping visually once the labels shorten.
const NAV_GROUPS = [
  {
    label: 'ביצועים',
    items: [
      { key: 'summary', label: 'תקציר', icon: '◈' },
      // The benchmark comparison used to be a section of its own further
      // down the page. It is now an overlay on the performance chart, so
      // the two are one destination rather than two.
      { key: 'performance', label: 'ביצועים לאורך זמן', icon: '◷' }
    ]
  },
  {
    label: 'פיזור התיק',
    items: [
      { key: 'pie', label: 'פיזור התיק', icon: '◑' },
      { key: 'sector', label: 'סקטורים', icon: '◐' },
      { key: 'byStock', label: 'לפי מניות', icon: '▤' },
      { key: 'byDate', label: 'לפי תאריכים', icon: '▦' }
    ]
  },
  {
    label: 'מניות אמריקאיות',
    items: [
      { key: 'dividends', label: 'דיבידנדים', icon: '$' },
      { key: 'analysts', label: 'אנליסטים', icon: '★' }
    ]
  },
  {
    label: 'כלים ודוחות',
    items: [
      { key: 'reports', label: 'דוחות', icon: '▣' },
      { key: 'rebalancing', label: 'איזון מחדש', icon: '⇄' }
    ]
  }
];

// Every section key the strip can point at, in the order they appear on
// the page - used to resolve which tab is current.
const NAV_KEYS = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.key));

const EMPTY_TRANSACTIONS = [];

function PortfolioAnalysisView({
  analysis,
  formatPriceWithSign,
  // Daily value snapshots are no longer what performance is computed from
  // (see the dynamic series below) - they're kept as a prop because the
  // benchmark comparison and the auto-snapshot mechanism still revolve
  // around them, and removing them from the API would be a larger change
  // than this section needs.
  americanStocks = [],
  israeliStocks = [],
  pensionFunds = [],
  // Needed by the dynamic performance series so the curve covers the whole
  // portfolio, not only the traded holdings (see
  // utils/historicalPortfolioValue.js).
  cashFunds = [],
  bankBalances = [],
  bankSavingsFunds = [],
  // The transactions ledger. Sales recorded there come back into the
  // performance history as closed slices (held until the sale date) and
  // their proceeds as outflows, so a sale is never charted as a loss.
  transactions = EMPTY_TRANSACTIONS,
  cpi = null,
  rebalanceTargets = null,
  rebalanceTargetsLoading = false,
  rebalanceSaving = false,
  rebalanceSaveError = '',
  onSaveRebalanceTargets,
  // Charts render SVG, whose presentation attributes can't read CSS
  // variables - so their colors are resolved from the active theme in JS
  // (see utils/chartTheme.js) and re-applied whenever it changes.
  theme = 'dark'
}) {
  const chart = useMemo(() => getChartTheme(theme), [theme]);
  const chartTooltip = useMemo(() => tooltipStyles(theme), [theme]);
  const SECTOR_COLORS = chart.categorical;

  // THE DISTRIBUTION DONUTS ON A PHONE.
  //
  // The full callouts (name, amount, share) need ~116px of margin on each
  // side, which on a phone leaves the ring a few dozen pixels across. So a
  // narrow screen gets COMPACT callouts instead: name and share only, in
  // smaller type, on a shorter leader. The amount is still in the legend
  // card under each chart, whose swatch matches the slice colour.
  const isNarrowScreen = useMediaQuery('(max-width: 768px)');
  const donutLayout = useMemo(
    () =>
      isNarrowScreen
        ? {
            compact: true,
            height: 300,
            margin: { top: 16, right: 100, bottom: 16, left: 100 },
            outerRadius: '90%',
            innerRadius: '64%'
          }
        : {
            compact: false,
            height: 360,
            margin: { top: 20, right: 116, bottom: 20, left: 116 },
            outerRadius: '58%',
            innerRadius: '42%'
          },
    [isNarrowScreen]
  );
  // PERFORMANCE OVER TIME - computed on the fly, not read back from saved
  // snapshots.
  //
  // The whole section is driven by one date range. For every sampled date
  // in it the portfolio is valued from real historical closing prices for
  // exactly the holdings it contained on that date (see
  // utils/historicalPortfolioValue.js). Narrowing the range re-computes
  // it; nothing is stored, so there is no saved figure that can go stale
  // or disagree with the holdings.
  //
  // The range opens on year-to-date rather than on the whole history: the
  // question a portfolio is opened with is nearly always "how is it doing
  // this year", and starting on everything meant a first paint that
  // fetched every year back to the first purchase to answer a question
  // nobody asked.
  //
  // The return figures and the annualized-volatility estimate below are
  // all read off this same series, which is what makes them consistent
  // with each other and with the chart.
  const todayDate = useMemo(() => todayISO(), []);

  // '' means "back to the first purchase" - so that range keeps tracking
  // inception as holdings are added, rather than pinning a date.
  const [performanceFrom, setPerformanceFrom] = useState(() =>
    startDateForPeriod(DEFAULT_RETURN_PERIOD)
  );
  const [performanceTo, setPerformanceTo] = useState('');

  // A date input is NOT a single-value control: it fires onChange on every
  // keystroke while the year is being typed. Typing "2023" emits "0002",
  // "0020" and "0202" first, so the raw input value is briefly a date
  // centuries in the past. Every one of those intermediate values used to
  // be committed straight through to the fetch + recompute below, which is
  // what froze the page (see buildSampleDates' own note).
  //
  // So a typed value is only accepted once it's actually a usable date.
  // Anything else leaves the previously committed range in place: the user
  // keeps typing, the chart keeps showing the last good range, and nothing
  // is recomputed until they've finished.
  const isCommittableDate = useCallback(
    (value) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
      const time = new Date(`${value}T00:00:00Z`).getTime();
      if (Number.isNaN(time)) return false;
      // No market data exists before this, and nothing after today can be
      // priced - both bounds also keep a half-typed year out.
      return value >= '1970-01-01' && value <= todayDate;
    },
    [todayDate]
  );

  const handlePerformanceFromChange = useCallback(
    (value) => {
      if (value === '') {
        setPerformanceFrom('');
        return;
      }
      if (isCommittableDate(value)) setPerformanceFrom(value);
    },
    [isCommittableDate]
  );

  const handlePerformanceToChange = useCallback(
    (value) => {
      if (value === '') {
        setPerformanceTo('');
        return;
      }
      if (isCommittableDate(value)) setPerformanceTo(value);
    },
    [isCommittableDate]
  );

  // The quick period toggles (see RETURN_PERIODS). Each one sets the same
  // two dates the inputs set, rather than being a third source of truth
  // beside them - so a toggle and a typed range cannot disagree, and the
  // highlighted button is derived from the dates rather than remembered.
  const selectReturnPeriod = useCallback(
    (periodKey) => {
      setPerformanceFrom(startDateForPeriod(periodKey, todayDate));
      // Every one of these periods ends today; leaving the end open is
      // what keeps it following the clock rather than freezing on the day
      // the button was pressed.
      setPerformanceTo('');
    },
    [todayDate]
  );

  const activeReturnPeriod = periodKeyForRange(performanceFrom, performanceTo || todayDate, todayDate);

  // WHAT THE CURVE IS ABOUT - see utils/portfolioSegments.js.
  //
  // Equities across both markets by default. Including the non-equity
  // accounts by default made the chart answer a question almost nobody was
  // asking it: idle cash sits in both ends of every sub-period and drags
  // each percentage toward zero, so stock performance was reported diluted
  // by whatever happened to be in the current account.
  const [marketSegment, setMarketSegment] = useState(DEFAULT_SEGMENT);

  // Whether the American side's return should carry the currency move.
  // Meaningful wherever there are US holdings in the selection - the US
  // view and the combined one (see resolveFxMode).
  //
  // Kept PER SEGMENT rather than as one shared setting, because the two
  // views open on different answers (see defaultFxModeForSegment) and a
  // single value would have to pick one of them for both. Switching market
  // and switching back therefore also returns the toggle to where the user
  // left it, instead of resetting a choice they made deliberately.
  const [fxModeBySegment, setFxModeBySegment] = useState({});
  const requestedFxMode = fxModeBySegment[marketSegment] ?? defaultFxModeForSegment(marketSegment);
  const fxMode = resolveFxMode(marketSegment, requestedFxMode);
  const showFxToggle = segmentSupportsFxToggle(marketSegment);
  const setRequestedFxMode = (mode) =>
    setFxModeBySegment((prev) => ({ ...prev, [marketSegment]: mode }));

  // History, not the current position: the open lots plus the units that
  // recorded sales closed (shared/transactionLedger.js). Everything below
  // that values the PAST reads these; anything about what is held NOW keeps
  // reading israeliStocks/americanStocks directly.
  const historyStocks = useMemo(
    () => expandHoldingsWithClosedLots({ israeliStocks, americanStocks }, transactions),
    [israeliStocks, americanStocks, transactions]
  );

  const segmentHoldings = useMemo(
    () => selectSegmentHoldings(historyStocks, marketSegment),
    [historyStocks, marketSegment]
  );

  // WHERE "הכל" STARTS.
  //
  // Derived from the SELECTED SEGMENT'S OWN HOLDINGS, which are shares and
  // nothing else. The whole-portfolio inception was what this used to read,
  // and that includes deposits into provident funds, bank savings and cash
  // accounts - none of which this chart values. A provident-fund deposit
  // years before the first share was bought therefore opened the stock
  // curve on a date with no stocks in it, and every figure below claimed to
  // be measured from there.
  //
  // Per-segment rather than "first stock anywhere" for the same reason:
  // switching to the Israeli market should start at the first Israeli
  // purchase, not at an American one that the curve does not contain.
  const segmentInceptionDate = useMemo(
    () => computeFirstStockPurchaseDate(segmentHoldings),
    [segmentHoldings]
  );

  // THE SINGLE RATE used when the currency move is being excluded.
  //
  // WHICH rate barely matters, and that is worth being explicit about: a
  // constant multiplier cancels out of every ratio, so ANY positive
  // constant yields exactly the same pure-dollar return. The choice only
  // sets the SCALE the curve is drawn on, i.e. what the shekel amounts on
  // the axis read as.
  //
  // So it is taken from the rate the app already holds against the
  // positions - the live rate the tables are showing - which makes the
  // curve's figures agree with the portfolio's current value elsewhere in
  // the app. Deliberately NOT read from the fetched FX history: that
  // history arrives from the very hook this value is passed into, and
  // feeding its output back into its input is a cycle with no fixed point.
  //
  // Null when there is no rate at all, in which case the valuation keeps
  // using historical rates rather than inventing one.
  const currentExchangeRate = useMemo(() => {
    const rates = (americanStocks || [])
      .map((lot) => Number(lot.currentExchangeRate) || Number(lot.exchangeRate))
      .filter((rate) => Number.isFinite(rate) && rate > 0);
    return rates.length ? rates[rates.length - 1] : null;
  }, [americanStocks]);

  const fixedExchangeRate = fxMode === FX_MODES.PURE_USD ? currentExchangeRate : null;

  const segmentIsEmpty = useMemo(() => isSegmentEmpty(segmentHoldings), [segmentHoldings]);

  // Which indices this market can sensibly be measured against. Holding an
  // Israeli equity curve up against the S&P 500 compares two different
  // markets in two different currencies and calls the difference
  // performance, so each segment offers its own list.
  const [benchmarkKey, setBenchmarkKey] = useState(
    () => benchmarksForSegment(DEFAULT_SEGMENT)[0].key
  );
  const benchmarkOptions = useMemo(() => benchmarksForSegment(marketSegment), [marketSegment]);

  // The benchmark is an overlay on the performance chart rather than a
  // second chart below it, so the two lines share one canvas, one date
  // range and one set of market/currency toggles instead of being compared
  // by scrolling between them.
  //
  // Off by default, which also keeps its price history off the critical
  // path: nothing is fetched for it until someone asks to see it.
  const [showBenchmark, setShowBenchmark] = useState(false);

  // Switching market keeps the chosen index when the new market also offers
  // it (moving between "all" and "American" should not reset an S&P
  // comparison), and falls back to that market's primary anchor when it
  // does not. Derived rather than stored, so the two can never disagree.
  const selectedBenchmarkKey = resolveBenchmarkForSegment(marketSegment, benchmarkKey);
  const selectedBenchmarkCurrency = benchmarkCurrency(marketSegment, selectedBenchmarkKey);
  const selectedBenchmarkLabel =
    benchmarkOptions.find((b) => b.key === selectedBenchmarkKey)?.label || '';
  const benchmarkNeedsFx = selectedBenchmarkCurrency === 'USD';

  // Whether the window is narrower than the segment's whole history. The
  // raw state is what says so: '' means "track the first purchase and
  // today", and the effective dates below are resolved values that cannot
  // tell the two apart.
  const isRangeNarrowed = Boolean(performanceFrom || performanceTo);

  const effectivePerformanceFrom = performanceFrom || segmentInceptionDate;
  // A range whose start is after its end produces nothing to chart, and is
  // easy to reach mid-edit (narrowing "from" before widening "to"). The
  // two are swapped rather than blanking the section out.
  const effectivePerformanceTo =
    performanceTo && performanceTo < effectivePerformanceFrom
      ? effectivePerformanceFrom
      : performanceTo || todayDate;

  const {
    series: performanceSeries,
    loading: performanceLoading,
    error: performanceError,
    // The raw fetched closes. Only the USD/ILS history is read here, to
    // restate a dollar-quoted benchmark in shekels.
    //
    // breakdownAtDate is not read at all any more - the monthly tracker
    // was its only consumer, and values its own months on its own page.
    priceData
  } = useHistoricalPortfolioValue({
    fromDate: effectivePerformanceFrom,
    toDate: effectivePerformanceTo,
    ...segmentHoldings,
    // See the option's own note: this is a performance series, so a ledger
    // account is worth nothing until there is evidence of it, and
    // portfolioCashFlows below declares the balance that then appears.
    anchorLedgerAccountsToFirstRecord: true,
    // The rate history is needed for two independent reasons: to restate a
    // dollar-quoted index in shekels, and to find the single rate the
    // pure-dollar view converts at. The first only applies while the
    // benchmark overlay is actually on.
    needsFxHistory: (showBenchmark && benchmarkNeedsFx) || fxMode === FX_MODES.PURE_USD,
    americanExchangeRate: fixedExchangeRate
  });

  // Every dated deposit/purchase the app knows about, so the return figures
  // below measure the assets' own performance rather than how much money
  // was paid in (see utils/portfolioCashFlows.js).
  // includeLedgerOpeningBalances pairs with the valuation option the
  // series is built with (useHistoricalPortfolioValue passes
  // anchorLedgerAccountsToFirstRecord). The two have to agree: the series
  // values a ledger account at 0 until the app has evidence of it, so the
  // balance that then appears must be declared as a contribution or the
  // return books it as a gain.
  // Built from the SAME selection the series is valued from, which is what
  // isolates one market's flows from another's: a segment holding no
  // American lots produces no American purchase flows, so a US trade cannot
  // perturb a sub-period of the Israeli curve.
  const portfolioCashFlows = useMemo(
    () =>
      buildPortfolioCashFlows({
        ...segmentHoldings,
        includeLedgerOpeningBalances: true,
        // Same rate the holdings are valued at, or the contribution and the
        // value change it caused would not cancel.
        americanExchangeRate: fixedExchangeRate,
        // Sale proceeds and dividends of the symbols in this segment.
        transactions
      }),
    [segmentHoldings, fixedExchangeRate, transactions]
  );

  const stats = useMemo(
    () => computeStatsFromSeries(buildSeriesFromHistoricalValues(performanceSeries), portfolioCashFlows),
    [performanceSeries, portfolioCashFlows]
  );
  // The two figures that sit beside the headline TWR (see
  // utils/performanceReturns.js): the EXACT time-weighted return, which
  // breaks the chain at every flow date instead of approximating flows
  // inside weekly samples, and the money-weighted return (XIRR), which
  // keeps the timing of the money in. Measured over the same span the
  // chart shows.
  const exactReturns = useMemo(() => {
    if (!stats.hasHistory) return null;
    const options = { americanExchangeRate: fixedExchangeRate };
    const exactTwr = computeExactTwr({
      fromDate: stats.firstDate,
      toDate: stats.lastDate,
      holdings: segmentHoldings,
      priceData,
      cashFlows: portfolioCashFlows,
      options
    });
    const mwr = computeMoneyWeightedReturn({
      fromDate: stats.firstDate,
      toDate: stats.lastDate,
      startValue: stats.series[0].value,
      endValue: stats.series[stats.series.length - 1].value,
      cashFlows: portfolioCashFlows
    });
    return { exactTwr, mwr };
  }, [stats, segmentHoldings, priceData, portfolioCashFlows, fixedExchangeRate]);

  // Dates that could not be valued in full are left out of the curve
  // rather than drawn as a partial sum (see buildSeriesFromHistoricalValues);
  // this is what lets the page say so, and name the holdings responsible.
  const skippedPartial = useMemo(() => summarizePartialPoints(performanceSeries), [performanceSeries]);

  const americanSymbols = useMemo(() => americanStocks.map((s) => s.stockName), [americanStocks]);
  const { sectorBySymbol, loading: sectorsLoading } = useStockSectors(americanSymbols);
  const sectorDistribution = useMemo(
    () => computeSectorDistribution(americanStocks, sectorBySymbol, israeliStocks),
    [americanStocks, sectorBySymbol, israeliStocks]
  );

  // One row per unique American ticker (a stock bought in several lots
  // shares the same live price/analyst data), sorted by current value so
  // the largest holdings show up first.
  const uniqueAmericanHoldings = useMemo(() => {
    const bySymbol = new Map();
    americanStocks.forEach((stock) => {
      const symbol = String(stock.stockName || '').trim().toUpperCase();
      if (!symbol) return;
      const existing = bySymbol.get(symbol);
      const valueILS = (stock.currentPrice || 0) * (stock.quantity || 0) * (stock.currentExchangeRate || stock.exchangeRate || 0);
      if (!existing) {
        bySymbol.set(symbol, { symbol, currentPrice: stock.currentPrice || null, valueILS });
      } else {
        existing.valueILS += valueILS;
        if (!existing.currentPrice && stock.currentPrice) existing.currentPrice = stock.currentPrice;
      }
    });
    return [...bySymbol.values()].sort((a, b) => b.valueILS - a.valueILS);
  }, [americanStocks]);

  const { recommendationsBySymbol, loading: analystLoading } = useAnalystRecommendations(americanSymbols);

  const uniqueAmericanSymbols = useMemo(() => uniqueAmericanHoldings.map((h) => h.symbol), [uniqueAmericanHoldings]);

  // Grouped by symbol (not deduped like uniqueAmericanHoldings) because
  // computeReceivedDividends needs each lot's own quantity/purchaseDate,
  // not just the aggregated current value.
  const lotsBySymbol = useMemo(() => {
    const map = new Map();
    americanStocks.forEach((stock) => {
      const symbol = String(stock.stockName || '').trim().toUpperCase();
      if (!symbol) return;
      if (!map.has(symbol)) map.set(symbol, []);
      map.get(symbol).push({ quantity: stock.quantity || 0, purchaseDate: stock.purchaseDate || null });
    });
    return map;
  }, [americanStocks]);

  const earliestAmericanPurchaseDate = useMemo(
    () =>
      americanStocks.reduce((earliest, stock) => {
        if (!stock.purchaseDate) return earliest;
        return !earliest || stock.purchaseDate < earliest ? stock.purchaseDate : earliest;
      }, null),
    [americanStocks]
  );

  const { dividendsBySymbol, loading: dividendsLoading } = useDividendData(
    uniqueAmericanSymbols,
    earliestAmericanPurchaseDate
  );

  const dividendRows = useMemo(
    () =>
      uniqueAmericanHoldings.map((holding) => {
        const data = dividendsBySymbol[holding.symbol];
        const lots = lotsBySymbol.get(holding.symbol) || [];
        const quantityHeld = lots.reduce((sum, lot) => sum + (lot.quantity || 0), 0);
        return {
          symbol: holding.symbol,
          dividendRate: data?.dividendRate ?? null,
          dividendYieldPercent: data?.dividendYieldPercent ?? null,
          payoutRatio: data?.payoutRatio ?? null,
          nextDate: data
            ? formatEpochDateISO(data.nextDividendDateEpoch) || formatEpochDateISO(data.exDividendDateEpoch)
            : null,
          receivedUSD: data ? computeReceivedDividends(data.history, lots) : 0,
          // Forward-looking, unlike receivedUSD above (historical/actual
          // payments already collected) - dividendRate (Yahoo's trailing
          // annual $/share) times the quantity currently held, not tied to
          // any particular past payment date.
          projectedAnnualUSD: data?.dividendRate != null ? data.dividendRate * quantityHeld : null
        };
      }),
    [uniqueAmericanHoldings, dividendsBySymbol, lotsBySymbol]
  );

  const totalProjectedAnnualUSD = useMemo(
    () => dividendRows.reduce((sum, row) => sum + (row.projectedAnnualUSD || 0), 0),
    [dividendRows]
  );

  const totalReceivedUSD = useMemo(
    () => dividendRows.reduce((sum, row) => sum + row.receivedUSD, 0),
    [dividendRows]
  );


  // The rebalancing PLAN used to be computed here purely to feed the
  // portfolio health score's allocation-drift sub-score. With the health
  // score removed, the only thing that needs a plan is RebalancingSection
  // below, which computes its own from the targets it's given (including
  // an in-progress edit draft this component can't see anyway).

  const {
    points: rawBenchmarkPoints,
    loading: benchmarkLoading,
    error: benchmarkError
  } = useBenchmarkHistory(
    showBenchmark && stats.hasHistory ? selectedBenchmarkKey : null,
    stats.firstDate
  );

  // Restated in shekels when the index is quoted in dollars, so the line
  // the portfolio is held against is the return an Israeli investor would
  // actually have received from it - see benchmarkPointsInILS.
  const benchmarkPoints = useMemo(
    () => benchmarkPointsInILS(rawBenchmarkPoints, selectedBenchmarkCurrency, priceData.fxHistoricalCloses),
    [rawBenchmarkPoints, selectedBenchmarkCurrency, priceData.fxHistoricalCloses]
  );

  // A dollar index with no rate history behind it yet would otherwise
  // silently compare against nothing; this lets the section say so.
  const benchmarkAwaitingFx =
    benchmarkNeedsFx && rawBenchmarkPoints.length > 0 && benchmarkPoints.length === 0;

  // Held against the CASH-FLOW-NEUTRALIZED curve, not the raw value series.
  //
  // This was the bug in the comparison: the portfolio line was its shekel
  // value indexed to 100, so every deposit stepped it upward. An index only
  // ever moves on market returns, so paying ₪50,000 into a ₪100,000
  // portfolio drew a 50% jump and reported it as beating the market by 50
  // points. stats.twrIndexSeries is the same curve with contributions
  // removed (Modified Dietz per sub-period, chained) - the figure the
  // headline return has always used, now also what the chart draws.
  const comparisonSeries = useMemo(
    () => buildComparisonSeries(stats.twrIndexSeries, benchmarkPoints),
    [stats.twrIndexSeries, benchmarkPoints]
  );
  const comparisonLast = comparisonSeries.length ? comparisonSeries[comparisonSeries.length - 1] : null;

  // What the overlay is doing right now, as one of a few named states - the
  // chart needs to say "loading the index" or "no overlap" without a chain
  // of ternaries inlined in the JSX beside the chart itself.
  const benchmarkStatus = (() => {
    if (!showBenchmark) return null;
    if (benchmarkAwaitingFx) return `טוען את היסטוריית שער הדולר כדי להציג את ${selectedBenchmarkLabel} בשקלים…`;
    if (benchmarkLoading) return `טוען נתוני ${selectedBenchmarkLabel}…`;
    if (benchmarkError) return benchmarkError;
    if (comparisonSeries.length < 2) {
      return `עדיין אין מספיק חפיפה בין ההיסטוריה של התיק שלכם לנתוני ${selectedBenchmarkLabel} כדי להציג השוואה.`;
    }
    return null;
  })();

  const benchmarkOverlayReady = showBenchmark && !benchmarkStatus && comparisonSeries.length >= 2;

  // The chart's rows, always the neutralized curve. With the overlay on it
  // comes from the comparison, which re-bases both series to the first date
  // the benchmark also covers - so the two start together and any gap
  // between them afterwards is relative performance.
  const performanceChartData = useMemo(
    () =>
      benchmarkOverlayReady
        ? comparisonSeries
        : stats.twrIndexSeries.map((point) => ({
            date: point.date,
            portfolioIndexed: point.value
          })),
    [benchmarkOverlayReady, comparisonSeries, stats.twrIndexSeries]
  );

  // PURCHASE/DEPOSIT HISTORY - years first, months on demand.
  //
  // The two distributions used to sit side by side as flat lists, and the
  // monthly one grew by twelve rows a year until it was the longest thing
  // on the page while answering a question ("which months did I buy in,
  // four years ago?") that is rarely the one being asked. Years are the
  // summary; a year's months are one click away.
  const distributionYears = useMemo(() => analysis.yearlyDistribution || [], [analysis.yearlyDistribution]);

  const monthsByYear = useMemo(() => {
    return (analysis.monthlyDistribution || []).reduce((acc, item) => {
      // The month key is "YYYY-MM", so its year is its first segment - the
      // same string the yearly distribution is keyed by.
      const year = String(item.month || '').slice(0, 4);
      if (!year) return acc;
      (acc[year] = acc[year] || []).push(item);
      return acc;
    }, {});
  }, [analysis.monthlyDistribution]);

  // Nothing is open to begin with, so the section starts as the short
  // year-level summary it is meant to be.
  const [expandedYears, setExpandedYears] = useState({});
  const toggleDistributionYear = (year) =>
    setExpandedYears((prev) => ({ ...prev, [year]: !prev[year] }));

  // EXTERNAL CALLOUT LABELS for the two distribution charts.
  //
  // A donut whose slices are only identified in a legend beside it makes
  // the reader match six colours to six rows before they can read
  // anything. The callout puts all three facts on the slice's own leader
  // line instead - what it is, what it is worth, and what share of the
  // total that is - so the chart answers "what is the big one, and how
  // much is in it?" without a lookup.
  //
  // Two lines rather than one run-on string: the name is what identifies
  // the slice and the amount is what quantifies it, and at this size a
  // single line of all three runs past the margin the callouts live in.
  //
  // The leader is drawn here rather than left to recharts' own labelLine,
  // because that line stops at the slice's edge and the text sits further
  // out - leaving a gap the reader has to bridge on charts with several
  // small slices. This one runs from the slice to an elbow and then
  // horizontally into the text it belongs to, so which label belongs to
  // which slice is never in question.
  //
  // Slices under 3% are left unlabelled: below that the callouts collide
  // with each other and the chart becomes less readable, not more. Those
  // remain identifiable in the legend underneath, which is why it stays.
  //
  // Neighbouring labels are also spread apart vertically (see
  // utils/pieCalloutLayout.js): several small slices next to each other
  // would otherwise put their labels at nearly the same height on the rail,
  // printed through one another. That needs every slice's position, not
  // just this one's, which is why this is a factory over the chart's values
  // rather than a plain renderer.
  //
  // Long names wrap onto more lines instead of running off the chart: on a
  // phone there is only ~90px beside the ring, and "קופת חיסכון בבנק" does
  // not fit on one line in it. The wrap is measured, and every label's
  // spacing follows the tallest one.
  const measureCalloutName = useMemo(
    () => makeTextMeasurer(donutLayout.compact ? 11 : 13, 700),
    [donutLayout.compact]
  );
  const measureCalloutValue = useMemo(() => makeTextMeasurer(12, 500), []);
  const makeSliceCallout = useCallback(
    (items) => ({ cx, cy, midAngle, outerRadius, percent, name, value, index }) => {
      if (!percent || percent < 0.03) return null;
      const radian = Math.PI / 180;
      const angle = -midAngle * radian;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      const { compact } = donutLayout;
      const plotHalf = (donutLayout.height - donutLayout.margin.top - donutLayout.margin.bottom) / 2;
      const ELBOW_GAP = compact ? 8 : 12; // slice edge -> elbow
      const RAIL_GAP = compact ? 16 : 34; // ring edge -> rail
      const TEXT_GAP = compact ? 4 : 6; // rail -> first character
      const LINE_HEIGHT = compact ? 14 : 17;

      // The room beside the ring, the same on both sides: the margins are
      // symmetric, so the SVG is 2 * cx wide.
      const textRoom = cx - outerRadius - RAIL_GAP - TEXT_GAP - 4;
      const values = items.map((item) => item.value);
      const total = values.reduce((sum, v) => sum + (v > 0 ? v : 0), 0);
      // Name lines (bold), then the figures: the share alone on a phone;
      // amount and share on one line where they fit, or two where not.
      const linesFor = (label, amount, share) => {
        const pct = `${(share * 100).toFixed(1)}%`;
        const amountText = `${formatPriceWithSign(amount)} ₪`;
        const figures = compact
          ? [pct]
          : measureCalloutValue(`${amountText} · ${pct}`) <= textRoom
          ? [`${amountText} · ${pct}`]
          : [amountText, pct];
        return [
          ...wrapLabel(label, textRoom, measureCalloutName).map((text) => ({ text, bold: true })),
          ...figures.map((text) => ({ text, bold: false }))
        ];
      };
      const tallest = items.reduce(
        (most, item) =>
          total > 0 && item.value / total >= 0.03
            ? Math.max(most, linesFor(item.name, item.value, item.value / total).length)
            : most,
        2
      );
      // Half the label block's height, plus room for the glyphs themselves.
      const blockHalf = ((tallest - 1) / 2) * LINE_HEIGHT + 8;

      const placement = layoutSliceCallouts(values, {
        cy,
        outerRadius,
        paddingAngle: 1,
        elbowGap: ELBOW_GAP,
        gap: tallest * LINE_HEIGHT + 8,
        top: cy - plotHalf + blockHalf,
        bottom: cy + plotHalf - blockHalf
      })[index];
      if (!placement) return null;
      const { isRight, labelY } = placement;

      const lines = linesFor(name, value, percent);

      // THE LABEL RAIL.
      //
      // Every label on a side shares one x, a fixed distance beyond the
      // ring, and the leader runs horizontally from the slice out to it.
      //
      // The labels used to be placed at their own angle - a little way
      // past the slice along its own radius - which put the ones near
      // the top and bottom of the circle almost directly above and below
      // the centre, printed straight over the ring. A rail cannot do
      // that: it is outside the widest point of the ring by
      // construction, so no label can land on the donut whatever angle
      // its slice sits at.
      //
      // It also lines the labels up with each other, which is what makes
      // several of them readable as a set rather than as text scattered
      // around a circle.

      const startX = cx + outerRadius * cos;
      const startY = cy + outerRadius * sin;
      const elbowX = cx + (outerRadius + ELBOW_GAP) * cos;
      const elbowY = cy + (outerRadius + ELBOW_GAP) * sin;
      const railX = isRight ? cx + outerRadius + RAIL_GAP : cx - outerRadius - RAIL_GAP;
      const textX = isRight ? railX + TEXT_GAP : railX - TEXT_GAP;

      // TEXT-ANCHOR IS RESOLVED AGAINST THE READING DIRECTION, and this
      // document is RTL - so `start` pins the text's RIGHT edge and
      // `end` pins its LEFT edge, the opposite of the LTR intuition.
      //
      // Getting this backwards is what put the labels back on top of the
      // donut even after they were moved out to the rail: a label on the
      // right of the chart was pinned by its right edge and grew leftwards
      // across the ring, and the one on the left grew rightwards into it.
      // What is wanted is the edge NEAREST the chart pinned to the rail,
      // so the label always grows away from the centre.
      const textAnchor = isRight ? 'end' : 'start';

      return (
        <g>
          <polyline
            points={`${startX},${startY} ${elbowX},${elbowY} ${railX},${labelY}`}
            stroke={chart.grid}
            strokeWidth={1.2}
            fill="none"
          />
          {/* Marks the slice the label describes - the end of the line the
              reader's eye follows back to check it. */}
          <circle cx={startX} cy={startY} r={2.2} fill={chart.grid} />
          {/* One <text> PER LINE, each at its own explicit y, LINE_HEIGHT
              apart and centred as a block on the label's height.

              Not one <text> with a <tspan> per line: iOS Safari lays out
              absolutely positioned tspans inside RTL text as a single run,
              so it printed the percentage on the name's line and broke
              the name mid-word ("קופו" / "ת גמל"). Separate elements have
              no shared run to reorder. */}
          {lines.map((line, i) => (
            <text
              key={i}
              x={textX}
              y={labelY + (i - (lines.length - 1) / 2) * LINE_HEIGHT}
              fill={chart.axis}
              textAnchor={textAnchor}
              dominantBaseline="central"
              direction="rtl"
              fontSize={compact ? 11 : line.bold ? 13 : 12}
              fontWeight={line.bold ? 700 : 500}
            >
              {line.text}
            </text>
          ))}
        </g>
      );
    },
    [chart.axis, chart.grid, formatPriceWithSign, donutLayout, measureCalloutName, measureCalloutValue]
  );

  const sectionRefs = useRef({});
  const scrollToSection = (key) => {
    sectionRefs.current[key]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Which tab is current, from which section is actually on screen. A tab
  // strip that never marks one is just a row of buttons - the highlight is
  // what makes it a position indicator as well as a shortcut.
  //
  // Guarded on IntersectionObserver rather than assumed: it does not exist
  // in jsdom, and the strip has to keep working as plain navigation
  // wherever it is missing.
  const [activeSection, setActiveSection] = useState(NAV_KEYS[0]);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible?.target?.dataset?.sectionKey) {
          setActiveSection(visible.target.dataset.sectionKey);
        }
      },
      // Biased to the upper part of the viewport: the section a reader is
      // looking at is the one at the top of the screen, not whichever
      // happens to cover the most pixels.
      { rootMargin: '-80px 0px -60% 0px', threshold: 0 }
    );
    NAV_KEYS.forEach((key) => {
      const element = sectionRefs.current[key];
      if (element) observer.observe(element);
    });
    return () => observer.disconnect();
  }, []);

  // The portfolio donut's slices, one per asset class, in the order of the
  // palette its legend reads its swatches from.
  const portfolioPieData = [
    {
      name: 'בורסה ישראלית',
      value: analysis.exchangeDistribution.israeli.value,
      percentage: analysis.exchangeDistribution.israeli.percentage
    },
    {
      name: 'בורסה אמריקאית',
      value: analysis.exchangeDistribution.american.value,
      percentage: analysis.exchangeDistribution.american.percentage
    },
    {
      name: 'קופות גמל',
      value: analysis.exchangeDistribution.pension.value,
      percentage: analysis.exchangeDistribution.pension.percentage
    },
    {
      name: 'קרנות כספיות',
      value: analysis.exchangeDistribution.cashFunds.value,
      percentage: analysis.exchangeDistribution.cashFunds.percentage
    },
    {
      name: 'עו"ש',
      value: analysis.exchangeDistribution.bank.value,
      percentage: analysis.exchangeDistribution.bank.percentage
    },
    {
      name: 'קופת חיסכון בבנק',
      value: analysis.exchangeDistribution.bankSavings.value,
      percentage: analysis.exchangeDistribution.bankSavings.percentage
    }
  ];

  return (
    <div className="App">
      <div className="analysis-container">
        <div className="analysis-content">
          <PageToolbar
            title="ניתוח תיק"
            subtitle="ביצועים, פיזור והמלצות - תמונה מעמיקה של התיק"
          />

          <BetaBanner tone="tax" />

          {/* Section navigation as a horizontal tab strip rather than a
              column beside the content. As a sidebar it took ~210px of the
              page permanently to list ten links to things already on it,
              and it duplicated the group headings that the sections carry
              themselves. Along the top it costs one row, scrolls sideways
              when it has to, and leaves the grid its full width.
              The groups survive as separators inside the strip, so the
              order still reads performance / composition / US / tools. */}
          <nav className="analysis-tabs" aria-label="מעבר לסעיף">
            {NAV_GROUPS.map((group, groupIndex) => (
              <React.Fragment key={group.label}>
                {groupIndex > 0 && <span className="analysis-tabs-divider" aria-hidden="true" />}
                {group.items.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className={`analysis-tab ${activeSection === item.key ? 'active' : ''}`}
                    aria-current={activeSection === item.key ? 'true' : undefined}
                    onClick={() => scrollToSection(item.key)}
                  >
                    <span className="analysis-tab-icon" aria-hidden="true">
                      {item.icon}
                    </span>
                    {item.label}
                  </button>
                ))}
              </React.Fragment>
            ))}
          </nav>

          <div className="analysis-grid">
          <div className="analysis-section" data-section-key="summary" ref={(el) => (sectionRefs.current.summary = el)}>
            <h2 className="section-title">תקציר ניתוח</h2>
            <div className="distribution-grid">
              <div className="distribution-card">
                <h3>מספר פוזיציות</h3>
                <div className="distribution-value">{analysis.summaryMetrics.positionsCount}</div>
                <div className="distribution-percentage">
                  ישראליות: {analysis.summaryMetrics.israeliPositions} | אמריקאיות: {analysis.summaryMetrics.americanPositions}
                </div>
                <div className="distribution-percentage">
                  גמל: {analysis.summaryMetrics.pensionPositions} | כספית: {analysis.summaryMetrics.cashFundsPositions} | עו"ש: {analysis.summaryMetrics.bankPositions}
                </div>
              </div>
              <div className="distribution-card">
                <h3>שינוי יומי משוקלל</h3>
                <div className={`distribution-value ${analysis.summaryMetrics.weightedDailyChangePercent >= 0 ? 'profit-positive' : 'profit-negative'}`}>
                  {analysis.summaryMetrics.weightedDailyChangePercent.toFixed(2)}%
                </div>
                <div className="distribution-percentage">
                  תשואה שנתית משוקללת: {analysis.summaryMetrics.weightedAnnualizedReturnPercent.toFixed(2)}%
                </div>
              </div>
              <div className="distribution-card">
                <h3>ריכוזיות 3 פוזיציות</h3>
                <div className="distribution-value">
                  {analysis.summaryMetrics.concentrationTop3Percent.toFixed(1)}%
                </div>
                <div className="distribution-percentage">
                  זמן החזקה ממוצע: {analysis.summaryMetrics.averageHoldingDays} ימים
                </div>
              </div>
            </div>
          </div>

          <div className="analysis-section" data-section-key="performance" ref={(el) => (sectionRefs.current.performance = el)}>
            <h2 className="section-title">ביצועי התיק לאורך זמן</h2>

            {/* HOW THE NUMBER IS MADE, in four steps.
                This replaces a paragraph that said the same things in
                prose. A method is a sequence, and a reader checking
                whether a figure means what they think has to find one
                step in it - which a block of text makes them re-read the
                whole thing to do. */}
            <ol className="calc-guide">
              <li className="calc-guide-step">
                <span className="calc-guide-title">שערי סגירה אמיתיים</span>
                <span className="calc-guide-text">
                  התיק מוערך מחדש בכל תאריך לפי שערי הסגירה בפועל (תל אביב, וול סטריט ושער הדולר) ולפי ההחזקות
                  שהיו בו באותו יום - לא מתוך נתונים שנשמרו מראש.
                </span>
              </li>
              <li className="calc-guide-step">
                <span className="calc-guide-title">נטרול הפקדות ומשיכות</span>
                <span className="calc-guide-text">
                  הטווח מחולק לתת-תקופות בכל תאריך שנכנס או יצא בו כסף. הפקדה מגדילה שווי בלי שההחזקות הרוויחו
                  דבר, ולכן היא מנוכה מהחישוב ולא נספרת כתשואה.
                </span>
              </li>
              <li className="calc-guide-step">
                <span className="calc-guide-title">שרשור התקופות (TWR)</span>
                <span className="calc-guide-text">
                  כל תת-תקופה נמדדת בנפרד (Modified Dietz) והתוצאות מוכפלות זו בזו. כך גודל ההפקדות ותזמונן אינם
                  משפיעים על התשואה - מה שנמדד הוא ביצועי הנכסים בלבד.
                </span>
              </li>
              <li className="calc-guide-step">
                <span className="calc-guide-title">הצגה באחוזים מ-100</span>
                <span className="calc-guide-text">
                  הגרף מתחיל ב-100 בתאריך הראשון, כך שכל נקודה היא הצמיחה המצטברת באחוזים מאותו יום - ולא שווי
                  התיק בשקלים.
                </span>
              </li>
            </ol>

            {/* WHAT THE CURVE IS ABOUT.
                Two independent choices - which market, and whether the
                non-equity accounts count - because they answer different
                questions and are routinely wanted in combination. */}
            <div className="segment-controls">
              <div className="segment-group" role="group" aria-label="בחירת שוק">
                <span className="segment-group-label" id="segment-market-label">
                  שוק
                </span>
                <div className="segment-buttons" aria-labelledby="segment-market-label">
                  {MARKET_SEGMENTS.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      className={`segment-button ${marketSegment === option.key ? 'active' : ''}`}
                      aria-pressed={marketSegment === option.key}
                      title={option.hint}
                      onClick={() => setMarketSegment(option.key)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Shown wherever the selection holds American lots - the US
                  view and the combined one. Hidden for the Israeli view,
                  where no holding has an exchange rate inside it and the
                  control would be a switch wired to nothing.
                  Toggling it on the combined view is how the currency's
                  effect on the whole stock portfolio is read: the Israeli
                  side does not move, so the difference between the two
                  curves is the dollar. */}
              {showFxToggle && (
                <div className="segment-group">
                  <label
                    className="fx-toggle"
                    title="כלול את תנודות שער הדולר בחישוב התשואה. כיבוי והדלקה מראים כמה מהתשואה נבע מהמטבע ולא מהמניות"
                  >
                    <input
                      type="checkbox"
                      checked={fxMode === FX_MODES.HISTORICAL}
                      onChange={(e) =>
                        setRequestedFxMode(e.target.checked ? FX_MODES.HISTORICAL : FX_MODES.PURE_USD)
                      }
                    />
                    <span>השפעת שער הדולר</span>
                  </label>
                </div>
              )}
            </div>

            <p className="section-subtitle segment-summary">
              מוצג כעת: <strong>{describeSelection(marketSegment, fxMode)}</strong>. עו"ש, קרנות כספיות, חיסכון
              בבנק וקופות גמל אינם נכללים בגרף הזה - הם אינם נעים עם השוק, ונוכחותם בשני קצות כל תת-תקופה מקררת כל
              אחוז ואחוז לכיוון האפס. הגרף מציג צמיחה מנוטרלת הפקדות באחוזים מהתאריך הראשון, ולא את שווי התיק
              בשקלים - הפקדה מגדילה שווי בלי שההחזקות הרוויחו דבר.
              {showFxToggle &&
                (fxMode === FX_MODES.PURE_USD
                  ? ` התשואה המוצגת היא דולרית בלבד: כל התאריכים מומרו לפי שער אחיד${
                      currentExchangeRate ? ` (${currentExchangeRate.toFixed(3)} ₪ לדולר)` : ''
                    }, כך שתנועת המטבע מתקזזת ומה שנמדד הוא ביצועי המניות עצמן.`
                  : ' כל תאריך מומר לפי שער הדולר שלו באותו יום, כך שהתשואה כוללת גם את תנועת המטבע.')}
            </p>

            {/* THE PERIODS ACTUALLY ASKED FOR, as one click each.
                The date inputs below stay - they are the precise control,
                and these are shortcuts into the same two values, not a
                separate mode. Which one is current is derived from the
                dates (see periodKeyForRange), so typing a range of your
                own simply leaves none of them marked. */}
            <div className="period-toggles" role="group" aria-label="תקופת תשואה">
              {RETURN_PERIODS.map((period) => (
                <button
                  key={period.key}
                  type="button"
                  className={`period-toggle ${activeReturnPeriod === period.key ? 'active' : ''}`}
                  aria-pressed={activeReturnPeriod === period.key}
                  title={period.hint}
                  onClick={() => selectReturnPeriod(period.key)}
                >
                  {period.label}
                </button>
              ))}
            </div>

            {/* Layout lives in .date-range-controls, not in an inline style:
                an inline align-items outranks the stylesheet, so the mobile
                rule that stacks these could never take effect. */}
            <div className="date-range-controls">
              <div className="form-group">
                <label htmlFor="performanceFrom">מתאריך</label>
                <input
                  type="date"
                  id="performanceFrom"
                  max={effectivePerformanceTo}
                  value={effectivePerformanceFrom}
                  onChange={(e) => handlePerformanceFromChange(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label htmlFor="performanceTo">עד תאריך</label>
                <input
                  type="date"
                  id="performanceTo"
                  min={effectivePerformanceFrom}
                  max={todayDate}
                  value={effectivePerformanceTo}
                  onChange={(e) => handlePerformanceToChange(e.target.value)}
                />
              </div>
            </div>

            {segmentIsEmpty ? (
              // Naming the filter that emptied the chart, rather than
              // showing the generic "no holdings" note - the portfolio may
              // be full and simply have nothing in THIS market.
              <div className="history-empty-note">
                אין החזקות בבחירה הנוכחית ({describeSelection(marketSegment, fxMode)}). נסו שוק אחר או
                היקף רחב יותר.
              </div>
            ) : !segmentInceptionDate ? (
              <div className="history-empty-note">
                עדיין אין החזקות עם תאריך קנייה/הפקדה בתיק, ולכן אין ממה לחשב ביצועים לאורך זמן.
              </div>
            ) : performanceLoading && !stats.hasHistory ? (
              <div className="history-empty-note">מחשב את שווי התיק לאורך התקופה משערי סגירה היסטוריים…</div>
            ) : performanceError ? (
              <div className="history-empty-note">{performanceError}</div>
            ) : !stats.hasHistory ? (
              <div className="history-empty-note">
                לא נמצאו מספיק שערי סגירה היסטוריים בטווח הזה כדי לחשב ביצועים. נסו טווח תאריכים רחב יותר.
              </div>
            ) : (
              <>
                {/* THE BENCHMARK OVERLAY.
                    One canvas, two measures: the portfolio's shekel value on
                    its own axis, and - when asked for - the neutralized
                    return against the chosen index on a second one, both
                    based at 100 so the divergence between them is the
                    relative performance. */}
                <div className="chart-overlay-controls">
                  <label className="overlay-toggle">
                    <input
                      type="checkbox"
                      checked={showBenchmark}
                      onChange={(e) => setShowBenchmark(e.target.checked)}
                    />
                    <span>השוואה מול מדד ייחוס</span>
                  </label>

                  {showBenchmark && (
                    <>
                      <div className="benchmark-toggle-row" role="group" aria-label="בחירת מדד ייחוס">
                        {benchmarkOptions.map((option) => (
                          <button
                            key={option.key}
                            type="button"
                            className={`benchmark-toggle-button ${
                              selectedBenchmarkKey === option.key ? 'active' : ''
                            }`}
                            aria-pressed={selectedBenchmarkKey === option.key}
                            onClick={() => setBenchmarkKey(option.key)}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                      <p className="overlay-hint">
                        המדדים המוצעים משתנים לפי השוק שנבחר למעלה. מדדים אמריקאיים מוצגים בשקלים, לפי
                        שער הדולר בכל תאריך - כך שההשוואה מודדת את התשואה שמשקיע ישראלי היה מקבל מהם
                        בפועל.
                      </p>
                    </>
                  )}
                </div>

                {benchmarkStatus && <p className="history-empty-note">{benchmarkStatus}</p>}

                {/* ONE MEASURE ON THIS CHART: growth with contributions
                    removed. The portfolio's raw shekel value used to be the
                    curve, and it answers a different question - a deposit
                    lifts it without the holdings having gained anything, so
                    read as performance it is simply wrong. The shekel
                    figures it carried are still on the cards below, where
                    they are labelled as values rather than as a return. */}
                <div className="equity-chart-container">
                  <ResponsiveContainer width="100%" height={280}>
                    <ComposedChart
                      data={performanceChartData}
                      margin={{ top: 10, right: 12, left: 4, bottom: 0 }}
                    >
                      {/* The fill fades to nothing at the baseline, so the
                          area reads as depth under the line rather than as a
                          solid block competing with it. */}
                      <defs>
                        <linearGradient id={AREA_GRADIENT_ID} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={chart.accent} stopOpacity={0.35} />
                          <stop offset="100%" stopColor={chart.accent} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      {/* Horizontal only, solid and faint. The dashed
                          lattice it replaces was the busiest thing on the
                          chart; a grid is there to read a value against,
                          not to be seen. */}
                      <CartesianGrid stroke={chart.grid} vertical={false} />
                      <XAxis
                        dataKey="date"
                        tickFormatter={(d) => formatDate(d)}
                        tick={{ fontSize: 11, fill: chart.axis }}
                        stroke={chart.grid}
                        tickLine={false}
                        axisLine={false}
                        minTickGap={28}
                      />
                      {/* Both series are based at 100, so the axis reads as
                          the growth since the first date rather than as an
                          index level nobody has to decode. */}
                      <YAxis
                        tickFormatter={(v) => `${v >= 100 ? '+' : ''}${(v - 100).toFixed(0)}%`}
                        tick={{ fontSize: 11, fill: chart.axis }}
                        stroke={chart.grid}
                        tickLine={false}
                        axisLine={false}
                        width={52}
                      />
                      <Tooltip
                        {...chartTooltip}
                        cursor={{ stroke: chart.accent, strokeWidth: 1, strokeDasharray: '4 4' }}
                        labelFormatter={(d) => formatDate(d)}
                        formatter={(value, name) => {
                          const change = Number(value) - 100;
                          return [
                            `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`,
                            name === 'portfolioIndexed' ? 'התיק שלי' : selectedBenchmarkLabel
                          ];
                        }}
                      />
                      {benchmarkOverlayReady && (
                        <Legend
                          formatter={(name) =>
                            name === 'portfolioIndexed' ? 'התיק שלי' : selectedBenchmarkLabel
                          }
                        />
                      )}
                      <Area
                        type="monotone"
                        dataKey="portfolioIndexed"
                        stroke={chart.accent}
                        strokeWidth={2.5}
                        fill={`url(#${AREA_GRADIENT_ID})`}
                        dot={false}
                        connectNulls
                        activeDot={{ r: 4, strokeWidth: 2, stroke: chart.tooltipBg }}
                      />
                      {benchmarkOverlayReady && (
                        <Line
                          type="monotone"
                          dataKey="benchmarkIndexed"
                          stroke={chart.benchmark}
                          strokeWidth={2.5}
                          strokeDasharray="5 3"
                          dot={false}
                          connectNulls
                        />
                      )}
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>

                {benchmarkOverlayReady && comparisonLast && (
                  <p className="chart-result-callout">
                    מאז {formatDate(comparisonSeries[0].date)}: התיק שלי{' '}
                    <span
                      className={
                        comparisonLast.portfolioIndexed >= 100 ? 'profit-positive' : 'profit-negative'
                      }
                    >
                      {(comparisonLast.portfolioIndexed - 100).toFixed(1)}%
                    </span>{' '}
                    לעומת {selectedBenchmarkLabel}{' '}
                    <span
                      className={
                        comparisonLast.benchmarkIndexed >= 100 ? 'profit-positive' : 'profit-negative'
                      }
                    >
                      {(comparisonLast.benchmarkIndexed - 100).toFixed(1)}%
                    </span>
                    . שתי השורות מנוטרלות הפקדות ומבוססות ל-100 בתאריך הראשון המשותף, כך שהפער ביניהן הוא
                    ביצועים ולא כסף שהוכנס.
                  </p>
                )}
                <div className="distribution-grid" style={{ marginTop: 16 }}>
                  <div className="distribution-card">
                    {/* Every figure in this section is scoped to the range
                        above, so the headline cannot keep saying "since
                        inception" once that range has been narrowed - it
                        would name a start date the number is not measured
                        from. */}
                    <h3>{isRangeNarrowed ? 'תשואה בתקופה שנבחרה' : 'תשואה מאז תחילת ההשקעה'}</h3>
                    <div
                      className={`distribution-value ${
                        stats.totalReturnPercent >= 0 ? 'profit-positive' : 'profit-negative'
                      }`}
                    >
                      {stats.totalReturnPercent != null ? `${stats.totalReturnPercent.toFixed(1)}%` : '—'}
                    </div>
                    <div className="distribution-percentage">
                      {formatDate(stats.firstDate)} - {formatDate(stats.lastDate)}
                    </div>
                    {stats.isCashFlowNeutralized && (
                      <div
                        className="distribution-percentage"
                        title="תשואה משוקללת-זמן (Time-Weighted): כל הפקדה, משיכה ורכישה חדשה מנוטרלות, כך שהמספר משקף אך ורק את ביצועי הנכסים עצמם"
                      >
                        מנוטרל הפקדות ורכישות
                        {stats.netCashFlow
                          ? ` (${formatPriceWithSign(stats.netCashFlow)} ₪ נכנסו לתיק בתקופה)`
                          : ''}
                      </div>
                    )}
                  </div>
                  <div className="distribution-card">
                    <h3>תשואה שנתית ממוצעת</h3>
                    <div
                      className={`distribution-value ${
                        (stats.annualizedReturnPercent || 0) >= 0 ? 'profit-positive' : 'profit-negative'
                      }`}
                    >
                      {stats.annualizedReturnPercent != null
                        ? `${stats.annualizedReturnPercent.toFixed(1)}%`
                        : 'התקופה קצרה מדי'}
                    </div>
                    <div className="distribution-percentage">
                      תשואה שנתית מתואמת (CAGR) לאורך התקופה שנבחרה, מאותה תשואה מנוטרלת-הפקדות
                    </div>
                  </div>
                  {exactReturns && (
                    <>
                      <div className="distribution-card">
                        <h3>תשואה משוקללת-זמן מדויקת (TWR)</h3>
                        <div
                          className={`distribution-value ${
                            (exactReturns.exactTwr.percent || 0) >= 0 ? 'profit-positive' : 'profit-negative'
                          }`}
                        >
                          {exactReturns.exactTwr.percent != null && !exactReturns.exactTwr.isPartial
                            ? `${exactReturns.exactTwr.percent.toFixed(1)}%`
                            : '—'}
                        </div>
                        <div className="distribution-percentage">
                          שרשור בכל תאריך של הפקדה/רכישה/מכירה ({exactReturns.exactTwr.subPeriods} תת-תקופות), בלי קירוב
                          {exactReturns.exactTwr.isPartial ? ' - חסרים מחירים לחלק מהתאריכים' : ''}
                        </div>
                      </div>
                      <div className="distribution-card">
                        <h3>תשואה משוקללת-כסף (MWR / IRR)</h3>
                        <div
                          className={`distribution-value ${
                            (exactReturns.mwr.periodPercent || 0) >= 0 ? 'profit-positive' : 'profit-negative'
                          }`}
                        >
                          {exactReturns.mwr.periodPercent != null
                            ? `${(exactReturns.mwr.days >= 365 ? exactReturns.mwr.annualPercent : exactReturns.mwr.periodPercent).toFixed(1)}%`
                            : '—'}
                        </div>
                        <div className="distribution-percentage">
                          {exactReturns.mwr.days >= 365 ? 'בשנה, ' : 'לתקופה, '}
                          כולל העיתוי של כל שקל שנכנס או יצא.{' '}
                          {exactReturns.mwr.periodPercent != null &&
                            exactReturns.exactTwr.percent != null &&
                            (exactReturns.mwr.periodPercent < exactReturns.exactTwr.percent - 0.5
                              ? 'נמוכה מה-TWR: הכסף נכנס בעיתוי פחות טוב.'
                              : exactReturns.mwr.periodPercent > exactReturns.exactTwr.percent + 0.5
                              ? 'גבוהה מה-TWR: הכסף נכנס בעיתוי טוב.'
                              : '')}
                        </div>
                      </div>
                    </>
                  )}
                  <div className="distribution-card">
                    <h3>שווי בתחילת התקופה</h3>
                    <div className="distribution-value">
                      {formatPriceWithSign(stats.series[0].value)} ₪
                    </div>
                    <div className="distribution-percentage">{formatDate(stats.firstDate)}</div>
                  </div>
                  <div className="distribution-card">
                    <h3>שווי בסוף התקופה</h3>
                    <div className="distribution-value">
                      {formatPriceWithSign(stats.series[stats.series.length - 1].value)} ₪
                    </div>
                    <div className="distribution-percentage">{formatDate(stats.lastDate)}</div>
                  </div>
                  {/* The raw "how much bigger is the portfolio now" figure
                      used to sit here. It is not a return - a portfolio that
                      grew only because money was paid into it shows a large
                      positive number while the holdings did nothing - and
                      printing it beside the real return invited the two to
                      be read as alternatives. Every percentage in this
                      section is now cash-flow-neutralized. The money that
                      did come in is still stated, as a contribution, on the
                      return card above. */}
                  <div className="distribution-card">
                    <h3>תנודתיות שנתית (משוערת)</h3>
                    <div className="distribution-value">
                      {stats.volatilityPercent != null
                        ? `${stats.volatilityPercent.toFixed(1)}%`
                        : 'עוד לא מספיק נתונים'}
                    </div>
                    <div className="distribution-percentage">
                      סטיית תקן שנתית של תשואות התיק, מחושבת משערי סגירה היסטוריים
                    </div>
                  </div>
                </div>
                {performanceLoading && (
                  <p className="history-empty-note" style={{ marginTop: 8 }}>מעדכן נתוני מחירים היסטוריים…</p>
                )}
              </>
            )}
            {skippedPartial.count > 0 && (
              <p className="history-empty-note" style={{ marginTop: 8 }}>
                {skippedPartial.count} תאריכים הושמטו מהגרף - לא נמצא עבורם מחיר היסטורי לכל ההחזקות, ולכן לא
                ניתן לחשב בהם את שווי התיק המלא
                {skippedPartial.symbols.length > 0 && ` (${skippedPartial.symbols.join(', ')})`}. התאריכים
                האלה מושמטים ולא מוצגים כירידה בשווי.
              </p>
            )}
          </div>

          <div className="analysis-section analysis-section-half" data-section-key="pie" ref={(el) => (sectionRefs.current.pie = el)}>
            <h2 className="section-title">גרף עוגה - פיזור התיק</h2>
            <div className="pie-chart-container">
              <div className="pie-chart-wrapper">
                <ResponsiveContainer width="100%" height={donutLayout.height}>
                  {/* The margin is what the callout labels live in - without
                      it they are drawn outside the SVG and simply clipped. */}
                  <PieChart margin={donutLayout.margin} key="pie-chart">
                    <Pie
                      key="pie-data"
                      data={portfolioPieData}
                      cx="50%"
                      cy="50%"
                      outerRadius={donutLayout.outerRadius}
                      innerRadius={donutLayout.innerRadius}
                      paddingAngle={1}
                      fill={chart.accent}
                      dataKey="value"
                      label={makeSliceCallout(portfolioPieData)}
                      labelLine={false}
                      isAnimationActive={false}
                    >
                      {chart.categorical.slice(0, 6).map((color) => (
                        <Cell key={color} fill={color} stroke="none" />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>

                <div className="pie-labels-side">
                  <div className="pie-label-item">
                    <div className="label-color" style={{ backgroundColor: chart.categorical[0] }}></div>
                    <div className="label-content">
                      <div className="label-name">בורסה ישראלית</div>
                      <div className="label-value">{formatPriceWithSign(analysis.exchangeDistribution.israeli.value)} ₪</div>
                      <div className="label-percentage">{analysis.exchangeDistribution.israeli.percentage.toFixed(1)}%</div>
                    </div>
                  </div>
                  <div className="pie-label-item">
                    <div className="label-color" style={{ backgroundColor: chart.categorical[1] }}></div>
                    <div className="label-content">
                      <div className="label-name">בורסה אמריקאית</div>
                      <div className="label-value">{formatPriceWithSign(analysis.exchangeDistribution.american.value)} ₪</div>
                      <div className="label-percentage">{analysis.exchangeDistribution.american.percentage.toFixed(1)}%</div>
                    </div>
                  </div>
                  <div className="pie-label-item">
                    <div className="label-color" style={{ backgroundColor: chart.categorical[2] }}></div>
                    <div className="label-content">
                      <div className="label-name">קופות גמל</div>
                      <div className="label-value">{formatPriceWithSign(analysis.exchangeDistribution.pension.value)} ₪</div>
                      <div className="label-percentage">{analysis.exchangeDistribution.pension.percentage.toFixed(1)}%</div>
                    </div>
                  </div>
                  <div className="pie-label-item">
                    <div className="label-color" style={{ backgroundColor: chart.categorical[3] }}></div>
                    <div className="label-content">
                      <div className="label-name">קרנות כספיות</div>
                      <div className="label-value">{formatPriceWithSign(analysis.exchangeDistribution.cashFunds.value)} ₪</div>
                      <div className="label-percentage">{analysis.exchangeDistribution.cashFunds.percentage.toFixed(1)}%</div>
                    </div>
                  </div>
                  <div className="pie-label-item">
                    <div className="label-color" style={{ backgroundColor: chart.categorical[4] }}></div>
                    <div className="label-content">
                      <div className="label-name">עו"ש</div>
                      <div className="label-value">{formatPriceWithSign(analysis.exchangeDistribution.bank.value)} ₪</div>
                      <div className="label-percentage">{analysis.exchangeDistribution.bank.percentage.toFixed(1)}%</div>
                    </div>
                  </div>
                  <div className="pie-label-item">
                    <div className="label-color" style={{ backgroundColor: chart.categorical[5] }}></div>
                    <div className="label-content">
                      <div className="label-name">קופת חיסכון בבנק</div>
                      <div className="label-value">{formatPriceWithSign(analysis.exchangeDistribution.bankSavings.value)} ₪</div>
                      <div className="label-percentage">{analysis.exchangeDistribution.bankSavings.percentage.toFixed(1)}%</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="analysis-section analysis-section-half" data-section-key="sector" ref={(el) => (sectionRefs.current.sector = el)}>
            <h2 className="section-title">פיזור לפי סקטור</h2>
            {americanStocks.length === 0 && israeliStocks.length === 0 ? (
              <p className="history-empty-note">אין מניות בתיק כרגע.</p>
            ) : sectorsLoading && !sectorDistribution.hasData ? (
              <p className="history-empty-note">טוען נתוני סקטור…</p>
            ) : !sectorDistribution.hasData ? (
              <p className="history-empty-note">לא ניתן היה לטעון נתוני סקטור כרגע.</p>
            ) : (
              <>
                <div className="pie-chart-container">
                  <div className="pie-chart-wrapper">
                    <ResponsiveContainer width="100%" height={donutLayout.height}>
                      <PieChart margin={donutLayout.margin}>
                        <Pie
                          data={sectorDistribution.sectors.map((s) => ({
                            name: sectorLabelHe(s.sectorKey),
                            value: s.value
                          }))}
                          cx="50%"
                          cy="50%"
                          outerRadius={donutLayout.outerRadius}
                          innerRadius={donutLayout.innerRadius}
                          paddingAngle={1}
                          dataKey="value"
                          label={makeSliceCallout(
                            sectorDistribution.sectors.map((sec) => ({ name: sectorLabelHe(sec.sectorKey), value: sec.value }))
                          )}
                          labelLine={false}
                          isAnimationActive={false}
                        >
                          {sectorDistribution.sectors.map((s, i) => (
                            <Cell key={s.sectorKey} fill={SECTOR_COLORS[i % SECTOR_COLORS.length]} stroke="none" />
                          ))}
                        </Pie>
                        <Tooltip formatter={(value) => [`${formatPriceWithSign(value)} ₪`, 'שווי']} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="pie-labels-side">
                      {sectorDistribution.sectors.map((s, i) => (
                        <div className="pie-label-item" key={s.sectorKey}>
                          <div
                            className="label-color"
                            style={{ backgroundColor: SECTOR_COLORS[i % SECTOR_COLORS.length] }}
                          ></div>
                          <div className="label-content">
                            <div className="label-name">{sectorLabelHe(s.sectorKey)}</div>
                            <div className="label-value">
                              {formatPriceWithSign(s.value)} ₪ ({s.symbolCount} מניות)
                            </div>
                            <div className="label-percentage">{s.percentage.toFixed(1)}%</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                {sectorDistribution.topSectorPercent > 40 && (
                  <p className="section-subtitle" style={{ marginTop: 10 }}>
                    שימו לב: {sectorDistribution.topSectorPercent.toFixed(0)}% מהרכיב האמריקאי מרוכז בסקטור אחד (
                    {sectorLabelHe(sectorDistribution.sectors[0].sectorKey)}) — ריכוזיות מסוג הזה לא נראית בפיזור
                    "ישראלי מול אמריקאי" הרגיל.
                  </p>
                )}
              </>
            )}
          </div>

          <div className="analysis-section" data-section-key="byStock" ref={(el) => (sectionRefs.current.byStock = el)}>
            <h2 className="section-title">פיזור לפי מניות</h2>
            <div className="stocks-table-container">
              <table className="analysis-table">
                <thead>
                  <tr>
                    <th>מנייה</th>
                    <th>בורסה</th>
                    <th>שווי נוכחי</th>
                    <th>אחוז מהתיק</th>
                    <th>רווח/הפסד</th>
                    <th>אחוז רווח/הפסד</th>
                    <th>זמן החזקה</th>
                    <th>תשואה שנתית</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.stockDistribution.map((stock, index) => (
                    <tr key={index}>
                      <td>{stock.displayName || stock.name}</td>
                      <td>{stock.exchange === 'israeli' ? 'ישראלית' : 'אמריקאית'}</td>
                      <td>{formatPriceWithSign(stock.value)} ₪</td>
                      <td>{stock.percentage.toFixed(1)}%</td>
                      <td className={stock.profit >= 0 ? 'profit-positive' : 'profit-negative'}>
                        {formatPriceWithSign(stock.profit)} ₪
                      </td>
                      <td className={stock.profitPercentage >= 0 ? 'profit-positive' : 'profit-negative'}>
                        {stock.profitPercentage.toFixed(1)}%
                      </td>
                      <td>{stock.daysHeld > 365 ? `${stock.yearsHeld.toFixed(1)} שנים` : `${stock.daysHeld} ימים`}</td>
                      <td className={stock.annualizedReturn >= 0 ? 'profit-positive' : 'profit-negative'}>
                        {(stock.annualizedReturn * 100).toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="analysis-section analysis-section-half" data-section-key="byDate" ref={(el) => (sectionRefs.current.byDate = el)}>
            <h2 className="section-title">פיזור לפי תאריכי קנייה והפקדה</h2>
            <p className="section-subtitle">
              כולל גם הפקדות לקופות גמל, לקופות חיסכון ולקרנות כספיות - כל הפקדה משויכת לחודש שבו בוצעה בפועל, לצד
              רכישות המניות. לחצו על שנה כדי לפתוח את הפירוט החודשי שלה.
            </p>
            {distributionYears.length === 0 ? (
              <p className="history-empty-note">אין עדיין רכישות או הפקדות מתוארכות בתיק.</p>
            ) : (
              <div className="year-accordion">
                {distributionYears.map((year) => {
                  const isOpen = !!expandedYears[year.year];
                  const months = monthsByYear[year.year] || [];
                  return (
                    <div className={`year-accordion-item ${isOpen ? 'is-open' : ''}`} key={year.year}>
                      <button
                        type="button"
                        className="year-accordion-header"
                        onClick={() => toggleDistributionYear(year.year)}
                        aria-expanded={isOpen}
                        aria-controls={`year-months-${year.year}`}
                      >
                        <span className="year-accordion-chevron" aria-hidden="true">
                          ▾
                        </span>
                        <span className="year-accordion-year">{year.year}</span>
                        <span className="year-accordion-value">{formatPriceWithSign(year.value)} ₪</span>
                        <span className="year-accordion-count">({year.count} רכישות/הפקדות)</span>
                      </button>

                      {/* Kept mounted and hidden rather than unmounted: the
                          months are already computed, and re-expanding a
                          year should be instant. */}
                      <div
                        id={`year-months-${year.year}`}
                        className="year-accordion-body"
                        hidden={!isOpen}
                      >
                        <div className="date-list">
                          {months.length === 0 ? (
                            <p className="history-empty-note">אין פירוט חודשי לשנה זו.</p>
                          ) : (
                            months.map((item) => (
                              <div key={item.month} className="date-item">
                                <span className="date-label">{formatMonthLabel(item.month)}</span>
                                <span className="date-value">{formatPriceWithSign(item.value)} ₪</span>
                                <span className="date-count">({item.count} רכישות/הפקדות)</span>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="analysis-section analysis-section-half" data-section-key="reports" ref={(el) => (sectionRefs.current.reports = el)}>
            <h2 className="section-title">דוחות מפורטים</h2>
            <div className="reports-grid">
              <div className="report-card">
                <h3>המניות הכי רווחיות</h3>
                <div className="report-list">
                  {analysis.reports.topPerformers.length === 0 ? (
                    <div className="report-item">
                      <span className="report-name">אין כרגע מניות ברווח</span>
                    </div>
                  ) : (
                    analysis.reports.topPerformers.map((stock, index) => (
                      <div key={index} className="report-item">
                        <span className="report-name">{stock.displayName || stock.name}</span>
                        <span className="report-profit profit-positive">
                          {formatPriceWithSign(stock.profit)} ₪
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
              <div className="report-card">
                <h3>המניות הכי מפסידות</h3>
                <div className="report-list">
                  {analysis.reports.worstPerformers.length === 0 ? (
                    <div className="report-item">
                      <span className="report-name">אין כרגע מניות בהפסד</span>
                    </div>
                  ) : (
                    analysis.reports.worstPerformers.map((stock, index) => (
                      <div key={index} className="report-item">
                        <span className="report-name">{stock.displayName || stock.name}</span>
                        <span className="report-profit profit-negative">
                          {formatPriceWithSign(stock.profit)} ₪
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
              <div className="report-card">
                <h3>הפוזיציות הכי גדולות</h3>
                <div className="report-list">
                  {analysis.reports.largestPositions.map((stock, index) => (
                    <div key={index} className="report-item">
                      <span className="report-name">{stock.displayName || stock.name}</span>
                      <span className="report-value">
                        {formatPriceWithSign(stock.value)} ₪
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <div className="analysis-section" data-section-key="dividends" ref={(el) => (sectionRefs.current.dividends = el)}>
            <h2 className="section-title">מעקב דיבידנדים (מניות אמריקאיות)</h2>
            {americanStocks.length === 0 ? (
              <p className="history-empty-note">אין מניות אמריקאיות בתיק כרגע.</p>
            ) : dividendsLoading && Object.keys(dividendsBySymbol).length === 0 ? (
              <p className="history-empty-note">טוען נתוני דיבידנד…</p>
            ) : (
              <>
                <div className="distribution-grid">
                  <div className="distribution-card">
                    <h3>סה"כ דיבידנדים שהתקבלו</h3>
                    <div className="distribution-value profit-positive">${totalReceivedUSD.toFixed(2)}</div>
                    <div className="distribution-percentage">מצטבר, מאז תאריך הרכישה של כל פוזיציה</div>
                  </div>
                  <div className="distribution-card">
                    <h3>הכנסת דיבידנד שנתית צפויה</h3>
                    <div className="distribution-value">${totalProjectedAnnualUSD.toFixed(2)}</div>
                    <div className="distribution-percentage">
                      דיבידנד שנתי למניה (לפי הנתון הידוע היום) × כמות מוחזקת כרגע - תחזית, לא סכום שכבר התקבל
                    </div>
                  </div>
                </div>

                <div className="stocks-table-container" style={{ marginTop: 16 }}>
                  <table className="analysis-table">
                    <thead>
                      <tr>
                        <th>מנייה</th>
                        <th>דיבידנד שנתי ($/מניה)</th>
                        <th>תשואת דיבידנד</th>
                        <th>יחס חלוקה (Payout)</th>
                        <th>תאריך תשלום קרוב</th>
                        <th>הכנסה שנתית צפויה ($)</th>
                        <th>סה"כ שהתקבל ($)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dividendRows.map((row) => (
                        <tr key={row.symbol}>
                          <td>{row.symbol}</td>
                          <td>{row.dividendRate != null ? `$${row.dividendRate.toFixed(2)}` : '—'}</td>
                          <td>{row.dividendYieldPercent != null ? `${row.dividendYieldPercent.toFixed(2)}%` : '—'}</td>
                          <td>{row.payoutRatio != null ? `${(row.payoutRatio * 100).toFixed(0)}%` : '—'}</td>
                          <td>{row.nextDate ? formatDate(row.nextDate) : '—'}</td>
                          <td>{row.projectedAnnualUSD != null ? `$${row.projectedAnnualUSD.toFixed(2)}` : '—'}</td>
                          <td>${row.receivedUSD.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>

          <div className="analysis-section" data-section-key="analysts" ref={(el) => (sectionRefs.current.analysts = el)}>
            <h2 className="section-title">המלצות אנליסטים (מניות אמריקאיות)</h2>
            {americanStocks.length === 0 ? (
              <p className="history-empty-note">אין מניות אמריקאיות בתיק כרגע.</p>
            ) : analystLoading && uniqueAmericanHoldings.every((h) => !recommendationsBySymbol[h.symbol]) ? (
              <p className="history-empty-note">טוען נתוני אנליסטים…</p>
            ) : (
              <div className="stocks-table-container">
                <table className="analysis-table">
                  <thead>
                    <tr>
                      <th>מנייה</th>
                      <th>המלצה</th>
                      <th>מס' אנליסטים</th>
                      <th>יעד מחיר ממוצע</th>
                      <th>מרחק מהיעד</th>
                      <th>שדרוג/הורדה אחרונים</th>
                    </tr>
                  </thead>
                  <tbody>
                    {uniqueAmericanHoldings.map((holding) => {
                      const rec = recommendationsBySymbol[holding.symbol];
                      const upside = rec ? computeUpsidePercent(holding.currentPrice, rec.targetMeanPrice) : null;
                      const sentiment = rec ? recommendationSentiment(rec.recommendationKey) : null;
                      const lastUpgrade = rec && rec.upgradeHistory && rec.upgradeHistory[0];
                      const lastUpgradeDate = lastUpgrade ? formatEpochDateISO(lastUpgrade.epochGradeDate) : null;
                      return (
                        <tr key={holding.symbol}>
                          <td>{holding.symbol}</td>
                          <td className={sentiment ? `profit-${sentiment}` : ''}>
                            {rec ? recommendationLabelHe(rec.recommendationKey) : 'לא זמין'}
                          </td>
                          <td>{rec && rec.numberOfAnalystOpinions != null ? rec.numberOfAnalystOpinions : '—'}</td>
                          <td>{rec && rec.targetMeanPrice != null ? `$${rec.targetMeanPrice.toFixed(2)}` : '—'}</td>
                          <td className={upside != null ? (upside >= 0 ? 'profit-positive' : 'profit-negative') : ''}>
                            {upside != null ? `${upside.toFixed(1)}%` : '—'}
                          </td>
                          <td>
                            {lastUpgrade
                              ? `${actionLabelHe(lastUpgrade.action)} · ${lastUpgrade.firm || ''}${
                                  lastUpgradeDate ? ` · ${formatDate(lastUpgradeDate)}` : ''
                                }`
                              : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="analysis-section" data-section-key="rebalancing" ref={(el) => (sectionRefs.current.rebalancing = el)}>
            <h2 className="section-title">איזון מחדש (Rebalancing)</h2>
            <RebalancingSection
              exchangeDistribution={analysis.exchangeDistribution}
              formatPriceWithSign={formatPriceWithSign}
              targets={rebalanceTargets}
              targetsLoading={rebalanceTargetsLoading}
              saving={rebalanceSaving}
              saveError={rebalanceSaveError}
              onSaveTargets={onSaveRebalanceTargets}
            />
          </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default PortfolioAnalysisView;
