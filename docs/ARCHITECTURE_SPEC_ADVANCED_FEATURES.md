# StockView: Advanced Features Architecture Spec

**Modules:** (1) Smart Alerts & Anomaly Detection · (2) TWR/MWR Performance & Recommendation Engine · (3) Event-Driven Monthly PDF Report · (4) Valuation Tools & DCF Engine

**Status:** Proposed design. Nothing in this document is implemented yet unless it says *(exists)*.

**Audience:** Anyone implementing these modules in this repository.

---

## 0. Starting point and shared foundations

### 0.1 What already exists and should be reused

The spec builds on these parts of the codebase. It does not replace them.

| Concern | Existing code | How the new modules use it |
|---|---|---|
| TWR (chained Modified Dietz over a sampled value series) | `src/utils/portfolioStats.js` → `computeTimeWeightedReturnPercent`, `buildTwrIndexSeries` | This stays the TWR engine. §2.2 adds an exact-TWR path for when valuations exist on each flow date. |
| Modified Dietz for a single period | `src/utils/modifiedDietz.js` | Gives the monthly return in the PDF report (§3). |
| External cash flows | `src/utils/portfolioCashFlows.js`, `monthlySnapshotComparison.js#buildManualCashFlows` | Inputs to TWR, XIRR, and the report's cash-flow section. |
| Target allocation and drift | `src/utils/rebalancing.js#computeRebalancingPlan`, `rebalance_targets` table, `rebalanceRoutes.js` | The rebalance rules in §2.4 wrap this. |
| Tax-loss candidates (real, CPI-adjusted) | `src/utils/taxLossHarvesting.js`, `cpiTax.js` | The TLH rule in §2.4 consumes this. |
| Dividends (forward summary + paid history) | `src/server/dividendRoutes.js`, `yahooQuotes.js` (`summaryDetail,calendarEvents`), `utils/dividendAnalysis.js` | Event calendar (§1.4) and report dividends (§3). |
| Price history | `historicalPricesRoutes.js`, `taseHistoryApi.js`, Yahoo chart endpoint | OHLCV input for anomaly detection. |
| Monthly checkpoints | `portfolio_monthly_snapshots` table, `monthlySnapshotRoutes.js`, `MANUAL_ENTRY_CATEGORIES` | The PDF report trigger (§3.1). |
| PDF | `jspdf` + `jspdf-autotable` (client, `exportReport.js`), `puppeteer` (server, already installed for TASE) | §3.4 moves the monthly report to server-side Puppeteer. |
| Storage | `dataStore.js` (SQLite locally, Postgres/Supabase in prod), `@supabase/supabase-js` | New tables in §0.3. Supabase Storage holds report files. |

> `docs/CODEBASE_OVERVIEW.md` describes a `src/utils/dcfValuation.js` that is no longer in the tree. §4 fully specifies a replacement.

### 0.2 Cross-cutting: a job runner

Three of the four modules need background work: nightly anomaly scans, calendar refreshes, and report rendering. Today the API runs on Render's free plan, which sleeps when idle, so an in-process `setInterval` is not reliable.

**Recommendation:**

1. Add a `jobs` table as a simple durable queue. Postgres `SELECT … FOR UPDATE SKIP LOCKED` works in production. SQLite uses a single worker.
2. Add protected internal endpoints, `POST /api/internal/jobs/:name`, authenticated by an `X-Cron-Secret` header.
3. Fire the schedules from an external scheduler: a **GitHub Actions `schedule:` workflow** (free, already in `.github/`), Render Cron Jobs, or Supabase `pg_cron` + `pg_net`. The scheduler only enqueues jobs, and the API drains the queue.
4. User-driven events (for example "monthly sync completed") enqueue jobs directly. Scheduled and event-driven work share one pipeline.

```
 GitHub Actions cron ──► POST /api/internal/jobs/enqueue ──┐
 User action (sync done) ─► domain event ───────────────────┤
                                                            ▼
                                                  jobs table (queue)
                                                            │ worker loop (SKIP LOCKED)
                        ┌───────────────┬───────────────────┼────────────────┐
                        ▼               ▼                   ▼                ▼
                 anomaly.scan   calendar.refresh   report.render    fundamentals.refresh
```

```sql
CREATE TABLE jobs (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,                 -- 'anomaly.scan' | 'calendar.refresh' | 'report.render' | ...
  payload       JSONB NOT NULL DEFAULT '{}',
  idempotency_key TEXT UNIQUE,                 -- e.g. 'report:42:2026-08:v3'
  run_after     TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts      INT NOT NULL DEFAULT 0,
  max_attempts  INT NOT NULL DEFAULT 5,
  status        TEXT NOT NULL DEFAULT 'queued', -- queued|running|done|failed
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready ON jobs (status, run_after);
```

Retries use exponential backoff (`run_after = now() + 2^attempts minutes`). A job that fails `max_attempts` times becomes `failed` and shows up in an admin log.

### 0.3 Data model additions

Holdings currently live inside `user_portfolios.payload`, a JSON blob. The new modules need the **set of symbols a user holds** across all users, so add a derived, denormalized table. Rebuild it on every `PUT /api/portfolio`. No blob parsing inside jobs.

```sql
-- Derived on every portfolio save; the source of truth stays user_portfolios.payload
CREATE TABLE user_holdings (
  user_id     INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol      TEXT NOT NULL,          -- 'AAPL' | TASE security number '1081124'
  market      TEXT NOT NULL,          -- 'US' | 'TASE'
  quantity    NUMERIC NOT NULL,
  cost_basis  NUMERIC,                -- in the holding's currency
  PRIMARY KEY (user_id, symbol, market)
);

-- Proposed: a transactions ledger. Today there is no sell/withdrawal ledger
-- (see the limitation noted in portfolioCashFlows.js). Exact MWR, realized
-- gains for TLH, and the report's "net capital withdrawn" all need one.
CREATE TABLE transactions (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trade_date  DATE NOT NULL,
  type        TEXT NOT NULL,          -- BUY|SELL|DEPOSIT|WITHDRAWAL|DIVIDEND|FEE|TAX
  symbol      TEXT, market TEXT,
  quantity    NUMERIC, price NUMERIC,
  amount      NUMERIC NOT NULL,       -- signed, in currency
  currency    TEXT NOT NULL,          -- 'ILS' | 'USD'
  fx_to_ils   NUMERIC,                -- rate on trade_date
  lot_id      TEXT                    -- links a SELL to the lot(s) it closes
);
```

The `alerts`, `market_events`, `monthly_sync_status`, `reports`, and `fundamentals_*` tables are defined inside their modules below.

---

## 1. Smart Alerts & Anomaly Detection Engine

### 1.1 Architecture

```
                  ┌──────────────── Scheduler (post-close, per market) ────────────────┐
                  │  TASE: Sun–Thu 17:45 Asia/Jerusalem   US: Mon–Fri 16:30 America/NY │
                  └──────────────────────────────┬────────────────────────────────────┘
                                                 ▼
 user_holdings ──► DISTINCT symbols ──► OHLCV fetcher (Yahoo chart / TASE history, cached)
                                                 │  ≥ 61 bars per symbol
                                                 ▼
                                   Signal detectors (pure functions)
                         price z-score · %-move · price-vs-SMA · volume/ADV
                                                 │  symbol-level signals (computed ONCE per symbol)
                                                 ▼
                        Fan-out to holders ──► per-user rules and thresholds
                                                 │
                                                 ▼
                     De-dup / cooldown / severity escalation ──► alerts table
                                                 │
                                   ┌─────────────┼──────────────┐
                                   ▼             ▼              ▼
                              In-app bell   Email digest   Web Push (optional)
```

