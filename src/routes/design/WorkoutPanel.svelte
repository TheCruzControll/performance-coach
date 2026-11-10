<!--
  /design → Workout (loaded when its section opens): every src/lib/ui/workout component in each
  of its states, from workout-fixture.ts, so each can be audited and screenshotted on its own.
  Components that hold a fixed id (ExerciseCard, SetLogger, UpNext: one per page) show one state
  at a time, picked above them. The timers run and their controls work; the history sheet asks
  the real endpoint, so its specs answer it.
-->
<script lang="ts">
	import type { HistoryRequest } from '#lib/client/workout/exercise-history.ts';
	import { defaultMissedReps, RPE_CHIPS } from '#lib/domain/workout/prefill.ts';
	import {
		addRest,
		pauseRest,
		pauseStopwatch,
		resetRest,
		resetStopwatch,
		resumeRest,
		resumeStopwatch,
		startRest
	} from '#lib/domain/workout/timers.ts';
	import type { RestState, StopwatchState } from '#lib/domain/workout/index.ts';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import ChoiceGroup from '#lib/ui/components/ChoiceGroup.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import { toast } from '#lib/ui/toast.svelte.ts';
	import ExerciseCard from '#lib/ui/workout/ExerciseCard.svelte';
	import ExerciseHistorySheet from '#lib/ui/workout/ExerciseHistorySheet.svelte';
	import RestTimer from '#lib/ui/workout/RestTimer.svelte';
	import SetLogger from '#lib/ui/workout/SetLogger.svelte';
	import SetRow from '#lib/ui/workout/SetRow.svelte';
	import Stopwatch from '#lib/ui/workout/Stopwatch.svelte';
	import SyncPill from '#lib/ui/workout/SyncPill.svelte';
	import UpNext from '#lib/ui/workout/UpNext.svelte';
	import {
		CARDS,
		type CardFixture,
		HISTORY_FALLBACK,
		LOGGERS,
		SET_ROWS,
		SYNC_STATES,
		UP_NEXT,
		upNextView
	} from './workout-fixture.ts';

	const choices = <K extends string>(record: Record<K, { label: string }>) =>
		(Object.keys(record) as K[]).map((value) => ({ value, label: record[value].label }));

	let loggerKind = $state<keyof typeof LOGGERS>('weight');
	let cardKind = $state<keyof typeof CARDS>('baseline');
	let upNextKind = $state<keyof typeof UP_NEXT>('partner');
	const logger = $derived(LOGGERS[loggerKind]);
	const card: CardFixture = $derived(CARDS[cardKind]);
	const view = $derived(upNextView(UP_NEXT[upNextKind]));

	const now = Date.now();
	const MINUTE = 60_000;
	/** Each state built at a time, so Skip and Dismiss bring it back fresh. */
	const RESTS: { name: string; rest: (at: number) => RestState }[] = [
		{ name: 'Running', rest: (at) => startRest(at, 3 * MINUTE) },
		{ name: 'Paused', rest: (at) => pauseRest(startRest(at - 40_000, 2 * MINUTE), at) },
		{ name: 'Over', rest: (at) => startRest(at - 162_000, 2 * MINUTE) }
	];
	let rests = $state(RESTS.map((r) => r.rest(now)));
	const act = (i: number, change: (rest: RestState, at: number) => RestState) =>
		(rests[i] = change(rests[i]!, Date.now()));

	let stopwatches = $state<StopwatchState[]>([
		{ startedAt: now - 25 * MINUTE, accumulatedMs: 0, runningSince: now - 25 * MINUTE },
		{ startedAt: now - 50 * MINUTE, accumulatedMs: 42 * MINUTE + 13_000, runningSince: null }
	]);
	/** A paused stopwatch's Resume or Reset, as the workout header offers them. */
	let options = $state(false);
	let chosen = 0;
	function choose(change: (stopwatch: StopwatchState, at: number) => StopwatchState) {
		stopwatches[chosen] = change(stopwatches[chosen]!, Date.now());
		options = false;
	}

	let history = $state.raw<HistoryRequest | null>(null);
	const openHistory = () =>
		(history = {
			exerciseId: '00000000-0000-4000-8000-0000000d0101',
			name: 'Back squat',
			fallback: HISTORY_FALLBACK
		});
	/** As a coach answer's exercise source opens it: by exercise id alone. */
	const openHistoryById = () => (history = { exerciseId: '00000000-0000-4000-8000-0000000d0101' });
	const logged = () => toast.show('Set logged', { tone: 'positive' });
</script>

