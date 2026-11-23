<!--
  @component
  A status word on its line: "Soon", "First step", "Good". The words carry the meaning; colour
  only reinforces it (never the other way round). `neutral` is the default and the only tone for
  "Soon"; `accent` marks the next step and is used sparingly. Legacy in v2: no pill, no tint, no
  outline; screen rows remove it where their screen has none.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { IconName } from '../icons/icons';
	import Icon from './Icon.svelte';

	interface Props {
		tone?: 'neutral' | 'accent' | 'positive' | 'warning' | 'danger';
		icon?: IconName;
		'data-testid'?: string;
		children: Snippet;
	}

	let { tone = 'neutral', icon, children, ...rest }: Props = $props();
</script>

<span class="badge" data-ui="badge" class:with-icon={icon} data-tone={tone} {...rest}>
	{#if icon}<Icon name={icon} size={12} strokeWidth={2} />{/if}
	{@render children()}
</span>

<style>
	.badge {
		--badge-text: var(--color-text-tertiary);
		display: inline-flex;
		flex: none;
		/* Never stretch as a grid item: a badge is as wide as its words. */
		justify-self: start;
		align-items: center;
		gap: var(--space-1);
		min-height: 1.375rem;
		padding: 0 var(--space-2);
		color: var(--badge-text);
		font: var(--type-caption);
		font-weight: var(--weight-semibold);
		white-space: nowrap;
	}

	/* Kept so an icon badge keeps its width and its box. Legacy: goes with the pill. */
	.with-icon {
		padding-left: var(--space-1-5);
	}

	/* The status words use the status tokens, which are text-safe on canvas and surfaces. */
	.badge[data-tone='accent'] {
		--badge-text: var(--color-accent-text);
	}
	.badge[data-tone='positive'] {
		--badge-text: var(--color-positive);
	}
	.badge[data-tone='warning'] {
		--badge-text: var(--color-warning);
	}
	.badge[data-tone='danger'] {
		--badge-text: var(--color-danger);
	}
</style>
