<!--
  @component
  An empty or failed part of a screen (Paper, 10 · States): one sentence that says what is true,
  a line on what to do about it, and at most one action. No glyph, no box: Instrument v2 has no
  medallion. The title is left out where the heading just above already says it (onboarding's
  goals step), so a screen never reads the same line twice. Lined up with the text above it by
  default; `align="center"` for a state alone in a sheet or a window.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { IconName } from '../icons/icons';

	interface Props {
		/**
		 * @deprecated v2 states have no glyph: accepted and not drawn. Removed when the last
		 * screen row drops it.
		 */
		icon?: IconName;
		/** Omit only when the heading the state sits under already says it. */
		title?: string;
		description?: string;
		/** @deprecated Only the glyph used it. Accepted and not drawn. */
		tone?:
			'accent' | 'neutral' | 'strength' | 'running' | 'combat' | 'hypertrophy' | 'conditioning';
		/** Inside a list, a card or a sheet: a 17 px title in place of the 26 px one. */
		compact?: boolean;
		align?: 'center' | 'start';
		/** One action. A screen that needs two puts the second behind a row or a sheet. */
		actions?: Snippet;
		'data-testid'?: string;
	}

	let {
		icon: _icon,
		tone: _tone,
		title,
		description,
		compact = false,
		align = 'start',
		actions,
		'data-testid': testId
	}: Props = $props();
</script>

<div class="empty" class:compact class:center={align === 'center'} data-testid={testId}>
	{#if title}<h2 class="title">{title}</h2>{/if}
	{#if description}<p class="description">{description}</p>{/if}
	{#if actions}<div class="actions">{@render actions()}</div>{/if}
</div>

<style>
	/* Paper's state block: the sentence, 8 px, the line on what to do, then the action. */
	.empty {
		display: grid;
		justify-items: start;
		gap: var(--space-2);
		padding: var(--space-6) 0;
		text-align: start;
	}

	.center {
		justify-items: center;
		text-align: center;
	}

	.title {
		font: var(--type-sheet-title);
		letter-spacing: var(--tracking-tight);
		color: var(--color-text);
	}

	.description {
		max-width: 34rem;
		font: var(--type-body);
		color: var(--color-text-secondary);
	}

	.compact {
		gap: var(--space-1);
		padding: var(--space-4) 0;
	}

	.compact .title {
		font: var(--type-row);
		font-weight: var(--weight-semibold);
		letter-spacing: normal;
	}

	.compact .description {
		font: var(--type-secondary);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: var(--space-5);
	}

	.compact .actions {
		margin-top: var(--space-3);
	}
</style>
