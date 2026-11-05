<!--
  @component
  Small status pill: "Soon", "First step", "Good". The words carry the meaning; colour only
  reinforces it (never the other way round). `neutral` is the default and the only tone for
  "Soon"; `accent` marks the next step and is used sparingly.
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

<span class="badge" class:with-icon={icon} data-tone={tone} {...rest}>
	{#if icon}<Icon name={icon} size={14} strokeWidth={2} />{/if}
	{@render children()}
</span>

<style>
	.badge {
		--badge-text: var(--color-text-secondary);
		--badge-bg: var(--color-surface-2);
		display: inline-flex;
		flex: none;
		/* Never stretch as a grid item: a badge is as wide as its words. */
		justify-self: start;
		align-items: center;
		gap: var(--space-1);
		min-height: 1.375rem;
		padding: 0 var(--space-2);
		border-radius: var(--radius-full);
		background: var(--badge-bg);
		box-shadow: inset 0 0 0 1px var(--color-border);
		color: var(--badge-text);
		font-size: var(--text-2xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		line-height: 1;
		text-transform: uppercase;
		white-space: nowrap;
	}

	.with-icon {
		padding-left: var(--space-1-5);
	}

	.badge[data-tone='accent'] {
		--badge-text: var(--color-accent-text);
		--badge-bg: var(--color-accent-subtle);
	}
	/*
	 * Status text sits on its own tint, which costs contrast in the light theme: there the text
	 * is darkened (≥ 5.2:1 on every surface, axe-checked); the dark theme's status colours are
	 * already bright enough.
	 */
	.badge[data-tone='positive'] {
		--badge-text: light-dark(
			color-mix(in srgb, var(--color-positive) 82%, #000),
			var(--color-positive)
		);
		--badge-bg: color-mix(in srgb, var(--color-positive) 12%, transparent);
	}
	.badge[data-tone='warning'] {
		--badge-text: light-dark(
			color-mix(in srgb, var(--color-warning) 82%, #000),
			var(--color-warning)
		);
		--badge-bg: color-mix(in srgb, var(--color-warning) 12%, transparent);
	}
	.badge[data-tone='danger'] {
		--badge-text: light-dark(
			color-mix(in srgb, var(--color-danger) 82%, #000),
			var(--color-danger)
		);
		--badge-bg: var(--color-danger-subtle);
	}
</style>
