#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/../"

: "${PG_TUNNEL_TOKEN:?PG_TUNNEL_TOKEN is not set; run this task through mise}"

echo "websocat: tcp-l:127.0.0.1:15432 -> ws://localhost:5173/api/pg"

while true; do
  websocat --oneshot -b -E \
    -H="Authorization: Bearer $PG_TUNNEL_TOKEN" \
    tcp-l:127.0.0.1:15432 ws://localhost:5173/api/pg || sleep 0.5
done
