<!--
  @component
  Primary action control. Flat, 4px radius, ≥44px touch target at every size, visible pressed state
  (scale + tone), loading state that keeps its width. Renders an <a> when `href` is set.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { IconName } from '../icons/icons';
	import Icon from './Icon.svelte';
	import Spinner from './Spinner.svelte';

	type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
	type Size = 'sm' | 'md' | 'lg';

	interface Props {
		variant?: Variant;
		size?: Size;
		/** Render as a link. Ignored while disabled. */
		href?: string;
		type?: 'button' | 'submit' | 'reset';
		/** A submit button's own form action, e.g. '?/keep' beside its form's '?/decide'. */
		formaction?: string;
		icon?: IconName;
		iconEnd?: IconName;
		loading?: boolean;
		disabled?: boolean;
		/** Stretch to the container width. */
		block?: boolean;
		onclick?: (event: MouseEvent) => void;
		/** E.g. start loading code-split UI on first touch, before the click lands. */
		onpointerdown?: (event: PointerEvent) => void;
		'aria-label'?: string;
		'aria-describedby'?: string;
		/** A disclosure's: whether what it shows is shown, and its id. */
		'aria-expanded'?: boolean;
		'aria-controls'?: string;
		'data-testid'?: string;
		children: Snippet;
	}

	let {
		variant = 'primary',
		size = 'md',
		href,
		type = 'button',
		icon,
		iconEnd,
		loading = false,
		disabled = false,
		block = false,
		onclick,
		onpointerdown,
		children,
		...aria
	}: Props = $props();

	const iconSize = $derived(size === 'sm' ? 16 : 18);
</script>

{#snippet content()}
	{#if loading}
		<Spinner size={iconSize} />
	{:else if icon}
		<Icon name={icon} size={iconSize} />
	{/if}
	<span class="label">{@render children()}</span>
	{#if iconEnd && !loading}
		<Icon name={iconEnd} size={iconSize} />
	{/if}
{/snippet}

{#if href && !disabled}
	<a
		{href}
		class="btn"
		class:block
		data-variant={variant}
		data-size={size}
		{onclick}
		{onpointerdown}
		{...aria}
	>
		{@render content()}
	</a>
{:else}
	<button
		{type}
		class="btn"
		class:block
		data-variant={variant}
		data-size={size}
		disabled={disabled || loading}
		aria-busy={loading || undefined}
		{onclick}
		{onpointerdown}
		{...aria}
	>
		{@render content()}
	</button>
{/if}

<style>
	.btn {
		--btn-height: 3rem;
		--btn-pad: var(--space-5);
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		min-height: var(--btn-height);
		padding: 0 var(--btn-pad);
		border-radius: var(--radius-sm);
		border: 1px solid transparent;
		font-family: var(--font-sans);
		font-size: var(--text-base);
		font-weight: var(--weight-regular);
		letter-spacing: var(--tracking-normal);
		line-height: 1;
		white-space: nowrap;
		user-select: none;
		-webkit-user-select: none;
		transition:
			transform var(--duration-fast) var(--ease-out),
			background-color var(--duration-fast) var(--ease-standard),
			border-color var(--duration-fast) var(--ease-standard),
			color var(--duration-fast) var(--ease-standard);
	}

	/* Every size keeps a ≥44px hit area, even when the visual is smaller. It is laid out in the
	   padding box, inside the 1 px border. */
	.btn::after {
		content: '';
		position: absolute;
		inset: min(0px, calc((var(--btn-height) - var(--touch-target)) / 2 - 1px));
	}

	.btn[data-size='sm'] {
		--btn-height: var(--touch-target);
		--btn-pad: var(--space-4);
		font-size: var(--text-ui);
	}

	.btn[data-size='lg'] {
		--btn-height: 3.5rem;
		--btn-pad: var(--space-5);
		font-size: var(--text-lg);
	}

	.block {
		display: flex;
		width: 100%;
	}

	.btn:active:not(:disabled) {
		transform: scale(0.97);
		transition-duration: var(--duration-instant);
	}

	/* Disabled has no opacity: its text and outlines take the disabled tokens. A loading button keeps
	   its look (aria-busy), so it is excluded here. */
	.btn:disabled {
		cursor: not-allowed;
	}
	.btn:disabled:not([aria-busy='true']) {
		color: var(--color-text-disabled);
	}

	.btn[aria-busy='true'] {
		cursor: progress;
	}

	/* ---- Variants ---- */
	.btn[data-variant='primary'] {
		background: var(--color-accent);
		color: var(--color-on-accent);
		font-weight: var(--weight-semibold);
	}
	.btn[data-variant='primary']:active:not(:disabled) {
		background: var(--color-accent-pressed);
	}
	.btn[data-variant='primary']:disabled:not([aria-busy='true']) {
		background: var(--color-surface-2);
	}

	.btn[data-variant='secondary'] {
		background: transparent;
		color: var(--color-text);
		border-color: var(--color-border-strong);
	}
	.btn[data-variant='secondary']:active:not(:disabled) {
		background: var(--color-surface-3);
	}
	.btn[data-variant='secondary']:disabled:not([aria-busy='true']) {
		border-color: var(--color-hairline);
	}

	.btn[data-variant='ghost'] {
		background: transparent;
		color: var(--color-text-secondary);
	}
	.btn[data-variant='ghost']:active:not(:disabled) {
		background: var(--color-surface-3);
	}

	.btn[data-variant='danger'] {
		background: transparent;
		color: var(--color-danger);
		border-color: var(--color-border-strong);
	}
	.btn[data-variant='danger']:active:not(:disabled) {
		background: var(--color-surface-3);
	}
	.btn[data-variant='danger']:disabled:not([aria-busy='true']) {
		border-color: var(--color-hairline);
	}

	@media (hover: hover) and (pointer: fine) {
		.btn[data-variant='primary']:hover:not(:disabled) {
			background: var(--color-accent-hover);
		}
		.btn[data-variant='secondary']:hover:not(:disabled) {
			background: var(--color-surface-2);
		}
		.btn[data-variant='ghost']:hover:not(:disabled) {
			color: var(--color-text);
		}
		.btn[data-variant='danger']:hover:not(:disabled) {
			background: var(--color-danger-subtle);
		}
	}

	.label {
		display: inline-flex;
		align-items: center;
	}
</style>
