// Modified Dietz return: a time-weighted approximation of investment
// performance over a period that had external cash flows (deposits,
// withdrawals, new purchases) partway through - so a mid-period deposit
// isn't counted as investment growth, and the closer to the end of the
// period a cash flow landed, the less "credit"/"blame" it gets for the
// period's overall % change. This is the standard industry approximation
// (see e.g. the GIPS performance-measurement standards) used whenever daily
// valuations aren't available - only the beginning/ending value and the
// dated list of flows in between are needed.
//
// R = (EMV - BMV - CF) / (BMV + Σ CF_i * w_i)
//   EMV / BMV = ending / beginning market value
//   CF_i      = each external cash flow (+ contribution, - withdrawal)
//   w_i       = (periodEnd - date_i) / (periodEnd - periodStart) - the
//               fraction of the period that flow's money was NOT yet
//               invested (a flow on day 1 of the period gets weight ~1, a
//               flow on the very last day gets weight ~0)
//
// Not a full daily time-weighted return (that needs a valuation on every
// cash-flow date, which this app doesn't have) - this is the best
// approximation achievable from month-start/month-end checkpoints plus a
// dated list of flows, and is what calculatePensionPeriodReturn's simpler
// (non-time-weighted) sibling in portfolioMath.js was already approximating
// less precisely for a single pension fund's own previous/current update.

export const modifiedDietzWeight = (periodStart, periodEnd, flowDate) => {
  const start = new Date(periodStart).getTime();
  const end = new Date(periodEnd).getTime();
  const flow = new Date(flowDate).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(flow) || end <= start) return 0;
  const clamped = Math.min(Math.max(flow, start), end);
  return (end - clamped) / (end - start);
};

// cashFlows: [{ date: 'YYYY-MM-DD', amount }] - positive = money added
// (deposit/purchase), negative = money removed (withdrawal/sale). This app
// currently only ever produces positive flows (no sell/withdrawal ledger
// exists yet), but the math supports both.
export const calculateModifiedDietzReturn = ({
  beginningValue = 0,
  endingValue = 0,
  cashFlows = [],
  periodStart,
  periodEnd
}) => {
  const netCashFlow = cashFlows.reduce((sum, cf) => sum + (cf.amount || 0), 0);
  const weightedCashFlow = cashFlows.reduce(
    (sum, cf) => sum + (cf.amount || 0) * modifiedDietzWeight(periodStart, periodEnd, cf.date),
    0
  );
  const denominator = beginningValue + weightedCashFlow;
  const gain = endingValue - beginningValue - netCashFlow;
  // Only a positive base is capital at work. A withdrawal that outweighs
  // the opening value turns it negative, and a "return" over it has its
  // sign backwards (a gain over -1,000 reads as a loss) - no return then.
  const percent = denominator > 0 ? (gain / denominator) * 100 : null;
  return { netCashFlow, weightedCashFlow, gain, percent };
};
