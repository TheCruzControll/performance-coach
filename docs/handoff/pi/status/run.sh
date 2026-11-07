#!/bin/sh
# Start the status server detached. Idempotent. `run.sh stop` stops it.
cd "$(dirname "$0")" || exit 1
PID=server.pid
running() { [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; }
if [ "$1" = stop ]; then
  running && kill "$(cat "$PID")" && echo stopped
  rm -f "$PID"
  exit 0
fi
if running; then
  echo "already running (pid $(cat "$PID"))"
else
  nohup python3 server.py >server.log 2>&1 &
  echo $! >"$PID"
  echo "started (pid $!)"
fi
echo "http://127.0.0.1:8765/"
