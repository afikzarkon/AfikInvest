---
name: tradingagents
description: >-
  Runs TradingAgents (Tauric Research's multi-agent LLM framework, vendored as
  the tools/tradingagents submodule) on a stock: market, sentiment, news and
  fundamentals analysts work in parallel, bull and bear researchers debate,
  a trader proposes, a risk team and a portfolio manager decide, and it
  returns a five-tier rating (Buy / Overweight / Hold / Underweight / Sell)
  with a full report. Can also score past decisions with `backtest`. Use
  when the user says "run TradingAgents", "AI analysis of NVDA", "what do the
  agents think of TSLA", "multi-agent analysis", "bull vs bear on X", or
  wants a second opinion beside /trader-* skills. Research only, never places
  orders.
argument-hint: "TICKER [YYYY-MM-DD]"
---

# tradingagents

TradingAgents lives in `tools/tradingagents` (git submodule, pinned commit) with
its own virtualenv. Paths below are relative to the AfikInvest repo root.

## 1. Make sure it is installed

```bash
test -x tools/tradingagents/.venv/bin/tradingagents || scripts/setup-tradingagents.sh
```

## 2. Make sure an LLM key is set

It calls an LLM provider many times per run (dozens of calls; with deep models
a run can cost real money and take several minutes). Keys are read from the
environment or from `tools/tradingagents/.env` (git-ignored inside the
submodule). Check which key exists **without printing its value**:

```bash
cd tools/tradingagents && grep -oE '^[A-Z_]+_API_KEY=.+' .env 2>/dev/null | cut -d= -f1; env | grep -oE '^(ANTHROPIC|OPENAI|GOOGLE|OPENROUTER|DEEPSEEK|XAI)_API_KEY' ; true
```

If none is set, stop and ask the user to add one to `tools/tradingagents/.env`
themselves (never ask them to paste a key into the chat). Without a key,
Ollama (`TRADINGAGENTS_LLM_PROVIDER=ollama`) or a ChatGPT plan
(`tradingagents login chatgpt`) also work.

## 3. Run an analysis (non-interactive)

Default to Anthropic when `ANTHROPIC_API_KEY` is present; otherwise use the
provider whose key exists. Tell the user the provider, models and ticker
before starting.

```bash
cd tools/tradingagents
export TRADINGAGENTS_LLM_PROVIDER=anthropic \
       TRADINGAGENTS_QUICK_THINK_LLM=claude-sonnet-5 \
       TRADINGAGENTS_DEEP_THINK_LLM=claude-opus-5-5 \
       TRADINGAGENTS_OUTPUT_LANGUAGE=English \
       TRADINGAGENTS_MAX_DEBATE_ROUNDS=1 TRADINGAGENTS_MAX_RISK_ROUNDS=1 \
       TRADINGAGENTS_NO_UPDATE_CHECK=1 \
       TRADINGAGENTS_RESULTS_DIR="$PWD/../../tradingagents-results"
.venv/bin/tradingagents --ticker NVDA --date "$(date +%F)" \
  --analysts market,social,news,fundamentals --save --no-show --html
```

- `--ticker`: any Yahoo Finance symbol (`AAPL`, `TEVA.TA`, `0700.HK`, `BTC-USD`).
- `--date`: the analysis date; default today (New York trading day).
- `--analysts`: any of `market,social,news,fundamentals`.
- `TRADINGAGENTS_OUTPUT_LANGUAGE=Hebrew` if the user wants the report in Hebrew.
- More debate rounds = deeper but slower and costlier.
- `--portfolio book.json` makes the trader and risk team size against real
  holdings: `{"cash": 25000, "currency": "USD", "positions": [{"ticker": "NVDA", "quantity": 120, "average_price": 150}]}`.
- Run it in the background (it takes minutes) and wait for it to finish.

Reports land in `tradingagents-results/` at the repo root (git-ignored),
including `complete_report.html`. Read the final decision and the portfolio
manager's reasoning and summarise: the rating, the main bull and bear points,
and the risks. Say plainly that it is an LLM research opinion, not financial
advice.

## 4. Backtest past decisions

```bash
cd tools/tradingagents && .venv/bin/tradingagents backtest --help
```

## Updating TradingAgents

```bash
git -C tools/tradingagents fetch --tags && git -C tools/tradingagents checkout <tag-or-commit>
scripts/setup-tradingagents.sh && git add tools/tradingagents
```
