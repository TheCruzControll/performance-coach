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
    the actions are disabled and the choices kept. A failure says why, and Retry resends it.
  - Otherwise the card says what was decided (with the version in History) or why there is
    nothing to decide, linking to the build or the cycle review where that is the next step.

  The card is server HTML whose form posts without JavaScript; what it does with it (posting in
  place, the toast, the sheet) is next-week-actions.svelte.ts, fetched on the first tap, so the
  review the page awaits stays small. Should that fetch fail, the form posts as it would without.
-->
<script lang="ts">
	import Button from '#lib/ui/components/Button.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import type { NextWeekView } from './load';
	import type { NextWeekUi } from './next-week-actions.svelte.ts';

	interface Props {
		next: NextWeekView;
		reviewId: string;
		online: boolean;
	}

	let { next, reviewId, online }: Props = $props();

	const open = $derived(next.state === 'open' || next.state === 'partly_past');
	const ui: NextWeekUi = $state({ pending: null, failure: null, failed: null });
	let plain = false;

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
</script>

<section
	class="next"
	aria-labelledby="next-title"
	data-testid="review-next-week"
	data-state={next.state}
>
	<h3 id="next-title">{next.title}</h3>
	{#if next.words}<p class="muted" data-testid="review-next-words">{next.words}</p>{/if}

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