<div class="grid" data-testid="workout-panel">
	<Section title="Set row" gap="md">
		<ol class="rows" aria-label="Every set state" data-testid="set-rows">
			{#each SET_ROWS as row (row.state)}
				{@const editable =
					row.state === 'done' || row.state === 'missed' || row.state === 'skipped'}
				<SetRow
					{row}
					onedit={editable ? () => {} : undefined}
					onplates={row.state === 'current' ? () => {} : undefined}
				/>
			{/each}
		</ol>
	</Section>

	<Section title="Set logger and RPE" gap="md">
		<ChoiceGroup
			legend="Measure and load"
			options={choices(LOGGERS)}
			bind:value={loggerKind}
			data-testid="logger-kind"
		/>
		<div class="thumb">
			<SetLogger
				setKey={loggerKind}
				heading={logger.heading}
				fields={logger.fields}
				values={logger.values}
				increment={logger.increment}
				loadHint={logger.loadHint}
				rpeChips={RPE_CHIPS}
				oncomplete={logged}
				missedFor={(reps) => defaultMissedReps({ repsMin: logger.values.reps }, reps)}
				secondary={{ label: 'Skip set', icon: 'arrow-right', onclick: () => {} }}
			/>
		</div>
	</Section>

	<Section title="Rest timer" gap="md">
		{#each RESTS as { name }, i (name)}
			<div class="state" data-testid="rest-{name.toLowerCase()}">
				<p class="caption">{name}</p>
				<RestTimer
					rest={rests[i]!}
					onpause={() => act(i, pauseRest)}
					onresume={() => act(i, resumeRest)}
					onreset={() => act(i, resetRest)}
					onadd={() => act(i, addRest)}
					onclear={() => (rests[i] = RESTS[i]!.rest(Date.now()))}
				/>
			</div>
		{/each}
	</Section>

	<Section title="Stopwatch" gap="md">
		<div class="inline" data-testid="stopwatches">
			{#each stopwatches as stopwatch, i (i)}
				<Stopwatch
					{stopwatch}
					onpause={() => (stopwatches[i] = pauseStopwatch(stopwatch, Date.now()))}
					onoptions={() => ((chosen = i), (options = true))}
				/>
			{/each}
		</div>
		<BottomSheet bind:open={options} title="Workout time paused">
			{#snippet footer()}
				<div class="choice">
					<Button block icon="play" onclick={() => choose(resumeStopwatch)}
						>Resume workout time</Button
					>
					<Button block variant="danger" icon="refresh" onclick={() => choose(resetStopwatch)}
						>Reset workout time</Button
					>
				</div>
			{/snippet}
			<p class="caption">Reset sets the time back to 0:00.</p>
		</BottomSheet>
	</Section>

	<Section title="Sync pill" gap="md">
		<ul class="pills" data-testid="sync-pills">
			{#each SYNC_STATES as status (status.state)}
				<li><SyncPill {status} onopen={status.state === 'synced' ? undefined : () => {}} /></li>
			{/each}
		</ul>
	</Section>

	<Section title="Up next" gap="md">
		<ChoiceGroup
			legend="Moment"
			options={choices(UP_NEXT)}
			bind:value={upNextKind}
			data-testid="up-next-kind"
		/>
		<UpNext {view} onstart={() => {}} onfinish={() => {}} onadd={() => {}} />
	</Section>

	<Section title="Exercise card" gap="md">
		<ChoiceGroup
			legend="Card state"
			options={choices(CARDS)}
			bind:value={cardKind}
			data-testid="card-kind"
		/>
		<ExerciseCard
			exercise={card.exercise}
			status={card.status}
			noPrevious={card.noPrevious}
			onhistory={openHistory}
		>
			{#snippet actions()}
				{#if !card.status || card.status.text !== 'Stopped'}
					<Button variant="secondary" icon="refresh" aria-label="Exercise options">Options</Button>
				{/if}
			{/snippet}
			{#each card.rows as row (row.setIndex)}
				<SetRow {row} />
			{/each}
		</ExerciseCard>
	</Section>

	<Section title="Exercise history" gap="md">
		<div class="inline">
			<Button
				variant="secondary"
				icon="chevron-right"
				onclick={openHistory}
				data-testid="open-history">Exercise history</Button
			>
			<Button
				variant="secondary"
				icon="chevron-right"
				onclick={openHistoryById}
				data-testid="open-history-by-id">By exercise id</Button
			>
		</div>
		<ExerciseHistorySheet request={history} onclose={() => (history = null)} />
	</Section>
</div>

<style>
	.grid {
		display: grid;
		gap: var(--space-8);
	}

	.rows,
	.pills {
		display: grid;
		gap: var(--space-1);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.pills {
		justify-items: start;
		gap: var(--space-2);
	}

	.state,
	.choice {
		display: grid;
		gap: var(--space-2);
	}

	.caption {
		font-size: var(--text-xs);
		color: var(--color-text-tertiary);
	}

	.inline {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-4);
	}

	/*
	 * The logger as it sits in the thumb zone: full-bleed below 1024 px, its negative foot margin
	 * paid back here, and sticky only within this box, so it never floats over the gallery.
	 */
	.thumb {
		display: flow-root;
		padding-bottom: calc(var(--space-8) + var(--safe-bottom));
	}

	@media (width >= 64rem) {
		.thumb {
			padding-bottom: 0;
		}
	}
</style>
