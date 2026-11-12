<!--
  @component
  Archived conversations (PRD §12): nothing archived is out of reach. Read through
  GET /api/coach/threads?archived=1 each time the sheet opens, newest archived first, a page at a
  time ('Show older'). Each row opens its conversation, read-only, and Unarchive returns it to
  Recent conversations (busy while sent; a failure says so on the row, and Retry sends it again).
  Loading rows while the first page loads; a failed read offers Retry; with none, 'No archived
  conversations'. A centred dialog on a desktop window. ThreadList fetches this on the first press.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import CoachNotice from '#lib/ui/coach/CoachNotice.svelte';
	import LoadingRows from '#lib/ui/coach/LoadingRows.svelte';
	import { COACH_NOTICES } from '#lib/ui/coach/coach-notices.ts';
	import { ARCHIVED_PAGE, manageThread, type ArchivedPage } from './manage';
	import type { ThreadRowView } from './words';

	/** onchanged: called before Recent conversations loads again after an unarchive. */
	let { open = $bindable(), onchanged }: { open: boolean; onchanged: () => void } = $props();

	let phase = $state<'loading' | 'failed' | 'ready'>('loading');
	let rows = $state.raw<ThreadRowView[]>([]);
	let next = $state<string | null>(null);
	let loadingOlder = $state(false);
	let olderFailed = $state(false);
	/** Rows being unarchived, and rows whose unarchive failed. */
	let sending = $state.raw(new Set<string>());
	let failed = $state.raw(new Set<string>());

	async function read(before: string | null): Promise<ArchivedPage | null> {
		const query = `archived=1&limit=${ARCHIVED_PAGE}${before ? `&before=${before}` : ''}`;
		try {
			const response = await fetch(`/api/coach/threads?${query}`);
			return response.ok ? ((await response.json()) as ArchivedPage) : null;
		} catch {
			return null;
		}
	}

	async function load() {
		phase = 'loading';
		failed = new Set();
		const page = await read(null);
		if (!page) {
			phase = 'failed';
			return;
		}
		rows = page.threads;
		next = page.next;
		phase = 'ready';
	}

	async function older() {
		if (next === null || loadingOlder) return;
		loadingOlder = true;
		olderFailed = false;
		const page = await read(next);
		loadingOlder = false;
		if (!page) {
			olderFailed = true;
			return;
		}
		rows = [...rows, ...page.threads.filter((row) => !rows.some((r) => r.id === row.id))];
		next = page.next;
	}

	const without = (set: Set<string>, id: string) => new Set([...set].filter((each) => each !== id));

	async function unarchive(id: string) {
		sending = new Set([...sending, id]);
		failed = without(failed, id);
		const done = await manageThread(id, { action: 'unarchive' });
		sending = without(sending, id);
		if (!done) {
			failed = new Set([...failed, id]);
			return;
		}
		rows = rows.filter((row) => row.id !== id);
		// The cursor is the last row listed, and it must be archived: continue from the one above.
		if (id === next) next = rows.at(-1)?.id ?? null;
		onchanged();
		await invalidateAll(); // back in Recent conversations
	}

	// Read afresh on every open: a conversation may have been archived since the last one.
	$effect(() => {
		if (open) untrack(load);
	});

	const failure = COACH_NOTICES.action_failed;
</script>

<BottomSheet bind:open title="Archived conversations" data-testid="archived-sheet">
	<div class="archived">
		{#if phase === 'loading'}
			<LoadingRows label="Loading archived conversations…" data-testid="archived-loading" />
		{:else if phase === 'failed'}
			<CoachNotice kind="load_failed" onretry={load} data-testid="archived-failed" />
		{:else if rows.length === 0}
			<EmptyState
				compact
				icon="lock"
				tone="neutral"
				title="No archived conversations"
				description="Conversations you archive are kept here, and you can bring them back."
				data-testid="archived-empty"
			/>
		{:else}
			<ul class="rows">
				{#each rows as row (row.id)}
					<li class="row" data-testid="archived-row">
						<a class="open" href={resolve('/(app)/coach/[[thread]]', { thread: row.id })}>
							<span class="title">{row.title}</span>
							<span class="when">{row.when}</span>
						</a>
						<Button
							variant="secondary"
							size="sm"
							icon={failed.has(row.id) ? 'refresh' : undefined}
							loading={sending.has(row.id)}
							onclick={() => unarchive(row.id)}
							data-testid="unarchive-row"
							>{failed.has(row.id) ? 'Try again' : 'Unarchive'}<span class="visually-hidden">
								{row.title}</span
							></Button
						>
						{#if failed.has(row.id)}
							<p class="failed" role="alert" data-testid="unarchive-failed">
								{failure.title}. {failure.body}
							</p>
						{/if}
					</li>
				{/each}
			</ul>
			<p class="visually-hidden" role="status">
				{loadingOlder ? 'Loading older archived conversations…' : ''}
			</p>
			{#if next !== null}
				<Button
					variant="secondary"
					icon="clock"
					loading={loadingOlder}
					onclick={older}
					data-testid="archived-older">Show older</Button
				>
			{/if}
			{#if olderFailed}
				<CoachNotice kind="load_failed" onretry={older} data-testid="archived-older-failed" />
			{/if}
		{/if}
	</div>
</BottomSheet>

<style>
	.archived {
		display: grid;
		gap: var(--space-3);
	}

	.rows {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--color-hairline);
		border-radius: var(--radius-lg);
	}

	.row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-1) var(--space-3);
		padding: var(--space-2) var(--space-3);
	}

	.row + .row {
		border-top: 1px solid var(--color-hairline);
	}

	.open {
		display: grid;
		gap: var(--space-1);
		min-height: var(--touch-target);
		align-content: center;
		color: var(--color-text);
		text-decoration: none;
		border-radius: var(--radius-sm);
	}

	.title {
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		overflow-wrap: anywhere;
	}

	.when {
		font-size: var(--text-xs);
		color: var(--color-text-secondary);
		font-variant-numeric: tabular-nums;
	}

	.failed {
		grid-column: 1 / -1;
		margin: 0;
		font-size: var(--text-xs);
		color: var(--color-danger);
	}

	.open:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	@media (hover: hover) and (pointer: fine) {
		.open:hover .title {
			text-decoration: underline;
		}
	}
</style>
