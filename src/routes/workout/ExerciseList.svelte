<!--
  @component
  The session's exercises, the strength view's side column from 1024 px (hidden below, where the
  current exercise has the screen): each with its superset label or number, its name (long names
  wrap) and its sets done, and the current one marked aria-current. Each row is a button and the
  list one tab stop, at the current exercise; Navigation.svelte, loaded after the first render,
  handles them (the arrows, Home and End move the focus within it; Enter or a click makes an
  exercise current, focus staying on it), so /workout's first paint carries none of it. Rows have
  hover and focus states. After the last exercise, Add exercise (`onadd`) opens the picker.
-->
<script lang="ts" module>
	export interface ExerciseItem {
		position: number;
		/** 'A1' in a superset; none for a straight exercise, which shows its number. */
		label?: string | null;
		name: string;
		done: number;
		total: number;
	}
</script>

<script lang="ts">
	interface Props {
		items: ExerciseItem[];
		/** The current exercise's position. */
		current?: number;
		/** Add exercise, after the last one: opens the picker (`onintent` fetches it). */
		onadd?: (event: MouseEvent) => void;
		onintent?: () => void;
	}

	let { items, current, onadd, onintent }: Props = $props();
</script>

<nav class="side" aria-label="Exercises" data-testid="workout-side">
	<p class="title" aria-hidden="true">Exercises</p>
	<ol id="exercise-list">
		{#each items as item (item.position)}
			<li>
				<button
					type="button"
					class="row"
					tabindex={item.position === current ? 0 : -1}
					aria-current={item.position === current ? 'step' : undefined}
					data-position={item.position}
				>
					<span class="badge">{item.label ?? item.position}</span>
					<span class="name">{item.name}</span>
					<span class="count tabular">{item.done}/{item.total} sets</span>
				</button>
			</li>
		{/each}
	</ol>
	{#if onadd}
		<button
			type="button"
			class="row add"
			onpointerdown={onintent}
			onclick={onadd}
			data-testid="side-add-exercise"
		>
			<span class="badge" aria-hidden="true">+</span>
			<span class="name">Add exercise</span>
		</button>
	{/if}
</nav>

<style>
	.side {
		display: none;
	}

	@media (width >= 64rem) {
		.side {
			display: grid;
			gap: var(--space-2);
			position: sticky;
			top: var(--space-6);
		}

		.title {
			padding: 0 var(--space-3);
			font-size: var(--text-sm);
			font-weight: var(--weight-semibold);
			color: var(--color-text-secondary);
		}

		ol {
			display: grid;
			gap: var(--space-1);
			list-style: none;
			margin: 0;
			padding: 0;
		}

		.row {
			display: grid;
			grid-template-columns: auto minmax(0, 1fr) auto;
			align-items: center;
			gap: var(--space-3);
			width: 100%;
			min-height: 3rem;
			margin: 0;
			padding: var(--space-2) var(--space-3);
			border-radius: var(--radius-md);
			border: 1px solid transparent;
			background: none;
			color: inherit;
			font: inherit;
			text-align: start;
			cursor: pointer;
			transition:
				border-color var(--duration-fast) var(--ease-standard),
				background-color var(--duration-fast) var(--ease-standard);
		}

		.row:focus-visible {
			outline-offset: 1px;
			border-radius: var(--radius-md);
		}

		.row[aria-current] {
			border-color: var(--color-accent);
			background: var(--color-surface-2);
		}

		@media (hover: hover) and (pointer: fine) {
			.row:hover {
				border-color: var(--color-border-strong);
				background: var(--color-surface-2);
			}

			.row[aria-current]:hover {
				border-color: var(--color-accent);
				background: var(--color-surface-3);
			}
		}

		.badge {
			display: inline-grid;
			place-items: center;
			min-width: 2rem;
			height: 1.5rem;
			padding: 0 var(--space-1-5);
			border-radius: var(--radius-full);
			background: color-mix(in srgb, var(--color-strength) 16%, transparent);
			font-size: var(--text-xs);
			font-weight: var(--weight-semibold);
		}

		.name {
			overflow-wrap: anywhere;
			font-weight: var(--weight-medium);
		}

		.add {
			color: var(--color-text-secondary);
		}

		.count {
			color: var(--color-text-secondary);
			font-size: var(--text-sm);
		}
	}
</style>
