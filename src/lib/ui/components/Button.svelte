<!--
  @component
  Action control, Instrument v2. `primary` is the one amber button a screen has; `secondary` and
  `danger` are quiet surface buttons; `ghost` is a text button and `link` an underlined text
  action. Every size keeps a ≥44px touch target. Pressed scales and changes tone. A loading
  button keeps its width and its look (aria-busy); a primary goes quiet while it loads. Renders
  an <a> when `href` is set.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { IconName } from '../icons/icons';
	import Icon from './Icon.svelte';
	import Spinner from './Spinner.svelte';

	type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'link';
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
		border-radius: var(--radius-md);
		border: 1px solid transparent;
		font: var(--type-button);
		letter-spacing: var(--tracking-normal);
		white-space: nowrap;
		box-shadow: none;
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
		--btn-height: 2.25rem;
		--btn-pad: var(--space-4);
		font-size: var(--text-sm);
	}

	.btn[data-size='lg'] {
		--btn-height: 3.75rem;
		--btn-pad: var(--space-6);
	}

	.block {
		display: flex;
		width: 100%;
	}

	.btn:active:not(:disabled) {
		transform: scale(0.97);
		transition-duration: var(--duration-instant);
	}

	/* Disabled and loading both set the disabled attribute. Disabled takes its quiet tokens (no
	   opacity); a loading button is styled as loading, below, not as disabled. */
	.btn:disabled {
		cursor: not-allowed;
	}

	.btn[aria-busy='true'] {
		cursor: progress;
	}

	/* ---- Variants ---- */
	.btn[data-variant='primary'] {
		background: var(--color-accent);
		color: var(--color-on-accent);
	}
	.btn[data-variant='primary']:active:not(:disabled) {
		background: var(--color-accent-pressed);
	}

	.btn[data-variant='secondary'],
	.btn[data-variant='danger'] {
		background: var(--color-surface-2);
		color: var(--color-text);
	}
	.btn[data-variant='danger'] {
		color: var(--color-danger);
	}
	.btn[data-variant='secondary']:active:not(:disabled),
	.btn[data-variant='danger']:active:not(:disabled) {
		background: var(--color-surface-3);
	}

	.btn[data-variant='ghost'] {
		background: transparent;
		color: var(--color-text-secondary);
		font: var(--type-secondary);
	}
	.btn[data-variant='ghost']:active:not(:disabled) {
		color: var(--color-text);
	}

	/* An underlined action in running text's place. No padding, so it is as wide as its words;
	   the ::after still gives it a 44 px hit area. Running text uses .text-link (base.css). */
	.btn[data-variant='link'] {
		--btn-pad: 0;
		background: transparent;
		color: var(--color-text-secondary);
		font: var(--type-secondary);
		text-decoration: underline 1px var(--color-text-disabled);
		text-underline-offset: 4px;
	}
	.btn[data-variant='link']:active:not(:disabled) {
		color: var(--color-text);
		text-decoration-color: var(--color-text);
	}

	@media (hover: hover) and (pointer: fine) {
		.btn[data-variant='primary']:hover:not(:disabled) {
			background: var(--color-accent-hover);
		}
		.btn[data-variant='secondary']:hover:not(:disabled),
		.btn[data-variant='danger']:hover:not(:disabled) {
			background: var(--color-surface-3);
		}
		.btn[data-variant='ghost']:hover:not(:disabled),
		.btn[data-variant='link']:hover:not(:disabled) {
			color: var(--color-text);
		}
		.btn[data-variant='link']:hover:not(:disabled) {
			text-decoration-color: var(--color-text);
		}
	}

	/* ---- Disabled and loading, last so a disabled button takes its quiet tokens ---- */
	.btn[data-variant='primary']:disabled:not([aria-busy='true']),
	.btn[data-variant='secondary']:disabled:not([aria-busy='true']),
	.btn[data-variant='danger']:disabled:not([aria-busy='true']) {
		background: var(--color-surface-2);
		color: var(--color-text-quiet);
	}
	.btn[data-variant='ghost']:disabled:not([aria-busy='true']),
	.btn[data-variant='link']:disabled:not([aria-busy='true']) {
		color: var(--color-text-disabled);
	}
	.btn[data-variant='link']:disabled:not([aria-busy='true']) {
		text-decoration: none;
	}

	/* A loading primary goes quiet, like a disabled one, with a tertiary label. Other loading
	   variants keep their look and show the spinner; ghost and link take the tertiary label. */
	.btn[data-variant='primary'][aria-busy='true'] {
		background: var(--color-surface-2);
		color: var(--color-text-tertiary);
	}
	.btn[data-variant='ghost'][aria-busy='true'],
	.btn[data-variant='link'][aria-busy='true'] {
		color: var(--color-text-tertiary);
	}

	.label {
		display: inline-flex;
		align-items: center;
	}
</style>