Design decisions:

- **Compute per symbol, deliver per user.** A symbol held by 500 users is fetched and analyzed once. User thresholds only filter the shared signals.
- **Detectors are pure functions** over an array of bars. That makes them unit-testable like the rest of `src/utils`, and they could run client-side too.
- **The baseline excludes today.** Today's move must not inflate the σ it is measured against.
- **Log returns** go into the z-score. They are symmetric and additive, so a −10% and a +11.1% day have equal magnitude.
- **Sample σ (n−1).** 20 observations is too few for the population formula.

### 1.2 Detection logic

| Signal | Formula | Default threshold | Severity |
|---|---|---|---|
| **Return z-score** | `z = (rₜ − μ₂₀) / σ₂₀`, where `rₜ = ln(Pₜ/Pₜ₋₁)` and μ, σ come from the 20 prior daily log returns | \|z\| ≥ 2 | ≥2 warning, ≥3 critical |
| **Single-day % move** | `Δ% = (Pₜ/Pₜ₋₁ − 1)·100` | \|Δ%\| ≥ 5 (user-set) | ≥X warning, ≥2X critical |
| **Price vs. moving average** | `k = (Pₜ − SMA₂₀) / σ(P)₂₀` (Bollinger distance) | \|k\| ≥ 3 | warning |
| **Volume spike** | `ratio = Vₜ / ADV₃₀`, with ADV over the 30 prior sessions and 0-volume days dropped | ≥ 2× | ≥2× warning, ≥3× critical |

**Combination rule.** Signals on the same symbol and day merge into **one alert**. The merged alert takes the highest severity, plus one step when price and volume signals agree (a price shock on 3× volume is a stronger signal than either alone). This keeps alert fatigue down.

**Portfolio weighting.** Severity also depends on the position's weight in the user's portfolio. A critical move in a 0.3% position is downgraded one step. A warning in a position above 15% of the portfolio is upgraded one step.

**Guards:**
- Require at least 21 clean bars. Otherwise emit nothing.
- Skip symbols whose last bar is not today's session (halted or stale data).
- Corporate actions: use **split-adjusted** closes (Yahoo `adjclose`). If a ratio looks like a split (for example exactly ½, ⅓, or 2× with normal volume), suppress the price alert and flag it `DATA_CHECK`.
- TASE prices come in agorot/shekels. Normalize with `normalizeIsraeliPrice` before comparing.

### 1.3 Reference implementation: anomaly detection (TypeScript)

```ts
export type Bar = { date: string; close: number; volume: number };
export type Severity = 'info' | 'warning' | 'critical';

export const DEFAULT_ANOMALY_CONFIG = {
  lookback: 20, zWarn: 2, zCritical: 3, pctMove: 5,
  advWindow: 30, volWarn: 2, volCritical: 3, minHistory: 20,
};
type AnomalyConfig = typeof DEFAULT_ANOMALY_CONFIG;

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const stdev = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)); // sample σ
};

export type AnomalySignal = {
  kind: 'PRICE_ZSCORE' | 'PRICE_PCT_MOVE' | 'PRICE_VS_SMA' | 'VOLUME_SPIKE';
  severity: Severity; value: number; threshold: number; direction: 'up' | 'down' | null;
};

// bars: ascending by date; the last element is the session being evaluated.
export function detectAnomalies(bars: Bar[], cfg: AnomalyConfig = DEFAULT_ANOMALY_CONFIG): AnomalySignal[] {
  const signals: AnomalySignal[] = [];
  const clean = bars.filter((b) => b.close > 0);
  if (clean.length < cfg.minHistory + 1) return signals;

  const today = clean[clean.length - 1];
  const prev = clean[clean.length - 2];
  const hist = clean.slice(-(cfg.lookback + 2), -1);           // strictly BEFORE today

  // 1) Return z-score
  const logReturns = hist.slice(1).map((b, i) => Math.log(b.close / hist[i].close));
  const rToday = Math.log(today.close / prev.close);
  const sigma = stdev(logReturns);
  if (sigma > 0) {
    const z = (rToday - mean(logReturns)) / sigma;
    const sev = Math.abs(z) >= cfg.zCritical ? 'critical' : Math.abs(z) >= cfg.zWarn ? 'warning' : null;
    if (sev) signals.push({ kind: 'PRICE_ZSCORE', severity: sev, value: z, threshold: cfg.zWarn, direction: z > 0 ? 'up' : 'down' });
  }

  // 2) Single-day % move
  const pct = (today.close / prev.close - 1) * 100;
  if (Math.abs(pct) >= cfg.pctMove) {
    signals.push({ kind: 'PRICE_PCT_MOVE', severity: Math.abs(pct) >= 2 * cfg.pctMove ? 'critical' : 'warning',
                   value: pct, threshold: cfg.pctMove, direction: pct > 0 ? 'up' : 'down' });
  }

  // 3) Distance from SMA in σ-of-price units
  const closes = hist.slice(-cfg.lookback).map((b) => b.close);
  const sma = mean(closes), sdPrice = stdev(closes);
  if (sdPrice > 0) {
    const k = (today.close - sma) / sdPrice;
    if (Math.abs(k) >= cfg.zCritical)
      signals.push({ kind: 'PRICE_VS_SMA', severity: 'warning', value: k, threshold: cfg.zCritical, direction: k > 0 ? 'up' : 'down' });
  }

  // 4) Volume vs ADV (excluding today; zero-volume bars are data gaps)
  const vols = clean.slice(-(cfg.advWindow + 1), -1).map((b) => b.volume).filter((v) => v > 0);
  if (vols.length >= Math.min(cfg.advWindow, cfg.minHistory) && today.volume > 0) {
    const ratio = today.volume / mean(vols);
    const sev = ratio >= cfg.volCritical ? 'critical' : ratio >= cfg.volWarn ? 'warning' : null;
    if (sev) signals.push({ kind: 'VOLUME_SPIKE', severity: sev, value: ratio, threshold: cfg.volWarn, direction: null });
  }
  return signals;
}
```

Verified: on a calm synthetic series followed by a +8% day on 3.4× volume, this returns critical z-score, warning %-move, warning SMA-distance, and critical volume. The same series without the final day returns no signals.

**De-duplication and cooldown** (per user, symbol, alert type):

```ts
// Before writing an alert:
//  - same (user, symbol, type) within cooldown (default 24h)   → skip, unless severity escalated
//  - same (user, symbol) with multiple signals today           → merge into one alert
const dedupKey = `${userId}:${symbol}:${type}:${sessionDate}`;   // UNIQUE index on alerts.dedup_key
```

### 1.4 Personalized event calendar

**Goal:** earnings calls, ex-dividend dates, and payment dates, **only for the user's active holdings**.

**Pipeline:**

1. **Symbol set.** `SELECT DISTINCT symbol, market FROM user_holdings WHERE quantity > 0`.
2. **Fetch** (daily at 06:00 UTC, plus on demand when a new symbol is added):
   - **US:** Yahoo `quoteSummary?modules=calendarEvents,summaryDetail` (already used in `yahooQuotes.js`) gives `earnings.earningsDate[]` (often a *range*), `exDividendDate`, and `dividendDate`. As a more stable, documented alternative or fallback, use **Finnhub** `/calendar/earnings` and `/stock/dividend`, or **FMP** `/earning_calendar` and `/stock_dividend_calendar`.
   - **TASE:** scrape or ingest **Maya** (maya.tase.co.il) corporate announcements. Periodic-report publication dates and dividend distribution announcements include the ex-date and payment date. Use EODHD's calendar where it covers TASE tickers.
