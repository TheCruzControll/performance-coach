<!--
  @component
  Next week's card in a weekly review (load.ts nextWeekView): the owner takes, changes or skips
  each recommended change in a few taps, then generates next week and lands in Train.

  - Each change: what it changes, before → after, its why, a native checkbox, and with a half
    step a second one to take the half step instead. A change whose session has passed is struck
    through and says so ('Monday has passed'); deciding drops it.
  - 'Generate next week' posts the ticked changes (?/decide), then Train opens on next week with
    the toast 'Next week updated · version 4', or '· 2 changes were for sessions already past'.
  - 'Keep next week as planned' (?/keep, the same form) opens a sheet with an optional reason.
  - Pending: the form is aria-busy and a second tap posts nothing. Offline (the shell says so):
    the actions are disabled, with the reason, and the choices kept. A failure says why, and
    Try again resends it.
  - A proposed deload (state 'deload') is one card: its headline (deloadHeadline in load.ts, from
    its week and today), the signals that led to it as plain lines, and what changes, through the
    inbox's DiffRows. It has no changes to tick: 'Accept the deload' posts the same ?/decide with
    `accept`, and 'Keep the plan' posts ?/keep. A late deload (state 'late_deload') is headed by its
    date alone and says 'No session is left in that week'; a superseded one (state
    'superseded_deload') says 'This deload is out of date'. Both offer 'Propose again', which posts
    ?/proposeAgain (next-week-actions.svelte.ts). Once its answer lands, focus moves to Try again
    after a failure, or else to the note; the answer is also announced through the card's polite
    status line, which is always in the card.
  - Otherwise the card says what was decided (with the version in History) or why there is
    nothing to decide, linking to the build or the cycle review where that is the next step.

  The card is server HTML whose form posts without JavaScript; what it does with it (posting in
  place, the toast, the sheet) is next-week-actions.svelte.ts, fetched on the first tap, so the
  review the page awaits stays small. Should that fetch fail, the form posts as it would without.
-->
<script lang="ts">
	import DiffRows from '#lib/ui/coach/DiffRows.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import { tick } from 'svelte';
	import {
		COULDNT_PREPARE,
		PROPOSE_AGAIN,
		PROPOSE_AGAIN_FAILED,
		PROPOSE_AGAIN_OFFLINE
	} from '#lib/domain/coach/propose-again.ts';
	import type { NextWeekView } from './load';
	import type { NextWeekUi } from './next-week-actions.svelte.ts';

	interface Props {
		next: NextWeekView;
		reviewId: string;
		online: boolean;
	}

	let { next, reviewId, online }: Props = $props();

	const open = $derived(next.state === 'open' || next.state === 'partly_past');
	/** A stale or late deload: Propose again asks for it again from today. */
	const stale = $derived(next.state === 'late_deload' || next.state === 'superseded_deload');
	const DECIDE_OFFLINE = 'You’re offline. Decide once you’re back online.';
	const ui: NextWeekUi = $state({ pending: null, failure: null, failed: null, note: null });
	let plain = false;
	/** Focus goes where a Propose again answer leaves the owner: its Try again, or its note. */
	let retryWrap = $state<HTMLElement>();
	let noteEl = $state<HTMLElement>();
	/** A Propose again post is on its way: its answer is what the next focus is about. */
	let asking = false;

	// The button that was pressed is busy and then gone, so focus would fall to the page's top: once
	// a Propose again post ends, a failure focuses its Try again and an answer its note.
	$effect(() => {
		if (ui.pending) {
			asking = ui.pending === 'proposeAgain';
			return;
		}
		if (!asking) return;
		asking = false;
		void tick().then(() => {
			if (ui.failed === 'proposeAgain') retryWrap?.querySelector('button')?.focus();
			else noteEl?.focus();
		});
	});

	/**
	 * What the card's polite region says, which is always in the card so a change is announced: a
	 * Propose again post's progress, its failure, or its note.
	 */
	const announce = $derived(
		ui.pending === 'proposeAgain'
			? 'Preparing it again…'
			: ui.failed === 'proposeAgain'
				? `${COULDNT_PREPARE}. ${PROPOSE_AGAIN_FAILED}`
				: (ui.note ?? '')
	);

	/** Generate or Keep: in place once next-week-actions loads, posted as it is should it not. */
	function act(event: SubmitEvent) {
		if (plain) return;
		event.preventDefault();
		const form = event.currentTarget as HTMLFormElement;
		import('./next-week-actions.svelte.ts').then(
			(m) => m.act(form, ui, event.submitter),
			() => ((plain = true), form.requestSubmit(event.submitter))
		);
	}

	/** Propose again: in place once next-week-actions loads, posted as it is should it not. */
	function again(event: SubmitEvent) {
		if (plain) return;
		event.preventDefault();
		const form = event.currentTarget as HTMLFormElement;
		import('./next-week-actions.svelte.ts').then(
			(m) => m.proposeAgain(ui),
			() => ((plain = true), form.requestSubmit())
		);
	}
