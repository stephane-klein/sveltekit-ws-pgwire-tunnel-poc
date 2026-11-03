# pg_session_identity — PostgreSQL extension

Pin a verified identity to a PostgreSQL session.

A tunnel or proxy injects a signed JWT into the PostgreSQL startup packet as
`app.token`. The extension verifies the token during authentication and stores
its claims in backend memory. SQL functions expose the identity, and there is
no setter: `SET`, `RESET` and `DISCARD ALL` cannot change it.

## How it works

```text
psql
  │ StartupMessage: user=app_user, database=appdb, app.token=<JWT>
  ▼
PostgreSQL
  - ClientAuthentication_hook
      reads app.token from port->guc_options
      verifies HS256 signature and exp
      stores sub, jti, exp, claims in TopMemoryContext
      clears app.token
  - pg_hba: trust for app_user from the tunnel host
  ▼
psql: SELECT session_identity.current_sub();  -- alice
```

The hook runs after `pg_hba` authentication, and before PostgreSQL sends
`AuthenticationOk`. It reads `port->guc_options` because the startup GUCs are
applied later in `InitPostgres()`.

### Token example

The `app.token` startup parameter carries the whole compact token, dots
included. For example, with `pg_session_identity.secret = 'change-me'`:

```text
eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSIsImp0aSI6IjRhM2MwZjJlLTEyMzQtNGE1Yi04YzdkLWVmMTIzNDU2Nzg5MCIsImV4cCI6MTc5MDAwMDAwMH0.-kfMrT0ZEjhtZgnWnOVuueUluK1XIRko7fNmesjFlaQ
```

A JWT is three base64url parts separated by dots:

```text
<header>.<payload>.<signature>
```

The first part is the header. It is a JSON object that describes the token:

```jsonc
{
  "alg": "HS256" // signature algorithm
}
```

The second part is the payload. It is a JSON object that carries the claims:

```jsonc
{
  "sub": "alice",                                // application user id
  "jti": "4a3c0f2e-1234-4a5b-8c7d-ef1234567890", // token id, for per-token revocation
  "exp": 1790000000                              // expiry, Unix seconds
}
```

The third part is the signature. It is not JSON: it is the HMAC-SHA256 of
`<header>.<payload>`, encoded in base64url, using `pg_session_identity.secret`.

The token is signed, not encrypted. Anyone who sees it can
read the claims. Only the signature protects them. The `exp` above is in the
past; it is shown for format only.

A small generator with Node.js:

```js
import { createHmac, randomUUID } from 'node:crypto';

const b64 = (value) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

const header = b64({ alg: 'HS256' });
const payload = b64({
  sub: 'alice',
  jti: randomUUID(),
  exp: Math.floor(Date.now() / 1000) + 3600
});
const signature = createHmac('sha256', 'change-me')
  .update(`${header}.${payload}`)
  .digest('base64url');

console.log(`${header}.${payload}.${signature}`);
```

## Requirements

- PostgreSQL 18.
- `shared_preload_libraries = 'pg_session_identity'`.
- A shared PostgreSQL role for the tunnel, e.g. `app_user`.
- An HS256 JWT issuer, usually the application or the tunnel.

## Build

```sh
$ make
$ sudo make install
```

## Container

```sh
$ podman build -t pg-session-identity .
```

The image installs the extension. Preload it with:

```sh
$ podman run --rm \
  -e POSTGRES_PASSWORD=password \
  pg-session-identity \
  postgres -c shared_preload_libraries=pg_session_identity
```

## Configuration

| GUC | Default | Description |
|---|---|---|
| `pg_session_identity.secret` | none | HS256 secret. Required. |
| `pg_session_identity.role` | `app_user` | PostgreSQL role protected by the hook. |
| `pg_session_identity.token_parameter` | `app.token` | Startup packet parameter carrying the JWT. |
| `pg_session_identity.leeway` | `30` | Clock skew in seconds. |
| `pg_session_identity.enabled` | `on` | Enable verification. |
| `pg_session_identity.require_jti` | `on` | Require a `jti` claim. |

Note: GUC means Grand Unified Configuration.

Example `postgresql.conf`:

```conf
shared_preload_libraries = 'pg_session_identity'
pg_session_identity.secret = 'change-me'
pg_session_identity.role = 'app_user'
```

Restart PostgreSQL after changing `shared_preload_libraries`.

## Setup

