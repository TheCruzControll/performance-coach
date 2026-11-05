<!--
  @component
  An on/off switch with a title and an optional description — a native checkbox with
  role="switch", so it is announced as "on"/"off". The whole row is the hit area.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		label: string;
		checked: boolean;
		description?: string;
		onchange?: (checked: boolean) => void;
		children?: Snippet;
		'data-testid'?: string;
	}

	let {
		label,
		checked = $bindable(false),
		description,
		onchange,
		children,
		'data-testid': testId
	}: Props = $props();

	const id = $props.id();
</script>

<label class="toggle" for={id}>
	<span class="text">
		<span class="title">{label}</span>
		{#if description}<span class="description" id="{id}-desc">{description}</span>{/if}
		{@render children?.()}
	</span>
	<input
		{id}
		class="input"
		type="checkbox"
		role="switch"
		bind:checked
		onchange={() => onchange?.(checked)}
		aria-describedby={description ? `${id}-desc` : undefined}
		data-testid={testId}
	/>
	<span class="track" aria-hidden="true"><span class="thumb"></span></span>
</label>

<style>
	.toggle {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--space-4);
		min-height: var(--touch-target);
		cursor: pointer;
	}

	.text {
		display: grid;
		flex: 1;
		gap: var(--space-1);
	}

	.title {
		font-weight: var(--weight-semibold);
	}

	.description {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.input {
		position: absolute;
		opacity: 0;
		width: 1px;
		height: 1px;
	}

	.track {
		position: relative;
		flex: none;
		width: 3.25rem;
		height: 2rem;
		border-radius: var(--radius-full);
		background: var(--color-surface-3);
		border: 1px solid var(--color-border-strong);
		transition: background-color var(--duration-base) var(--ease-standard);
	}

	.thumb {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 1.625rem;
		height: 1.625rem;
		border-radius: 50%;
		background: var(--color-text);
		box-shadow: 0 1px 3px rgb(0 0 0 / 0.3);
		transition: transform var(--duration-slow) var(--ease-spring);
	}

	.input:checked + .track {
		background: var(--color-accent);
		border-color: transparent;
	}

	.input:checked + .track .thumb {
		background: var(--color-on-accent);
		transform: translateX(1.25rem);
	}

	.input:focus-visible + .track {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}
</style>
