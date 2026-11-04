# sveltekit-ws-pgwire-tunnel-poc

The goal of this POC is to try to create a tunnel that carries the
[PostgreSQL wire protocol](https://www.postgresql.org/docs/current/protocol.html) over a
[WebSocket](https://en.wikipedia.org/wiki/WebSocket), built into a
[SvelteKit](https://svelte.dev/docs/kit/) application served by
[adapter-node](https://svelte.dev/docs/kit/adapter-node).

Why this POC? Because for years I have wanted to let a CLI, or even an end user, run SQL directly on
the data of an application, in addition to, or instead of, a REST API. In my experience, an SQL
query is more flexible, more expressive and more efficient than the same feature written behind a
REST API.

Of course, some people will see this as a security risk. That is why these users reach the
PostgreSQL database only through a role with limited permissions. To understand these mechanisms, I
recommend reading the
[Creating roles](https://postgraphile.org/postgraphile/5/required-knowledge#creating-roles),
[Granting permissions](https://postgraphile.org/postgraphile/5/required-knowledge#granting-permissions)
and
[Creating security policies](https://postgraphile.org/postgraphile/5/required-knowledge#creating-security-policies)
sections of the [PostGraphile](https://postgraphile.org/postgraphile/5/) documentation.

## Architecture

```text
psql
  │ 127.0.0.1:15432, sslmode=disable
  ▼
websocat              (Authorization: Bearer <JWT>)
  │ WSS /api/pg
  ▼
SvelteKit tunnel      (rewrites StartupMessage)
  │ TCP
  ▼
PostgreSQL            (pg_session_identity + RLS)
```

Websocat is <https://github.com/vi/websocat>.

The SvelteKit endpoint verifies the JWT during the WebSocket handshake. It then
opens a TCP connection to PostgreSQL and rewrites the client's `StartupMessage`,
the first message of the PostgreSQL wire protocol. The `user` and `database`
values sent by `psql` are discarded, and the same token is copied into
`app.token`. The rewritten PostgreSQL startup message contains the following
parameters:

```text
user      = app_user
database  = appdb
app.token = <JWT>
```

PostgreSQL authenticates `app_user` with `trust`, which means no password.
Access to this role is protected by the
[pg_session_identity](./pg_session_identity/) extension.

The [pg_session_identity](./pg_session_identity/) extension rejects the
connection unless the JWT is valid. The application user is the `sub` claim.
There is no PostgreSQL password for the tunnel user.

The `pg_session_identity` extension verifies the JWT at connection startup and
stores its claims in backend memory for the lifetime of the session.
`session_identity.current_sub()` returns the `sub` claim of that verified
token. Unlike a custom setting such as [`current_setting('app.user')`](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADMIN-SET),
it has no setter: `SET`, `RESET` and `DISCARD ALL` cannot change it. PostgreSQL row-level
security (RLS) policies can therefore rely on it to restrict access to rows:

```sql
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY contacts_owner ON contacts
  USING (owner_id = (SELECT session_identity.current_sub()))
  WITH CHECK (owner_id = (SELECT session_identity.current_sub()));

GRANT SELECT, INSERT, UPDATE, DELETE ON contacts TO app_user;
```

Now go to the [Getting started](#getting-started) section to run a demo.

## Getting started

```sh
$ mise install
$ pnpm install
$ podman compose up -d --build
$ mise run load-sql sqls/schema.sql
$ pnpm run dev
```

Open <http://localhost:5173/>. The web application connects as `postgres` and
sees all rows.

## Connect through the tunnel

Generate a token for a user:

```sh
$ export PG_SESSION_TOKEN="$(mise run make-token alice)"
```

Start the bridge:

```sh
$ mise run websocat
```

In a second terminal:

```sh
$ mise run psql-tunnel
```

No password, no database name, no user name. The tunnel forces them.

Inside `psql`:

```sql
select current_user;                   -- app_user
select session_identity.current_sub(); -- alice
select count(*) from contacts;         -- 25
```

Alice sees only the rows with `owner_id = 'alice'`. The RLS policy uses
`session_identity.current_sub()`.

To test another user, stop `websocat`, generate a token for `bob`, and restart
it:

```sh
$ export PG_SESSION_TOKEN="$(mise run make-token bob)"
$ mise run websocat
```

## Query /app/pg WebSocket from a Node.js script

The script uses neither `websocat` nor a local TCP port. It opens a WebSocket
to `/api/pg`, presents it to postgres.js as a duplex stream, and runs
`select * from contacts`.

```sh
$ export PG_SESSION_TOKEN="$(mise run make-token alice)"
$ node src/cli/query_contacts.js
```

Or, from the devbox, in one command:

```sh
$ mise run query-contacts alice
```

The rows are filtered by the RLS policy for `alice`.
