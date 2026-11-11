<!--
  @component
  The sync status as a small pill (sync-words.ts): Saved, Saving…, Offline · N pending, Can’t
  connect · N waiting, Retrying in n s, N need attention, Sign in to sync · N waiting, Finish adding
  your passkey. Always words with
  an icon, never colour alone, in a polite status region, so a change is announced without moving
  focus. Quiet beside logging: small type on a faint surface, a warning tint only when the owner is
  needed. With `onopen` (whenever there is something to show) it is a 44 px button that opens the
  sync sheet, the pill inside it taking the hover (fine pointers) and the focus ring; `onintent` (pointer down,
  hover, focus) lets the page fetch the sheet first. The workout header shows it, and the resume
  bar reuses it. It sits flush right, so its box never depends on the words: the two longest any
  state can show sit hidden in the same grid cell, in tabular figures, and size it at every text
  size (counts stop at "999+"), and the 44 px height is held whether or not it is a button. A change
  of words, which comes without input, never moves or resizes it.
-->
<script lang="ts">
	import type { OutboxStatus } from '#lib/client/workout/outbox-rules.ts';
	import Icon from '../components/Icon.svelte';
	import { syncWords, type SyncWords } from './sync-words.ts';

	interface Props {
		/** null until the engine has read the outbox: the pill's place stays empty. */
		status: OutboxStatus | null;
		onopen?: (event: MouseEvent) => void;
		onintent?: () => void;
	}

	let { status, onopen, onintent }: Props = $props();
	const words = $derived(status && syncWords(status));
	const widest = [
		syncWords({ state: 'signed-out', waiting: 1000 }).text,
		syncWords({ state: 'unreachable', waiting: 1000 }).text
	];
</script>

{#snippet face(words: SyncWords, testid?: string)}
	<span
		class="pill"
		data-alert={words.alert || undefined}
		data-a={widest[0]}
		data-b={widest[1]}
		data-testid={testid}
	>
		<span class="words"><Icon name={words.icon} size={14} strokeWidth={2} />{words.text}</span>
	</span>
{/snippet}

<div class="sync" role="status" data-testid="sync-status">
	{#if words}
		{#if onopen}
			<button
				type="button"
				class="hit"
				aria-haspopup="dialog"
				onclick={onopen}
				onpointerdown={onintent}
				onpointerenter={onintent}
				onfocus={onintent}
				data-testid="sync-pill"
			>
				{@render face(words)}
			</button>
		{:else}
			{@render face(words, 'sync-pill')}
		{/if}
	{/if}
</div>

<style>
	.sync {
		display: flex;
		align-items: center;
		min-width: 0;
		min-height: 2.75rem;
		margin-left: auto;
	}

	.pill {
		display: inline-grid;
		align-items: center;
		max-width: 100%;
		min-height: 1.75rem;
		padding: 0 var(--space-2);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-full);
		background: var(--color-surface-1);
		color: var(--color-text-secondary);
		font: inherit;
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
		font-variant-numeric: tabular-nums;
		text-align: start;
	}

	/* The words and the hidden longest words share one cell: it, not the words, sizes the pill. */
	.words,
	.pill::before,
	.pill::after {
		grid-area: 1 / 1;
	}

	.pill::before,
	.pill::after {
		padding-left: calc(14px + var(--space-1-5));
		visibility: hidden;
	}

	.pill::before {
		content: attr(data-a);
	}

	.pill::after {
		content: attr(data-b);
	}

	.words {
		display: flex;
		align-items: center;
		gap: var(--space-1-5);
	}

	.pill[data-alert] {
		border-color: color-mix(in srgb, var(--color-warning) 45%, transparent);
		background: color-mix(in srgb, var(--color-warning) 12%, var(--color-surface-1));
		color: light-dark(color-mix(in srgb, var(--color-warning) 82%, #000), var(--color-warning));
	}

	/* The button is the 44 px target; the pill inside it draws the state and the focus ring. */
	.hit {
		display: inline-flex;
		align-items: center;
		max-width: 100%;
		min-width: 2.75rem;
		min-height: 2.75rem;
		padding: 0;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}

	.hit:focus-visible {
		outline: none;
	}

	.hit:focus-visible .pill {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	@media (hover: hover) and (pointer: fine) {
		.hit:hover .pill {
			border-color: var(--color-border-strong);
			background: var(--color-surface-3);
		}
	}
</style>
