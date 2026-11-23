<!--
  Changes (Instrument v2, Paper 4 · Train "What has changed"; history.server.ts): one line per
  change with its day, newest first, and Show older changes; a change as who made it and why
  (Was and Now are not stored); and the week as it was before it, as Train's lines. Reached from
  Train's More. From 1024 px a split screen: the list in its column, the change open beside it
  behind a hairline, with an × back to the list; with no change open, that column is empty.
-->
<script lang="ts">
	import { invalidateAll, preloadData } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { navigating } from '$app/state';
	import Icon from '#lib/ui/components/Icon.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import WeekLines from '#lib/ui/program/WeekLines.svelte';
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

	// ---- The list, and 'Show older changes' --------------------------------------------------

	const list = $derived(data.state === 'list' ? data : null);
	/** No program, or the error: a statement in place of the list. */
	const card = $derived('card' in data ? data.card : null);
	/** The list's first page: the list's, or a change's, which a desktop window lists beside it. */
	const first = $derived(data.state === 'list' || data.state === 'version' ? data.page : null);
	const count = $derived(data.state === 'list' || data.state === 'version' ? data.count : null);

	/**
	 * The older pages loaded below the server's first page, kept with the page they follow (its
	 * newest version and its cursor), so picking a change keeps them, and a new first page (a
	 * change made meanwhile) starts the list again.
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

	// ---- A change, and the week as it was ----------------------------------------------------

	const shown = $derived(data.state === 'version' ? data : null);
	const changeHref = $derived(
		shown
			? resolve('/(app)/train/history/[[version]]', { version: String(shown.version.number) })
			: HISTORY
	);

	/** The page's own heading, for the window's title. */
	const heading = $derived(shown ? (shown.week ? 'As it was' : shown.version.summary) : 'Changes');

	/** 'Changed today', 'Changed yesterday', 'Changed 12 Nov'. */
	const changed = (day: string) =>
		`Changed ${day === 'Today' || day === 'Yesterday' ? day.toLowerCase() : day}`;

	/** A session as it was in the week shown; the current version's is the session itself. */
	const sessionHref = (lineage: string) => {
		const path = resolve('/(app)/train/session/[key]', { key: lineage });
		return shown?.week?.older ? `${path}?v=${shown.week.version}` : path;
	};
</script>

<svelte:head>
	<title>{heading} · Train · Performance Coach</title>
</svelte:head>

