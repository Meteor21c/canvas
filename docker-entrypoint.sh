#!/bin/sh
set -eu
umask 077
# Fail before starting either child if the persistent volume is not writable.
test -w /app/data || { printf '%s\n' 'Canvas data volume must be writable by uid 1000' >&2; exit 1; }
PORT=8080 /app/server &
API_PID=$!
cd /app/web
PORT=3000 node server.js &
WEB_PID=$!
shutdown() {
  trap - INT TERM
  kill -TERM "$API_PID" "$WEB_PID" 2>/dev/null || true
  wait "$API_PID" 2>/dev/null || true
  wait "$WEB_PID" 2>/dev/null || true
  exit 0
}
trap shutdown INT TERM
while kill -0 "$API_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null; do sleep 1; done
kill -TERM "$API_PID" "$WEB_PID" 2>/dev/null || true
wait "$API_PID" 2>/dev/null || true
wait "$WEB_PID" 2>/dev/null || true
exit 1
