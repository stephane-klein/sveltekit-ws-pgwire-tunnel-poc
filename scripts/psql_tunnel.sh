#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/../"

if ! ss -ltn 2>/dev/null | grep -q '127.0.0.1:15432'; then
  echo "websocat is not listening on 127.0.0.1:15432; run 'mise run websocat' first" >&2
  exit 1
fi

psql "host=127.0.0.1 port=15432 sslmode=disable"
