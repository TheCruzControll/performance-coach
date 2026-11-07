<!--
  @component
  The strength workout, read only, until strength-view replaces it: every exercise with its
  prescription and its sets, planned beside logged. Below 1024 px one column of exercise cards;
  from 1024 px a side column lists the exercises (with their labels and progress) beside them.
  It renders two siblings, the side list and the cards, which the Shell lays out as its columns.
-->
<script lang="ts">
	import { formatDuration, formatWeight } from '#lib/domain/units.ts';
	import { groups } from '#lib/domain/workout/flow.ts';
	import type { KitSet, LoggedSet, WorkoutView } from '#lib/domain/workout/index.ts';
	import { plannedVsLogged } from '#lib/domain/workout/selectors.ts';
	import Icon from '#lib/ui/components/Icon.svelte';

	interface Props {
		view: WorkoutView;
	}

	let { view }: Props = $props();

	const amount = (reps: number | null, seconds: number | null, metres: number | null) =>
		reps !== null
			? `${reps} reps`
			: seconds !== null
				? formatDuration(seconds)
				: metres !== null
					? `${metres} m`
					: null;

	/** What a planned set asks for: '5 reps · ≈ 100 kg', '6–10 reps · RPE 8', '0:45'. */
	function target(set: KitSet): string {
		const { repsMin: min, repsMax: max, prescribedWeight: weight, targetRpe } = set;
		const reps = min !== null && max !== null && min !== max ? `${min}–${max} reps` : null;
		const parts = [
			reps ?? amount(min ?? max, set.seconds, set.metres),
			weight &&
				`${weight.basis === 'estimated' ? '≈ ' : ''}${formatWeight(weight.value, weight.unit)}`,
			targetRpe !== null ? `RPE ${targetRpe}` : null
		];
		return parts.filter(Boolean).join(' · ');
	}

	/** What was done: '100 kg × 5 · RPE 8', '0:45', 'Skipped'. */
	function result(set: LoggedSet & { isSkipped: boolean }): string {
		if (set.isSkipped) return 'Skipped';
		const done = amount(set.reps, set.seconds, set.metres) ?? 'Done';
		const load =
			set.weight !== null
				? `${formatWeight(set.weight, set.unit)} × ${done}`
				: set.assistance !== null
					? `${done} · ${formatWeight(set.assistance, set.unit)} assist`
					: done;
		return set.rpe !== null ? `${load} · RPE ${set.rpe}` : load;
	}

	const exercises = $derived.by(() => {
		const labels = new Map(
			groups({ exercises: view.slots }).flatMap((group) =>
				group.members.map((member) => [member.position, member.label] as const)
			)
		);
		return view.slots.map((slot) => {
			const rows = plannedVsLogged(view, slot.position);
			return {
				position: slot.position,
				label: labels.get(slot.position) ?? null,
				name: view.exercises[slot.exerciseId]?.name ?? slot.kit?.exercise.name ?? 'Exercise',
				line: [...new Set(slot.kit?.sets.map((set) => set.line))].join(' · '),
				rows,
				done: rows.filter((row) => row.logged).length
			};
		});
	});
</script>

<nav class="side" aria-label="Exercises" data-testid="workout-side">
	<ol>
		{#each exercises as exercise (exercise.position)}
			<li>
				<a class="row" href="#exercise-{exercise.position}">
					<span class="badge" aria-hidden="true">{exercise.label ?? exercise.position}</span>
					<span class="row-name">{exercise.name}</span>
					<span class="count">
						{exercise.done}/{exercise.rows.length}<span class="visually-hidden">&nbsp;sets</span>
					</span>
				</a>
			</li>
		{/each}
	</ol>
</nav>

<div class="exercises" data-testid="workout-main">
	{#each exercises as exercise (exercise.position)}
		<section
			class="exercise"
			id="exercise-{exercise.position}"
			aria-labelledby="exercise-{exercise.position}-name"
			data-testid="exercise"
		>
			<header class="exercise-head">
				{#if exercise.label}<span class="badge">{exercise.label}</span>{/if}
				<h2 id="exercise-{exercise.position}-name">{exercise.name}</h2>
				{#if exercise.line}<p class="line">{exercise.line}</p>{/if}
			</header>
			<ol class="sets">
				{#each exercise.rows as row, i (i)}
					<li class="set" data-testid="set" data-done={row.logged ? '' : undefined}>
						<span class="index">{row.setIndex}</span>
						<span class="target">{row.planned ? target(row.planned) : 'Extra set'}</span>
						<span class="result">
							{#if row.logged}
								<Icon name="check" size={16} />{result(row.logged)}
							{:else}
								To do
							{/if}
						</span>
					</li>
				{/each}
			</ol>
		</section>
	{/each}
</div>

<style>
	ol {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.side {
		display: none;
	}

	.badge {
		display: inline-grid;
		place-items: center;
		min-width: 2rem;
		height: 1.5rem;
		padding: 0 var(--space-1-5);
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--color-strength) 16%, transparent);
		color: var(--color-text);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
		font-variant-numeric: tabular-nums;
	}

	.exercises {
		display: grid;
		gap: var(--space-4);
	}

	.exercise {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-4);
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border);
		background: var(--color-surface-1);
		box-shadow: var(--elevation-1);
		scroll-margin-top: var(--space-4);
	}

	.exercise-head {
		display: grid;
		grid-template-columns: auto 1fr;
		align-items: center;
		column-gap: var(--space-2);
		row-gap: var(--space-1);
	}

	h2 {
		grid-column: -2 / -1;
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
		line-height: var(--leading-snug);
	}

	.exercise-head:not(:has(.badge)) h2,
	.line {
		grid-column: 1 / -1;
	}

	.line {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.sets {
		display: grid;
		border-top: 1px solid var(--color-hairline);
	}

	.set {
		display: grid;
		grid-template-columns: 1.5rem minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-3);
		min-height: 2.75rem;
		border-bottom: 1px solid var(--color-hairline);
		font-size: var(--text-sm);
	}

	.set:last-child {
		border-bottom: 0;
	}

	.index {
		color: var(--color-text-tertiary);
		font-variant-numeric: tabular-nums;
	}

	.result {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		color: var(--color-text-tertiary);
		text-align: right;
	}

	.set[data-done] .result {
		color: var(--color-positive);
		font-weight: var(--weight-semibold);
	}

	@media (width >= 64rem) {
		.side {
			display: block;
			position: sticky;
			top: var(--space-6);
		}

		.side ol {
			display: grid;
			gap: var(--space-1);
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
			color: var(--color-text);
			text-decoration: none;
			transition:
				background-color var(--duration-fast) var(--ease-standard),
				border-color var(--duration-fast) var(--ease-standard);
		}

		.row:focus-visible {
			background: var(--color-surface-2);
		}

		.row-name {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			font-weight: var(--weight-medium);
		}

		.count {
			color: var(--color-text-secondary);
			font-size: var(--text-sm);
			font-variant-numeric: tabular-nums;
		}
	}

	@media (width >= 64rem) and (hover: hover) and (pointer: fine) {
		.row:hover {
			background: var(--color-surface-2);
			border-color: var(--color-border-strong);
		}
	}
</style>
