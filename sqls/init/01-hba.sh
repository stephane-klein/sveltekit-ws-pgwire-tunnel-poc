#!/usr/bin/env bash
set -e

# app_user has no password, but access is protected by the pg_session_identity
# extension. It verifies the JWT in the app.token startup parameter during
# connection startup and rejects the connection when the token is missing or
# invalid.
#
# Important: keep this role in sync with pg_session_identity.role in
# compose.yaml.
#
# Insert this rule before the default rules so app_user matches first.
sed -i '1i host appdb app_user all trust' "$PGDATA/pg_hba.conf"
