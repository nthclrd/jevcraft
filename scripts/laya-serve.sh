#!/bin/sh
# Local Laya decision engine: creates .venv on first run, installs laya[serve], then serves the Jev-compatible API.
# Needs Python 3.10 or newer on PATH. Point LAYA_HOST at 0.0.0.0 (and set LAYA_API_KEY) to serve another machine.
set -e
cd "$(dirname "$0")/.."
VENV="${LAYA_VENV:-.venv}"
if [ ! -x "$VENV/bin/laya-serve" ]; then
  python3 -m venv "$VENV"
  "$VENV/bin/python" -m pip install --quiet --upgrade pip
  "$VENV/bin/python" -m pip install "laya[serve]"
fi
export LAYA_HOST="${LAYA_HOST:-127.0.0.1}"
export LAYA_PORT="${LAYA_PORT:-8000}"
# english is what the bot's states are written in; use multilingual (or a comma list) for non-English players.
export LAYA_MODELS="${LAYA_MODELS:-english}"
exec "$VENV/bin/laya-serve"