{#snippet chevron()}
	<Icon name="chevron-right" size={14} class="chevron" />
{/snippet}

{#if first}
	<!-- Split from 1024 px (docs/design-system.md, Responsive layout → Screens): the list beside
	     the change, which stays in the URL. A phone shows the change alone. -->
	<div data-layout="split">
		<div class={['list', shown && 'beside']}>
			<a class="back-link" href={TRAIN} data-testid="back-to-train">
				<Icon name="chevron-left" size={16} /> Week
			</a>
			<svelte:element this={shown ? 'h2' : 'h1'} class="title">Changes</svelte:element>
			{#if count}<p class="lead" data-testid="history-count">{count}</p>{/if}
			<div class="versions" data-testid="history-list">
				<VersionList {versions} selected={shown?.version.number ?? null} />
				<p class="visually-hidden" role="status">
					{loadingOlder ? 'Loading older changes…' : ''}
				</p>
				{#if cursor !== null}
					<button
						type="button"
						class="quiet older"
						disabled={loadingOlder}
						aria-busy={loadingOlder}
						onclick={showOlder}
						data-testid="show-older"
					>
						<span>Show older changes</span>{@render chevron()}
					</button>
				{/if}
				{#if olderFailed}
					<Notice tone="danger" title="Couldn’t load older changes" data-testid="older-failed">
						<button type="button" class="retry" onclick={showOlder}>Try again</button>
					</Notice>
				{/if}
			</div>
			{#if list?.empty}
				<p class="lead" data-testid="history-empty">{list.empty.description}</p>
			{/if}
		</div>

		{#if shown}
			{@const version = shown.version}
			<div class="detail" data-testid="version-detail">
				{#if shown.week}
					{@const week = shown.week}
					<!-- The week as it was before the change, read-only. -->
					<a class="back-link" href={changeHref} data-testid="back-to-change">
						<Icon name="chevron-left" size={16} />
						<span class="back-label">{version.summary}</span>
					</a>
					<h1 class="title">As it was</h1>
					<p class="lead">
						{version.number === 1
							? 'As first planned · read-only'
							: 'Before this change · read-only'}
					</p>
					<div class="week" data-testid="version-week">
						{#if week.bridge}
							<section class="state" data-testid={week.bridge.id} aria-labelledby="bridge-title">
								<h2 id="bridge-title" class="statement">{week.bridge.title}</h2>
								<p class="sentence">{week.bridge.description}</p>
							</section>
						{:else}
							<WeekLines
								lines={week.lines}
								label={week.label}
								href={sessionHref}
								pending={navigating.to?.url.pathname ?? null}
							/>
						{/if}
					</div>
					<a class="quiet" href={TRAIN} data-testid="see-current-week">
						<span>See the current week</span>{@render chevron()}
					</a>
				{:else}
					<!-- A phone goes back to the list; a desktop window closes the change beside it. -->
					<a class="back-link phone" href={HISTORY} data-testid="back-to-history">
						<Icon name="chevron-left" size={16} /> Changes
					</a>
					<p class="changed">
						<span>{changed(version.day)}</span>
						<a class="close" href={HISTORY} aria-label="Close" data-testid="close-change">
							<Icon name="close" size={16} />
						</a>
					</p>
					<h1 class="title">{version.summary}</h1>
					<p class="lead">
						{#if version.note}<span class="note">{version.note}</span>{/if}
						<span>{version.when} · {version.by}</span>
					</p>
					<dl class="facts" data-testid="version-changes">
						<div class="fact">
							<dt class="label">Who</dt>
							<dd class="value">{version.by}</dd>
						</div>
						{#if version.decisions.length === 1}
							<div class="fact" data-testid="decision">
								<dt class="label">Why</dt>
								<dd class="value">{version.decisions[0]!.why}</dd>
							</div>
						{:else}
							{#each version.decisions as decision (decision.id)}
								<!-- Several: each decision's own words, and its why under them. -->
								<div class="fact several" data-testid="decision">
									<dt class="value">{decision.summary ?? version.summary}</dt>
									<dd class="why">{decision.why}</dd>
								</div>
							{/each}
						{/if}
					</dl>
					{#if version.current}
						<p class="aside" data-testid="current-version">This is your plan now.</p>
					{:else}
						<p class="aside" data-testid="older-version">
							An earlier version, read-only. Its sessions open as they were then.
						</p>
					{/if}
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() + a query -->
					<a class="quiet" href={`${changeHref}?week`} data-testid="see-week">
						<span>See the week as it was</span>{@render chevron()}
					</a>
				{/if}
			</div>
		{/if}
	</div>
{:else if card}
	<div class="screen">
		<a class="back-link" href={TRAIN} data-testid="back-to-train">
			<Icon name="chevron-left" size={16} /> Week
		</a>
		<!-- One statement in place of the list (Paper, 4 · Train "No week to show"). -->
		<section class="state" data-testid={card.id} aria-labelledby="state-title">
			<h1 id="state-title" class="statement">{card.title}</h1>
			<p class="sentence">{card.description}</p>
			{#if data.state === 'error'}
				<button
					type="button"
					class="again"
					aria-busy={reloading}
					disabled={reloading}
					onclick={reload}
					data-testid="history-retry"
				>
					Try again
				</button>
			{/if}
		</section>
	</div>
{/if}

<style>
	.list,
	.detail,
	.screen {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.title {
		margin-top: var(--space-10);
		font: var(--type-title);
		letter-spacing: var(--tracking-display);
		color: var(--color-text);
		overflow-wrap: anywhere;
	}

	.lead {
		display: grid;
		margin-top: var(--space-2);
		font: var(--type-body);
		color: var(--color-text-secondary);
	}

	.versions {
		display: grid;
		margin-top: var(--space-8);
	}

	/* The back link keeps to its words; the one to the change names it, on one line, cut short. */
	.back-link {
		align-self: flex-start;
		max-width: 100%;
	}

	.back-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* 'Changed today' and its ×: a desktop window's, in place of the back link. */
	.changed {
		display: none;
		align-items: center;
		justify-content: space-between;
		min-height: var(--touch-target);
		margin-top: var(--space-3);
		font: var(--type-secondary);
		color: var(--color-text-secondary);
	}

	.close {
		display: grid;
		place-items: center;
		width: var(--touch-target);
		height: var(--touch-target);
		margin-right: calc((var(--touch-target) - 1rem) / -2);
		color: var(--color-text-secondary);
	}

	/* Who and Why: 60 px rows, a 96 px label column, a hairline between. */
	.facts {
		display: grid;
		margin: var(--space-8) 0 0;
	}

	.fact {
		display: flex;
		align-items: baseline;
		gap: var(--space-3);
		min-height: 3.75rem;
		padding: var(--space-4) 0;
	}

	.fact + .fact {
		border-top: 1px solid var(--color-hairline);
	}

	.label {
		flex: none;
		width: 6rem;
		font: var(--type-secondary);
		line-height: 1.2; /* 15/18 */
		color: var(--color-text-tertiary);
	}

	.value {
		flex: 1;
		min-width: 0;
		margin: 0;
		font: var(--type-row);
		color: var(--color-text);
	}

	.several {
		flex-direction: column;
		gap: var(--space-1);
	}

	.why {
		margin: 0;
		font: var(--type-secondary);
		color: var(--color-text-secondary);
	}

	.aside {
		margin-top: var(--space-6);
		font: var(--type-secondary);
		color: var(--color-text-tertiary);
	}

	.week {
		margin-top: var(--space-8);
	}

	/* A quiet row: Show older changes, See the week as it was, See the current week. */
	.quiet {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		width: 100%;
		min-height: 3.75rem;
		margin-top: var(--space-3-5);
		font: var(--type-secondary);
		color: var(--color-text-secondary);
		text-align: start;
		text-decoration: none;
	}

	.quiet :global(.chevron) {
		flex: none;
		color: var(--color-text-tertiary);
	}

	.older {
		margin-top: 0;
		border-top: 1px solid var(--color-hairline);
	}

	.older[aria-busy='true'] {
		cursor: progress;
		color: var(--color-text-tertiary);
	}

	/* A phone at the foot, above the tab bar, as Train's states stand; from 1024 px at the top. */
	.screen:has(.state) {
		min-height: calc(100svh - var(--nav-inset-bottom) - var(--safe-top) - var(--space-12));
	}

	.screen .state {
		margin-top: auto;
		padding-top: var(--space-10);
	}

	.statement {
		font: var(--type-statement);
		letter-spacing: var(--tracking-statement);
		color: var(--color-text);
	}

	.sentence {
		padding: var(--space-3) 0 var(--space-7);
		font: var(--type-body);
		color: var(--color-text-secondary);
	}

	.again {
		min-height: var(--touch-target);
		font: var(--type-button);
		color: var(--color-text);
	}

	.again:disabled {
		cursor: progress;
	}

	/* The notice's inline action, as Train styles its own: accent, underlined, a 44 × 44 px target. */
	.retry {
		display: flex;
		align-items: center;
		min-width: var(--touch-target);
		min-height: var(--touch-target);
		padding: 0 var(--space-2);
		margin: calc(var(--space-2) * -1);
		font-size: var(--text-sm);
		font-weight: var(--weight-bold);
		color: var(--color-accent-text);
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	@media (hover: hover) and (pointer: fine) {
		.quiet:is(a, button):hover:not(:disabled),
		.close:hover {
			color: var(--color-text);
		}
	}

	/* A phone or a tablet shows a change alone. */
	@media (width < 64rem) {
		.beside {
			display: none;
		}
	}

	/* Desktop (split, layout.css): the list in the first column, the change in the second behind
	   a hairline (Paper, "Change detail"), its title a statement, and an × in place of the back
	   link. */
	@media (width >= 64rem) {
		.detail {
			align-self: stretch;
			padding-left: var(--space-14);
			border-left: 1px solid var(--color-hairline);
		}

		.detail .title {
			font: var(--type-statement);
			letter-spacing: var(--tracking-statement);
		}

		.phone {
			display: none;
		}

		.changed {
			display: flex;
		}

		.screen:has(.state) {
			min-height: 0;
		}

		.screen .state {
			margin-top: 0;
		}
	}
</style>
