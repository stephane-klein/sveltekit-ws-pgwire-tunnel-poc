import net from 'node:net';
import { jwtVerify } from 'jose';
import { WebSocketServer } from 'ws';

const DEFAULT_PATH = '/api/pg';

const SSL_REQUEST = 80877103;
const GSSENC_REQUEST = 80877104;
const MAX_STARTUP_PACKET = 10_000;
const JWT_LEEWAY_SECONDS = 30;

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

export function rewriteStartupPacket(packet, { user, database, token }) {
	const version = packet.readInt32BE(4);
	const params = parseStartupPacket(packet).filter(({ key }) => {
		if (key === 'user' || key === 'database') return false;
		if (key === 'options' || key === 'replication') return false;
		return !key.startsWith('app.');
	});

	params.push({ key: 'user', value: Buffer.from(user, 'utf8') });
	params.push({ key: 'database', value: Buffer.from(database, 'utf8') });
	params.push({ key: 'app.token', value: Buffer.from(token, 'utf8') });

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

export function attachPgTunnel(server, path = DEFAULT_PATH) {
	const wss = new WebSocketServer({ noServer: true });

	async function handleUpgrade(req, socket, head) {
		const { pathname } = new URL(req.url ?? '/', 'http://localhost');

		if (pathname !== path) {
			if (process.env.NODE_ENV === 'production') socket.destroy();
			return; // in development, leave Vite's HMR upgrade alone
		}

		const secret = process.env.PG_SESSION_IDENTITY_SECRET;
		const token = req.headers.authorization?.startsWith('Bearer ')
			? req.headers.authorization.slice('Bearer '.length)
			: null;

		if (!secret || !token) {
			socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
			return;
		}

		const claims = await verifyJwt(token, secret);
		if (!claims) {
			socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
			return;
		}

		if (socket.destroyed) return;

		wss.handleUpgrade(req, socket, head, (ws) => {
			const host = process.env.PG_REMOTE_HOST ?? '127.0.0.1';
			const port = Number(process.env.PG_REMOTE_PORT ?? 5432);
			const role = process.env.PG_TUNNEL_ROLE ?? 'app_user';
			const database = process.env.PG_TUNNEL_DATABASE ?? 'appdb';
			const pg = net.connect({ host, port });

			let opened = false;
			let startupDone = false;
			let buffer = Buffer.alloc(0);
			const timer = setTimeout(() => pg.destroy(), 10_000);

			pg.once('connect', () => {
				opened = true;
				clearTimeout(timer);
				console.log(`[pg-tunnel] open ${host}:${port} sub=${claims.sub}`);
			});

			pg.once('close', () => {
				clearTimeout(timer);
				if (opened) console.log('[pg-tunnel] close');
			});

			ws.on('message', (data) => {
				const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);

				if (startupDone) {
					pg.write(chunk);
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

			pg.on('data', (chunk) => ws.send(chunk, { binary: true }));

			ws.on('close', () => pg.destroy());
			pg.on('close', () => ws.close());

			ws.on('error', (err) => {
				console.error(`[pg-tunnel] ws error: ${err.code ?? err.message}`);
				pg.destroy();
			});

			pg.on('error', (err) => {
				console.error(`[pg-tunnel] pg error: ${err.code ?? err.message}`);
				ws.close();
			});
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