```sql
CREATE ROLE app_user LOGIN;

CREATE SCHEMA session_identity;
CREATE EXTENSION pg_session_identity SCHEMA session_identity;

GRANT USAGE ON SCHEMA session_identity TO app_user;
GRANT EXECUTE ON FUNCTION session_identity.current_sub() TO app_user;
GRANT EXECUTE ON FUNCTION session_identity.current_jti() TO app_user;
GRANT EXECUTE ON FUNCTION session_identity.current_exp() TO app_user;
GRANT EXECUTE ON FUNCTION session_identity.current_claims() TO app_user;
```

`app_user` has no password. It is authenticated by the token, not by a
password. In `pg_hba.conf`:

```conf
host    appdb    app_user    127.0.0.1/32    trust
```

Restrict this line to the host that runs the tunnel.

## JWT format

The token must use HS256. It has three parts:

```text
<header>.<payload>.<signature>
```

The header:

```jsonc
{
  "alg": "HS256" // signature algorithm
}
```

The payload:

```jsonc
{
  "sub": "alice",                                // application user id, required
  "jti": "4a3c0f2e-1234-4a5b-8c7d-ef1234567890", // token id, required by default
  "exp": 1790000000                              // expiry in Unix seconds, required
}
```

The signature is the HMAC-SHA256 of `<header>.<payload>` with the secret,
encoded in base64url. It is not JSON and is not shown here.

The comments are documentation only; JSON does not allow them.

The extension also accepts optional `ver`, `aud`, `iss` and `nbf` claims.
They are not part of the minimal token. `current_ver()` returns the `ver` value,
or `0` when it is absent; grant it to `app_user` if you use `ver`.

## SQL API

```sql
SELECT session_identity.current_sub();     -- alice
SELECT session_identity.current_jti();     -- token id
SELECT session_identity.current_exp();     -- timestamptz
SELECT session_identity.current_claims();  -- jsonb payload
```

All functions are `STABLE PARALLEL UNSAFE`. They return `NULL` when no identity
was set.

## Tunnel integration

The tunnel must rewrite the startup packet:

```text
user      = app_user
database  = appdb
app.token = <JWT>
```

It must remove any client-supplied `app.token`, `options`, and other `app.*`
parameters. Reject the WebSocket with 401 when the JWT is missing or invalid.

The tunnel must see the startup packet in clear text. Use
`sslmode=disable` on the local hop (`psql` to `websocat`); the WebSocket
connection carries the encryption. If you need TLS end to end, the tunnel must
terminate TLS and re-encrypt to PostgreSQL.

## Revocation

The extension does not revoke tokens by itself. It exposes `jti` and `exp` so
that you can add a session table:

```sql
CREATE TABLE app.sessions (
  jti           text PRIMARY KEY,
  sub           text NOT NULL,
  pid           int,
  backend_start timestamptz,
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);
```

To revoke one token:

```sql
UPDATE app.sessions SET revoked_at = now() WHERE jti = '...';
```

To revoke all tokens of a user:

```sql
UPDATE app.sessions SET revoked_at = now() WHERE sub = 'alice';
```

The `sub` column is what makes the second query possible. You do not need to
know the individual `jti` values.

To close the sessions that are already open:

```sql
SELECT pg_terminate_backend(s.pid)
FROM app.sessions s
JOIN pg_stat_activity a
  ON a.pid = s.pid
 AND a.backend_start = s.backend_start
WHERE s.sub = 'alice'
  AND s.revoked_at IS NOT NULL;
```

A login trigger can check `revoked_at` after the hook. `pg_terminate_backend()`
closes the live backend immediately.

## Security notes

- HS256 uses a symmetric secret. The tunnel and PostgreSQL share it; either
  side can mint tokens. For a strict issuer/verifier split, use ES256 or RS256.
- The token is the only credential for `app_user`. A stolen token grants a
  database session until `exp`.
- Never log the token. The extension logs only `sub` and `jti`.
- Keep `pg_session_identity.secret` out of the repository.
- `app_user` must not be a member of other roles, and must not be a superuser.
- The `trust` line in `pg_hba.conf` must be restricted to the tunnel host.

## Limitations

- HS256 only in version 1.0.
- No JWKS rotation.
- No built-in revocation; the extension exposes `jti` and `exp`.
- The startup packet must be readable by the tunnel, so `sslmode=disable` on
  the local hop.
- `shared_preload_libraries` is mandatory; loading the library with `LOAD` is
  too late for the authentication hook.

## License

MIT.
