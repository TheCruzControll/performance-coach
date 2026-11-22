<script lang="ts">
	import { onMount } from 'svelte';
	import { afterNavigate, invalidateAll, preloadData } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { navigating } from '$app/state';
	import { waitingToSync, type WaitingSummary } from '#lib/client/workout/probe.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';
	import type { WorkoutRowView } from './history.server';
	import WorkoutDetail from './WorkoutDetail.svelte';
	import WorkoutList from './WorkoutList.svelte';
	import type { PageData, PageProps } from './$types';

	let { data }: PageProps = $props();

	const PROGRESS = resolve('/(app)/progress');
	const LIST = resolve('/(app)/progress/workouts/[[id]]', {});

	const ready = $derived(data.state === 'ready' ? data : null);
	const detail = $derived(ready?.detail ?? null);

	let reloading = $state(false);
	async function reload() {
		reloading = true;
		await invalidateAll();
		reloading = false;
	}

	// ---- 'Show older' ------------------------------------------------------------------------

	type Page = { rows: WorkoutRowView[]; next: string | null };
	/**
	 * The older pages loaded below the first, kept with the first page's workouts: opening a
	 * workout loads the first page again, unchanged, so the list keeps them; a new first page (a
	 * workout synced meanwhile) starts it again.
	 */
	let older = $state.raw<{ after: string; pages: Page[] } | null>(null);
	const first = $derived(ready ? ready.rows.map((row) => row.id).join() : '');
	const pages = $derived(ready && older?.after === first ? older.pages : []);
	const rows = $derived(ready ? [ready.rows, ...pages.map((p) => p.rows)].flat() : []);
	const cursor = $derived(ready ? (pages.at(-1) ?? ready).next : null);
	let loadingOlder = $state(false);
	let olderFailed = $state(false);
	/** preloadData keeps its last result per URL, a soft failure too: each attempt is its own. */
	let attempt = 0;

	async function showOlder() {
		if (cursor === null || loadingOlder) return;
		const after = first;
		loadingOlder = true;
		olderFailed = false;
		const result = await preloadData(`${LIST}?before=${cursor}&attempt=${++attempt}`).catch(
			() => null
		);
		loadingOlder = false;
		if (first !== after) return; // the list was loaded again meanwhile
		const next = result?.type === 'loaded' ? (result.data as PageData) : null;
		if (next?.state === 'ready') older = { after, pages: [...pages, next] };
		else olderFailed = true; // offline, a failed request or the load's own error
	}

	// ---- Waiting to sync ----------------------------------------------------------------------

	/** Finished on this device, not synced yet: read after hydration, never on the server. */
	let waiting = $state.raw<WaitingSummary[]>([]);
	onMount(() => {
		void waitingToSync().then((found) => (waiting = found));
	});
	const shownWaiting = $derived(waiting.filter((w) => !rows.some((r) => r.id === w.workoutId)));

	// ---- Focus -------------------------------------------------------------------------------

	// A row keeps focus and scroll, so a desktop window's list stays put. On a phone the list is
	// hidden once a workout opens (its column has no box): focus moves to its title, at the top.
	let list = $state<HTMLElement>();
	afterNavigate(({ type }) => {
		if (type !== 'link' || !detail || !list || list.getClientRects().length > 0) return;
		window.scrollTo(0, 0);
		document.getElementById('workout-title')?.focus();
	});

	const opening = $derived(
		!!navigating.to?.params?.id && navigating.to.route.id === '/(app)/progress/workouts/[[id]]'
	);
</script>

<svelte:head>
	<title>{detail ? `${detail.title} · History` : 'History'} · Performance Coach</title>
</svelte:head>

<div
	class="history"
	class:selected={!!detail}
	data-layout={ready && !ready.empty ? 'split' : undefined}
>
	<div class="top">
		<a class="back to-progress" href={PROGRESS} data-testid="back-to-progress">
			<Icon name="chevron-left" size={18} /> Progress
		</a>
		<a class="back to-list" href={LIST} data-testid="back-to-list">
			<Icon name="chevron-left" size={18} /> All workouts
		</a>
		<PageHeader title="History" eyebrow="Workouts" />
	</div>

	{#if !ready}
		<Surface padding="none" radius="xl">
			<EmptyState
				icon="alert"
				tone="combat"
				title="Couldn’t load your workouts"
				description="Your workouts are safe. Check your connection, then try again."
				data-testid="history-error"
			>
				{#snippet actions()}
					<Button
						variant="secondary"
						icon="refresh"
						loading={reloading}
						onclick={reload}
						data-testid="history-retry">Try again</Button
					>
				{/snippet}
			</EmptyState>
		</Surface>
	{:else}
		<section class="list" aria-label="Completed workouts" bind:this={list}>
			{#if ready.empty && shownWaiting.length === 0}
				<Surface padding="none" radius="xl">
					<EmptyState
						icon="clock"
						tone="neutral"
						title="No workouts yet"
						description="Every workout you finish is listed here, newest first, with its sets, runs and notes."
						data-testid="history-empty"
					>
						{#snippet actions()}
							<Button
								href={resolve('/(app)/today')}
								iconEnd="arrow-right"
								data-testid="history-start"
							>
								Start today’s workout
							</Button>
						{/snippet}
					</EmptyState>
				</Surface>
			{:else}
				<WorkoutList {rows} waiting={shownWaiting} selected={detail?.id ?? null} />
			{/if}
			<p class="visually-hidden" role="status">{loadingOlder ? 'Loading older workouts…' : ''}</p>
			{#if cursor !== null}
				<Button
					variant="secondary"
					icon="clock"
					loading={loadingOlder}
					onclick={showOlder}
					data-testid="show-older">Show older</Button
				>
			{/if}
			{#if olderFailed}
				<Notice tone="danger" title="Couldn’t load older workouts" data-testid="older-failed">
					<Button variant="ghost" size="sm" onclick={showOlder}>Try again</Button>
				</Notice>
			{/if}
		</section>

		{#if !ready.empty}
			<div class="pane" aria-busy={opening ? 'true' : undefined}>
				{#if detail}
					{#key detail.id}<WorkoutDetail {detail} />{/key}
				{:else}
					<Surface padding="none" radius="xl">
						<EmptyState
							compact
							icon="progress"
							tone="neutral"
							title="Pick a workout"
							description="Its sets, segments, notes and records show here."
							data-testid="pick-workout"
						/>
					</Surface>
				{/if}
			</div>
		{/if}
	{/if}
</div>

<style>
	/* One column; from 1024 px a split screen's two (layout.css), the list beside the detail. */
	.history {
		display: grid;
		row-gap: var(--space-5);
	}

	.history:not([data-layout='split']) {
		grid-template-columns: minmax(0, 1fr);
	}

	.top {
		grid-column: 1 / -1;
	}

	.list {
		display: grid;
		gap: var(--space-3);
		align-content: start;
		min-width: 0;
	}

	.pane {
		min-width: 0;
		transition: opacity var(--duration-fast) var(--ease-standard);
	}

	/* Opening another workout: the one shown dims until the next renders. */
	.pane[aria-busy='true'] {
		opacity: 0.6;
	}

	.to-list {
		display: none;
	}

	/* Below 1024 px the list and a workout are separate screens. */
	@media (width < 64rem) {
		.history {
			grid-template-columns: minmax(0, 1fr);
		}

		.selected .list,
		.selected .to-progress,
		.history:not(.selected) .pane {
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
