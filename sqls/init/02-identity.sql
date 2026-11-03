SELECT 'CREATE ROLE app_user LOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user')
\gexec

CREATE SCHEMA IF NOT EXISTS session_identity;

CREATE EXTENSION pg_session_identity SCHEMA session_identity;

GRANT USAGE ON SCHEMA session_identity TO app_user;
GRANT EXECUTE ON FUNCTION session_identity.current_sub() TO app_user;
GRANT EXECUTE ON FUNCTION session_identity.current_jti() TO app_user;
GRANT EXECUTE ON FUNCTION session_identity.current_exp() TO app_user;
GRANT EXECUTE ON FUNCTION session_identity.current_claims() TO app_user;