3. **Projection** (for payment dates not yet announced). From the paid history (`fetchYahooDividendHistory`), take the **median interval** between the last 4–8 payments and snap it to the nearest canonical cadence (30/91/182/365 days). Then project the next ex-date and pay-date, preserving the historical *ex→pay lag*. Projected amount = last amount (or the trailing average if the dividend is variable). Every projected row carries `status: 'projected'` and a confidence based on cadence regularity (σ of intervals / median).
4. **Upsert** into `market_events`, keyed by `(symbol, market, event_type, event_date)`. An announced event replaces a projected one for the same window (±10 days).
5. **Serve.** `GET /api/calendar?from&to` joins `market_events` with `user_holdings` for the logged-in user, and multiplies dividend-per-share by the user's quantity to show the **expected cash amount** in ILS and USD.
6. **Reminder alerts.** A daily job emits `EVENT_UPCOMING` alerts at T−7 and T−1 days before an earnings date, and T−2 before an ex-dividend date (the last day to buy and still receive the dividend).

```sql
CREATE TABLE market_events (
  id          BIGSERIAL PRIMARY KEY,
  symbol      TEXT NOT NULL,
  market      TEXT NOT NULL,
  event_type  TEXT NOT NULL,          -- EARNINGS | EX_DIVIDEND | DIVIDEND_PAYMENT | SPLIT
  event_date  DATE NOT NULL,
  event_date_end DATE,                -- earnings windows are often a range
  time_of_day TEXT,                   -- BMO | AMC | UNKNOWN
  amount_per_share NUMERIC, currency TEXT,
  status      TEXT NOT NULL,          -- confirmed | estimated | projected
  confidence  NUMERIC,                -- 0..1 for projected rows
  source      TEXT NOT NULL,          -- yahoo | finnhub | fmp | maya | projection
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (symbol, market, event_type, event_date)
);
```

### 1.5 Alert output schema

```jsonc
{
  "id": "alt_01J9Z3K6Q8...",
  "userId": 42,
  "type": "PRICE_ANOMALY",            // PRICE_ANOMALY | VOLUME_ANOMALY | COMBINED_ANOMALY
                                      // | EVENT_UPCOMING | DRIFT | TAX_OPPORTUNITY | DATA_CHECK
  "severity": "critical",             // info | warning | critical
  "createdAt": "2026-09-24T14:52:00Z",
  "sessionDate": "2026-09-24",
  "instrument": { "symbol": "NVDA", "market": "US", "name": "NVIDIA Corp", "currency": "USD" },
  "position": { "quantity": 40, "weightPct": 12.4, "valueILS": 61210.5, "dayPnlILS": -4620.1 },
  "signals": [
    { "kind": "PRICE_ZSCORE",   "value": -3.4, "threshold": 2, "direction": "down" },
    { "kind": "PRICE_PCT_MOVE", "value": -7.1, "threshold": 5, "direction": "down" },
    { "kind": "VOLUME_SPIKE",   "value": 2.8,  "threshold": 2, "direction": null }
  ],
  "title": "NVDA fell 7.1% on 2.8× normal volume",
  "message": "NVIDIA dropped 7.1% today, about 3.4 standard deviations beyond its usual daily move, on 2.8 times its 30-day average volume. Your position lost ₪4,620 and makes up 12.4% of your portfolio.",
  "recommendation": {
    "action": "REVIEW",               // REVIEW | NO_ACTION | CHECK_NEWS | CONSIDER_REBALANCE | CONSIDER_TLH
    "text": "Check recent news before acting. The position is still 2.4 pp above its 10% target; if the thesis is unchanged, consider trimming back to target instead of a full exit.",
    "links": [{ "label": "Open position", "href": "/us-stocks?symbol=NVDA" }]
  },
  "dedupKey": "42:NVDA:COMBINED_ANOMALY:2026-09-24",
  "readAt": null,
  "channels": ["in_app", "email_digest"]
}
```

Messages are generated from templates in Hebrew and English, never free text. Recommendation texts are rule-based suggestions and carry the same "not investment advice" disclaimer that `cpiTax.js` already uses.

---

## 2. Performance (TWR vs. MWR) and Recommendation Engine

### 2.1 Why both returns are needed

| | **TWR** | **MWR / IRR** |
|---|---|---|
| Question it answers | "How good were the investments?" | "How did *my money* do, including my timing?" |
| Cash-flow effect | Neutralized (each sub-period is chained) | Fully included |
| Right comparison for | Benchmarks (TA-125, S&P 500) and fund managers | The investor's personal outcome, and goals |
| Existing code | `portfolioStats.js` (exists) | None; new |

When TWR ≫ MWR, the user added money before drawdowns (bad timing). When MWR ≫ TWR, the timing was good. Show both side by side, with a one-line explanation.

### 2.2 TWR

**Exact TWR** needs a valuation right before each external flow:

$$\text{TWR} = \prod_{i=1}^{n}\frac{V_i^{\text{end}}}{V_{i-1}^{\text{end}} + CF_{i-1}} - 1 \qquad \text{Annualized: } (1+\text{TWR})^{365/\text{days}} - 1$$

**This app** only has sampled valuations (daily snapshots, weekly historical samples, monthly checkpoints). So the existing implementation chains **Modified Dietz** sub-periods, which is the GIPS-accepted approximation. Keep that as the default. Use the exact path when a valuation exists on every flow date. With historical prices already fetched per holding (`historicalPortfolioValue.js`), you can *construct* those valuations: call `computePortfolioValueAtDate(flow.date − 1 day)` for each flow date and insert those points into the series before chaining.

```ts
export type ValuationPoint = { date: string; value: number };   // value measured BEFORE that date's flow
export type CashFlow = { date: string; amount: number };         // + into portfolio, − out of it

export function trueTwr(points: ValuationPoint[], flows: CashFlow[]): number | null {
  if (points.length < 2) return null;
  const flowOn = new Map<string, number>();
  for (const f of flows) flowOn.set(f.date, (flowOn.get(f.date) ?? 0) + f.amount);

  let growth = 1, measured = false;
  for (let i = 1; i < points.length; i++) {
    const start = points[i - 1].value + (flowOn.get(points[i - 1].date) ?? 0); // after the flow
    if (start <= 0) continue;                       // empty portfolio: no return, only funding
    growth *= points[i].value / start;
    measured = true;
  }
  return measured ? growth - 1 : null;
}
// Verified: 100 → 110, deposit 100, 210 → 189  ⇒  1.10 × 0.90 − 1 = −1.00%
```

### 2.3 MWR (XIRR)

Solve for the r that makes the net present value of all dated flows zero. Flows are from the **investor's** perspective: contributions negative, withdrawals positive, and the ending market value as a final positive flow. Dates use Actual/365 (the same convention as Excel `XIRR`).

$$\sum_{k} \frac{CF_k}{(1+r)^{(t_k - t_0)/365}} = 0$$

Algorithm: Newton–Raphson from a guess of 10%, with a bisection fallback on [−99.99%, +1000%] when Newton diverges or the derivative vanishes. Return `null` (show "N/A") when every flow has the same sign or the root is not bracketed.

