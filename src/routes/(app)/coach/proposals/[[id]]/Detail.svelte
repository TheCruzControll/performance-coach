<!--
  @component
  The proposal the inbox opened: its kind, when it was proposed and decided, the conversation it
  came from, the owner's reason for a rejection (their own words, shown as text), and the same
  ProposalCard a conversation shows, with all its decisions:
  - Accept goes by id; the card then shows the proposal as the server answered (applied as version
    N, waiting for the cycle review, or superseded), and the list is read again so it moves under
    Decided.
  - Reject opens RejectSheet, loaded on the first tap; the rejection goes by id with its optional
    reason.
  - 'Ask for changes' opens the conversation it came from with that sheet (`?revise=<id>`), where
    the coach drafts the revision; only while the coach can answer, and never for a review's.
  - A decision that failed on the way shows 'Couldn’t save' on the card, whose Retry sends the
    same decision again; while offline nothing can be decided.
  This file is the inbox's code on demand (+page.svelte imports it once a proposal is open), so
  the card comes with it; the sheet's code loads with the first Reject, and a failed fetch is a
  notice with Retry, failing again while online reloading the page.
-->
<script lang="ts">
	import { onMount, type Component } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { decideProposal, type Decision } from '#lib/client/coach/proposals.ts';
	import type { ProposalCardView } from '#lib/domain/coach/cards.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import ProposalCard from '#lib/ui/coach/ProposalCard.svelte';
	import { toast } from '#lib/ui/toast.svelte.ts';
	import type { InboxDetail } from './inbox.server';

	interface Props {
		detail: InboxDetail;
		/** The coach can answer now: 'Ask for changes' is offered. */
		canAsk: boolean;
	}

	let { detail, canAsk }: Props = $props();

	/** A refused decision, as the Coach screen words it (coach-notices.ts, not imported: its chunk). */
	const ACTION_FAILED = 'That didn’t go through';
	type RejectSheet = Component<{
		open: boolean;
		mode: 'reject';
		title: string;
		pending?: boolean;
		onsubmit: (words: string | null) => void;
	}>;

	/**
	 * What a decision here answered, until the page's own data catches up: then the server's card,
	 * which also names the review a next cycle was folded into.
	 */
	let answered = $state.raw<ProposalCardView | null>(null);
	const card = $derived(
		answered?.id === detail.card.id && answered.status !== detail.card.status
			? answered
			: detail.card
	);
	let pending = $state<Decision['action'] | null>(null);
	let failure = $state.raw<Decision | null>(null);
	let online = $state(true);

	async function decide(decision: Decision) {
		if (pending) return; // a second tap while the first is on its way
		const id = card.id;
		pending = decision.action;
		failure = null;
		const result = await decideProposal(id, decision);
		pending = null;
		if (result.kind === 'decided') {
			answered = result.card;
			void invalidateAll(); // the list moves it under Decided
		} else if (result.retry) failure = decision;
		else toast.show(ACTION_FAILED, { tone: 'danger' });
	}

	// ---- Reject's sheet, on demand ----------------------------------------------------------------

	// Left out of the server build, which never renders it, and kept apart from .then(): Vite moves
	// `import(…).then(…)` whole into its preloader.
	const loadSheet = (): Promise<{ default: RejectSheet }> =>
		import.meta.env.SSR
			? Promise.reject(new Error('client only'))
			: import('#lib/ui/coach/RejectSheet.svelte');

	let Sheet = $state.raw<RejectSheet | null>(null);
	let sheetOpen = $state(false);
	let sheetFailed = $state(false);
	let failures = 0;

	function reject() {
		sheetFailed = false;
		if (Sheet) return void (sheetOpen = true);
		loadSheet().then(
			(module) => {
				Sheet = module.default;
				sheetOpen = true;
			},
			() => {
				// Chromium keeps a failed module fetch for the document's lifetime: start again.
				if (++failures >= 2 && navigator.onLine) return location.reload();
				sheetFailed = true;
			}
		);
	}

	onMount(() => (online = navigator.onLine));

	const conversation = $derived(
		detail.threadId ? resolve('/(app)/coach/[[thread]]', { thread: detail.threadId }) : null
	);
</script>

<svelte:window ononline={() => (online = true)} onoffline={() => (online = false)} />

<section class="detail" aria-labelledby="proposal-kind" data-testid="inbox-detail">
	<header class="head">
		<h2 id="proposal-kind" class="kind" tabindex="-1">{detail.kind}</h2>
		<p class="dates">{detail.dates.join(' · ')}</p>
	</header>

	<ProposalCard
		{card}
		accepting={pending === 'accept'}
		rejecting={pending === 'reject'}
		failed={failure !== null}
		offline={!online}
		onaccept={() => decide({ action: 'accept' })}
		onreject={reject}
		onrevise={conversation && canAsk
			? () => location.assign(`${conversation}?revise=${encodeURIComponent(card.id)}`)
			: undefined}
		onretry={() => failure && decide(failure)}
	/>
	{#if sheetFailed}
		<Notice tone="danger" title="Couldn’t load this part of the coach" data-testid="sheet-failed">
			<p>Check your connection, then try again. Nothing was lost.</p>
			<Button variant="secondary" size="sm" icon="refresh" onclick={reject}>Retry</Button>
		</Notice>
	{/if}

	{#if detail.note}
		<blockquote class="note" data-testid="decision-note">
			<p class="label">Your reason</p>
			<p class="words">{detail.note}</p>
		</blockquote>
	{/if}

	{#if conversation}
		<a class="source" href={conversation} data-testid="open-conversation">
			<Icon name="coach" size={18} /> Open the conversation
			<Icon name="chevron-right" size={16} />
		</a>
	{/if}
</section>

{#if Sheet}
	<Sheet
		bind:open={sheetOpen}
		mode="reject"
		title={card.title}
		pending={pending === 'reject'}
		onsubmit={async (words) => {
			await decide({ action: 'reject', reason: words });
			sheetOpen = false;
		}}
	/>
{/if}

<style>
	.detail {
		display: grid;
		gap: var(--space-4);
		min-width: 0;
	}

	.head {
		display: grid;
		gap: var(--space-1);
	}

	.kind {
		outline: none;
		color: var(--color-text-secondary);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
	}

	.dates {
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
	}

	.note {
		display: grid;
		gap: var(--space-1);
		margin: 0;
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		background: var(--color-surface-1);
	}

	.label {
		color: var(--color-text-secondary);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
	}

	.words {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.source {
		display: inline-flex;
		align-items: center;
		justify-self: start;
		gap: var(--space-2);
		min-height: var(--touch-target);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-accent-text);
	}

	.source:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	@media (hover: hover) and (pointer: fine) {
		.source:hover {
			text-decoration: underline;
		}
	}
</style>
