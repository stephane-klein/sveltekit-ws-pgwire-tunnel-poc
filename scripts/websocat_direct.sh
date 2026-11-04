#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/../"

: "${PG_TUNNEL_DIRECT_TOKEN:?PG_TUNNEL_DIRECT_TOKEN is not set; configure it in .envrc.local}"

echo "websocat: tcp-l:127.0.0.1:15433 -> ws://localhost:5173/api/pg (direct)"

while true; do
  websocat --oneshot -b -E \
    -H="Authorization: Bearer $PG_TUNNEL_DIRECT_TOKEN" \
    tcp-l:127.0.0.1:15433 ws://localhost:5173/api/pg || sleep 0.5
done