```ts
const DAY = 86_400_000;
const yearFrac = (t0: number, t: number) => (t - t0) / DAY / 365;

function xnpv(rate: number, flows: { t: number; amount: number }[]) {
  const t0 = flows[0].t;
  return flows.reduce((s, f) => s + f.amount / (1 + rate) ** yearFrac(t0, f.t), 0);
}
function dxnpv(rate: number, flows: { t: number; amount: number }[]) {
  const t0 = flows[0].t;
  return flows.reduce((s, f) => { const y = yearFrac(t0, f.t); return s - (y * f.amount) / (1 + rate) ** (y + 1); }, 0);
}

export function xirr(cashFlows: CashFlow[], guess = 0.1): number | null {
  const flows = cashFlows.map((f) => ({ t: Date.parse(f.date), amount: f.amount }))
    .filter((f) => Number.isFinite(f.t) && f.amount !== 0).sort((a, b) => a.t - b.t);
  if (!flows.some((f) => f.amount > 0) || !flows.some((f) => f.amount < 0)) return null;

  let r = guess;                                             // Newton–Raphson
  for (let i = 0; i < 50; i++) {
    const f = xnpv(r, flows), df = dxnpv(r, flows);
    if (Math.abs(f) < 1e-7) return r;
    if (!Number.isFinite(df) || df === 0) break;
    const next = r - f / df;
    if (!Number.isFinite(next) || next <= -0.9999) break;
    if (Math.abs(next - r) < 1e-10) return next;
    r = next;
  }
  let lo = -0.9999, hi = 10, fLo = xnpv(lo, flows);           // bisection fallback
  if (fLo * xnpv(hi, flows) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2, fMid = xnpv(mid, flows);
    if (Math.abs(fMid) < 1e-7 || hi - lo < 1e-10) return mid;
    if (fLo * fMid < 0) hi = mid; else { lo = mid; fLo = fMid; }
  }
  return (lo + hi) / 2;
}

// Adapter: portfolio flows (+in / −out) → investor-perspective series
export function portfolioMwr(flows: CashFlow[], endDate: string, endValue: number, startDate?: string, startValue = 0) {
  const series: CashFlow[] = [];
  if (startDate && startValue > 0) series.push({ date: startDate, amount: -startValue });
  for (const f of flows) series.push({ date: f.date, amount: -f.amount });
  series.push({ date: endDate, amount: endValue });
  return xirr(series);
}
```

Verified against Excel's documented `XIRR` example (−10,000 / 2,750 / 4,250 / 3,250 / 2,750 → **37.336%**) and a one-year case of −1000 → +1100, which gives exactly 10%. In the TWR example above (deposit right before a −10% period), TWR is −1.0% and MWR is −7.3%, as expected.

**Data caveat:** MWR is only as good as the flow ledger. Until `transactions` (§0.3) records sells and withdrawals, a sale looks like a loss. Show the MWR with a "partial flow data" badge while `portfolioCashFlows.js` is the only source. For periods shorter than one year, show the **de-annualized** figure, `(1+r)^(days/365) − 1`, because annualizing a 3-week return is misleading.

### 2.4 Rule-based recommendation engine (Sell / Trim / Hold / Rebalance / Harvest)

**Architecture:** a pipeline of independent, pure **rules**. Each rule receives an immutable `PortfolioContext` and emits zero or more `Recommendation` objects. A resolver then merges conflicts and ranks the output. Rules are data-configurable per user (thresholds and on/off), so they are easy to test and to explain.

```
PortfolioContext = { positions[], lots[], categoryAllocation, targets, cpi, fx,
                     realizedGainsYTD, taxRate (0.25), today, userPrefs }
        │
        ├─► DriftRule (category)          ──┐
        ├─► ConcentrationRule (position)  ──┤
        ├─► ProfitTakingRule              ──┼─► Resolver: merge same-symbol actions,
        ├─► TaxLossHarvestRule            ──┤   net buys vs sells, tax-aware lot choice,
        └─► CashDragRule                  ──┘   rank by (severity × ₪ impact) → top N
```

**Rules:**

| Rule | Trigger | Action | Notes |
|---|---|---|---|
| **Drift (category)** | \|current% − target%\| ≥ **5 pp** absolute **or** ≥ **25% relative** of target (the "5/25 rule") | `REBALANCE`: buy or sell `diffValue` from `computeRebalancingPlan` | Only when `isValidAllocation`. Prefer directing **new contributions** to underweight categories before any sell (tax-free rebalancing). |
| **Concentration** | Single position > **15%** of liquid portfolio (user-set) | `TRIM` to the cap | Severity grows with the excess. |
| **Profit taking** | Unrealized gain ≥ **+50%** (user-set) **and** position weight > target/cap | `TRIM` the excess over target, **not** the whole gain | Show the **after-tax** proceeds: Israeli 25% on the *real* (CPI-adjusted) gain via `cpiTax.js`; US holdings via `calculateAmericanStockMetrics` (includes FX). |
| **Tax-loss harvesting** | Position has a real loss ≥ ₪1,000 **and** (the user has realized gains YTD **or** it is Oct–Dec) | `HARVEST`: sell and optionally re-buy a *similar, not identical* exposure | Reuse `computeTaxLossHarvestingOpportunities`. Benefit = min(loss, realized gains YTD + planned gains) × 25%. Year-end mode ranks by benefit in Dec. |
| **Cash drag** | Cash + money-market above the target by > 5 pp for 60+ days | `DEPLOY` into the most underweight category | |
| **Hold (default)** | No rule fired for a position | `HOLD` | Shown only on request, to keep the list short. |

**Tax-aware lot selection** for any SELL or TRIM. Candidate lots are ordered by *tax cost per ₪ sold*: loss lots first, then highest real cost basis. **Caveat:** the lot-identification method actually allowed depends on the jurisdiction and the broker (Israeli brokers typically apply FIFO per account). Make the method a user setting (`FIFO` default, `SPECIFIC_ID` where the broker supports it), and show the tax estimate for the method in use.

**Wash-sale caveat:** US tax residents are subject to the 30-day wash-sale rule. Israeli law has no identical statutory rule, but a sell-and-rebuy with no economic substance may be challenged. The HARVEST recommendation therefore suggests an **alternative instrument** (for example a different S&P 500 ETF provider, or a sector ETF instead of a single stock) and never "sell and re-buy the same security".

