import net from 'node:net';
import { WebSocketServer } from 'ws';

const DEFAULT_PATH = '/api/pg';

export function attachPgTunnel(server, path = DEFAULT_PATH) {
	const wss = new WebSocketServer({ noServer: true });

	server.on('upgrade', (req, socket, head) => {
		const { pathname } = new URL(req.url ?? '/', 'http://localhost');

		if (pathname !== path) {
			if (process.env.NODE_ENV === 'production') socket.destroy();
			return; // in development, leave Vite's HMR upgrade alone
		}

		const expected = `Bearer ${process.env.PG_TUNNEL_TOKEN}`;
		if (!process.env.PG_TUNNEL_TOKEN || req.headers.authorization !== expected) {
			socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
			return;
		}

		wss.handleUpgrade(req, socket, head, (ws) => {
			const host = process.env.PG_REMOTE_HOST ?? '127.0.0.1';
			const port = Number(process.env.PG_REMOTE_PORT ?? 5432);
			const pg = net.connect({ host, port });

			let opened = false;
			const timer = setTimeout(() => pg.destroy(), 10_000);

			pg.once('connect', () => {
				opened = true;
				clearTimeout(timer);
				console.log(`[pg-tunnel] open ${host}:${port}`);
			});

			pg.once('close', () => {
				clearTimeout(timer);
				if (opened) console.log('[pg-tunnel] close');
			});

			ws.on('message', (data) => pg.write(data));
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
	});

	return wss;
}
