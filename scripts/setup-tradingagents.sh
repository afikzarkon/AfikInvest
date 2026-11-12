#!/usr/bin/env bash
# Sets up TradingAgents (tools/tradingagents, a git submodule) in its own
# Python virtualenv. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

git submodule update --init tools/tradingagents
cd tools/tradingagents

if command -v uv >/dev/null 2>&1; then
  [ -d .venv ] || uv venv --python 3.13 .venv
  uv pip install --python .venv/bin/python .
else
  [ -d .venv ] || python3 -m venv .venv   # needs Python 3.11+
  .venv/bin/pip install --upgrade pip
  .venv/bin/pip install .
fi

[ -f .env ] || cp .env.example .env
echo
echo "TradingAgents is ready: tools/tradingagents/.venv/bin/tradingagents"
echo "Put your LLM API key (e.g. ANTHROPIC_API_KEY) in tools/tradingagents/.env"
