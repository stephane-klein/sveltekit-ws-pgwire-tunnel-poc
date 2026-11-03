<script>
	let { data } = $props();
</script>

<h1>Contacts</h1>

<p>{data.total} contacts — page {data.page} sur {data.pageCount}</p>

<table>
	<thead>
		<tr>
			<th>Id</th>
			<th>Prénom</th>
			<th>Nom</th>
			<th>Créé le</th>
		</tr>
	</thead>
	<tbody>
		{#each data.contacts as contact (contact.id)}
			<tr>
				<td>{contact.id}</td>
				<td>{contact.firstname}</td>
				<td>{contact.lastname}</td>
				<td>{contact.created_at}</td>
			</tr>
		{/each}
	</tbody>
</table>

{#if data.pageCount > 1}
	<nav>
		{#if data.page > 1}
			<a href="?page={data.page - 1}">← Précédent</a>
		{/if}
		{#if data.page < data.pageCount}
			<a href="?page={data.page + 1}">Suivant →</a>
		{/if}
	</nav>
{/if}

<style>
	table {
		border-collapse: collapse;
		width: 100%;
	}

	th,
	td {
		border-bottom: 1px solid #ddd;
		padding: 0.4rem 0.75rem;
		text-align: left;
	}

	th {
		background: #f5f5f5;
	}

	nav {
		display: flex;
		gap: 1rem;
		margin-top: 1rem;
	}
</style>
