#!/bin/bash
set -e
PORT=58146
BINARY="remote-terminal"
LOG="/tmp/remote-terminal.log"
cd "$(dirname "$0")"

if lsof -ti :$PORT >/dev/null 2>&1; then
  echo "Stopping existing process on port $PORT..."
  lsof -ti :$PORT | xargs kill 2>/dev/null
  sleep 1
fi

echo "Building..."
go build -o $BINARY .

echo "Starting on port $PORT..."
PORT=$PORT ./$BINARY > "$LOG" 2>&1 &
echo "PID: $!"
sleep 1

if lsof -ti :$PORT >/dev/null 2>&1; then
  echo "✅ Running on http://localhost:$PORT"
else
  echo "❌ Failed to start. Check $LOG"
  cat "$LOG"
  exit 1
fi