```ts
type Action = 'HOLD' | 'TRIM' | 'SELL' | 'BUY' | 'REBALANCE' | 'HARVEST' | 'DEPLOY';
type Recommendation = {
  id: string; rule: string; action: Action; severity: 'low' | 'medium' | 'high';
  symbol?: string; category?: string;
  amountILS: number;                         // + buy, − sell
  estTaxILS?: number; estTaxSavedILS?: number;
  rationale: string;                         // templated, bilingual
  inputs: Record<string, number | string>;   // numbers that fired the rule, shown in the "why?" popover
};

interface Rule { id: string; evaluate(ctx: PortfolioContext): Recommendation[]; }

const driftRule: Rule = {
  id: 'drift',
  evaluate(ctx) {
    const plan = computeRebalancingPlan(ctx.categoryAllocation, ctx.targets);   // existing
    if (!plan.isValidAllocation) return [];
    return plan.rows
      .filter((r) => r.targetPercent > 0 || r.currentPercent > 0)
      .filter((r) => Math.abs(r.diffPercent) >= ctx.prefs.driftAbsPp ||
                     (r.targetPercent > 0 && Math.abs(r.diffPercent) / r.targetPercent >= ctx.prefs.driftRel))
      .map((r) => ({
        id: `drift:${r.key}`, rule: 'drift', action: 'REBALANCE', category: r.key,
        severity: Math.abs(r.diffPercent) >= 10 ? 'high' : 'medium',
        amountILS: r.diffValue,
        rationale: `${r.label} is ${r.currentPercent.toFixed(1)}% vs target ${r.targetPercent}%`,
        inputs: { current: r.currentPercent, target: r.targetPercent },
      }));
  },
};

const profitTakingRule: Rule = {
  id: 'profit-taking',
  evaluate(ctx) {
    return ctx.positions.flatMap((p) => {
      const cap = ctx.prefs.positionCapPct;
      if (p.unrealizedGainPct < ctx.prefs.profitTakePct || p.weightPct <= cap) return [];
      const sellILS = ((p.weightPct - cap) / 100) * ctx.totalValueILS;
      const tax = estimateTaxOnSale(p, sellILS, ctx);            // real gain × 25%, lot-aware
      return [{ id: `pt:${p.symbol}`, rule: 'profit-taking', action: 'TRIM', symbol: p.symbol,
        severity: p.weightPct > cap * 1.5 ? 'high' : 'medium', amountILS: -sellILS, estTaxILS: tax,
        rationale: `Up ${p.unrealizedGainPct.toFixed(0)}% and ${p.weightPct.toFixed(1)}% of the portfolio (cap ${cap}%)`,
        inputs: { gainPct: p.unrealizedGainPct, weightPct: p.weightPct, cap } }];
    });
  },
};

export function runRecommendationEngine(ctx: PortfolioContext, rules: Rule[]) {
  const raw = rules.filter((r) => ctx.prefs.enabledRules.includes(r.id)).flatMap((r) => r.evaluate(ctx));
  return resolve(raw)   // 1) HARVEST beats TRIM on the same symbol when both fire (sell losses first)
                        // 2) net BUY/SELL per category so we never "sell A to buy A"
                        // 3) drop items below min trade size (₪500) or where fees > 1% of trade
                        // 4) rank by severity, then |amountILS| + estTaxSavedILS
    .slice(0, ctx.prefs.maxItems ?? 7);
}
```

**Endpoint:** `GET /api/recommendations`. It is computed on request (it is cheap) and cached for 10 minutes per user. Every item stores its `inputs`, so the UI can answer "why am I seeing this?".

---

## 3. Automated Monthly PDF Report Generator

### 3.1 Event-driven trigger ("monthly sync complete")

The report is generated when the user's **manual** assets are up to date for the month, not on a fixed calendar date. Manual assets are provident, pension, and study funds (`pension`), money-market funds (`cashFunds`), bank balances (`bank`), and bank savings (`bankSavings`).

**The sync state machine** (per user, per month):

```
   OPEN ──(first manual-asset update in month M)──► IN_PROGRESS
     │                                                  │
     │               all required manual accounts have  │  or user clicks
     │               valueDate ∈ month M ───────────────┤  "Finished monthly update" (סיימתי עדכון חודשי)
     │                                                  ▼
     │                                              COMPLETE ──► emits MonthlySyncCompleted(user, M, version)
     │                                                  │
     │                               a later edit to M's manual data
     │                                                  ▼
     └──────────────────────────────────────────────── DIRTY ──► (debounced) re-emit with version+1
```

**Rules:**

- **Required accounts** = every manual-entry account (from `MANUAL_ENTRY_CATEGORIES`) with a non-zero balance. The user can exclude an account ("don't wait for this one").
- **Completion** means either every required account has `currentValueDate` inside the target month (or within the first 10 days of the next month, since statements for month M usually arrive early in M+1), **or** the user presses the button. The button is the primary UX, and auto-detection is a convenience.
- **Debounce:** on COMPLETE, enqueue `report.render` with `run_after = now() + 10 min`. Users often fix a typo right after finishing. A new edit moves the job's `run_after` forward.
- **Idempotency:** `idempotency_key = report:{userId}:{month}:v{version}`. A re-render produces a new version, never a duplicate. The UI lists every version.
- **Fallback nudge:** if the state is still `OPEN` or `IN_PROGRESS` on day 12 of M+1, send one reminder ("Your August report is waiting for 2 accounts: …"). No report is generated from stale data.
- Completing the sync also **writes the monthly snapshot** (`upsertMonthlySnapshot` for month M). The report and the monthly tracker then read the same numbers.

```sql
CREATE TABLE monthly_sync_status (
  user_id   INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month     TEXT NOT NULL,                 -- 'YYYY-MM'
  state     TEXT NOT NULL,                 -- OPEN | IN_PROGRESS | COMPLETE | DIRTY
  required_accounts JSONB NOT NULL,        -- [{id, category, name, updatedAt}]
  version   INT  NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, month)
);
CREATE TABLE reports (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month       TEXT NOT NULL, version INT NOT NULL,
  status      TEXT NOT NULL,               -- queued | rendering | ready | failed
  storage_key TEXT,                        -- 'reports/42/2026-08/v2.pdf'
  bytes       INT, pages INT,
  data_hash   TEXT,                        -- sha256 of the input JSON; identical input → reuse the file
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, month, version)
);
```

### 3.2 Report content and calculations

All figures are in ILS, with a USD column converted at the **month-end** BOI rate (`/api/exchange-rate/:date`).

1. **Executive summary**
   - Net worth at the end of M, from the sum of the monthly snapshot categories.
   - Δ net worth (₪ and $) = `NW_M − NW_{M−1}`, split into **Δ from contributions** (net external flows) and **Δ from market** (the rest).
   - Monthly return %: Modified Dietz for the month (`calculateModifiedDietzReturn`) using the month's dated flows. YTD TWR is shown next to it, chained from the monthly Dietz returns.
   - One-line "headline", templated: "Up 2.3% in August, mainly from US equities (+₪4,120)."
2. **Asset allocation.** A donut plus a table: equities (IL / US), fixed income (bond ETFs, classified via `israeliEtfClassifier.js`), provident/pension funds, and cash reserves (bank + money-market). Shows the current % vs target % and the drift badge from §2.4.
3. **Top movers and draggers.** Positions ranked by **₪ contribution** = `ΔValue − netFlows(position)`. The % change is shown alongside, but ranking by ₪ prevents a +40% move in a ₪500 position from outranking a +3% move in a ₪200k one. Shows the top 5 and bottom 5, with each position's share of the month's P&L.
4. **Cash-flow summary.** Dividends received in M (`computeReceivedDividends` for US holdings, plus manual or TASE entries), with gross, withholding tax, and net. Deposits, withdrawals, and net capital injected, from `portfolioCashFlows.js`, manual flows, and later the `transactions` ledger. Fees and taxes paid, if recorded.
5. **Appendix.** Upcoming events for M+1 (§1.4), open recommendations (§2.4), and a data-freshness table (last update per manual account), plus the disclaimer.

The report is rendered from a single **`ReportModel` JSON** built on the server by pure functions. The PDF is a pure view of that model, and the model is stored next to the file (via `data_hash`) so any report can be re-rendered or audited.

### 3.3 Library evaluation

