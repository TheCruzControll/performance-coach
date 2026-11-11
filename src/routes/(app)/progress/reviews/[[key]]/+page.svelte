<!--
  Progress → Reviews (M6): the block to review and each cycle review, then every weekly review,
  newest first, and the one the key selects
  (load.ts), server-rendered so it reads without JavaScript (+page.ts awaits its view).

  - A split screen from 1024 px: the list beside the review, or beside 'Pick a review'. Below it
    the list and a review are separate screens, with 'All reviews' back to the list.
  - No review yet: a designed empty state over the week to review.
  - A failed load is a notice with Retry inside the screen; a bad key is the 404 page; a client
    navigation here offline is the (app) error boundary's offline state.
-->
<script lang="ts">
	import { afterNavigate, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import Button from '#lib/ui/components/Button.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';
	import ReviewList from './ReviewList.svelte';
	import type { ReviewRow } from './load';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const ready = $derived(data.failed ? null : data);
	const selected = $derived(ready?.selected ?? null);
	let retrying = $state(false);

	async function retry() {
		retrying = true;
		try {
			await invalidateAll();
		} finally {
			retrying = false;
		}
	}

	// On a phone the list is hidden once a review opens (its column has no box): focus moves to
	// the review's title, at the top. On a desktop window the list keeps focus and scroll.
	let list = $state<HTMLElement>();
	afterNavigate(({ type }) => {
		if (type === 'enter' || !selected || !list || list.getClientRects().length > 0) return;
		window.scrollTo(0, 0);
		document.getElementById('review-title')?.focus();
	});
</script>

{#snippet earlierCycles(rows: ReviewRow[])}
	<ReviewList {rows} selected={null} label="Earlier cycles" />
{/snippet}

<svelte:head>
	<title>{selected ? `${selected.title} · Reviews` : 'Reviews'} · Performance Coach</title>
</svelte:head>

<div class="reviews" class:selected={!!selected} data-layout="split">
	<div class="top">
		<a class="back to-progress" href={resolve('/(app)/progress')}>
			<Icon name="chevron-left" size={18} /> Progress
		</a>
		<a
			class="back to-list"
			href={resolve('/(app)/progress/reviews/[[key]]', {})}
			data-testid="back-to-reviews"
		>
			<Icon name="chevron-left" size={18} /> All reviews
		</a>
		<PageHeader title="Reviews" eyebrow="Progress" />
	</div>

	{#if !ready}
		<div class="failed" data-testid="reviews-failed">
			<Notice tone="danger" title="Couldn’t load your reviews">
				Your training is safe. Try again in a moment.
			</Notice>
			<Button variant="secondary" icon="refresh" loading={retrying} onclick={retry}>Retry</Button>
		</div>
	{:else}
		<section class="list" aria-label="Reviews" bind:this={list}>
			{#if ready.empty}
				<Surface padding="none" radius="xl">
					<EmptyState
						compact
						icon="sparkle"
						tone="accent"
						title="No reviews yet"
						description="Once a week ends, or once every session is done or skipped, review it: planned against done, adherence, and what is really changing."
						data-testid="reviews-empty"
					/>
				</Surface>
			{/if}
			{#if ready.cycles.length}
				<ReviewList
					rows={ready.cycles}
					label="Cycle reviews"
					selected={selected?.key ?? null}
					refused={form?.reason === 'not_reviewable' ? form : null}
				/>
			{/if}
			<ReviewList
				rows={ready.rows}
				selected={selected?.key ?? null}
				refused={form?.reason === 'not_reviewable' ? form : null}
			/>
		</section>

		<div class="pane">
			{#if selected && data.View}
				{#key selected.key}<data.View review={selected} {earlierCycles} />{/key}
			{:else}
				<Surface padding="none" radius="xl">
					<EmptyState
						compact
						icon="progress"
						tone="neutral"
						title="Pick a review"
						description="Its planned against done, adherence and trends show here."
						data-testid="pick-review"
					/>
				</Surface>
			{/if}
		</div>
	{/if}
</div>

<style>
	/* One column; from 1024 px the split screen's two (layout.css), the list beside the review. */
	.reviews {
		display: grid;
		row-gap: var(--space-5);
	}

	.top,
	.failed {
		grid-column: 1 / -1;
	}

	.failed {
		display: grid;
		justify-items: start;
		gap: var(--space-3);
	}

	.list {
		display: grid;
		gap: var(--space-3);
		align-content: start;
		min-width: 0;
	}

	.pane {
		min-width: 0;
	}

	.to-list {
		display: none;
	}

	/* Below 1024 px the list and a review are separate screens. */
	@media (width < 64rem) {
		.reviews {
			grid-template-columns: minmax(0, 1fr);
		}

		.selected .list,
		.selected .to-progress,
		.reviews:not(.selected) .pane {
			display: none;
		}

		.selected .to-list {
			display: inline-flex;
		}
	}

	.back {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		min-height: var(--touch-target);
		margin-top: var(--space-2);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}

	.back:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	@media (hover: hover) and (pointer: fine) {
		.back:hover {
			color: var(--color-text);
		}
	}
</style>
