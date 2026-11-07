<!--
  @component
  The sync status as a small pill (sync-words.ts): Saved, Saving…, Offline · N pending, Retrying in
  n s, N need attention, Sign in to sync · N waiting, Finish adding your passkey. Always words with
  an icon, never colour alone, in a polite status region, so a change is announced without moving
  focus. Quiet beside logging: small type on a faint surface, a warning tint only when the owner is
  needed. With `onopen` (whenever there is something to show) it is a 44 px button that opens the
  sync sheet, the pill inside it taking the hover (fine pointers) and the focus ring; `onintent` (pointer down,
  hover, focus) lets the page fetch the sheet first. The workout header shows it, and the resume
  bar reuses it.
-->
<script lang="ts">
	import type { OutboxStatus } from '#lib/client/workout/outbox-rules.ts';
	import Icon from '../components/Icon.svelte';
	import { syncWords } from './sync-words.ts';

	interface Props {
		/** null until the engine has read the outbox: the pill's place stays empty. */
		status: OutboxStatus | null;
		onopen?: (event: MouseEvent) => void;
		onintent?: () => void;
	}

	let { status, onopen, onintent }: Props = $props();
	const words = $derived(status && syncWords(status));
</script>

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
				<span class="pill" data-alert={words.alert || undefined}>
					<Icon name={words.icon} size={14} strokeWidth={2} />{words.text}
				</span>
			</button>
		{:else}
			<span class="pill" data-alert={words.alert || undefined} data-testid="sync-pill">
				<Icon name={words.icon} size={14} strokeWidth={2} />{words.text}
			</span>
		{/if}
	{/if}
</div>

<style>
	.sync {
		display: flex;
		min-width: 0;
	}

	.pill {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1-5);
		min-width: 0;
		min-height: 1.75rem;
		padding: 0 var(--space-2);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-full);
		background: var(--color-surface-1);
		color: var(--color-text-secondary);
		font: inherit;
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
		white-space: nowrap;
		/* At a large text size on a phone the words end in an ellipsis rather than overflow. */
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
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
