<!--
  @component
  The inbox's list: the proposals waiting for the owner under 'Waiting for you', then the decided
  ones under 'Decided', each newest first, in words composed on the server (inbox.server.ts). A row
  is one link, ≥ 44 px, with its title, the review that proposed it ('Weekly review') for a review's,
  kind and day, and where it stands as a badge (words plus a
  treatment, never colour alone). Hover, pressed and focus states; aria-current on the proposal
  shown beside the list; aria-busy with a progress line while it opens. Rows keep focus and scroll
  when opened, so a desktop window's list stays put.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { navigating } from '$app/state';
	import type { ProposalStatus } from '#lib/domain/training/vocabulary.ts';
	import Badge from '#lib/ui/components/Badge.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import type { InboxRow } from './inbox.server';

	interface Props {
		rows: readonly InboxRow[];
		/** The proposal shown beside the list. */
		selected: string | null;
		/** The query the list was opened with (its filter), kept by each row's link. */
		search: string;
	}

	let { rows, selected, search }: Props = $props();

	const TONE: Record<ProposalStatus, 'accent' | 'positive' | 'neutral' | 'warning'> = {
		proposed: 'accent',
		accepted: 'positive',
		applied: 'positive',
		rejected: 'neutral',
		superseded: 'warning'
	};

	const groups = $derived(
		[
			{
				id: 'waiting',
				title: 'Waiting for you',
				rows: rows.filter((r) => r.status === 'proposed')
			},
			{ id: 'decided', title: 'Decided', rows: rows.filter((r) => r.status !== 'proposed') }
		].filter((group) => group.rows.length > 0)
	);
</script>

{#each groups as group (group.id)}
	<section class="group" aria-labelledby="inbox-{group.id}" data-testid="inbox-{group.id}">
		<h2 id="inbox-{group.id}" class="heading">
			{group.title} <span class="count numeric">{group.rows.length}</span>
		</h2>
		<ol class="rows">
			{#each group.rows as row (row.id)}
				{@const path = resolve('/(app)/coach/proposals/[[id]]', { id: row.id })}
				{@const pending = navigating.to?.url.pathname === path}
				<li>
					<a
						class="row"
						href="{path}{search}"
						aria-current={row.id === selected ? 'page' : undefined}
						aria-busy={pending ? 'true' : undefined}
						data-sveltekit-reset="false"
						data-sveltekit-noscroll
						data-testid="inbox-row"
					>
						<span class="text">
							<span class="title">{row.title}</span>
							<span class="meta"
								>{#if row.origin}<span class="origin" data-testid="inbox-origin">{row.origin}</span>
									·
								{/if}{row.meta}</span
							>
						</span>
						<Badge tone={TONE[row.status]} icon={row.status === 'proposed' ? 'sparkle' : undefined}
							>{row.state}</Badge
						>
						<Icon name="chevron-right" size={20} class="chevron" />
						{#if pending}<span class="progress"></span>{/if}
					</a>
				</li>
			{/each}
		</ol>
	</section>
{/each}

<style>
	.group {
		display: grid;
		gap: var(--space-2);
	}

	.heading {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		color: var(--color-text-secondary);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
	}

	.count {
		color: var(--color-text-tertiary);
	}

	.rows {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.row {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto;
		align-items: center;
		column-gap: var(--space-3);
		min-height: var(--touch-target);
		padding: var(--space-3) var(--space-4);
		overflow: hidden;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-surface-1);
		color: var(--color-text);
		transition:
			border-color var(--duration-fast) var(--ease-standard),
			background-color var(--duration-fast) var(--ease-standard);
	}

	.row:active {
		background: var(--color-surface-2);
		transition-duration: var(--duration-instant);
	}

	@media (hover: hover) and (pointer: fine) {
		.row:hover {
			border-color: var(--color-border-strong);
		}
	}

	.row:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	/* The proposal shown beside the list: an accent edge and a lifted surface, and aria-current. */
	.row[aria-current='page'] {
		border-color: var(--color-accent);
		background: var(--color-surface-2);
	}

	.text {
		display: grid;
		min-width: 0;
	}

	.title {
		overflow: hidden;
		font-weight: var(--weight-semibold);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.meta {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.origin {
		color: var(--color-text);
		font-weight: var(--weight-medium);
	}

	.row :global(.chevron) {
		color: var(--color-text-tertiary);
	}

	.row[aria-busy='true'] {
		cursor: progress;
	}

	/* Opening: a line sweeps along the row's bottom edge; still, under reduced motion. */
	.progress {
		position: absolute;
		inset: auto 0 0;
		height: 2px;
		background: linear-gradient(90deg, transparent, var(--color-accent-text), transparent);
		animation: sweep 1.2s var(--ease-standard) infinite;
	}

	@keyframes sweep {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(100%);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.progress {
			animation: none;
			opacity: 0.6;
		}
	}
</style>
