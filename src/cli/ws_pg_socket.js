import { once } from 'node:events';
import { createWebSocketStream, WebSocket } from 'ws';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const RETRYABLE_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH']);

// Opens a WebSocket to the PostgreSQL tunnel and exposes it as a duplex
// stream compatible with the `socket` option of postgres.js.
export async function openPgSocket(options) {
	let lastError;

	for (const url of loopbackCandidates(options.url)) {
		try {
			return await openOnce({ ...options, url });
		} catch (err) {
			if (!isRetryable(err)) throw err;
			lastError = err;
		}
	}

	throw lastError;
}

async function openOnce({ url, token, insecure = false, timeoutMs = 10_000 }) {
	const ws = new WebSocket(url, {
		headers: { Authorization: `Bearer ${token}` },
		handshakeTimeout: timeoutMs,
		rejectUnauthorized: !insecure
	});

	try {
		await once(ws, 'open');
	} catch (err) {
		ws.terminate();
		throw err;
	}

	const stream = createWebSocketStream(ws);

	// createWebSocketStream signals the end of the readable side with 'end',
	// but postgres.js only listens for 'close'. Without this hook, a clean
	// close from the server can leave the query waiting forever.
	ws.once('close', () => {
		const finish = () => {
			if (stream.destroyed) return;

			if (stream.writableEnded) {
				stream.destroy();
				return;
			}

			// A close during startup is seen by postgres.js as a transient
			// CONNECTION_CLOSED error, and it retries for connect_timeout
			// seconds. A distinct code makes the failure immediate.
			const error = new Error('the tunnel closed the connection');
			error.code = 'TUNNEL_CLOSED';
			stream.destroy(error);
		};

		if (stream.readableEnded) finish();
		else stream.once('end', finish);
	});

	return stream;
}

function loopbackCandidates(url) {
	const parsed = new URL(url);
	if (!LOOPBACK_HOSTS.has(parsed.hostname)) return [url];

	const candidates = [parsed.toString()];

	for (const host of ['127.0.0.1', '[::1]', 'localhost']) {
		const candidate = new URL(url);
		candidate.hostname = host;
		candidates.push(candidate.toString());
	}

	return [...new Set(candidates)];
}

function isRetryable(err) {
	if (RETRYABLE_CODES.has(err?.code)) return true;

	return (
		Array.isArray(err?.errors) &&
		err.errors.some((cause) => RETRYABLE_CODES.has(cause?.code))
	);
}
