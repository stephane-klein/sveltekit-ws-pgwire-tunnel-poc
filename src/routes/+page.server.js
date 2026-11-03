import { sql } from '#lib/server/pg';

const PAGE_SIZE = 50;

export async function load({ url }) {
	const [{ total }] = await sql`select count(*)::int as total from contacts`;

	const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
	const requested = Number(url.searchParams.get('page')) || 1;
	const page = Math.min(Math.max(1, Math.trunc(requested)), pageCount);
	const offset = (page - 1) * PAGE_SIZE;

	const contacts = await sql`
		select
			id,
			firstname,
			lastname,
			to_char(created_at, 'DD/MM/YYYY HH24:MI') as created_at
		from contacts
		order by id
		limit ${PAGE_SIZE} offset ${offset}
	`;

	return { contacts, page, pageCount, total };
}