| Library | RTL / Hebrew | Charts | Layout effort | Runtime | Verdict |
|---|---|---|---|---|---|
| **Puppeteer (HTML → PDF)** | **Native.** Chrome handles the bidi algorithm, shaping, and mixed Hebrew + numbers | Recharts / SVG as-is | Low (HTML/CSS, `@page`, print CSS) | Node; already a dependency | **Recommended** |
| Playwright (`page.pdf`) | Native | Same | Same | Node | Equivalent alternative |
| jsPDF + autotable (current) | Manual. `exportReport.js#toPdfDisplayText` has to reverse Hebrew runs by hand | Rasterize | High | Browser | Keep for the instant client-side "export now" button only |
| @react-pdf/renderer | Weak bidi support; mixed RTL/LTR lines are unreliable | Custom SVG primitives, no Recharts | Medium | Node / browser | Not for a Hebrew-first report |
| PDFKit | No bidi algorithm | Manual drawing | High | Node | No |
| ReportLab | Needs `python-bidi` + `arabic-reshaper`-style workarounds | matplotlib images | High | Adds a Python service | Only if a Python service already existed |
| Gotenberg / Browserless (hosted Chrome) | Native | Same as Puppeteer | Low | Separate container / SaaS | **Scale-out option** for Puppeteer (same HTML) |

**Decision: server-side Puppeteer rendering an HTML report template.** It reuses the design tokens, fonts (Alef is already bundled in `src/assets/fonts`), and Recharts components the app already has, and it removes the manual bidi workaround.

**Operational note:** `render.yaml` already warns that Chrome can run out of memory on the 512 MB free plan. Mitigations, in order:
1. One shared browser instance, one page at a time (concurrency 1). Launch with `--disable-dev-shm-usage --no-zygote --single-process`, close each page after rendering, and recycle the browser every N renders.
2. Run the `report.render` worker as a **separate Render Background Worker** (or Starter plan), so the API is never taken down by a render.
3. If that is still not enough, point the same HTML at **Gotenberg** (self-hosted Docker) or **Browserless**. The template does not change.

### 3.4 End-to-end workflow

```
[User] marks last manual account / clicks "Finished monthly update"
   │
   ▼
POST /api/monthly-sync/:month/complete  ──► monthly_sync_status := COMPLETE (version++)
   │                                         upsertMonthlySnapshot(month)
   │                                         enqueue job 'report.render' (run_after = +10 min, idempotent key)
   ▼
Worker picks the job (SKIP LOCKED)
   1. buildReportModel(userId, month)        ← pure: snapshots, cash flows, dividends, prices, FX, targets
   2. hash = sha256(model); if a ready report with the same hash exists → reuse, skip to 6
   3. html = renderToStaticMarkup(<MonthlyReport model={model} />)   // React 19 server render
      • Recharts: fixed width/height (no ResponsiveContainer on the server), isAnimationActive={false}
      • <html dir="rtl" lang="he">, fonts inlined as base64 @font-face (no network during render)
   4. page.setContent(html, { waitUntil: 'load' }) → await document.fonts.ready
      pdf = page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true,
                       displayHeaderFooter: true, footerTemplate: '<… page X of Y …>' })
   5. upload to Supabase Storage bucket 'reports' (private): reports/{userId}/{month}/v{n}.pdf
   6. reports.status = ready; create in-app notification "Your August report is ready"
   7. optional email (Resend / Postmark / SES): short summary + a signed URL (expires in 7 days).
      Never attach financial PDFs to email by default.
   │
   ▼
GET /api/reports            → list of versions
GET /api/reports/:id/download → 302 to a fresh signed URL (60 s), after the ownership check
```

**Security:** the bucket is private, and every download goes through a short-lived signed URL issued after `requireAuth` plus an ownership check. The HTML template receives only the model, with no user-controlled HTML (escape every string). The page runs with `javaScriptEnabled: false` once the markup is pre-rendered, and with request interception that blocks all network access.

**Print CSS essentials:**

```css
@page { size: A4; margin: 14mm 12mm 16mm; }
section { break-inside: avoid; }          /* keep a KPI block or chart on one page */
h2 { break-after: avoid; }
table { font-variant-numeric: tabular-nums; }
.num { direction: ltr; unicode-bidi: isolate; }  /* "-₪1,234.50" never flips inside RTL text */
```

---

## 4. Integrated Valuation Tools and DCF Engine

### 4.1 Architecture

```
fundamentals.refresh job (weekly + on first view of a symbol)
   │   FMP / EODHD / Yahoo quoteSummary (fallback)
   ▼
fundamentals_annual (10y of income, cash-flow, and balance-sheet lines per symbol)
fundamentals_ttm    (latest trailing-12-month values)
sector_benchmarks   (sector / industry medians, refreshed monthly)
   │
   ├─► GET /api/valuation/:symbol/multiples  → current vs 5y avg/median vs sector
   └─► GET /api/valuation/:symbol/dcf-inputs → FCF history, cash, debt, diluted shares, price
                                               (the DCF itself runs CLIENT-SIDE: the sliders update instantly)
```

The DCF engine is a pure function in `src/utils/dcf.js`. It runs in the browser for interactivity. The server only supplies the inputs, so a user's `g` and `r` never cost an API call.

### 4.2 Historical multiples comparison

**Definitions** (per share or aggregate; aggregate is used here to avoid share-count noise):

| Multiple | Formula | Undefined when |
|---|---|---|
| P/E | Market cap / Net income (TTM) | Net income ≤ 0 → "N/M" |
| P/S | Market cap / Revenue (TTM) | Revenue ≤ 0 |
| P/FCF | Market cap / (Operating cash flow − CapEx) (TTM) | FCF ≤ 0 → "N/M" |

