\echo Use "CREATE EXTENSION pg_session_identity" to load this file. \quit

CREATE FUNCTION session_identity.current_sub()
RETURNS text
AS 'MODULE_PATHNAME', 'pg_session_identity_current_sub'
LANGUAGE C STABLE PARALLEL UNSAFE;

CREATE FUNCTION session_identity.current_jti()
RETURNS text
AS 'MODULE_PATHNAME', 'pg_session_identity_current_jti'
LANGUAGE C STABLE PARALLEL UNSAFE;

CREATE FUNCTION session_identity.current_ver()
RETURNS integer
AS 'MODULE_PATHNAME', 'pg_session_identity_current_ver'
LANGUAGE C STABLE PARALLEL UNSAFE;

CREATE FUNCTION session_identity.current_exp()
RETURNS timestamptz
AS 'MODULE_PATHNAME', 'pg_session_identity_current_exp'
LANGUAGE C STABLE PARALLEL UNSAFE;

CREATE FUNCTION session_identity.current_claims()
RETURNS jsonb
AS 'MODULE_PATHNAME', 'pg_session_identity_current_claims'
LANGUAGE C STABLE PARALLEL UNSAFE;

REVOKE EXECUTE ON FUNCTION session_identity.current_sub() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION session_identity.current_jti() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION session_identity.current_ver() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION session_identity.current_exp() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION session_identity.current_claims() FROM PUBLIC;
