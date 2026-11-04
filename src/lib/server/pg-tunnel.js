import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { jwtVerify } from 'jose';
import { WebSocket, WebSocketServer } from 'ws';

const DEFAULT_PATH = '/api/pg';

const SSL_REQUEST = 80877103;
const GSSENC_REQUEST = 80877104;
const MAX_STARTUP_PACKET = 10_000;
const JWT_LEEWAY_SECONDS = 30;
const CONNECT_TIMEOUT_MS = 10_000;
const STARTUP_TIMEOUT_MS = 10_000;

export async function verifyJwt(token, secret) {
	try {
		const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
			algorithms: ['HS256'],
			clockTolerance: JWT_LEEWAY_SECONDS,
			requiredClaims: ['sub', 'jti', 'exp']
		});

		if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null;
		if (typeof payload.jti !== 'string' || payload.jti.length === 0) return null;

		return payload;
	} catch {
		return null;
	}
}

function parseStartupPacket(packet) {
	const params = [];
	let offset = 8;

	while (offset < packet.length && packet[offset] !== 0) {
		const keyEnd = packet.indexOf(0, offset);
		if (keyEnd === -1) throw new Error('malformed startup packet');

		const valueEnd = packet.indexOf(0, keyEnd + 1);
		if (valueEnd === -1) throw new Error('malformed startup packet');

		params.push({
			key: packet.toString('latin1', offset, keyEnd),
			value: packet.subarray(keyEnd + 1, valueEnd)
		});
		offset = valueEnd + 1;
	}

	return params;
}

export function rewriteStartupPacket(packet, { user, database, token, keepOptions = false }) {
	const version = packet.readInt32BE(4);
	const params = parseStartupPacket(packet).filter(({ key }) => {
		if (key === 'user' || key === 'database') return false;
		if (key === 'replication') return false;
		if (key === 'options' && !keepOptions) return false;
		return !key.startsWith('app.');
	});

	params.push({ key: 'user', value: Buffer.from(user, 'utf8') });
	params.push({ key: 'database', value: Buffer.from(database, 'utf8') });
	if (token) params.push({ key: 'app.token', value: Buffer.from(token, 'utf8') });

	const body = Buffer.concat(
		params.flatMap(({ key, value }) => [
			Buffer.from(`${key}\0`, 'latin1'),
			value,
			Buffer.from('\0')
		])
	);

	const out = Buffer.alloc(8 + body.length + 1);
	out.writeInt32BE(out.length, 0);
	out.writeInt32BE(version, 4);
	body.copy(out, 8);

	return out;
}

function bearerToken(req) {
	const header = req.headers.authorization;
	if (!header?.startsWith('Bearer ')) return null;
	return header.slice('Bearer '.length);
}

function parseDirectRoles(value) {
	return (value ?? '')
		.split(',')
		.map((role) => role.trim())
		.filter(Boolean);
}

function safeEqual(left, right) {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

async function authenticate(req) {
	const token = bearerToken(req);
	if (!token) return null;

	const directToken = process.env.PG_TUNNEL_DIRECT_TOKEN?.trim();
	const directRoles = parseDirectRoles(process.env.PG_TUNNEL_DIRECT_ROLES);

	if (directToken && directRoles.length > 0 && safeEqual(token, directToken)) {
		return { mode: 'direct', roles: directRoles };
	}

	const secret = process.env.PG_SESSION_IDENTITY_SECRET;
	if (!secret) return null;

	const claims = await verifyJwt(token, secret);
	if (!claims) return null;

	return { mode: 'jwt', claims, token };
}

function errorResponse(message, code = '28000') {
	const fields = [
		['S', 'FATAL'],
		['V', 'FATAL'],
		['C', code],
		['M', message]
	];

	const body = Buffer.concat([
		...fields.flatMap(([type, value]) => [
			Buffer.from(type, 'latin1'),
			Buffer.from(value, 'utf8'),
			Buffer.from([0])
		]),
		Buffer.from([0])
	]);

	const out = Buffer.alloc(5 + body.length);
	out[0] = 0x45; // 'E'
	out.writeInt32BE(out.length - 1, 1);
	body.copy(out, 5);

	return out;
}

function sendFatal(ws, message) {
	const payload = errorResponse(message);

	if (ws.readyState !== WebSocket.OPEN) return;

	ws.send(payload, { binary: true }, () => {
		if (ws.readyState === WebSocket.OPEN) {
			ws.close(1008, 'startup rejected');
		}
	});
}

function connectPg(ws, label) {
	const host = process.env.PG_REMOTE_HOST ?? '127.0.0.1';
	const port = Number(process.env.PG_REMOTE_PORT ?? 5432);
	const pg = net.connect({ host, port });

	let opened = false;
	const timer = setTimeout(() => pg.destroy(), CONNECT_TIMEOUT_MS);

	pg.once('connect', () => {
		opened = true;
		clearTimeout(timer);
		console.log(`[pg-tunnel] open ${host}:${port} ${label}`);
	});

	pg.once('close', () => {
		clearTimeout(timer);
		if (opened) console.log('[pg-tunnel] close');
		ws.close();
	});

	pg.on('data', (chunk) => {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(chunk, { binary: true });
		}
	});

	pg.on('error', (err) => {
		console.error(`[pg-tunnel] pg error: ${err.code ?? err.message}`);
		if (ws.readyState === WebSocket.OPEN) ws.close();
	});

	return pg;
}

