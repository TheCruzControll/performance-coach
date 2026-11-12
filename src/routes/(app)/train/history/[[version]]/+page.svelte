<script lang="ts">
	import { invalidateAll, preloadData } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { navigating } from '$app/state';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';
	import SessionCard from '#lib/ui/program/SessionCard.svelte';
	import WeekStrip from '#lib/ui/program/WeekStrip.svelte';
	import DecisionItem from './DecisionItem.svelte';
	import type { HistoryPageView } from './history.server';
	import VersionList from './VersionList.svelte';
	import type { PageData, PageProps } from './$types';

	let { data }: PageProps = $props();

	const TRAIN = resolve('/(app)/train');
	const HISTORY = resolve('/(app)/train/history/[[version]]', {});

	let reloading = $state(false);
	async function reload() {
		reloading = true;
		await invalidateAll();
		reloading = false;
	}

	// ---- The list, and 'Show older versions' -------------------------------------------------

	const list = $derived(data.state === 'list' ? data : null);
	/** The state shown as a card: no changes yet (above the list), no program, or the error. */
	const card = $derived(data.state === 'list' ? data.empty : 'card' in data ? data.card : null);
	/** The list's first page: the list's, or a version's, which a desktop window lists beside it. */
	const first = $derived(data.state === 'list' || data.state === 'version' ? data.page : null);

	/**
	 * The older pages loaded below the server's first page, kept with the page they follow (its
	 * newest version and its cursor), so picking a version keeps them, and a new first page (a
	 * version made meanwhile) starts the list again.
	 */
	const keyOf = (page: HistoryPageView) => `${page.versions[0]?.number}:${page.next}`;
	let older = $state.raw<{ after: string; pages: HistoryPageView[] } | null>(null);
	const pages = $derived(first && older?.after === keyOf(first) ? older.pages : []);
	const versions = $derived(first ? [first, ...pages].flatMap((p) => p.versions) : []);
	const cursor = $derived(first ? (pages.at(-1) ?? first).next : null);
	let loadingOlder = $state(false);
	let olderFailed = $state(false);
	/** preloadData keeps its last result per URL, a soft failure too: each attempt is its own. */
	let attempt = 0;

	async function showOlder() {
		if (!first || cursor === null || loadingOlder) return;
		const after = keyOf(first);
		loadingOlder = true;
		olderFailed = false;
		// The next page through the route's own load, without navigating: an older page is
		// never the URL, and the route ships no form-action client.
		const result = await preloadData(`${HISTORY}?before=${cursor}&attempt=${++attempt}`).catch(
			() => null
		);
		loadingOlder = false;
		if (!first || keyOf(first) !== after) return; // the list was loaded again meanwhile
		const next = result?.type === 'loaded' ? (result.data as PageData) : null;
		if (next?.state === 'list') older = { after, pages: [...pages, next.page] };
		else olderFailed = true; // offline, a failed request or the load's own error
	}

	// ---- A version -------------------------------------------------------------------------

	const shown = $derived(data.state === 'version' ? data : null);

	/** The weekday the owner tapped, for the version they tapped it on. */
	let chosen = $state<{ version: number; day: number } | null>(null);
	const selectedIndex = $derived(
		shown && chosen?.version === shown.version.number ? chosen.day : (shown?.week.selected ?? 0)
	);
	const day = $derived(shown?.week.days[selectedIndex]);

	/** A session as it was in this version; the current version's is the session itself. */
	const sessionHref = (lineage: string) => {
		const path = resolve('/(app)/train/session/[key]', { key: lineage });
		return shown?.version.current ? path : `${path}?v=${shown?.version.number}`;
	};
	const navigatingTo = (href: string) =>
		!!navigating.to && `${navigating.to.url.pathname}${navigating.to.url.search}` === href;
</script>

<svelte:head>
	<title>{shown ? `Version ${shown.version.number}` : 'History'} · Train · Performance Coach</title>
</svelte:head>

