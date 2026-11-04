import postgres from 'postgres';
import { openPgSocket } from './ws_pg_socket.js';

const url = process.env.PG_TUNNEL_URL ?? 'ws://localhost:5173/api/pg';
const token = process.env.PG_SESSION_TOKEN;
const insecure = process.env.PG_TUNNEL_INSECURE === '1';

const CONNECTION_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH']);

if (!token) {
	console.error(
		'query-contacts: PG_SESSION_TOKEN is not set.\n' +
			'Example: export PG_SESSION_TOKEN="$(mise run make-token alice)"'
	);
	process.exit(2);
}

let pathname;

try {
	pathname = new URL(url).pathname;
} catch {
	console.error(`query-contacts: PG_TUNNEL_URL is not a valid URL: ${url}`);
	process.exit(2);
}

if (pathname !== '/api/pg') {
	console.error(
		'query-contacts: PG_TUNNEL_URL must point exactly to /api/pg, without a trailing slash.'
	);
	process.exit(2);
}

let sql;

try {
	sql = postgres({
		host: 'ws-tunnel',
		port: 1,
		user: 'tunnel',
		database: 'appdb',
		ssl: false,
		max: 1,
		connect_timeout: 10,
		connection: { application_name: 'query-contacts' },
		socket: () => openPgSocket({ url, token, insecure })
	});

	const rows = await sql`select * from contacts`.signal(AbortSignal.timeout(30_000));

	console.table(rows);
	console.log(`${rows.length} row(s)`);
} catch (err) {
	console.error(`query-contacts: ${explain(err)}`);
	process.exitCode = 1;
} finally {
	if (sql) await sql.end({ timeout: 5 }).catch(() => {});
}

function explain(err) {
	const message = String(err?.message ?? err);

	if (isConnectionError(err)) {
		return `cannot reach ${url}. Is the dev server running? Check the host and port in PG_TUNNEL_URL.`;
	}
	if (message.startsWith('Unexpected server response: 401')) {
		return 'the tunnel rejected the token (HTTP 401). It is missing, invalid, or expired.';
	}
	if (message.startsWith('Unexpected server response: 404')) {
		return 'the WebSocket endpoint was not found. Check PG_TUNNEL_URL (the path must be /api/pg).';
	}
	if (err?.code === 'CONNECT_TIMEOUT') {
		return 'timed out while connecting to the tunnel.';
	}
	if (message.includes('Opening handshake has timed out')) {
		return 'timed out while opening the WebSocket.';
	}
	if (
		err?.code === 'CONNECTION_CLOSED' ||
		err?.code === 'CONNECTION_DESTROYED' ||
		err?.code === 'TUNNEL_CLOSED'
	) {
		return 'the tunnel closed the connection. Is PostgreSQL running? Check the server logs.';
	}
	if (err?.name === 'AbortError') {
		return 'the query exceeded the 30 second limit.';
	}
	if (typeof err?.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code)) {
		return `PostgreSQL ${err.code}: ${message}`;
	}

	return message;
}

function isConnectionError(err) {
	if (CONNECTION_CODES.has(err?.code)) return true;

	return (
		Array.isArray(err?.errors) &&
		err.errors.some((cause) => CONNECTION_CODES.has(cause?.code))
	);
}
