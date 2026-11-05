<!--
  @component
  Mutually exclusive options (radiogroup). Animated thumb, roving tabindex, arrow-key
  navigation. Use for 2–4 short options (units, theme, ranges).
-->
<script lang="ts" generics="T extends string">
	import type { IconName } from '../icons/icons';
	import Icon from './Icon.svelte';

	interface Option {
		value: T;
		label: string;
		icon?: IconName;
	}

	interface Props {
		options: Option[];
		value: T;
		/** Accessible name of the group. */
		label: string;
		size?: 'sm' | 'md';
		onchange?: (value: T) => void;
		'data-testid'?: string;
	}

	let {
		options,
		value = $bindable(),
		label,
		size = 'md',
		onchange,
		'data-testid': testId
	}: Props = $props();

	const index = $derived(
		Math.max(
			0,
			options.findIndex((o) => o.value === value)
		)
	);
	let buttons: HTMLButtonElement[] = $state([]);

	function select(i: number, focus = false) {
		const option = options[i];
		if (!option) return;
		if (option.value !== value) {
			value = option.value;
			onchange?.(option.value);
		}
		if (focus) buttons[i]?.focus();
	}

	function onkeydown(event: KeyboardEvent) {
		const last = options.length - 1;
		const moves: Record<string, number> = {
			ArrowRight: index === last ? 0 : index + 1,
			ArrowDown: index === last ? 0 : index + 1,
			ArrowLeft: index === 0 ? last : index - 1,
			ArrowUp: index === 0 ? last : index - 1,
			Home: 0,
			End: last
		};
		const next = moves[event.key];
		if (next !== undefined) {
			event.preventDefault();
			select(next, true);
		}
	}
</script>

<div
	class="segmented"
	data-size={size}
	role="radiogroup"
	aria-label={label}
	style:--count={options.length}
	style:--index={index}
	data-testid={testId}
>
	<span class="thumb" aria-hidden="true"></span>
	{#each options as option, i (option.value)}
		<button
			bind:this={buttons[i]}
			type="button"
			role="radio"
			class="option"
			aria-checked={option.value === value}
			tabindex={option.value === value ? 0 : -1}
			onclick={() => select(i)}
			{onkeydown}
		>
			{#if option.icon}<Icon name={option.icon} size={size === 'sm' ? 16 : 18} />{/if}
			<span>{option.label}</span>
		</button>
	{/each}
</div>

<style>
	.segmented {
		--height: var(--touch-target);
		--pad: 3px;
		position: relative;
		display: grid;
		grid-template-columns: repeat(var(--count), minmax(0, 1fr));
		padding: var(--pad);
		min-height: var(--height);
		border-radius: var(--radius-full);
		background: var(--color-surface-2);
		border: 1px solid var(--color-border);
		isolation: isolate;
	}

	.segmented[data-size='sm'] {
		--height: 2.25rem;
	}

	.thumb {
		position: absolute;
		z-index: -1;
		top: var(--pad);
		bottom: var(--pad);
		left: var(--pad);
		width: calc((100% - 2 * var(--pad)) / var(--count));
		border-radius: var(--radius-full);
		background: var(--color-surface-inverse);
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.25);
		transform: translateX(calc(var(--index) * 100%));
		transition: transform var(--duration-slow) var(--ease-spring);
	}

	.option {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-1-5);
		min-width: 0;
		padding: 0 var(--space-3);
		border-radius: var(--radius-full);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		color: var(--color-text-secondary);
		white-space: nowrap;
		transition: color var(--duration-base) var(--ease-standard);
	}

	.option[aria-checked='true'] {
		color: var(--color-text-inverse);
	}

	.option:focus-visible {
		outline-offset: 1px;
		border-radius: var(--radius-full);
	}

	@media (hover: hover) {
		.option[aria-checked='false']:hover {
			color: var(--color-text);
		}
	}
</style>