function relayJwt(ws, { claims, token }) {
	const role = process.env.PG_TUNNEL_ROLE ?? 'app_user';
	const database = process.env.PG_TUNNEL_DATABASE ?? 'appdb';
	const pg = connectPg(ws, `sub=${claims.sub}`);

	let startupDone = false;
	let buffer = Buffer.alloc(0);

	ws.on('message', (data) => {
		const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);

		if (startupDone) {
			if (!pg.destroyed) pg.write(chunk);
			return;
		}

		buffer = Buffer.concat([buffer, chunk]);

		while (buffer.length >= 4) {
			const length = buffer.readInt32BE(0);

			if (length < 8 || length > MAX_STARTUP_PACKET) {
				ws.close(1002, 'invalid startup packet');
				pg.destroy();
				return;
			}

			if (buffer.length < length) return;

			const packet = buffer.subarray(0, length);
			buffer = buffer.subarray(length);

			const code = packet.readInt32BE(4);

			if (code === SSL_REQUEST || code === GSSENC_REQUEST) {
				pg.write(packet);
				continue;
			}

			if ((code >>> 16) === 3) {
				try {
					pg.write(rewriteStartupPacket(packet, { user: role, database, token }));
				} catch (err) {
					console.error(`[pg-tunnel] startup rewrite failed: ${err.message}`);
					ws.close(1002, 'invalid startup packet');
					pg.destroy();
					return;
				}
			} else {
				pg.write(packet);
			}

			startupDone = true;

			if (buffer.length > 0) {
				pg.write(buffer);
				buffer = Buffer.alloc(0);
			}

			return;
		}
	});

	ws.on('close', () => pg.destroy());

	ws.on('error', (err) => {
		console.error(`[pg-tunnel] ws error: ${err.code ?? err.message}`);
		pg.destroy();
	});
}

function relayDirect(ws, { roles }) {
	const database = process.env.PG_TUNNEL_DATABASE ?? 'appdb';

	let buffer = Buffer.alloc(0);
	let pg = null;
	let startupDone = false;
	let finished = false;

	const startupTimer = setTimeout(() => {
		if (!startupDone && !finished) ws.close(1008, 'startup timeout');
	}, STARTUP_TIMEOUT_MS);

	ws.on('message', (data) => {
		if (finished) return;

		const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);

		if (startupDone) {
			if (!pg.destroyed) pg.write(chunk);
			return;
		}

		buffer = Buffer.concat([buffer, chunk]);

		while (buffer.length >= 4) {
			const length = buffer.readInt32BE(0);

			if (length < 8 || length > MAX_STARTUP_PACKET) {
				finished = true;
				ws.close(1002, 'invalid startup packet');
				return;
			}

			if (buffer.length < length) return;

			const packet = buffer.subarray(0, length);
			buffer = buffer.subarray(length);

			const code = packet.readInt32BE(4);

			if (code === SSL_REQUEST || code === GSSENC_REQUEST) {
				// Keep the local hop in clear text: the WebSocket carries the
				// encryption. Refusing SSL locally lets psql fall back to a
				// plaintext startup message, which the tunnel must inspect.
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(Buffer.from('N'), { binary: true });
				}
				continue;
			}

			if ((code >>> 16) !== 3) {
				finished = true;
				ws.close(1002, 'unsupported startup packet');
				return;
			}

			let user;
			try {
				const params = parseStartupPacket(packet);
				user = params.find(({ key }) => key === 'user')?.value.toString('utf8');
			} catch {
				finished = true;
				ws.close(1002, 'invalid startup packet');
				return;
			}

			if (!user) {
				finished = true;
				sendFatal(ws, 'no PostgreSQL user name specified in startup packet');
				return;
			}

			if (!roles.includes(user)) {
				finished = true;
				console.warn(`[pg-tunnel] direct role ${JSON.stringify(user)} not allowed`);
				sendFatal(ws, `role "${user}" is not allowed by the tunnel`);
				return;
			}

			let rewritten;
			try {
				rewritten = rewriteStartupPacket(packet, {
					user,
					database,
					keepOptions: true
				});
			} catch (err) {
				finished = true;
				console.error(`[pg-tunnel] startup rewrite failed: ${err.message}`);
				ws.close(1002, 'invalid startup packet');
				return;
			}

			clearTimeout(startupTimer);

			try {
				pg = connectPg(ws, `role=${user}`);
			} catch (err) {
				finished = true;
				console.error(`[pg-tunnel] pg connect failed: ${err.message}`);
				ws.close(1011, 'database connection failed');
				return;
			}

			startupDone = true;
			pg.write(rewritten);

			if (buffer.length > 0) {
				pg.write(buffer);
				buffer = Buffer.alloc(0);
			}

			return;
		}
	});

	ws.on('close', () => {
		clearTimeout(startupTimer);
		pg?.destroy();
	});

	ws.on('error', (err) => {
		console.error(`[pg-tunnel] ws error: ${err.code ?? err.message}`);
		clearTimeout(startupTimer);
		pg?.destroy();
	});
}

export function attachPgTunnel(server, path = DEFAULT_PATH) {
	const wss = new WebSocketServer({ noServer: true });

	async function handleUpgrade(req, socket, head) {
		const { pathname } = new URL(req.url ?? '/', 'http://localhost');

		if (pathname !== path) {
			if (process.env.NODE_ENV === 'production') socket.destroy();
			return; // in development, leave Vite's HMR upgrade alone
		}

		const auth = await authenticate(req);
		if (!auth) {
			socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
			return;
		}

		if (socket.destroyed) return;

		wss.handleUpgrade(req, socket, head, (ws) => {
			if (auth.mode === 'jwt') {
				relayJwt(ws, auth);
			} else {
				relayDirect(ws, auth);
			}
		});
	}

	server.on('upgrade', (req, socket, head) => {
		handleUpgrade(req, socket, head).catch((error) => {
			console.error(`[pg-tunnel] upgrade failed: ${error.message}`);
			socket.destroy();
		});
	});

	return wss;
}
