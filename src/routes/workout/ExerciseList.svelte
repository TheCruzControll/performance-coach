<!--
  @component
  The session's exercises, the strength view's side column from 1024 px (hidden below, where the
  current exercise has the screen): each with its superset label or number, its name (long names
  wrap) and its sets done, and the current one marked aria-current. A progress list for now:
  exercise-navigation makes it navigable (roving focus, Enter makes an exercise current), with the
  hover and focus states a control has.
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
	}

	let { items, current }: Props = $props();
</script>

<nav class="side" aria-label="Exercises" data-testid="workout-side">
	<p class="title" aria-hidden="true">Exercises</p>
	<ol>
		{#each items as item (item.position)}
			<li class="row" aria-current={item.position === current ? 'step' : undefined}>
				<span class="badge">{item.label ?? item.position}</span>
				<span class="name">{item.name}</span>
				<span class="count tabular">{item.done}/{item.total} sets</span>
			</li>
		{/each}
	</ol>
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
			min-height: 3rem;
			padding: var(--space-2) var(--space-3);
			border-radius: var(--radius-md);
			border: 1px solid transparent;
		}

		.row[aria-current] {
			border-color: var(--color-accent);
			background: var(--color-surface-2);
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

		.count {
			color: var(--color-text-secondary);
			font-size: var(--text-sm);
		}
	}
</style>
