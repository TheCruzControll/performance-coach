<!--
  Progress → one exercise (M6): is this lift going up? The header names it with its tags and its
  e1RM verdict over the period picker; then the best estimated 1RM with its context, the e1RM
  chart (estimates as rings, the profile's maxes as their own marks, server-rendered with its
  table twin) beside the 1–10 rep-max table on a desktop window, top sets, every PR with its date,
  RPE against target and the recent sessions, each linking to its workout.

  - The verdict (before trends, when they appear) answers the question in the page's own chunk;
    everything under it (ExerciseTrends) loads after hydration, served as static markup until it
    has (trends.ts, TrendsLoader), so only the header's code counts towards initial JS.
  - Before TREND_SESSIONS sessions of the lift, a designed empty state says when trends appear.
  - A period switch is a link: the frame holds, dimmed, until the numbers arrive (PeriodPicker).
    Offline it is cancelled and the numbers stay, with a notice; a client navigation here offline
    is the (app) error boundary's offline state.
  - A failed load is a notice with Retry inside the screen; an unknown id is the 404 page.
-->
<script lang="ts">
	import { beforeNavigate, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import PeriodPicker from '#lib/ui/analytics/PeriodPicker.svelte';
	import VerdictBadge from '#lib/ui/analytics/VerdictBadge.svelte';
	import Badge from '#lib/ui/components/Badge.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import type { PageProps } from './$types';
	import TrendsLoader from './TrendsLoader.svelte';

	let { data }: PageProps = $props();

	const detail = $derived(data.failed ? null : data.detail);
	let offline = $state(false);
	let retrying = $state(false);

	// A period switch made offline would fail to load: keep the frame and the numbers.
	beforeNavigate(({ to, cancel }) => {
		if (to?.url.pathname !== page.url.pathname || navigator.onLine) return;
		cancel();
		offline = true;
	});

	async function retry() {
		retrying = true;
		try {
			await invalidateAll();
		} finally {
			retrying = false;
		}
	}
</script>

<svelte:head>
	<title>{detail?.name ?? 'Exercise'} · Progress · Performance Coach</title>
</svelte:head>

<svelte:window ononline={() => (offline = false)} />

<div data-layout="wide" class="screen" data-testid="exercise-detail">
	<a class="back" href={resolve('/(app)/progress')}
		><Icon name="chevron-left" size={18} strokeWidth={2} />Progress</a
	>
	<PageHeader title={detail?.name ?? 'Exercise'} eyebrow="Exercise" />
	{#if detail}
		<div class="meta">
			<ul class="tags" aria-label="About this lift" data-testid="exercise-tags">
				{#each detail.tags as tag (tag)}<li><Badge>{tag}</Badge></li>{/each}
			</ul>
			{#if !detail.waiting}<VerdictBadge verdict={detail.verdict} window={detail.window} />{/if}
		</div>
	{/if}

	{#if offline}
		<Notice tone="warning" icon="wifi-off" data-testid="exercise-offline">
			You’re offline — showing what was loaded
		</Notice>
	{/if}

	<PeriodPicker current={data.period} data-testid="exercise-period">
		{#if !detail}
			<div class="failed" data-testid="exercise-failed">
				<Notice tone="danger" title="Couldn’t load this exercise">
					Your training is safe. Try again in a moment.
				</Notice>
				<Button variant="secondary" icon="refresh" loading={retrying} onclick={retry}>Retry</Button>
			</div>
		{:else}
			<div class="pc-exercise-view" data-state={detail.waiting ? 'waiting' : 'ready'}>
				{#if detail.waiting}
					<EmptyState
						icon="progress"
						tone="strength"
						title="Trends appear after {detail.waiting.need} sessions with this lift"
						description="{detail.waiting.have} of {detail.waiting
							.need} so far. Log it again and its estimated 1RM, verdict and records fill in."
						data-testid="exercise-waiting"
					/>
				{/if}

				<TrendsLoader {detail} served={data.served} />
			</div>
		{/if}
	</PeriodPicker>
</div>

<style>
	.screen {
		display: grid;
		gap: var(--space-4);
	}

	.back {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		justify-self: start;
		min-height: var(--touch-target);
		padding-inline: var(--space-2);
		margin: var(--space-2) 0 calc(var(--space-6) * -1) calc(var(--space-2) * -1);
		border-radius: var(--radius-sm);
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		text-decoration: none;
	}

	.back:active {
		background: var(--color-surface-2);
	}

	@media (hover: hover) and (pointer: fine) {
		.back:hover {
			background: var(--color-surface-2);
			color: var(--color-text);
		}
	}

	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
		margin-top: calc(var(--space-3) * -1);
	}

	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.failed {
		display: grid;
		justify-items: start;
		gap: var(--space-3);
	}

	.pc-exercise-view {
		container-type: inline-size;
		display: grid;
		gap: var(--space-6);
		min-width: 0;
	}

	/* A desktop window: the period picker keeps a control's width instead of the column's. */
	@media (width >= 64rem) {
		.screen :global(.period-view > .picker) {
			justify-self: start;
			inline-size: 24rem;
		}
	}
</style>