</script>

<section
	class="next"
	aria-labelledby="next-title"
	data-testid="review-next-week"
	data-state={next.state}
>
	<h3 id="next-title">{next.title}</h3>
	{#if next.words}<p class="muted" data-testid="review-next-words">{next.words}</p>{/if}

	{#if next.deload}
		{#if next.deload.evidence.length}
			<section class="part" aria-labelledby="next-why">
				<h4 id="next-why" class="label">Why</h4>
				<ul class="lines" data-testid="review-next-evidence">
					{#each next.deload.evidence as line, i (i)}<li>{line}</li>{/each}
				</ul>
			</section>
		{/if}
		<section class="part" aria-labelledby="next-what">
			<h4 id="next-what" class="label">What changes</h4>
			{#if next.deload.rows.length}
				<DiffRows rows={next.deload.rows} />
			{:else if next.deload.lines.length}
				<ul class="lines">
					{#each next.deload.lines as line, i (i)}<li>{line}</li>{/each}
				</ul>
			{:else}
				<p class="muted">Nothing in your plan moves.</p>
			{/if}
			{#if next.deload.more}<p class="muted" data-testid="review-next-more">
					{next.deload.more}
				</p>{/if}
		</section>
	{/if}

	{#if next.items.length}
		<form
			method="POST"
			action="?/decide"
			onsubmit={act}
			aria-busy={ui.pending ? 'true' : undefined}
		>
			<input type="hidden" name="reviewId" value={reviewId} />
			<ul class="items">
				{#each next.items as item (item.id)}
					<li class="item" data-testid="review-next-item">
						<label class="pick">
							<input
								type="checkbox"
								name="item"
								value={item.id}
								disabled={!!item.passed}
								checked={!item.passed}
							/>
							<span class="what"
								><span class="label">{item.label}</span>
								<span class="muted"
									>{item.before} <span aria-hidden="true">→</span>
									<span class="visually-hidden">to</span>
									<strong>{item.after}</strong></span
								></span
							>
						</label>
						<p class="muted">{item.passed ?? item.why}</p>
						{#if item.half && !item.passed}
							<label class="pick"
								><input type="checkbox" name="choice:{item.id}" value="half_step" /> Half step · {item.half}</label
							>
						{/if}
					</li>
				{/each}
			</ul>
			{#if open}
				{#if ui.failed === 'decide'}
					<Notice tone="danger" data-testid="review-next-failure">{ui.failure}</Notice>
				{/if}
				<Button
					type="submit"
					loading={ui.pending === 'decide'}
					disabled={!online}
					data-testid="review-next-generate"
					>{ui.failed === 'decide' ? 'Try again' : 'Generate next week'}</Button
				>
				<Button
					type="submit"
					variant="secondary"
					formaction="?/keep"
					disabled={!online || !!ui.pending}
					data-testid="review-next-keep">Keep next week as planned</Button
				>
			{/if}
		</form>
	{/if}

	{#if !online && open}<p class="muted" data-testid="review-next-offline">{DECIDE_OFFLINE}</p>{/if}

	{#if next.state === 'deload'}
		<form
			method="POST"
			action="?/decide"
			onsubmit={act}
			aria-busy={ui.pending ? 'true' : undefined}
		>
			<input type="hidden" name="reviewId" value={reviewId} />
			<input type="hidden" name="accept" value="deload" />
			{#if ui.failed === 'decide'}
				<Notice tone="danger" data-testid="review-next-failure">{ui.failure}</Notice>
			{/if}
			{#if !online}<p class="muted" data-testid="review-next-offline">{DECIDE_OFFLINE}</p>{/if}
			<Button
				type="submit"
				loading={ui.pending === 'decide'}
				disabled={!online}
				data-testid="review-next-accept"
				>{ui.failed === 'decide' ? 'Try again' : 'Accept the deload'}</Button
			>
			<Button
				type="submit"
				variant="secondary"
				formaction="?/keep"
				disabled={!online || !!ui.pending}
				data-testid="review-next-keep">Keep the plan</Button
			>
		</form>
	{/if}

	{#if stale}
		<form
			method="POST"
			action="?/proposeAgain"
			onsubmit={again}
			aria-busy={ui.pending === 'proposeAgain' ? 'true' : undefined}
			data-testid="review-next-again"
		>
			{#if ui.failed === 'proposeAgain'}
				<Notice tone="danger" title={COULDNT_PREPARE} data-testid="review-next-propose-failure"
					>{ui.failure}</Notice
				>
			{:else if ui.note}
				<!-- Not a live region of its own: the card's polite region announces it. -->
				<p
					class="muted note"
					tabindex="-1"
					bind:this={noteEl}
					data-testid="review-next-propose-note"
				>
					{ui.note}
				</p>
			{/if}
			{#if !online}
				<p class="muted" data-testid="review-next-propose-offline">{PROPOSE_AGAIN_OFFLINE}</p>
			{/if}
			<span bind:this={retryWrap}>
				<Button
					type="submit"
					loading={ui.pending === 'proposeAgain'}
					disabled={!online || !!ui.pending}
					data-testid="review-next-propose-again"
					>{ui.failed === 'proposeAgain' ? 'Try again' : PROPOSE_AGAIN}</Button
				>
			</span>
		</form>
	{/if}

	<p class="visually-hidden" role="status" data-testid="review-next-status">{announce}</p>

	{#if next.link}
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- app paths from load.ts -->
		<a class="link" href={next.link.href} data-testid="review-next-link"
			>{next.link.label} <span aria-hidden="true">→</span></a
		>
	{/if}

	{#if next.notProposed.length}
		<ul class="items" aria-label="Not proposed">
			{#each next.notProposed as n (n.id)}
				<li class="item muted" data-testid="review-next-not-proposed">
					<span class="label">{n.label}</span>{n.words}
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.next,
	form {
		display: grid;
		gap: var(--space-3);
	}

	form {
		justify-items: start;
	}

	h3 {
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
	}

	.part {
		display: grid;
		gap: var(--space-1-5);
		min-width: 0;
	}

	.label {
		color: var(--color-text-secondary);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
	}

	.lines {
		display: grid;
		gap: var(--space-1);
		margin: 0;
		padding-left: var(--space-4);
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
		overflow-wrap: anywhere;
	}

	.items {
		display: grid;
		justify-self: stretch;
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
	}

	.item,
	.what {
		display: grid;
		gap: var(--space-1);
	}

	.item {
		padding: var(--space-3) var(--space-4);
	}

	.item + .item {
		border-top: 1px solid var(--color-border);
	}

	.pick {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1) var(--space-3);
		min-height: var(--touch-target);
	}

	input {
		accent-color: var(--color-accent);
		inline-size: 1.25rem;
		block-size: 1.25rem;
	}

	.label {
		font-weight: var(--weight-medium);
	}

	.muted {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.item:has(:disabled) .what {
		text-decoration: line-through;
		color: var(--color-text-tertiary);
	}

	.link {
		display: inline-flex;
		align-items: center;
		min-height: var(--touch-target);
		font-weight: var(--weight-medium);
		color: var(--color-accent-text);
	}

	/* Focus lands here after an answer: the words are the focus, so no ring is drawn around them. */
	.note {
		outline: none;
	}

	.link:focus-visible,
	input:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	@media (hover: hover) and (pointer: fine) {
		.pick:hover,
		.link:hover {
			color: var(--color-text);
		}
	}
</style>
