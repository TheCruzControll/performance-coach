<!--
  @component
  Recent conversations, newest first: each a row that opens it, with its title and when it was
  last active. 'Show older' under them is busy while the next page loads, and its failure says so
  inline with Retry. With none, the page shows the coach's empty state in its place.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import Button from '#lib/ui/components/Button.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import CoachNotice from '#lib/ui/coach/CoachNotice.svelte';
	import type { ThreadRowView } from './words';

	interface Props {
		rows: ThreadRowView[];
		/** There is an older page. */
		more: boolean;
		loadingOlder: boolean;
		olderFailed: boolean;
		onolder: () => void;
	}

	let { rows, more, loadingOlder, olderFailed, onolder }: Props = $props();
</script>

<section class="recent" aria-labelledby="recent-heading">
	<h2 id="recent-heading" class="eyebrow">Recent conversations</h2>
	<ul class="rows">
		{#each rows as row (row.id)}
			<li>
				<ListRow
					href={resolve('/(app)/coach/[[thread]]', { thread: row.id })}
					icon="coach"
					title={row.title}
					subtitle={row.when}
					data-testid="thread-row"
				/>
			</li>
		{/each}
	</ul>
	<p class="visually-hidden" role="status">{loadingOlder ? 'Loading older conversations…' : ''}</p>
	{#if more}
		<Button
			variant="secondary"
			icon="clock"
			loading={loadingOlder}
			onclick={onolder}
			data-testid="show-older">Show older</Button
		>
	{/if}
	{#if olderFailed}
		<CoachNotice kind="load_failed" onretry={onolder} data-testid="older-failed" />
	{/if}
</section>

<style>
	.recent {
		display: grid;
		gap: var(--space-2);
	}

	.rows {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}
</style>
