#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Load .env safely — reads KEY=VALUE lines only, never executes shell code.
# Leading `~/` in a value is expanded to $HOME; other variable references
# like $HOME inside values are not expanded.
_load_env() {
  if [ -f .env ]; then
    while IFS='=' read -r key value; do
      case "$key" in
        ''|\#*) continue ;;
        *)
          case "$value" in
            '~'|'~/'*) value="$HOME${value#\~}" ;;
          esac
          export "$key=$value"
          ;;
      esac
    done < .env
  fi
}
_load_env

PORT="${PORT:-58146}"

# ── Check server is running ───────────────────────────────────
if ! curl -sf --max-time 2 "http://localhost:${PORT}/api/ping" >/dev/null 2>&1; then
  echo "Error: dongminal server is not running on port ${PORT}"
  echo "Start it first: ./scripts/start.sh"
  exit 1
fi

# ── Detect OS and open frameless window ───────────────────────
URL="http://localhost:${PORT}"

case "$(uname -s)" in
  Darwin)
    open -na "Google Chrome" --args --app="$URL"
    ;;
  Linux)
    for browser in google-chrome google-chrome-stable chromium chromium-browser; do
      if command -v "$browser" >/dev/null 2>&1; then
        "$browser" --app="$URL" &
        exit 0
      fi
    done
    echo "Error: No supported browser found (tried: google-chrome, chromium)"
    echo "Install Chrome or Chromium, then retry."
    exit 1
    ;;
  *)
    echo "Error: unsupported OS ($(uname -s))"
    exit 1
    ;;
esac
