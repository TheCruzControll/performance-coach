<!--
  @component
  The Undo card of a weigh-in the coach logged (the weight plan's PR 9): 'Logged 82.4 kg for today ·
  Undo', after the answer that logged it, and again after a reload while the weigh-in still holds
  that run's write. Undo sends the run to the weigh-in's endpoint (WeighInUndo). While it is on its
  way the button is disabled and busy. Once it took the write back the card reads 'Undone'; when
  the weigh-in is gone, or no longer the coach's write, 'Nothing to undo'. A request that did not
  go through says so in place, and Try again sends it again, which is safe: the server takes the
  write back once. Its words are in domain/coach/recorded.ts. The card uses the proposal card's box,
  so it reads as part of the conversation, not as an action of its own.
-->
<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { WeighInUndo } from '#lib/client/coach/weigh-in-undo.svelte.ts';
	import { NOTHING_TO_UNDO, UNDO_FAILED, UNDONE } from '#lib/domain/coach/recorded.ts';
	import Button from '../components/Button.svelte';

	interface Props {
		/** The weigh-in's id: Undo's path. */
		id: number;
		/** Its words, 'Logged 82.4 kg for today'. */
		label: string;
		/** The run that logged it: Undo sends it. */
		runId: string;
		'data-testid'?: string;
	}

	let { id, label, runId, 'data-testid': testId = 'recorded-card' }: Props = $props();

	// The parent keys each card by its weigh-in and run (weighInKey), so a card is only ever given
	// one pair: it is made once from them.
	const undo = untrack(() => new WeighInUndo(id, runId));

	/** The outcome, which takes focus once Undo settles; Try again's wrap, for focus after a failure. */
	let outcomeEl = $state<HTMLElement>();
	let undoWrap = $state<HTMLElement>();

	// The button that was pressed is busy and then gone, so focus would fall to the page's top: when
	// Undo settles its outcome takes focus, and when it failed Try again does. Only the phase is
	// tracked, so a busy change does not move it.
	$effect(() => {
		const phase = undo.phase;
		untrack(() => {
			if (phase !== 'undone' && phase !== 'nothing' && phase !== 'failed') return;
			void tick().then(() => {
				if (phase === 'failed') undoWrap?.querySelector('button')?.focus();
				else outcomeEl?.focus();
			});
		});
	});

	/** The line the status region announces; the visible words are in the card itself. */
	const announced = $derived(
		undo.posting
			? 'Undoing…'
			: undo.phase === 'undone'
				? UNDONE
				: undo.phase === 'nothing'
					? NOTHING_TO_UNDO
					: undo.phase === 'failed'
						? UNDO_FAILED
						: ''
	);
</script>

<div
	class="recorded"
	data-testid={testId}
	data-phase={undo.phase}
	aria-busy={undo.posting || undefined}
>
	<p class="line">
		{#if undo.settled}
			<span data-testid="recorded-outcome" tabindex="-1" bind:this={outcomeEl}
				>{undo.phase === 'undone' ? UNDONE : NOTHING_TO_UNDO}</span
			>
		{:else}
			<span id="recorded-{id}-label" data-testid="recorded-label">{label}</span>
			<span class="dot" aria-hidden="true">·</span>
			<span class="action" bind:this={undoWrap}>
				<Button
					variant="ghost"
					size="sm"
					loading={undo.posting}
					disabled={undo.posting}
					aria-describedby="recorded-{id}-label"
					onclick={() => undo.undo()}
					data-testid="recorded-undo">{undo.phase === 'failed' ? 'Try again' : 'Undo'}</Button
				>
			</span>
		{/if}
	</p>
	{#if undo.phase === 'failed'}
		<p class="failure" data-testid="recorded-failure">{UNDO_FAILED}</p>
	{/if}
	<p class="visually-hidden" role="status">{announced}</p>
</div>

<style>
	.recorded {
		display: grid;
		gap: var(--space-2);
		min-width: 0;
		padding: var(--space-4);
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border);
		background: var(--color-surface-1);
	}

	.line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1-5);
		margin: 0;
		color: var(--color-text);
		font-size: var(--text-sm);
		line-height: var(--leading-snug);
		overflow-wrap: anywhere;
	}

	.dot {
		color: var(--color-text-tertiary);
	}

	.action {
		display: inline-flex;
	}

	.failure {
		margin: 0;
		color: var(--color-danger);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}
</style>
