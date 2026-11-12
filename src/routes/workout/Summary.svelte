<!--
  @component
  A workout's summary (PRD §7, §9), in words from finish.ts over domain summary.ts's numbers, the
  same ones History shows: the duration, the sets done and skipped, the volume where it applies
  (reps, seconds and metres elsewhere), each exercise's best set with its e1RM marked estimated,
  the PRs ('New estimated best · Back squat'), and a run's or a session's totals.
  - `editing`: the finish sheet's fields under it: the duration (from the stopwatch, in minutes,
    nudged or typed), the session RPE chips 1–10 (one radio group) and the notes, each with the
    server's error when a refused change is being fixed.
  - `completed`: the page's completed state, read-only: the session RPE and the notes, how the
    workout is saved ('Saved on this device — it syncs when you're back online', or synced, with
    'View in History'), 'Not saved on this device' with Retry, and Back to Today. It renders from
    IndexedDB and the precached chunks alone, so it works offline and after an offline reload.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import type { OutboxStatus } from '#lib/client/workout/outbox-rules.ts';
	import type { NotSaved, WorkoutStore } from '#lib/client/workout/store.ts';
	import type { FieldErrors } from '#lib/domain/validation.ts';
	import type { WorkoutFields, WorkoutView } from '#lib/domain/workout/index.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import NumberStepper from '#lib/ui/components/NumberStepper.svelte';
	import Stat from '#lib/ui/components/Stat.svelte';
	import TextArea from '#lib/ui/components/TextArea.svelte';
	import RpeChips from '#lib/ui/workout/RpeChips.svelte';
	import {
		DURATION_MINUTES,
		fieldError,
		FINISH_RPE_CHIPS,
		NOTES_MAX,
		summaryOf,
		summaryWords
	} from './finish.ts';

	interface Props {
		view: WorkoutView;
		/** The finish sheet's fields, and the server's errors for them when fixing. */
		editing?: {
			values: WorkoutFields;
			errors?: FieldErrors;
			onchange: (change: Partial<WorkoutFields>) => void;
		};
		/** The completed state: the sync status, and what this device could not save (Retry). */
		completed?: {
			status: OutboxStatus | null | undefined;
			notSaved: readonly NotSaved[];
			store: WorkoutStore | null;
		};
	}

	let { view, editing, completed }: Props = $props();

	const status = $derived(completed?.status);
	/** Nothing waits to sync: the server has the workout, so History does. */
	const synced = $derived(
		status?.state === 'synced' || (status?.state === 'offline' && status.pending === 0)
	);
	const offline = $derived(status ? status.state === 'offline' : !navigator.onLine);
	const unsaved = $derived(completed?.notSaved[0]);
	const retry = () => unsaved && void completed?.store?.retry(unsaved.id);

	const values = $derived(editing?.values ?? view.workout);
	const words = $derived(
		summaryWords({ ...summaryOf(view, Date.now()), durationSeconds: values.durationSeconds })
	);
	const minutes = $derived(Math.max(1, Math.round((values.durationSeconds ?? 60) / 60)));
	const rpeError = $derived(fieldError(editing?.errors, 'sessionRpe'));
</script>

