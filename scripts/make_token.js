import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';

const secret = process.env.PG_SESSION_IDENTITY_SECRET;
const sub = process.argv[2];
const ttl = Number(process.argv[3] ?? 3600);

if (!secret) {
	console.error('PG_SESSION_IDENTITY_SECRET is not set');
	process.exit(1);
}

if (!sub) {
	console.error('usage: node scripts/make_token.js <sub> [ttl_seconds]');
	process.exit(1);
}

if (!Number.isFinite(ttl) || ttl <= 0) {
	console.error('ttl must be a positive number of seconds');
	process.exit(1);
}

const token = await new SignJWT({})
	.setProtectedHeader({ alg: 'HS256' })
	.setSubject(sub)
	.setJti(randomUUID())
	.setExpirationTime(`${ttl}s`)
	.sign(new TextEncoder().encode(secret));

console.log(token);
