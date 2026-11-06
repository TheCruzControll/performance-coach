<!--
  @component
  Circular icon-only button. `label` is required: it becomes the accessible name.
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
		onclick?: (event: MouseEvent) => void;
		onpointerdown?: (event: PointerEvent) => void;
		onpointerup?: (event: PointerEvent) => void;
		onpointerleave?: (event: PointerEvent) => void;
		onpointercancel?: (event: PointerEvent) => void;
		'aria-controls'?: string;
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
		...rest
	}: Props = $props();

	const iconSize = $derived(size === 'lg' ? 26 : size === 'sm' ? 18 : 22);
</script>

<button
	{type}
	class="icon-btn"
	data-variant={variant}
	data-size={size}
	aria-label={label}
	aria-pressed={pressed}
	{disabled}
	{...rest}
>
	<Icon name={icon} size={iconSize} strokeWidth={size === 'lg' ? 2 : 1.75} />
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
		color: var(--color-text);
		user-select: none;
		-webkit-user-select: none;
		transition:
			transform var(--duration-fast) var(--ease-out),
			background-color var(--duration-fast) var(--ease-standard),
			color var(--duration-fast) var(--ease-standard);
	}

	.icon-btn::after {
		content: '';
		position: absolute;
		inset: min(0px, calc((var(--size) - var(--touch-target)) / 2));
	}

	.icon-btn[data-size='sm'] {
		--size: 2.25rem;
	}
	.icon-btn[data-size='lg'] {
		--size: 3.5rem;
	}

	.icon-btn[data-variant='filled'] {
		background: var(--color-surface-2);
		border: 1px solid var(--color-border);
		box-shadow: inset 0 1px 0 0 var(--color-highlight);
	}
	.icon-btn[data-variant='accent'] {
		background: var(--color-accent);
		color: var(--color-on-accent);
	}

	.icon-btn:active:not(:disabled) {
		transform: scale(0.92);
		transition-duration: var(--duration-instant);
	}
	.icon-btn[data-variant='ghost']:active:not(:disabled),
	.icon-btn[data-variant='filled']:active:not(:disabled) {
		background: var(--color-surface-3);
	}
	.icon-btn[data-variant='accent']:active:not(:disabled) {
		background: var(--color-accent-pressed);
	}

	@media (hover: hover) and (pointer: fine) {
		.icon-btn[data-variant='ghost']:hover:not(:disabled) {
			background: var(--color-surface-2);
		}
	}

	.icon-btn:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}
</style>
