#!/bin/bash
cd "$(dirname "$0")/.."

[ -f .env ] && set -a && source .env && set +a

PORT="${PORT:-58146}"

open -na "Google Chrome" --args --app="http://localhost:${PORT}"