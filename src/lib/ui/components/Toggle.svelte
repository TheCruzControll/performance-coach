<!--
  @component
  An on/off row: a title, an optional description and a switch. A native checkbox with
  role="switch", so it is announced as on or off and Space flips it. The checkbox covers the
  whole row, which makes the row the hit area. The title is its label (the name) and the
  description its aria-describedby.
-->
<script lang="ts">
	interface Props {
		label: string;
		checked?: boolean;
		description?: string;
		onchange?: (checked: boolean) => void;
		'data-testid'?: string;
	}

	let {
		label,
		checked = $bindable(false),
		description,
		onchange,
		'data-testid': testId
	}: Props = $props();

	const id = $props.id();
</script>

<div class="toggle">
	<span class="text">
		<label class="title" for={id}>{label}</label>
		{#if description}<span class="description" id="{id}-description">{description}</span>{/if}
	</span>
	<input
		{id}
		class="input"
		type="checkbox"
		role="switch"
		bind:checked
		onchange={() => onchange?.(checked)}
		aria-describedby={description ? `${id}-description` : undefined}
		data-testid={testId}
	/>
	<span class="track" aria-hidden="true"></span>
</div>

<style>
	.toggle {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--space-4);
		min-height: var(--touch-target);
	}

	.text {
		display: grid;
		flex: 1;
		gap: 2px;
		text-align: start;
	}

	.title {
		font-weight: var(--weight-semibold);
	}

	.description {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	/* The native control covers the whole row: it is the hit area and the focus target. */
	.input {
		position: absolute;
		inset: 0;
		z-index: 1;
		width: 100%;
		height: 100%;
		margin: 0;
		appearance: none;
		opacity: 0;
		cursor: pointer;
	}

	/* 52 × 32 px; the 2 px padding is the gap around the thumb. */
	.track {
		flex: none;
		width: 3.25rem;
		height: 2rem;
		padding: 2px;
		border-radius: var(--radius-full);
		border: 1px solid var(--color-border-strong);
		background: var(--color-surface-3);
		color: var(--color-text);
		transition:
			background-color var(--duration-fast) var(--ease-standard),
			border-color var(--duration-fast) var(--ease-standard),
			color var(--duration-fast) var(--ease-standard),
			transform var(--duration-fast) var(--ease-out);
	}

	/* The thumb: high contrast on the track in both states and themes, and its side says on
	   or off. */
	.track::before {
		content: '';
		display: block;
		height: 100%;
		aspect-ratio: 1;
		border-radius: 50%;
		background: currentColor;
		transition: transform var(--duration-slow) var(--ease-spring);
	}

	.input:checked + .track {
		background: var(--color-accent);
		border-color: transparent;
		color: var(--color-on-accent);
	}

	.input:checked + .track::before {
		transform: translateX(1.25rem);
	}

	.input:focus-visible + .track {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	@media (hover: hover) and (pointer: fine) {
		.input:not(:checked):hover + .track {
			border-color: var(--color-text-tertiary);
		}

		.input:checked:hover + .track {
			background: var(--color-accent-hover);
		}
	}
</style>
