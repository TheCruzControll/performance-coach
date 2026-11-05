<!--
  @component
  A tappable row for tools and destinations: tinted icon tile, title, one line of supporting
  text and a trailing chevron (or a `trailing` snippet such as a "Soon" badge). Renders a link
  with `href`, a button with `onclick`, or a static row when `disabled` (not yet available).
  Full-width, ≥ 68 px tall: an easy thumb target.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { IconName } from '../icons/icons';
	import Icon from './Icon.svelte';

	type Tone = 'accent' | 'strength' | 'running' | 'combat' | 'hypertrophy' | 'conditioning';

	interface Props {
		title: string;
		subtitle?: string;
		icon: IconName;
		tone?: Tone;
		href?: string;
		onclick?: (event: MouseEvent) => void;
		/** Shown but not actionable yet; pair with a "Soon" badge in `trailing`. */
		disabled?: boolean;
		trailing?: Snippet;
		onpointerdown?: (event: PointerEvent) => void;
		onpointerenter?: (event: PointerEvent) => void;
		'data-testid'?: string;
	}

	let {
		title,
		subtitle,
		icon,
		tone = 'accent',
		href,
		onclick,
		disabled = false,
		trailing,
		...rest
	}: Props = $props();

	const toneColor = $derived(
		disabled
			? 'var(--color-text-tertiary)'
			: tone === 'accent'
				? 'var(--color-accent-text)'
				: `var(--color-${tone})`
	);
</script>

{#snippet body()}
	<span class="tile" style:--tone={toneColor} aria-hidden="true"
		><Icon name={icon} size={22} /></span
	>
	<span class="text">
		<span class="title">{title}</span>
		{#if subtitle}<span class="subtitle">{subtitle}</span>{/if}
	</span>
	{#if trailing}{@render trailing()}{:else if !disabled}<span class="chevron"
			><Icon name="chevron-right" size={20} /></span
		>{/if}
{/snippet}

{#if disabled}
	<div class="row" aria-disabled="true" {...rest}>{@render body()}</div>
{:else if href}
	<a class="row interactive" {href} {...rest}>{@render body()}</a>
{:else}
	<button type="button" class="row interactive" {onclick} {...rest}>{@render body()}</button>
{/if}

<style>
	.row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		width: 100%;
		min-height: 4.25rem;
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border);
		background: var(--color-surface-1);
		box-shadow: var(--elevation-1);
		color: var(--color-text);
		text-align: left;
	}

	.interactive {
		cursor: pointer;
		transition:
			transform var(--duration-fast) var(--ease-out),
			border-color var(--duration-fast) var(--ease-standard);
	}

	.interactive:active {
		transform: scale(0.985);
		border-color: var(--color-border-strong);
		transition-duration: var(--duration-instant);
	}

	@media (hover: hover) {
		.interactive:hover {
			border-color: var(--color-border-strong);
		}
	}

	.tile {
		display: grid;
		flex: none;
		place-items: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--tone) 14%, transparent);
		color: var(--tone);
	}

	.text {
		flex: 1;
		display: grid;
		min-width: 0;
	}

	.title {
		font-weight: var(--weight-semibold);
	}

	.subtitle {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.chevron {
		display: grid;
		color: var(--color-text-tertiary);
	}

	/* Not available yet: quieter, without lowering text contrast below 4.5:1. */
	.row[aria-disabled='true'] {
		background: transparent;
		box-shadow: none;
		border-style: dashed;
	}

	.row[aria-disabled='true'] .title {
		color: var(--color-text-secondary);
	}
</style>
