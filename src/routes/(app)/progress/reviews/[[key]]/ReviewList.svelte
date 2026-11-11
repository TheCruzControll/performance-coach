<!--
  @component
  The reviews, newest first (load.ts reviewRows): a reviewed week is one link, ≥ 44 px, with its
  summary, hover, pressed and focus states and aria-current on the review shown beside the list;
  a week with no review has a Create button, a form that works without JavaScript too. Create:

  - pending: aria-busy and disabled, so a second tap posts nothing (the service is idempotent
    under the owner lock as well)
  - not reviewable yet (409): when it will be, and why
  - failure (500, or the request never answered): a notice, and the button resends as Retry
  - offline: disabled, with 'You're offline'
-->
<script lang="ts">
	import { applyAction, enhance, type SubmitFunction } from '$app/forms';
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import type { ReviewRow } from './load';

	/**
	 * Shown when Create is refused because the week is not reviewable yet. The rule is the m6-plan
	 * open question 'early review' (EARLY_REVIEW in services/reviews/weekly.ts): change both.
	 */
	const NOT_REVIEWABLE_WORDS =
		'Your review is ready after Sunday, or once every session is done or skipped';

	type Refusal = { weekStartsOn: string; ready?: string };
	type CreateState = { kind: 'pending' } | { kind: 'failed' } | ({ kind: 'refused' } & Refusal);

	interface Props {
		rows: readonly ReviewRow[];
		/** The review shown beside the list. */
		selected: string | null;
		/** A refusal the server rendered (a form posted without JavaScript). */
		refused?: Refusal | null;
	}

	let { rows, selected, refused = null }: Props = $props();

	/**
	 * navigator.onLine and its events, read here rather than through client/connectivity: sharing
	 * that module with the shell would split it into a chunk of its own on every route.
	 */
	let online = $state(true);
	onMount(() => (online = navigator.onLine));

	let states = $state<Record<string, CreateState>>({});
	const stateOf = (week: string): CreateState | undefined =>
		states[week] ?? (refused?.weekStartsOn === week ? { kind: 'refused', ...refused } : undefined);

	const create =
		(week: string): SubmitFunction =>
		({ cancel }) => {
			if (states[week]?.kind === 'pending' || !online) return cancel();
			states[week] = { kind: 'pending' };
			return async ({ result }) => {
				if (result.type === 'failure' && result.data?.reason === 'not_reviewable')
					states[week] = { kind: 'refused', weekStartsOn: week, ready: result.data.ready };
				else if (result.type === 'redirect') {
					await applyAction(result);
					delete states[week];
				} else states[week] = { kind: 'failed' };
			};
		};

	const TONE = { due: 'due', in_progress: 'quiet', not_reviewed: 'quiet' } as const;
</script>

<svelte:window ononline={() => (online = true)} onoffline={() => (online = false)} />

<ol class="rows" aria-label="Weekly reviews">
	{#each rows as row (row.key)}
		<li>
			{#if row.state === 'reviewed'}
				<a
					class="row link"
					href={resolve('/(app)/progress/reviews/[[key]]', { key: row.key })}
					aria-current={row.key === selected ? 'page' : undefined}
					data-sveltekit-reset="false"
					data-testid="review-row"
				>
					<span class="text">
						<span class="title">{row.title}</span>
						<span class="meta">{row.text}</span>
					</span>
					<Icon name="chevron-right" size={20} class="chevron" />
				</a>
			{:else}
				{@const state = stateOf(row.weekStartsOn)}
				<form
					class="row create"
					data-tone={TONE[row.state]}
					method="POST"
					action="?/create"
					use:enhance={create(row.weekStartsOn)}
					data-state={row.state}
					data-testid="review-create"
				>
					<input type="hidden" name="weekStartsOn" value={row.weekStartsOn} />
					<span class="text">
						<span class="title">{row.title}</span>
						<span class="meta">{row.text}</span>
					</span>
					<Button
						type="submit"
						size="sm"
						variant={row.state === 'due' ? 'primary' : 'secondary'}
						icon={state?.kind === 'failed' ? 'refresh' : undefined}
						loading={state?.kind === 'pending'}
						disabled={!online}
						aria-label="{state?.kind === 'failed' ? 'Retry' : 'Create review'} · {row.title}"
						>{state?.kind === 'failed' ? 'Retry' : 'Create review'}</Button
					>
					{#if !online}
						<p class="note" data-testid="create-offline">
							<Icon name="wifi-off" size={16} />You’re offline
						</p>
					{:else if state?.kind === 'refused'}
						<div class="note-wide">
							<Notice tone="warning" icon="clock" data-testid="create-refused">
								{NOT_REVIEWABLE_WORDS}{state.ready ? ` · ${state.ready}` : ''}
							</Notice>
						</div>
					{:else if state?.kind === 'failed'}
						<div class="note-wide">
							<Notice tone="danger" data-testid="create-failed">
								Couldn’t create this review. Your training is safe: try again.
							</Notice>
						</div>
					{/if}
				</form>
			{/if}
		</li>
	{/each}
</ol>

<style>
	.rows {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-2) var(--space-3);
		min-height: var(--touch-target);
		padding: var(--space-3) var(--space-4);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-surface-1);
		color: var(--color-text);
	}

	/* The week that is ready to review: an accent edge, so it leads the list. */
	.create[data-tone='due'] {
		border-color: var(--color-accent);
	}

	.create[data-tone='quiet'] {
		background: transparent;
		border-style: dashed;
	}

	.link {
		transition:
			border-color var(--duration-fast) var(--ease-standard),
			background-color var(--duration-fast) var(--ease-standard);
	}

	.link:active {
		background: var(--color-surface-2);
		transition-duration: var(--duration-instant);
	}

	@media (hover: hover) and (pointer: fine) {
		.link:hover {
			border-color: var(--color-border-strong);
		}
	}

	.link:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	.link[aria-current='page'] {
		border-color: var(--color-accent);
		background: var(--color-surface-2);
	}

	.text {
		display: grid;
		gap: var(--space-0-5);
		min-width: 0;
	}

	.title {
		font-weight: var(--weight-semibold);
	}

	.meta {
		display: -webkit-box;
		overflow: hidden;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
		color: var(--color-text-secondary);
	}

	.row :global(.chevron) {
		color: var(--color-text-tertiary);
	}

	.note {
		display: inline-flex;
		grid-column: 1 / -1;
		align-items: center;
		gap: var(--space-1-5);
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.note-wide {
		grid-column: 1 / -1;
	}
</style>
