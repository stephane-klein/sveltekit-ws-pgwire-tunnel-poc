#!/usr/bin/env bash
set -e

if [ $# -ne 1 ]; then
  echo "Usage: $0 <file.sql>" >&2
  exit 1
fi

# Resolve the path before changing directory, so a relative path is read
# from the caller's working directory.
sql_file=$(realpath "$1")

cd "$(dirname "$0")/../"

psql "${MY_APP_POSTGRES_URL:?PostgreSQL container is not running}" \
  --single-transaction \
  --set ON_ERROR_STOP=1 \
  --file "$sql_file"
