<!--
  @component
  Round icon-only button, Instrument v2. `label` is required: it becomes the accessible name. With
  `tooltip`, a mouse or keyboard user on a desktop also sees the label, in a caption under the
  button aligned to its end (for a header's trailing buttons) while it is hovered or focused; a
  touch screen never shows it. Escape hides it until the button is left or hovered again. The
  caption is hidden from assistive technology, which reads the name. `filled` is the stepper's
  round surface-3 control; `pressed` shows the inverse fill.
-->
<script lang="ts">
	import type { IconName } from '../icons/icons';
	import Icon from './Icon.svelte';

	interface Props {
		icon: IconName;
		label: string;
		variant?: 'ghost' | 'filled' | 'accent';
		size?: 'sm' | 'md' | 'lg';
		disabled?: boolean;
		type?: 'button' | 'submit';
		pressed?: boolean;
		/** Caption the button with its label on hover and keyboard focus (fine pointers only). */
		tooltip?: boolean;
		onclick?: (event: MouseEvent) => void;
		onpointerdown?: (event: PointerEvent) => void;
		onpointerup?: (event: PointerEvent) => void;
		onpointerleave?: (event: PointerEvent) => void;
		onpointercancel?: (event: PointerEvent) => void;
		'aria-controls'?: string;
		'aria-expanded'?: boolean;
		'data-testid'?: string;
	}

	let {
		icon,
		label,
		variant = 'ghost',
		size = 'md',
		disabled = false,
		type = 'button',
		pressed,
		tooltip = false,
		...rest
	}: Props = $props();

	/** Escape hid the caption (WCAG 1.4.13); leaving or hovering the button again resets it. */
	let dismissed = $state(false);
	const iconSize = $derived(size === 'sm' ? 16 : 18);
</script>

<button
	{type}
	class="icon-btn"
	data-variant={variant}
	data-size={size}
	aria-label={label}
	aria-pressed={pressed}
	{disabled}
	onkeydown={tooltip
		? (event) => {
				if (event.key === 'Escape') dismissed = true;
			}
		: undefined}
	onblur={tooltip ? () => (dismissed = false) : undefined}
	onpointerenter={tooltip ? () => (dismissed = false) : undefined}
	{...rest}
>
	<Icon
		name={icon}
		size={iconSize}
		strokeWidth={size === 'lg' ? 2 : 1.75}
	/>{#if tooltip && !dismissed}<span class="tip" aria-hidden="true" data-testid="icon-tip"
			>{label}</span
		>{/if}
</button>

<style>
	.icon-btn {
		--size: var(--touch-target);
		position: relative;
		display: inline-grid;
		place-items: center;
		flex: none;
		width: var(--size);
		height: var(--size);
		border-radius: var(--radius-full);
		border: 1px solid transparent;
		color: var(--color-text);
		user-select: none;
		-webkit-user-select: none;
		transition:
			transform var(--duration-fast) var(--ease-out),
			background-color var(--duration-fast) var(--ease-standard),
			color var(--duration-fast) var(--ease-standard);
	}

	/* The hit area: ≥ 44 px. It is laid out in the padding box, inside the 1 px border. */
	.icon-btn::after {
		content: '';
		position: absolute;
		inset: min(0px, calc((var(--size) - var(--touch-target)) / 2 - 1px));
	}

	.icon-btn[data-size='sm'] {
		--size: 2.25rem;
	}
	.icon-btn[data-size='lg'] {
		--size: 3.75rem;
	}

	/* ---- Variants ---- */
	.icon-btn[data-variant='ghost'] {
		background: transparent;
		color: var(--color-text-secondary);
	}
	.icon-btn[data-variant='filled'] {
		background: var(--color-surface-3);
	}
	.icon-btn[data-variant='accent'] {
		background: var(--color-accent);
		color: var(--color-on-accent);
	}

	.icon-btn:active:not(:disabled) {
		transform: scale(0.92);
		transition-duration: var(--duration-instant);
	}
	.icon-btn[data-variant='ghost']:active:not(:disabled) {
		background: var(--color-surface-2);
	}
	.icon-btn[data-variant='filled']:active:not(:disabled) {
		background: color-mix(in srgb, var(--color-surface-3), var(--color-text) 8%);
	}
	.icon-btn[data-variant='accent']:active:not(:disabled) {
		background: var(--color-accent-pressed);
	}

	@media (hover: hover) and (pointer: fine) {
		.icon-btn[data-variant='ghost']:hover:not(:disabled) {
			background: var(--color-surface-2);
		}
		.icon-btn[data-variant='filled']:hover:not(:disabled) {
			background: color-mix(in srgb, var(--color-surface-3), var(--color-text) 8%);
		}
		.icon-btn[data-variant='accent']:hover:not(:disabled) {
			background: var(--color-accent-hover);
		}
	}

	/* Pressed (aria-pressed) is the inverse fill, as the effort scale's selected circle. It comes
	   after the variants and hover so it wins over them, and it never applies while disabled. */
	.icon-btn[aria-pressed='true'][data-variant]:not(:disabled) {
		background: var(--color-surface-inverse);
		color: var(--color-text-inverse);
	}

	/* Out of layout until shown, so a caption at a screen's edge never scrolls it sideways. */
	.tip {
		display: none;
	}

	@media (hover: hover) and (pointer: fine) {
		.icon-btn:hover:not(:disabled) .tip,
		.icon-btn:focus-visible .tip {
			position: absolute;
			top: calc(100% + var(--space-1-5));
			right: 0;
			z-index: var(--z-raised);
			display: block;
			padding: var(--space-1) var(--space-2);
			border-radius: var(--radius-sm);
			background: var(--color-surface-2);
			box-shadow: var(--elevation-2);
			color: var(--color-text);
			font: var(--type-caption);
			white-space: nowrap;
			pointer-events: none;
		}
	}

	/* Last, so a disabled button takes the disabled glyph and fill, whatever its variant or pressed
	   state. No opacity: the quiet tokens carry it. */
	.icon-btn:disabled {
		cursor: not-allowed;
		color: var(--color-text-disabled);
	}
	.icon-btn[data-variant='filled']:disabled,
	.icon-btn[data-variant='accent']:disabled {
		background: var(--color-surface-2);
	}
</style>
