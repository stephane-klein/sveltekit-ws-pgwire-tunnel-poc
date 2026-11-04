#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/../"

: "${PGUSER:?PGUSER is not set; run 'mise run psql-direct <role>'}"
: "${PG_TUNNEL_DATABASE:=appdb}"

if ! ss -ltn 2>/dev/null | grep -q '127.0.0.1:15433'; then
  echo "websocat is not listening on 127.0.0.1:15433; run 'mise run websocat-direct' first" >&2
  exit 1
fi

psql "host=127.0.0.1 port=15433 user=$PGUSER dbname=$PG_TUNNEL_DATABASE sslmode=disable" "$@"