{#if shown}
	{@const version = shown.version}
	<a class="back" href={HISTORY} data-testid="back-to-history">
		<Icon name="chevron-left" size={18} /> History
	</a>
	<PageHeader
		title={`Version ${version.number}`}
		eyebrow={`${version.when} · ${version.by}`}
		dated
	/>

	<!-- Split from 1024 px (docs/design-system.md, Responsive layout → Screens): the list beside
	     the version, which stays in the URL. A phone shows the version alone. -->
	<div data-layout="split">
		{@render listColumn(version.number)}
		<div class="stack" data-testid="version-detail">
			{#if version.current}
				<Notice icon="check" title="Your current plan" data-testid="current-version">
					Read-only here. <a class="inline" href={TRAIN}>Change it on Train</a>
				</Notice>
			{:else}
				<Notice icon="clock" title="Older version · read-only" data-testid="older-version">
					Your plan as it was after this change: its sessions open as they were then.
					<a class="inline" href={TRAIN}>See your current plan</a>
				</Notice>
			{/if}

			<Section title={shown.week.label} data-testid="version-week">
				{#if shown.week.bridge}
					{@const bridge = shown.week.bridge}
					<Surface padding="none" radius="lg">
						<EmptyState
							icon={bridge.icon}
							tone={bridge.tone}
							title={bridge.title}
							description={bridge.description}
							data-testid={bridge.id}
						/>
					</Surface>
				{:else}
					<WeekStrip
						days={shown.week.strip}
						today={shown.today}
						selected={day ? shown.week.strip[selectedIndex]!.date : null}
						label={shown.week.label}
						onselect={(date) =>
							(chosen = {
								version: version.number,
								day: shown.week.strip.findIndex((d) => d.date === date)
							})}
						data-testid="week-strip"
					/>
					{#if day}
						<h3 class="day">{day.heading}</h3>
						{#each day.cards as card (card.lineage)}
							{@const href = sessionHref(card.lineage)}
							<SessionCard
								session={card}
								{href}
								baseline={card.baseline}
								pending={navigatingTo(href)}
								data-testid="session-card"
							/>
						{:else}
							<Surface padding="none" radius="lg">
								<EmptyState
									compact
									icon="moon"
									tone="neutral"
									title="Rest day"
									description={day.rest ?? undefined}
									data-testid="rest-day"
								/>
							</Surface>
						{/each}
					{/if}
				{/if}
			</Section>

			<Section title="What changed" data-testid="version-changes">
				<p class="summary">{version.summary}</p>
				{#if version.decisions.length}
					<ul class="decisions">
						{#each version.decisions as decision (decision.id)}
							<DecisionItem {decision} />
						{/each}
					</ul>
				{/if}
			</Section>
		</div>
	</div>
{:else}
	<a class="back" href={TRAIN} data-testid="back-to-train">
		<Icon name="chevron-left" size={18} /> Train
	</a>
	<PageHeader title="History" eyebrow="Program" />

	<!-- Split from 1024 px with a list: no version picked yet, the detail's place says how to
	     pick one, or holds 'no changes yet'. Without one (no program, the error), readable. -->
	<div class="stack" data-layout={list ? 'split' : undefined}>
		{#if card}
			<Surface padding="none" radius="xl" class="detail">
				<EmptyState
					icon={card.icon}
					tone={card.tone}
					title={card.title}
					description={card.description}
					actions={list ? undefined : cardAction}
					data-testid={card.id}
				/>
			</Surface>
		{/if}
		{#if list}
			{@render listColumn(null)}
			{#if !card}
				<Surface padding="none" radius="xl" class="detail pick">
					<EmptyState
						icon="clock"
						tone="neutral"
						title="Pick a version"
						description="Its week, as it was then, and why it changed open here."
						data-testid="history-pick"
					/>
				</Surface>
			{/if}
		{/if}
	</div>
{/if}

<!-- The versions, then 'Show older versions' and its failure at the foot: the list's own column,
     shown beside a version from 1024 px (a phone shows the version alone). -->
{#snippet listColumn(selected: number | null)}
	<div class={['versions', selected !== null && 'beside']} data-testid="history-list">
		<VersionList {versions} {selected} />
		<p class="visually-hidden" role="status">
			{loadingOlder ? 'Loading older versions…' : ''}
		</p>
		{#if cursor !== null}
			<button
				type="button"
				class="older"
				disabled={loadingOlder}
				aria-busy={loadingOlder}
				onclick={showOlder}
				data-testid="show-older"
			>
				<span class="glyph"><Icon name="clock" size={18} /></span> Show older versions
			</button>
		{/if}
		{#if olderFailed}
			<Notice tone="danger" title="Couldn’t load older versions" data-testid="older-failed">
				<button type="button" class="retry" onclick={showOlder}>Retry</button>
			</Notice>
		{/if}
	</div>
{/snippet}

<!-- The state card's next step: Retry for the error (Train's inline Retry, not a Button, to stay
     in budget), Train for no program. -->
{#snippet cardAction()}
	{#if data.state === 'error'}
		<button
			type="button"
			class="retry"
			aria-busy={reloading}
			disabled={reloading}
			onclick={reload}
			data-testid="history-retry"
		>
			<Icon name="refresh" size={18} /> Retry
		</button>
	{:else}
		<a class="retry" href={TRAIN}>Go to Train</a>
	{/if}
{/snippet}

<style>
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

	@media (hover: hover) and (pointer: fine) {
		.back:hover {
			color: var(--color-text);
		}
	}

	.stack,
	.versions {
		display: grid;
		gap: var(--space-6);
	}

	/* A phone or a tablet shows a version alone, and has no detail to point to. */
	@media (width < 64rem) {
		.beside,
		.stack > :global(.pick) {
			display: none;
		}
	}

	/*
	 * Desktop (split, layout.css): the list in the first column, from the top, and the version (or
	 * the card in its place) in the second, so the list stays put while a version is picked.
	 */
	@media (width >= 64rem) {
		[data-layout='split'] {
			column-gap: var(--space-8);
		}

		[data-layout='split'] > .versions {
			grid-column: 1;
			grid-row: 1;
		}

		[data-layout='split'] > :global(.detail) {
			grid-column: 2;
			grid-row: 1;
		}
	}

	.summary {
		font-weight: var(--weight-semibold);
		line-height: var(--leading-snug);
	}

	.decisions {
		display: grid;
		gap: var(--space-3);
		margin: var(--space-1) 0 0;
		padding: 0;
		list-style: none;
	}

	.day {
		margin-top: var(--space-2);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		color: var(--color-text-secondary);
	}

	/* The notice styles its links (accent, underlined): on a line of its own, a 44 px target. */
	.inline {
		display: flex;
		align-items: center;
		min-height: var(--touch-target);
		margin-bottom: calc(var(--space-2) * -1);
		font-weight: var(--weight-semibold);
	}

	/* A quiet outlined pill, as Train's header actions are: 44 px tall, the list's width. */
	.older {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		min-height: var(--touch-target);
		padding: 0 var(--space-5);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-full);
		background: var(--color-surface-1);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		color: var(--color-text);
		transition:
			border-color var(--duration-fast) var(--ease-standard),
			transform var(--duration-fast) var(--ease-out);
	}

	@media (hover: hover) and (pointer: fine) {
		.older:hover:not(:disabled) {
			border-color: var(--color-border-strong);
		}
	}

	.older:active:not(:disabled) {
		transform: scale(0.97);
	}

	.older:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	/* Loading: a spinner takes the icon's place after a beat, so a fast page shows nothing. */
	.older[aria-busy='true'] {
		cursor: progress;
	}

	.glyph {
		position: relative;
		display: inline-grid;
		place-items: center;
	}

	.older[aria-busy='true'] .glyph :global(svg) {
		animation: shown 0s 150ms reverse forwards;
	}

	.older[aria-busy='true'] .glyph::before {
		content: '';
		position: absolute;
		width: 16px;
		height: 16px;
		border: 2px solid color-mix(in srgb, currentColor 25%, transparent);
		border-top-color: currentColor;
		border-radius: var(--radius-full);
		opacity: 0;
		animation:
			shown 0s 150ms forwards,
			spin 0.8s linear infinite;
	}

	@keyframes shown {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	/* An accent text action with a 44 × 44 px target, as Train's notices word their Retry. */
	.retry {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1-5);
		min-width: var(--touch-target);
		min-height: var(--touch-target);
		padding: 0 var(--space-3);
		font-size: var(--text-sm);
		font-weight: var(--weight-bold);
		color: var(--color-accent-text);
	}

	.retry:disabled {
		cursor: progress;
		opacity: 0.6;
	}

	@media (hover: hover) and (pointer: fine) {
		.retry:hover:not(:disabled) {
			text-decoration: underline;
			text-underline-offset: 3px;
		}
	}
</style>