<div class="summary" data-testid="workout-summary">
	{#if completed}
		<header class="head">
			<h2 class="eyebrow"><Icon name="check" size={16} /> Workout complete</h2>
			{#if unsaved}
				<Notice tone="danger" title="Not saved on this device" data-testid="summary-not-saved">
					This browser refused to save the finish.
					<Button size="sm" variant="secondary" icon="refresh" onclick={retry}>Try again</Button>
				</Notice>
			{:else if synced}
				<Notice tone="positive" title="Synced" data-testid="summary-synced">
					It's in your History.
				</Notice>
			{:else}
				<Notice
					tone={status?.state === 'attention' ? 'warning' : 'neutral'}
					icon={offline ? 'wifi-off' : undefined}
					data-testid="summary-saved-here"
				>
					{status?.state === 'attention'
						? 'Saved on this device — a change needs attention before it syncs: open the sync status above.'
						: offline
							? "Saved on this device — it syncs when you're back online."
							: 'Saved on this device — syncing now.'}
				</Notice>
			{/if}
		</header>
	{/if}

	{#if words.stats.length > 0}
		<ul class="stats" aria-label="Totals">
			{#each words.stats as stat (stat.label)}
				<Stat as="li" level={2} label={stat.label} value={stat.value} />
			{/each}
		</ul>
	{/if}

	{#if words.prs.length > 0}
		<section class="block" aria-labelledby="summary-prs">
			<h3 id="summary-prs" class="eyebrow">PRs</h3>
			<ul class="list">
				{#each words.prs as pr (pr.key)}
					<li class="pr" data-testid="summary-pr">
						<span class="pr-icon"><Icon name="trend-up" size={18} /></span>
						<span>
							<span class="name">{pr.title}</span>
							<span class="line">{pr.detail}</span>
						</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if words.exercises.length > 0}
		<section class="block" aria-labelledby="summary-exercises">
			<h3 id="summary-exercises" class="eyebrow">Exercises</h3>
			<ul class="list">
				{#each words.exercises as exercise (exercise.key)}
					<li class="exercise" data-testid="summary-exercise">
						<span class="name">{exercise.name}</span>
						<span class="line">{exercise.done}</span>
						{#if exercise.best}<span class="line best">{exercise.best}</span>{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if editing}
		<div class="fields">
			<NumberStepper
				label="Duration"
				unit="min"
				value={minutes}
				min={DURATION_MINUTES[0]}
				max={DURATION_MINUTES[1]}
				bigStep={5}
				chars={4}
				hint="From the stopwatch, pauses left out"
				error={fieldError(editing.errors, 'durationSeconds')}
				onchange={(m) => editing?.onchange({ durationSeconds: m * 60 })}
				data-testid="summary-duration"
			/>
			<div class="rpe">
				<p class="question">How hard was the whole session?</p>
				<RpeChips
					chips={FINISH_RPE_CHIPS}
					value={values.sessionRpe}
					onchange={(sessionRpe) => editing?.onchange({ sessionRpe })}
				/>
				{#if rpeError}<p class="error" role="alert">{rpeError}</p>{/if}
			</div>
			<TextArea
				label="Notes"
				optional
				maxlength={NOTES_MAX}
				error={fieldError(editing.errors, 'notes')}
				bind:value={() => values.notes ?? '', (notes) => editing?.onchange({ notes })}
				data-testid="summary-notes"
			/>
		</div>
	{:else}
		<section class="block" aria-labelledby="summary-effort">
			<h3 id="summary-effort" class="eyebrow">Effort and notes</h3>
			<p class="line" data-testid="summary-rpe">
				{values.sessionRpe !== null ? `Session RPE ${values.sessionRpe}` : 'No session RPE'}
			</p>
			{#if values.notes}<p class="notes" data-testid="summary-notes-text">{values.notes}</p>{/if}
		</section>
	{/if}

	{#if completed}
		<div class="actions">
			{#if synced}
				<Button
					block
					iconEnd="arrow-right"
					href={resolve('/(app)/progress/workouts/[[id]]', { id: view.workout.id })}
					data-testid="view-in-history">View in History</Button
				>
			{/if}
			<Button
				block
				variant={synced ? 'secondary' : 'primary'}
				href={resolve('/(app)/today')}
				data-testid="back-to-today">Back to Today</Button
			>
		</div>
	{/if}
</div>

<style>
	.summary {
		display: grid;
		gap: var(--space-5);
	}

	.head {
		display: grid;
		gap: var(--space-3);
	}

	.eyebrow {
		display: flex;
		align-items: center;
		gap: var(--space-1-5);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
		color: var(--color-text-tertiary);
	}

	.stats {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-3);
	}

	.block {
		display: grid;
		gap: var(--space-2);
	}

	.list {
		display: grid;
		gap: var(--space-2);
	}

	.exercise,
	.pr {
		display: grid;
		gap: var(--space-0-5);
		padding: var(--space-3) var(--space-4);
		border: 1px solid var(--color-hairline);
		border-radius: var(--radius-lg);
	}

	.pr {
		grid-template-columns: auto 1fr;
		align-items: start;
		gap: var(--space-3);
		border-color: color-mix(in srgb, var(--color-accent) 40%, var(--color-hairline));
	}

	.pr-icon {
		display: inline-grid;
		color: var(--color-accent);
	}

	.name {
		display: block;
		font-weight: var(--weight-semibold);
		overflow-wrap: anywhere;
	}

	.line {
		display: block;
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
	}

	.best {
		font-variant-numeric: tabular-nums;
	}

	.notes {
		white-space: pre-line;
		overflow-wrap: anywhere;
	}

	.fields {
		display: grid;
		gap: var(--space-5);
	}

	.rpe {
		display: grid;
		gap: var(--space-2);
	}

	.question {
		font-weight: var(--weight-medium);
	}

	.error {
		color: var(--color-danger);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
	}

	.actions {
		display: grid;
		gap: var(--space-2);
	}

	@media (width >= 40rem) {
		.stats {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}
</style>
