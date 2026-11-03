import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { attachPgTunnel } from './src/lib/server/pg-tunnel.js';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter()
		}),
		{
			name: 'pg-tunnel',
			configureServer(server) {
				if (server.httpServer) attachPgTunnel(server.httpServer);
			}
		}
	]
});
