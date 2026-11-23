<!--
  @component
  The Undo card of a weigh-in the coach logged (the weight plan's PR 9): 'Logged 82.4 kg for today ·
  Undo', after the answer that logged it, and again after a reload while the weigh-in still holds
  that run's write. Undo sends the run to the weigh-in's endpoint (WeighInUndo). While it is on its
  way the button is disabled and busy. Once it took the write back the card reads 'Undone'; when
  the weigh-in is gone, or no longer the coach's write, 'Nothing to undo'. A request that did not
  go through says so in place, and Try again sends it again, which is safe: the server takes the
  write back once. Its words are in domain/coach/recorded.ts. The card wears the coach's draft-card
  styles, so it reads as part of the conversation, not as an action of its own.
-->
<script lang="ts">
	import { untrack } from 'svelte';
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

	// One card per weigh-in: its id and run never change, so the card is made once from them.
	const undo = untrack(() => new WeighInUndo(id, runId));

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
			<span data-testid="recorded-outcome"
				>{undo.phase === 'undone' ? UNDONE : NOTHING_TO_UNDO}</span
			>
		{:else}
			<span data-testid="recorded-label">{label}</span>
			<span class="dot" aria-hidden="true">·</span>
			<Button
				variant="ghost"
				size="sm"
				loading={undo.posting}
				disabled={undo.posting}
				onclick={() => undo.undo()}
				data-testid="recorded-undo">{undo.phase === 'failed' ? 'Try again' : 'Undo'}</Button
			>
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

	.failure {
		margin: 0;
		color: var(--color-danger);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}
</style>
