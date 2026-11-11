<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll, preloadData } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { navigating, page } from '$app/state';
	import type { TurnRef } from '#lib/client/coach/stream.ts';
	import type { CoachTurns } from '#lib/client/coach/turn.svelte.ts';
	import Icon from '#lib/ui/components/Icon.svelte';
	import CoachNotice from '#lib/ui/coach/CoachNotice.svelte';
	import Composer from '#lib/ui/coach/Composer.svelte';
	import LoadingRows from '#lib/ui/coach/LoadingRows.svelte';
	import type { CoachNoticeKind } from '#lib/ui/coach/coach-notices.ts';
	import CoachHeader from './CoachHeader.svelte';
	import ContextChip from './ContextChip.svelte';
	import Suggestions from './Suggestions.svelte';
	import type { ThreadRowView } from './words';
	import type { PageData, PageProps } from './$types';

	let { data }: PageProps = $props();

	const ROUTE = '/(app)/coach/[[thread]]';
	const HOME = resolve(ROUTE, {});

	const ready = $derived(data.failed ? null : data);

	/**
	 * Why the coach cannot answer: not launched and switched off have their own notices, every
	 * other reason the unavailable one. The composer stays disabled either way.
	 */
	const unavailable = $derived.by((): CoachNoticeKind | null => {
		if (data.coach.status === 'ready') return null;
		const { reason } = data.coach;
		return reason === 'not_launched' || reason === 'disabled' ? reason : 'unavailable';
	});

	let retrying = $state(false);
	async function retry() {
		retrying = true;
		await invalidateAll();
		retrying = false;
	}

	// ---- 'Show older' ------------------------------------------------------------------------

	type Older = { rows: ThreadRowView[]; next: string | null };
	/**
	 * Older pages loaded below the first, kept with the first page's conversations: a new first
	 * page (a conversation answered meanwhile), or a conversation renamed, archived or unarchived
	 * (onchanged), starts the list again.
	 */
	let older = $state.raw<{ after: string; pages: Older[] } | null>(null);
	const first = $derived(ready ? ready.threads.map((row) => row.id).join() : '');
	const pages = $derived(ready && older?.after === first ? older.pages : []);
	const rows = $derived(ready ? [ready.threads, ...pages.map((p) => p.rows)].flat() : []);
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
		const result = await preloadData(`${HOME}?before=${cursor}&attempt=${++attempt}`).catch(
			() => null
		);
		loadingOlder = false;
		if (first !== after) return; // the list was loaded again meanwhile
		const next = result?.type === 'loaded' ? (result.data as PageData) : null;
		if (next?.failed === false) {
			older = { after, pages: [...pages, { rows: next.threads, next: next.next }] };
		} else olderFailed = true; // offline, a failed request or the load's own failure
	}

	// ---- Asking ----------------------------------------------------------------------------

	/**
	 * The stream client (client/coach/turn.svelte.ts and stream.ts) loads on demand, on idle or
	 * with the first send, never in the initial JavaScript. An entry point's question waits in the
	 * composer; the page opens fresh with each.
	 */
	// svelte-ignore state_referenced_locally
	let draft = $state.raw(data.prefill?.text ?? '');
	let live = $state.raw<CoachTurns | null>(null);
	let loading: Promise<CoachTurns> | undefined;
	// A failed import is forgotten, so the next Send imports again.
	const loadLive = () =>
		(loading ??= (import.meta.env.SSR ? never() : import('#lib/client/coach/turn.svelte.ts')).then(
			(module) => (live = module.coachTurns),
			(error: unknown) => {
				loading = undefined;
				throw error;
			}
		));
	// A misconfigured coach still answers lookups (askable); an archived conversation is
	// read-only until unarchived (its banner, ArchivedBanner).
	const canAsk = $derived(data.askable && !ready?.thread?.archived);

	/**
	 * The stream client failing to load on a Send is the chunk-failed notice, whose Retry sends
	 * again; failing again while online reloads the page with the question kept in the composer
	 * (sessionStorage, KEPT), as Chromium keeps a failed module fetch for the document's lifetime.
	 */
	const KEPT = 'coach.unsent';
	let liveFailed = $state.raw<string | null>(null);
	let liveFailures = 0;
	let starting = $state(false);
	let entered: PageData['prefill'] | undefined;
	async function send(text: string) {
		if (starting) return; // a second press while the client loads
		starting = true;
		const turns = await loadLive().catch(() => null);
		starting = false;
		if (!turns) {
			if (++liveFailures >= 2 && navigator.onLine) {
				sessionStorage.setItem(KEPT, text);
				return location.reload();
			}
			liveFailed = text;
			return;
		}
		liveFailed = null;
		draft = '';
		// An entry (where Coach was opened from, and about what) goes with its first question.
		const entry = data.prefill === entered ? null : data.prefill;
		entered = data.prefill;
		void turns.send(text, entry?.from, entry?.ref ?? null);
	}

	/** A turn about something on screen: 'Ask for changes' sends the proposal it revises. */
	async function ask(text: string, from: string, ref: TurnRef) {
		const turns = await loadLive().catch(() => null);
		void turns?.send(text, from, ref);
	}

	onMount(() => {
		const kept = sessionStorage.getItem(KEPT);
		sessionStorage.removeItem(KEPT);
		if (kept && !draft) draft = kept;
		if (canAsk) (window.requestIdleCallback ?? setTimeout)(() => loadLive().catch(() => {}));
		return () => live?.leave();
	});

	/**
	 * Opening a conversation, or going back to the list: the screen is busy until it renders. Not
	 * while an answer streams: a new conversation's page opens under it.
	 */
	const switching = $derived(
		!live?.running &&
			navigating.to?.route.id === ROUTE &&
			navigating.to.url.pathname !== page.url.pathname
	);

	// ---- The conversation's code -------------------------------------------------------------

	/**
	 * A conversation's code (its answer blocks, their words and dates) loads on demand, in the
	 * browser only, so the list's initial JavaScript stays within budget (docs/performance.md). It
	 * starts with the navigation that opens one, alongside its data; until it arrives the
	 * conversation shows loading rows, and a failed import offers Retry, which imports again.
	 */
	const never = () => new Promise<never>(() => {});
	const wantsThread = $derived(Boolean(page.params.thread) || switching || live?.asking);
	let threadAttempt = $state(0);
	const threadCode = $derived.by(() => {
		void threadAttempt;
		if (!wantsThread) return null;
		return import.meta.env.SSR ? never() : import('./Thread.svelte');
	});

	/**
	 * Budget lever (M5 plan, Budgets: 'the recent-conversations list on idle'): the list's code
	 * loads on demand too, in the browser as soon as /coach shows, so the stream client fits in the
	 * route's 60 KB. Loading rows hold its place meanwhile; Retry imports again. With no
	 * conversation the server renders the empty state, the screen's largest text, so it paints
	 * with the page instead of after a chunk; the list's code still loads, and stays, for its
	 * 'Archived conversations' (archived ones stay in reach) and the Undo after archiving the last.
	 */
	const wantsList = $derived(!page.params.thread);
	const listCode = $derived.by(() => {
		void threadAttempt;
		if (!wantsList) return null;
		return import.meta.env.SSR ? never() : import('./ThreadList.svelte');
	});
