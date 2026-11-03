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