**Historical series.** For each of the last 5 fiscal years *y*, compute the multiple at **several points** (month-end market caps across the year ÷ that year's fundamentals, or quarterly TTM when quarterly data is available). Year-end-only sampling makes the average hostage to one day's price.

**Aggregation:**
- **5y average** = the mean of the sampled points, *excluding* N/M points, with the count shown ("based on 52 of 60 months").
- Also show the **5y median** and the **percentile** of the current value within the 5-year range. The percentile is the most intuitive signal: "P/E is at the 88th percentile of its own 5-year history."
- Deviation = `current / avg5y − 1`.

**Sector benchmark.** Use the median of the company's industry (GICS industry or Yahoo industry) peers, **not the mean**, because means are dominated by near-zero-earnings outliers. Sources: FMP sector/industry P/E endpoints, a peer set computed from `similarCompanies` (already fetched by the stock-research flow) with fundamentals for each, or Damodaran's free annual industry datasets (NYU Stern) as a stable baseline. Always label the source and its date.

```ts
type MultipleRow = {
  metric: 'PE' | 'PS' | 'PFCF';
  current: number | null;
  avg5y: number | null; median5y: number | null; percentile5y: number | null; // 0..100
  sectorMedian: number | null; sectorSource: string;
  vsHistoryPct: number | null;   // current / avg5y − 1
  vsSectorPct: number | null;    // current / sectorMedian − 1
  samples: number;
};
```

UI: a compact table with a bullet/range chart per metric showing the 5-year min–max bar, a tick for the 5y average, a tick for the sector median, and a dot for the current value.

### 4.3 DCF: formula and logic

A two-stage model on **Free Cash Flow = Cash from operations − Capital expenditures**:

1. **Base FCF (FCF₀).** Default to the **average of the last 3 fiscal years**, which normalizes working-capital swings. The user can switch to "latest TTM". If FCF₀ ≤ 0, the model refuses to produce a fair value and explains why.
2. **Stage 1** (years 1..N, N = 5): FCFₜ = FCF₀·(1+g)ᵗ, PVₜ = FCFₜ / (1+r)ᵗ.
3. **Terminal value** (Gordon growth at end of year N): TV = FCF_N·(1+g∞) / (r − g∞), PV(TV) = TV / (1+r)ᴺ. g∞ defaults to **2.5%** (near long-run nominal GDP / inflation). It is an "advanced" input and must satisfy r > g∞.
4. **Enterprise value** = Σ PVₜ + PV(TV).
5. **Equity value** = EV + cash & short-term investments − total debt.
6. **Intrinsic value per share** = Equity value / **diluted** shares outstanding. Use the currency of the statements. When it differs from the trading currency (common for TASE dual-listed or ADR cases), convert at the spot FX rate.
7. **Margin of safety** = (IV − Price) / IV. The **upside** (IV − Price) / Price is also shown, since users often confuse the two.
8. **Verdict:** MoS > +10% → **Undervalued**; MoS < −10% → **Overvalued**; otherwise **Fairly valued**. The ±10% band is configurable. Many value investors require MoS ≥ 25–30% before buying, which is offered as a preset.

A **methodological note** in the UI: CFO − CapEx is after interest, so strictly it sits between FCFF and FCFE. Discounting it at WACC and then subtracting net debt is the standard *simplified* retail DCF. It is shown as such, not as an investment-bank model.

**Input guardrails:** g ∈ [−20%, +40%] (warning above 25%); r ∈ [4%, 20%]; r − g∞ ≥ 1 pp. Warnings are also shown when FCF is volatile (coefficient of variation of the last 3 years > 0.5) and when the terminal value is more than 75% of EV. A **sensitivity grid** (r ± 1 pp × g ± 2 pp) is always shown next to the point estimate.

**Default input suggestions** (prefilled; the user can overwrite them):
- g: the analyst 5-year growth estimate (already fetched by `analystRoutes.js`), capped at 20%; otherwise the 5-year FCF CAGR, capped.
- r: CAPM cost of equity, `r_f + β·ERP` (10y government yield — US Treasury for US stocks, Israeli government bond for TASE — plus ERP ≈ 5%, with β from quoteSummary). This is displayed as "suggested", never locked.

### 4.4 Reference implementation: DCF (TypeScript)

```ts
export type DcfInput = {
  fcfHistory: number[];         // annual FCF, oldest → newest
  growthRate: number;           // g   (stage 1)
  discountRate: number;         // r   (WACC)
  terminalGrowth?: number;      // g∞  default 0.025
  years?: number;               // N   default 5
  cash: number; debt: number; sharesDiluted: number; marketPrice: number;
  baseMethod?: 'latest' | 'avg3';
  fairBand?: number;            // default 0.10
};

export function dcf(input: DcfInput) {
  const { fcfHistory, growthRate: g, discountRate: r, terminalGrowth: gT = 0.025, years = 5,
          cash, debt, sharesDiluted, marketPrice, baseMethod = 'avg3', fairBand = 0.1 } = input;
  if (!(r > gT)) throw new Error('Discount rate must exceed terminal growth rate');
  if (!(sharesDiluted > 0)) throw new Error('sharesDiluted must be positive');
  if (fcfHistory.length === 0) throw new Error('No FCF history');

  const warnings: string[] = [];
  const recent = fcfHistory.slice(-3);
  const base = baseMethod === 'latest' ? fcfHistory[fcfHistory.length - 1] : mean(recent);
  if (base <= 0) warnings.push('Base FCF ≤ 0: a growth-based DCF is not meaningful');
  if (recent.length >= 3 && stdev(recent) / Math.abs(mean(recent)) > 0.5) warnings.push('FCF is volatile: low confidence');
  if (g > 0.25) warnings.push('Growth above 25%/yr for 5 years is rarely sustained');

  const projections = [];
  let pvStage1 = 0, fcf = base;
  for (let t = 1; t <= years; t++) {
    fcf *= 1 + g;
    const df = 1 / (1 + r) ** t;
    projections.push({ year: t, fcf, discountFactor: df, pv: fcf * df });
    pvStage1 += fcf * df;
  }
  const terminalValue = (fcf * (1 + gT)) / (r - gT);
  const pvTerminal = terminalValue / (1 + r) ** years;
  const enterpriseValue = pvStage1 + pvTerminal;
  const equityValue = enterpriseValue + cash - debt;
  const intrinsicPerShare = equityValue / sharesDiluted;

  const marginOfSafety = intrinsicPerShare > 0 ? (intrinsicPerShare - marketPrice) / intrinsicPerShare : null;
  const upside = (intrinsicPerShare - marketPrice) / marketPrice;
  const verdict = marginOfSafety === null ? 'N/A'
    : marginOfSafety > fairBand ? 'UNDERVALUED'
    : marginOfSafety < -fairBand ? 'OVERVALUED' : 'FAIRLY_VALUED';
  if (pvTerminal / enterpriseValue > 0.75) warnings.push('Terminal value > 75% of EV: highly sensitive to r and g∞');

  return { baseFcf: base, projections, pvStage1, terminalValue, pvTerminal, enterpriseValue,
           equityValue, intrinsicPerShare, marketPrice, marginOfSafety, upside, verdict,
           terminalShareOfEv: pvTerminal / enterpriseValue, warnings };
}

export function dcfSensitivity(input: DcfInput,
  rSteps = [-0.01, -0.005, 0, 0.005, 0.01], gSteps = [-0.02, -0.01, 0, 0.01, 0.02]) {
  return rSteps.map((dr) => gSteps.map((dg) => {
    const r = input.discountRate + dr;
    if (r <= (input.terminalGrowth ?? 0.025)) return null;
    return dcf({ ...input, discountRate: r, growthRate: input.growthRate + dg }).intrinsicPerShare;
  }));
}
```

**Worked example** (verified against a hand calculation). FCF history [90, 100, 110] → FCF₀ = 100; g = 8%, r = 9%, g∞ = 2.5%; cash 200, debt 500, 100M diluted shares, price $15. Result: Σ PV(stage 1) ≈ 486.4, PV(TV) ≈ 1,505.9, EV ≈ 1,992.3, equity ≈ 1,692.3, **IV ≈ $16.92/share**, MoS ≈ **+11.4% → Undervalued** (just outside the ±10% band), with a warning that the terminal value is 75.6% of EV. The sensitivity grid spans $12.84 (r = 10%, g = 6%) to $22.71 (r = 8%, g = 10%). This spread is why the grid is always shown next to the point estimate.

### 4.5 Data tables

```sql
CREATE TABLE fundamentals_annual (
  symbol TEXT NOT NULL, market TEXT NOT NULL, fiscal_year INT NOT NULL, period_end DATE NOT NULL,
  currency TEXT NOT NULL,
  revenue NUMERIC, net_income NUMERIC, cfo NUMERIC, capex NUMERIC,   -- capex stored as a positive outflow
  cash_sti NUMERIC, total_debt NUMERIC, shares_diluted NUMERIC,
  source TEXT NOT NULL, fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, market, fiscal_year)
);
CREATE TABLE sector_benchmarks (
  sector TEXT NOT NULL, industry TEXT, metric TEXT NOT NULL,   -- PE | PS | PFCF
  median NUMERIC, p25 NUMERIC, p75 NUMERIC, n INT,
  as_of DATE NOT NULL, source TEXT NOT NULL,
  PRIMARY KEY (sector, industry, metric, as_of)
);
```

---

## 5. Recommended external APIs and libraries

### 5.1 Market and fundamental data

| Need | Primary | Fallback / alternative | Notes |
|---|---|---|---|
| US quotes, OHLCV history | **Yahoo Finance** chart / quoteSummary (in use, unofficial) | **Polygon.io** (Massive), **Tiingo**, **Alpha Vantage** | Yahoo has no SLA and can change or rate-limit at any time. Keep the existing crumb/cache layer and add a paid fallback before relying on it for alerts. |
| TASE quotes and history | Existing TASE API/scraper (`taseQuoteApi.js`, `taseHistoryApi.js`) | **EODHD** (covers the TA exchange, `.TA` tickers), Yahoo `.TA` symbols | Check EODHD's TASE fundamentals coverage per ticker before relying on it. |
| Earnings calendar | **Finnhub** `/calendar/earnings` | FMP `/earning_calendar`, Yahoo `calendarEvents` | Finnhub's free tier is generous. Store `time_of_day` (BMO/AMC). |
| Dividends (ex/pay dates) | Yahoo `calendarEvents` + chart `events=div` (in use) | **FMP** `/stock_dividend_calendar`, Polygon `/v3/reference/dividends` | Polygon gives declaration, ex, record, and pay dates. |
| Israeli corporate events | **Maya** (maya.tase.co.il) announcements | Company IR pages | No official public API. Scrape politely with caching, or use a licensed TASE data feed. |
| Fundamentals (10y statements) | **Financial Modeling Prep** (income, cash-flow, balance-sheet, key-metrics, ratios) | **EODHD** fundamentals, SEC **EDGAR XBRL** "companyfacts" (free, US only, authoritative) | EDGAR is a good free source for US FCF history. |
| Sector multiples | FMP sector/industry P/E | Damodaran industry datasets (annual, free) | Label the source and date on screen. |
| FX (ILS) | Bank of Israel representative rates (in use via `/api/exchange-rate`) | exchangerate.host, ECB | Month-end rate for reports. |
| CPI (Israel) | CBS API (in use via `cpiRoutes.js`) | — | Real-gain tax for TLH and profit-taking. |
| Risk-free rate | FRED `DGS10` (US 10y) | Bank of Israel yield curve (IL 10y) | DCF "suggested r". |

**Integration pattern:** put every provider behind a `MarketDataProvider` interface (`getBars`, `getEvents`, `getFundamentals`), with a TTL cache and in-flight de-duplication (the pattern `dividendRoutes.js` already uses), a per-provider token-bucket rate limiter, and ordered fallback. API keys stay server-side, in `.env`.

### 5.2 Libraries

| Purpose | Library |
|---|---|
| PDF rendering | **puppeteer** (installed) or **playwright**; `react-dom/server` for the template; **Gotenberg** / Browserless for scale-out |
| Charts in the report | **recharts** (installed), static-rendered SVG |
| Email delivery | **Resend** or **Postmark** (transactional); Nodemailer + SES as a self-managed option |
| Web push (optional) | **web-push** (VAPID) |
| File storage | **@supabase/supabase-js** Storage (installed); S3 / R2 as an alternative |
| Job queue | The Postgres `jobs` table (§0.2); **pg-boss** if you want a maintained Postgres-backed queue; **BullMQ** only if Redis is added |
| Scheduling | GitHub Actions `schedule`, Render Cron Jobs, or Supabase `pg_cron` |
| Numerics | Plain `number` (float64) is sufficient for analytics; round only at presentation. Use **decimal.js** only if the app ever records money *transactions* that must reconcile to the agora. |
| Dates / time zones | **date-fns-tz** or **Luxon** for market-session times (Asia/Jerusalem, America/New_York; both have DST) |
| Validation | **zod** for API payloads (alert rules, DCF inputs, report model) |

---

## 6. Suggested delivery order

| Phase | Scope | Why this order |
|---|---|---|
| 1 | §0.2 job runner, §0.3 `user_holdings`; MWR/XIRR next to the existing TWR; DCF engine and UI (client-side, inputs from existing Yahoo data) | Highest user value for the least infrastructure. The DCF and XIRR are pure functions. |
| 2 | Anomaly engine + alerts table + in-app bell; event calendar (US first) | Needs the job runner and the holdings table. |
| 3 | Monthly-sync state machine + Puppeteer report (worker) + storage + email link | Needs the snapshot and flow data to be trustworthy. Rendering needs a worker plan. |
| 4 | `transactions` ledger (sells, withdrawals, dividends) → exact MWR, realized-gains-aware TLH, full cash-flow report; recommendation engine; multiples with sector benchmarks; TASE calendar via Maya | Paid fundamentals data and the ledger migration are the largest pieces. |

**Testing strategy.** Every calculation (`detectAnomalies`, `trueTwr`, `xirr`, `dcf`, each recommendation rule, `buildReportModel`) is a pure function with Jest tests in `src/utils/*.test.js`, following the existing convention. Include known-answer tests: Excel XIRR, the hand-computed DCF above, and TWR sub-period products. Also test edge cases: empty series, all-positive flows, r ≤ g∞, zero volume, split days, and FCF ≤ 0. The PDF is covered by a snapshot test of `ReportModel` plus a smoke render that asserts the page count and that the text layer contains the Hebrew headings.

---

*All recommendations produced by these modules are rule-based, informational outputs and not investment or tax advice. The UI must say so wherever a Sell/Trim/Harvest action or a valuation verdict is shown.*

---

## 7. Implementation notes (as built)

All four steps plus the Step 0 ledger are implemented. Where the build differs from the design above, this section says so.

| Area | Where | Notes |
|---|---|---|
| Transactions ledger | `src/shared/transactionLedger.js`, `server/transactionRoutes.js`, `/transactions` | Lot rows hold only what is still owned. Each SELL stores a snapshot of the units it closed, and `expandHoldingsWithClosedLots` brings them back for history. Withdrawals are negative entries in the account's `deposits` list. The ledger row and the portfolio change are saved in one DB transaction. |
| Shared code | `src/shared/*.js` | CommonJS without spread or `class extends`, so the untranspiled server and the CRA bundle can both use it. `sharedModules.test.js` enforces this. |
| New tables | `server/featureStore.js` over `server/sqlAdapter.js` | Written once for SQLite and Postgres. Integration tests run on both when `TEST_DATABASE_URL` is set. |
| Holdings index | `server/holdingsIndex.js` | **Deviation:** derived from the stored portfolios on each scan rather than a `user_holdings` table, so it can never drift. |
| Alerts | `shared/anomalyDetection.js`, `server/alertEngine.js`, `/alerts` | As specified. TASE volume field names are read defensively (the TASE API is undocumented). |
| Event calendar | `shared/eventCalendar.js` | **US holdings only.** TASE dates come from Maya, which has no public API. |
| Scheduling | `.github/workflows/scheduled-jobs.yml`, `server/internalJobRoutes.js`, `src/worker.js` | Needs the `STOCKVIEW_API_URL` and `CRON_SECRET` repository secrets, and `CRON_SECRET` on the server. |
| Exact TWR / MWR | `utils/performanceReturns.js`, analytics page | Exact TWR ignores the difference between a sale's fill price and that day's close. |
| Recommendations | `utils/recommendationEngine.js`, `/recommendations` | **Deviation:** computed in the browser (where CPI and holdings already live) rather than `GET /api/recommendations`. Preferences are stored via `/api/preferences/recommendations`. |
| Monthly report | `server/report/*`, `/reports` | The HTML is built with template strings rather than React SSR, since the server is not transpiled. Storage is Supabase when configured, otherwise local disk. E-mail via Resend is opt-in. |
| Valuation | `shared/valuationMultiples.js`, `utils/dcfValuation.js`, `server/fundamentals.js`, `/valuation` | Statements come from Yahoo's timeseries (about 4-5 years) or FMP with `FMP_API_KEY`. The sector benchmark is the median of Yahoo's peer list. **US symbols only.** |
