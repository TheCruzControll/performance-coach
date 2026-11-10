<script lang="ts">
	import { invalidateAll, preloadData } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { navigating, page } from '$app/state';
	import Icon from '#lib/ui/components/Icon.svelte';
	import CoachNotice from '#lib/ui/coach/CoachNotice.svelte';
	import Composer from '#lib/ui/coach/Composer.svelte';
	import LoadingRows from '#lib/ui/coach/LoadingRows.svelte';
	import type { CoachNoticeKind } from '#lib/ui/coach/coach-notices.ts';
	import CoachHeader from './CoachHeader.svelte';
	import ContextChip from './ContextChip.svelte';
	import Suggestions from './Suggestions.svelte';
	import ThreadList from './ThreadList.svelte';
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
	 * page (a conversation answered meanwhile) starts the list again.
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

	/** Opening a conversation, or going back to the list: the screen is busy until it renders. */
	const switching = $derived(
		navigating.to?.route.id === ROUTE && navigating.to.url.pathname !== page.url.pathname
	);

	// ---- The conversation's code -------------------------------------------------------------

	/**
	 * A conversation's code (its answer blocks, their words and dates) loads on demand, in the
	 * browser only, so the list's initial JavaScript stays within budget (docs/performance.md). It
	 * starts with the navigation that opens one, alongside its data; until it arrives the
	 * conversation shows loading rows, and a failed import offers Retry, which imports again.
	 */
	const never = () => new Promise<never>(() => {});
	const wantsThread = $derived(Boolean(page.params.thread) || switching);
	let threadAttempt = $state(0);
	const threadCode = $derived.by(() => {
		void threadAttempt;
		if (!wantsThread) return null;
		return import.meta.env.SSR ? never() : import('./Thread.svelte');
	});
</script>

<svelte:head>
	<title>{ready?.thread ? `${ready.thread.title} · Coach` : 'Coach'} · Performance Coach</title>
</svelte:head>

<CoachHeader mockBadge={data.coach.mockBadge} />

<div class="coach" aria-busy={switching ? 'true' : undefined} data-testid="coach-screen">
	{#if switching}
		<LoadingRows label="Loading the conversation…" data-testid="coach-loading" />
	{:else if page.params.thread}
		<a class="back" href={HOME} data-testid="all-conversations">
			<Icon name="chevron-left" size={18} /> All conversations
		</a>
		{#if ready?.thread}
			{#await threadCode}
				<LoadingRows label="Loading the conversation…" data-testid="thread-loading" />
			{:then code}
				{#if code}<code.default thread={ready.thread} />{/if}
			{:catch}
				<CoachNotice
					kind="chunk_failed"
					onretry={() => threadAttempt++}
					data-testid="thread-failed"
				/>
			{/await}
		{:else}
			<CoachNotice kind="load_failed" onretry={retry} {retrying} data-testid="load-failed" />
		{/if}
		{#if unavailable}<CoachNotice kind={unavailable} data-testid="coach-unavailable" />{/if}
	{:else}
		{#if data.prefill?.label}<ContextChip label={data.prefill.label} />{/if}
		<Suggestions />
		{#if unavailable}<CoachNotice kind={unavailable} data-testid="coach-unavailable" />{/if}
		{#if ready}
			<ThreadList {rows} more={cursor !== null} {loadingOlder} {olderFailed} onolder={showOlder} />
		{:else}
			<CoachNotice kind="load_failed" onretry={retry} {retrying} data-testid="load-failed" />
		{/if}
	{/if}
</div>

<Composer value={data.prefill?.text ?? ''} disabled data-testid="composer" />

<style>
	/* Reserves the composer's height so nothing ends up under it at the end of the page. */
	.coach {
		display: grid;
		gap: var(--space-5);
		padding-bottom: calc(var(--space-20) + var(--space-2));
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
