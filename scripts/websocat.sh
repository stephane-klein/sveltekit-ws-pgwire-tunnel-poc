#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/../"

: "${PG_SESSION_TOKEN:?PG_SESSION_TOKEN is not set; run 'mise run make-token <sub>' and export it}"

echo "websocat: tcp-l:127.0.0.1:15432 -> ws://localhost:5173/api/pg"

while true; do
  websocat --oneshot -b -E \
    -H="Authorization: Bearer $PG_SESSION_TOKEN" \
    tcp-l:127.0.0.1:15432 ws://localhost:5173/api/pg || sleep 0.5
done
