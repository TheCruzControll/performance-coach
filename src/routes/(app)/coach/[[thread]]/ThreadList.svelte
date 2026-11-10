<!--
  @component
  Recent conversations, newest first: each a row that opens it, with its title and when it was
  last active, and an options button that opens its sheet (ManageSheet: rename, archive with
  Undo). 'Show older' under them is busy while the next page loads, and its failure says so
  inline with Retry. With none, the coach's empty state. 'Archived conversations' opens the
  Archived list (ArchivedSheet), so nothing archived is out of reach.
  Both sheets' code is fetched on the first press; the sheet opens when it arrives. A failed fetch
  says so in a toast whose Retry fetches again; failing again while online reloads the page, as
  KnowsButton does.
-->
<script lang="ts">
	import type { Component } from 'svelte';
	import { resolve } from '$app/paths';
	import Button from '#lib/ui/components/Button.svelte';
	import IconButton from '#lib/ui/components/IconButton.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import CoachNotice from '#lib/ui/coach/CoachNotice.svelte';
	import { SCREEN_FAILURE_LABEL } from '#lib/ui/coach/coach-notices.ts';
	import { toast } from '#lib/ui/toast.svelte.ts';
	import type { ThreadRowView } from './words';

	interface Props {
		rows: ThreadRowView[];
		/** There is an older page. */
		more: boolean;
		loadingOlder: boolean;
		olderFailed: boolean;
		onolder: () => void;
		/** A conversation was renamed, archived or unarchived: the older pages are stale. */
		onchanged: () => void;
	}

	let { rows, more, loadingOlder, olderFailed, onolder, onchanged }: Props = $props();

	type Changes = { onchanged: () => void };
	type Sheet = Component<{ open: boolean; thread: ThreadRowView } & Changes>;
	type Sheets = { manage: Sheet; archived: Component<{ open: boolean } & Changes> };

	let Manage = $state.raw<Sheets['manage'] | null>(null);
	let Archived = $state.raw<Sheets['archived'] | null>(null);
	/** The conversation whose sheet is open, and whether the Archived list is. */
	let managing = $state.raw<ThreadRowView | null>(null);
	let manageOpen = $state(false);
	/** Each press opens a fresh sheet, with the title as it now stands. */
	let opened = $state(0);
	let archivedOpen = $state(false);
	/** Per sheet: a second failure of the same one reloads the page. */
	const failed = { manage: false, archived: false };

	// Client only, and apart from .then(), as UsageButton explains.
	const imports = {
		manage: () => import('./ManageSheet.svelte'),
		archived: () => import('./ArchivedSheet.svelte')
	};

	function fetchSheet<K extends keyof Sheets>(key: K, then: (sheet: Sheets[K]) => void) {
		const load = import.meta.env.SSR
			? Promise.reject(new Error('client only'))
			: (imports[key]() as Promise<{ default: Sheets[K] }>);
		load.then(
			(module) => then(module.default),
			() => {
				if (failed[key] && navigator.onLine) return location.reload();
				failed[key] = true;
				toast.show(SCREEN_FAILURE_LABEL.chunk_failed, {
					tone: 'danger',
					duration: 0,
					action: { label: 'Retry', onclick: () => fetchSheet(key, then) }
				});
			}
		);
	}

	function manage(row: ThreadRowView) {
		managing = row;
		opened += 1;
		manageOpen = true;
		if (!Manage) fetchSheet('manage', (sheet) => (Manage = sheet));
	}

	function showArchived() {
		archivedOpen = true;
		if (!Archived) fetchSheet('archived', (sheet) => (Archived = sheet));
	}
</script>

<section class="recent" aria-labelledby="recent-heading">
	<h2 id="recent-heading" class="eyebrow">Recent conversations</h2>
	{#if rows.length === 0}
		<CoachNotice kind="empty" data-testid="coach-empty" />
	{:else}
		<ul class="rows">
			{#each rows as row (row.id)}
				<li class="row">
					<ListRow
						href={resolve('/(app)/coach/[[thread]]', { thread: row.id })}
						icon="coach"
						title={row.title}
						subtitle={row.when}
						data-testid="thread-row"
					>
						{#snippet trailing()}<span class="room" aria-hidden="true"></span>{/snippet}
					</ListRow>
					<span class="options">
						<IconButton
							icon="more"
							label={`Manage ${row.title}`}
							onclick={() => manage(row)}
							data-testid="manage-thread"
						/>
					</span>
				</li>
			{/each}
		</ul>
	{/if}
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
	<button type="button" class="archived" onclick={showArchived} data-testid="archived-link">
		Archived conversations
	</button>
</section>

{#if Manage && managing}
	{#key opened}<Manage bind:open={manageOpen} thread={managing} {onchanged} />{/key}
{/if}
{#if Archived}<Archived bind:open={archivedOpen} {onchanged} />{/if}

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

	/* The options button sits over the row's trailing edge, beside (never inside) its link. */
	.row {
		position: relative;
	}

	.room {
		flex: none;
		width: var(--touch-target);
	}

	.options {
		position: absolute;
		top: 50%;
		right: var(--space-2);
		translate: 0 -50%;
	}

	.archived {
		justify-self: start;
		min-height: var(--touch-target);
		padding: 0 var(--space-1);
		border: 0;
		background: none;
		font: inherit;
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-accent-text);
		cursor: pointer;
		border-radius: var(--radius-sm);
	}

	.archived:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	@media (hover: hover) and (pointer: fine) {
		.archived:hover {
			text-decoration: underline;
		}
	}
</style>
