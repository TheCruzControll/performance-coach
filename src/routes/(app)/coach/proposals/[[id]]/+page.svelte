<!--
  @component
  The Proposals inbox (M5 plan, coach-proposals-inbox): every change the coach proposed, in one
  place. The ones waiting for the owner come first, then every decision, a page at a time ('Show
  more'), narrowed by a filter that lives in the URL, so a reload keeps it. From 1024 px it is a
  split screen (data-layout="split"): the list beside the proposal it opened, in the readable
  column. Below, the list and a proposal are separate screens, with 'All proposals' back. Opening
  a proposal keeps the one shown, dimmed and aria-busy, until the next renders. A failed load is
  its own state with Retry; no proposal at all, or none in a filter, has its designed empty state.
-->
<script lang="ts">
	import { tick, type Component } from 'svelte';
	import { afterNavigate, invalidateAll, preloadData } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { navigating, page } from '$app/state';
	import Button from '#lib/ui/components/Button.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';
	import InboxList from './InboxList.svelte';
	import Pending from './Pending.svelte';
	import type { InboxDetail, InboxFilter, InboxRow } from './inbox.server';
	import type { PageData, PageProps } from './$types';

	let { data }: PageProps = $props();

	const ROUTE = '/(app)/coach/proposals/[[id]]';
	const COACH = resolve('/(app)/coach/[[thread]]', {});
	const LIST = resolve(ROUTE, {});
	const FILTERS: { value: InboxFilter; label: string }[] = [
		{ value: 'all', label: 'All' },
		{ value: 'waiting', label: 'Waiting' },
		{ value: 'decided', label: 'Decided' }
	];
	/** The filter's query, which links into and back to the list keep. */
	const queryOf = (filter: InboxFilter) => (filter === 'all' ? '' : `?show=${filter}`);

	const ready = $derived(data.state === 'ready' ? data : null);
	const detail = $derived(ready?.detail ?? null);
	const search = $derived(queryOf(data.filter));

	let retrying = $state(false);
	async function retry() {
		retrying = true;
		await invalidateAll();
		retrying = false;
	}

	// ---- 'Show more' -------------------------------------------------------------------------

	type More = { rows: InboxRow[]; next: string | null };
	/**
	 * Later pages loaded below the first, kept with the first page's proposals: opening one loads
	 * the first page again, unchanged, so the list keeps them; a changed first page (a decision)
	 * starts it again.
	 */
	let more = $state.raw<{ after: string; pages: More[] } | null>(null);
	const first = $derived(ready ? `${data.filter}:${ready.rows.map((r) => r.id + r.status)}` : '');
	const pages = $derived(ready && more?.after === first ? more.pages : []);
	const rows = $derived(ready ? [ready.rows, ...pages.map((p) => p.rows)].flat() : []);
	const cursor = $derived(ready ? (pages.at(-1) ?? ready).next : null);
	let loadingMore = $state(false);
	let moreFailed = $state(false);
	/** preloadData keeps its last result per URL, a soft failure too: each attempt is its own. */
	let attempt = 0;

	async function showMore() {
		if (cursor === null || loadingMore) return;
		const after = first;
		loadingMore = true;
		moreFailed = false;
		const filter = search ? `${search.slice(1)}&` : '';
		const url = `${LIST}?${filter}more=${encodeURIComponent(cursor)}&attempt=${++attempt}`;
		const result = await preloadData(url).catch(() => null);
		loadingMore = false;
		if (first !== after) return; // the list was loaded again meanwhile
		const next = result?.type === 'loaded' ? (result.data as PageData) : null;
		if (next?.state === 'ready') more = { after, pages: [...pages, next] };
		else moreFailed = true; // offline, a failed request or the load's own failure
	}

	// ---- The proposal's code ----------------------------------------------------------------

	/**
	 * Budget lever (M5 plan: ProposalCard, RejectSheet and the decisions load on demand): the
	 * detail's code (Detail.svelte, with the decision client) loads in the browser once a proposal
	 * is open, so the list's initial JavaScript stays small and the route node adds few bytes to
	 * every route's router. Loading rows hold its place meanwhile; a failed import offers Retry,
	 * and failing again while online reloads the page, as Detail.svelte's sheet does.
	 */
	type DetailCode = Component<{ detail: InboxDetail; canAsk: boolean }>;
	const never = () => new Promise<never>(() => {});
	// Kept apart from .catch(): Vite moves `import(…).then(…)` whole into its preloader.
	const loadDetail = (): Promise<{ default: DetailCode }> => import('./Detail.svelte');
	const wantsDetail = $derived(!!detail);
	let detailAttempt = $state(0);
	let detailFailures = 0;
	const detailCode = $derived.by((): Promise<{ default: DetailCode }> | null => {
		void detailAttempt;
		if (!wantsDetail) return null;
		if (import.meta.env.SSR) return never();
		return loadDetail().catch((error: unknown) => {
			// Chromium keeps a failed module fetch for the document's lifetime: start again.
			if (++detailFailures >= 2 && navigator.onLine) location.reload();
			throw error;
		});
	});

	// ---- Opening a proposal ------------------------------------------------------------------

	const opening = $derived(
		navigating.to?.route.id === ROUTE &&
			!!navigating.to.params?.id &&
			navigating.to.params.id !== page.params.id
	);

	// A row keeps focus and scroll on a desktop window. On a phone the list is hidden once a
	// proposal opens (its column has no box): focus moves to the proposal, at the top.
	let list = $state<HTMLElement>();
	afterNavigate(async ({ type }) => {
		if (type !== 'link' || !detail || !list || list.getClientRects().length > 0) return;
		window.scrollTo(0, 0);
		await detailCode?.catch(() => {}); // its heading renders once its code has arrived
		await tick();
		document.getElementById('proposal-kind')?.focus();
	});
</script>

<!-- A part that failed to load, with Retry: EmptyState, already on the page, so no Notice code
     loads with the list (budget lever, as for Detail.svelte). Announced as an alert. -->
{#snippet failure(title: string, testId: string, onretry: () => void)}
	<div role="alert">
		<Surface padding="none" radius="xl">
			<EmptyState
				compact
				icon="alert"
				tone="combat"
				{title}
				description="Check your connection, then try again."
				data-testid={testId}
			>
				{#snippet actions()}
					<Button variant="secondary" icon="refresh" onclick={onretry}>Try again</Button>
				{/snippet}
			</EmptyState>
		</Surface>
	</div>
{/snippet}

<svelte:head>
	<title>{detail ? `${detail.card.title} · Proposals` : 'Proposals'} · Performance Coach</title>
</svelte:head>

<div
	class="inbox"
	class:selected={!!detail}
	data-layout={ready && !ready.none ? 'split' : undefined}
	data-testid="inbox"
>
	<div class="top">
		<a class="back to-coach" href={COACH} data-testid="back-to-coach">
			<Icon name="chevron-left" size={18} /> Coach
		</a>
		<a class="back to-list" href="{LIST}{search}" data-testid="all-proposals">
			<Icon name="chevron-left" size={18} /> All proposals
		</a>
		<PageHeader title="Proposals" eyebrow="Coach" />
	</div>

	{#if !ready}
		<Surface padding="none" radius="xl">
			<EmptyState
				icon="alert"
				tone="combat"
				title="Couldn’t load your proposals"
				description="Nothing was changed. Check your connection, then try again."
				data-testid="inbox-failed"
			>
				{#snippet actions()}
					<Button
						variant="secondary"
						icon="refresh"
						loading={retrying}
						onclick={retry}
						data-testid="inbox-retry">Try again</Button
					>
				{/snippet}
			</EmptyState>
		</Surface>
	{:else if ready.none}
		<Surface padding="none" radius="xl">
			<EmptyState
				icon="sparkle"
				title="No proposals yet"
				description="When the coach suggests a change to your plan, it waits here for your answer. Nothing changes until you accept."
				data-testid="inbox-empty"
			>
				{#snippet actions()}
					<Button href={COACH} iconEnd="arrow-right" data-testid="inbox-ask">Ask the coach</Button>
				{/snippet}
			</EmptyState>
		</Surface>
	{:else}
		<section class="list" aria-label="Proposals" bind:this={list}>
			<nav class="filters" aria-label="Show">
				{#each FILTERS as filter (filter.value)}
					<a
						class="filter"
						href="{LIST}{queryOf(filter.value)}"
						aria-current={filter.value === data.filter ? 'page' : undefined}
						data-sveltekit-noscroll
						data-testid="filter-{filter.value}">{filter.label}</a
					>
				{/each}
			</nav>
			{#if rows.length}
				<InboxList {rows} selected={detail?.card.id ?? null} {search} />
			{:else}
				<Surface padding="none" radius="xl">
					<EmptyState
						compact
						icon={data.filter === 'waiting' ? 'check' : 'clock'}
						tone="neutral"
						title={data.filter === 'waiting' ? 'Nothing waiting for you' : 'Nothing decided yet'}
						description={data.filter === 'waiting'
							? 'You’ve answered every proposal. New ones show here first.'
							: 'Proposals you accept or reject are kept here, with what happened.'}
						data-testid="inbox-filter-empty"
					/>
				</Surface>
			{/if}
			<p class="visually-hidden" role="status">{loadingMore ? 'Loading more proposals…' : ''}</p>
			{#if cursor !== null}
				<Button variant="secondary" loading={loadingMore} onclick={showMore} data-testid="show-more"
					>Show more</Button
				>
			{/if}
			{#if moreFailed}
				{@render failure('Couldn’t load more proposals', 'more-failed', showMore)}
			{/if}
		</section>

		<div class="pane" aria-busy={opening ? 'true' : undefined} data-testid="inbox-pane">
			{#if detail}
				{#await detailCode}
					<Pending data-testid="detail-loading" />
				{:then code}
					{#if code}{#key detail.card.id}<code.default {detail} canAsk={data.canAsk} />{/key}{/if}
				{:catch}
					{@render failure('Couldn’t load this proposal', 'detail-failed', () => detailAttempt++)}
				{/await}
			{:else if opening}
				<Pending data-testid="detail-loading" />
			{:else}
				<Surface padding="none" radius="xl">
					<EmptyState
						compact
						icon="sparkle"
						tone="neutral"
						title="Pick a proposal"
						description="What changes, why, and its impact on your weeks show here."
						data-testid="pick-proposal"
					/>
				</Surface>
			{/if}
		</div>
	{/if}
</div>

<style>
	/* One column; from 1024 px a split screen's two (layout.css), the list beside the proposal. */
	.inbox {
		display: grid;
		row-gap: var(--space-5);
	}

	.inbox:not([data-layout='split']) {
		grid-template-columns: minmax(0, 1fr);
	}

	.top {
		grid-column: 1 / -1;
	}

	.list {
		display: grid;
		gap: var(--space-4);
		align-content: start;
		min-width: 0;
	}

	.pane {
		min-width: 0;
		transition: opacity var(--duration-fast) var(--ease-standard);
	}

	/* Opening another proposal: the one shown dims until the next renders. */
	.pane[aria-busy='true'] {
		opacity: 0.6;
	}

	/* Beside the list it has nothing to go back to; .back.to-list outranks .back's display. */
	.back.to-list {
		display: none;
	}

	/* Below 1024 px the list and a proposal are separate screens; opening one shows the list
	   until it renders (its row is busy), so the pane shows only once a proposal is open. */
	@media (width < 64rem) {
		.inbox {
			grid-template-columns: minmax(0, 1fr);
		}

		.selected .list,
		.selected .to-coach,
		.inbox:not(.selected) .pane {
			display: none;
		}

		.selected .to-list {
			display: inline-flex;
		}
	}

	.filters {
		display: flex;
		gap: var(--space-2);
	}

	.filter {
		display: inline-flex;
		align-items: center;
		min-height: var(--touch-target);
		padding: 0 var(--space-4);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-full);
		background: var(--color-surface-1);
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		transition:
			border-color var(--duration-fast) var(--ease-standard),
			background-color var(--duration-fast) var(--ease-standard);
	}

	/* The filter shown: filled, and aria-current, never colour alone. */
	.filter[aria-current='page'] {
		border-color: var(--color-surface-inverse);
		background: var(--color-surface-inverse);
		color: var(--color-text-inverse);
		font-weight: var(--weight-semibold);
	}

	.back,
	.filter {
		-webkit-tap-highlight-color: transparent;
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

	.back:focus-visible,
	.filter:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	@media (hover: hover) and (pointer: fine) {
		.back:hover {
			color: var(--color-text);
		}

		.filter:not([aria-current='page']):hover {
			border-color: var(--color-border-strong);
			color: var(--color-text);
		}
	}
</style>