</script>

<svelte:head>
	<title>{ready?.thread ? `${ready.thread.title} · Coach` : 'Coach'} · Performance Coach</title>
</svelte:head>

{#snippet failed()}
	<CoachNotice kind="load_failed" onretry={retry} {retrying} data-testid="load-failed" />
{/snippet}
{#snippet empty()}
	<section class="recent" aria-labelledby="recent-heading">
		<h2 id="recent-heading" class="eyebrow">Recent conversations</h2>
		<CoachNotice kind="empty" data-testid="coach-empty" />
	</section>
{/snippet}
{#snippet cannot()}
	{#if unavailable}<CoachNotice kind={unavailable} data-testid="coach-unavailable" />{/if}
{/snippet}

<CoachHeader mockBadge={data.coach.mockBadge} />

<div class="coach" aria-busy={switching ? 'true' : undefined} data-testid="coach-screen">
	{#if switching}
		<LoadingRows label="Loading the conversation…" data-testid="coach-loading" />
	{:else if page.params.thread || live?.asking}
		<a class="back" href={HOME} data-testid="all-conversations">
			<Icon name="chevron-left" size={18} /> All conversations
		</a>
		{#if ready?.thread || live?.asking}
			{#await threadCode}
				<LoadingRows label="Loading the conversation…" data-testid="thread-loading" />
			{:then code}
				{#if code}<code.default
						thread={ready?.thread ?? undefined}
						{live}
						onask={canAsk ? ask : undefined}
					/>{/if}
			{:catch}
				<CoachNotice
					kind="chunk_failed"
					onretry={() => threadAttempt++}
					data-testid="thread-failed"
				/>
			{/await}
		{:else}
			{@render failed()}
		{/if}
		{@render cannot()}
	{:else}
		{#if data.prefill?.label}<ContextChip label={data.prefill.label} />{/if}
		<Suggestions onpick={canAsk ? (text) => (draft = text) : undefined} />
		{@render cannot()}
		{#if ready}
			{#await listCode}
				{#if rows.length === 0}
					{@render empty()}
				{:else}
					<LoadingRows label="Loading your conversations…" data-testid="list-loading" />
				{/if}
			{:then code}
				{#if code}<code.default
						{rows}
						more={cursor !== null}
						{loadingOlder}
						{olderFailed}
						onolder={showOlder}
						onchanged={() => (older = null)}
					/>{/if}
			{:catch}
				{#if rows.length === 0}{@render empty()}{/if}
				<CoachNotice
					kind="chunk_failed"
					onretry={() => threadAttempt++}
					data-testid="list-failed"
				/>
			{/await}
		{:else}
			{@render failed()}
		{/if}
	{/if}
	{#if liveFailed !== null}
		<CoachNotice
			kind="chunk_failed"
			onretry={() => send(liveFailed!)}
			retrying={starting}
			data-testid="stream-failed"
		/>
	{/if}
</div>

<Composer
	bind:value={draft}
	disabled={!canAsk}
	running={live?.running}
	onsend={send}
	onstop={() => live?.stop()}
	data-testid="composer"
/>

<style>
	/* Reserves the composer's height so nothing ends up under it at the end of the page. */
	.coach {
		display: grid;
		gap: var(--space-5);
		padding-bottom: calc(var(--space-20) + var(--space-2));
	}

	.recent {
		display: grid;
		gap: var(--space-2);
	}

	.back {
		display: inline-flex;
		align-items: center;
		justify-self: start;
		gap: var(--space-1);
		min-height: var(--touch-target);
		margin-top: calc(var(--space-3) * -1);
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
