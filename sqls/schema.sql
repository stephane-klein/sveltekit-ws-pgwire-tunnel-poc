DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO public;
GRANT ALL ON SCHEMA public TO postgres;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO public;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO public;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO public;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
COMMENT ON SCHEMA public IS 'standard public schema';

CREATE TABLE contacts (
    id         BIGINT                   GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id   TEXT                     NOT NULL,
    firstname  TEXT                     NOT NULL,
    lastname   TEXT                     NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

INSERT INTO contacts (owner_id, firstname, lastname)
SELECT
    CASE WHEN n % 2 = 0 THEN 'alice' ELSE 'bob' END,
    'John' || n,
    'Doe' || n
  FROM generate_series(1, 50) AS n
  ON CONFLICT DO NOTHING;

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY contacts_owner ON contacts
  USING (owner_id = (SELECT session_identity.current_sub()))
  WITH CHECK (owner_id = (SELECT session_identity.current_sub()));

GRANT SELECT, INSERT, UPDATE, DELETE ON contacts TO app_user;
