<!--
  @component
  Small status text: "Soon", "First step", "Good". No pill: a coloured mono word on the line, in the
  label style (lowercase by `text-transform`, the copy stays as written). The words carry the
  meaning; colour only reinforces it (never the other way round). `neutral` is the default and the
  only tone for "Soon"; `accent` marks the next step and is used sparingly.
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

<span class="badge" data-ui="badge" data-tone={tone} {...rest}>
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
		/* 16 px line, as the label style (.eyebrow): a line height, not spacing. */
		line-height: 16px;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		font-weight: var(--weight-regular);
		color: var(--badge-text);
		text-transform: lowercase;
		white-space: nowrap;
	}

	/* Status words are the status tokens themselves: they are text-safe on canvas and surfaces. */
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
