<!--
  @component
  One segment in the run's list: its number, what it is ('Interval 3 of 6'), what it asks for or,
  once logged, what was run with its pace, and its state in words (To do, Now, Done), never by
  colour alone; the one on screen is marked aria-current. The whole row is a 44 px button that makes the segment current, with hover and
  :focus-visible states; the list moves focus between rows with the arrow keys.
-->
<script lang="ts">
	interface Props {
		position: number;
		title: string;
		/** The target, or what was run. */
		line: string;
		/** The segment on screen. */
		current: boolean;
		done: boolean;
		onselect: () => void;
	}

	let { position, title, line, current, done, onselect }: Props = $props();

	/** ArrowUp and ArrowDown move to the row above or below. */
	function arrows(event: KeyboardEvent) {
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		const row = (event.currentTarget as HTMLElement).closest('li');
		const to = event.key === 'ArrowDown' ? row?.nextElementSibling : row?.previousElementSibling;
		const button = to?.querySelector('button');
		if (!button) return;
		event.preventDefault();
		button.focus();
	}
</script>

<li>
	<button
		type="button"
		class="row"
		data-done={done ? '' : undefined}
		aria-current={current ? 'step' : undefined}
		onclick={onselect}
		onkeydown={arrows}
		data-testid="run-segment"
	>
		<span class="badge tabular">{position}</span>
		<span class="text">
			<span class="name">{title}</span>
			<span class="line">{line}</span>
		</span>
		<span class="state">{done ? 'Done' : current ? 'Now' : 'To do'}</span>
	</button>
</li>

<style>
	.row {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-3);
		width: 100%;
		min-height: var(--touch-target);
		padding: var(--space-2) var(--space-3);
		border: 1px solid transparent;
		border-radius: var(--radius-md);
		background: none;
		color: inherit;
		font: inherit;
		text-align: start;
		cursor: pointer;
	}

	.row[aria-current] {
		border-color: var(--color-accent);
		background: var(--color-surface-2);
	}

	.row:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	@media (hover: hover) and (pointer: fine) {
		.row:hover {
			border-color: var(--color-border-strong);
			background: var(--color-surface-2);
		}
	}

	.badge {
		display: inline-grid;
		place-items: center;
		min-width: 2rem;
		height: 1.5rem;
		padding: 0 var(--space-1-5);
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--color-running) 16%, transparent);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
	}

	.text {
		display: grid;
		min-width: 0;
	}

	.name {
		font-weight: var(--weight-medium);
		overflow-wrap: anywhere;
	}

	.line {
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}

	.state {
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
	}

	.row[data-done] .state {
		color: var(--color-positive);
		font-weight: var(--weight-semibold);
	}
</style>
