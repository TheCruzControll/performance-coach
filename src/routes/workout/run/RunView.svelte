<!--
  @component
  The run workout (PRD §7, §8): the current segment's entry (the device's position, so a reload
  returns to it), the planned segments with their targets, the run's totals, and how it felt.
  - The entry starts from the target, or from what was logged: distance, time and heart rate
    (SegmentFields), with the pace worked out as they change. Log segment dispatches its
    run.segment, the totals' run.log and the move to the next segment at once (run-log.ts); on a
    segment already logged, Save changes edits it, even after it synced.
  - A free segment (an ad-hoc run's, or one beyond the plan) asks for its type; Add a segment
    opens one after the others.
  - The run's RPE (1 to 10) and notes are a run.log each, sent when they change.
  - A change this device could not save says so, with Retry.
  Below 1024 px one column: the entry, the segments, the totals, the effort. From 1024 px the
  segments sit beside the rest (the Shell's columns), the list sticky. Every control has hover
  and :focus-visible states; the list's rows move focus with the arrow keys.
-->
<script lang="ts">
	import type { ActiveSnapshot, ActiveWorkout } from '#lib/client/workout/active.svelte.ts';
	import type { RunSegmentKind } from '#lib/domain/training/vocabulary.ts';
	import { formatDuration } from '#lib/domain/units.ts';
	import type { LocalAction, Mutation } from '#lib/domain/workout/index.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import ChoiceGroup from '#lib/ui/components/ChoiceGroup.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import StatusSlot from '#lib/ui/components/StatusSlot.svelte';
	import Stat from '#lib/ui/components/Stat.svelte';
	import TextArea from '#lib/ui/components/TextArea.svelte';
	import RpeChips from '#lib/ui/workout/RpeChips.svelte';
	import {
		actualText,
		distanceText,
		entryError,
		freeItem,
		nextFreePosition,
		normalized,
		paceText,
		prefillOf,
		RUN_RPE_CHIPS,
		runFieldMutation,
		SEGMENT_WORDS,
		segmentActions,
		segmentItems,
		segmentTitle,
		targetText,
		type EntryError,
		type SegmentValues
	} from './run-log.ts';
	import SegmentFields from './SegmentFields.svelte';
	import SegmentRow from './SegmentRow.svelte';

	interface Props {
		snapshot: ActiveSnapshot;
		active: ActiveWorkout;
	}

	let { snapshot, active }: Props = $props();
	const view = $derived(snapshot.view);
	const unit = $derived(view.kit?.units.distance ?? 'km');
	const items = $derived(segmentItems(view));
	const position = $derived(view.device.position);
	let freeKind = $state<RunSegmentKind | null>('easy');
	const planned = $derived(items.find((i) => i.position === position));
	const item = $derived(planned ?? freeItem(position, freeKind ?? 'easy'));
	const kinds = Object.entries(SEGMENT_WORDS).map(([value, label]) => ({
		value: value as RunSegmentKind,
		label
	}));

	// What was typed for the segment on screen; a new segment or a new log starts again.
	interface Edits {
		key: string;
		values: Partial<SegmentValues>;
		error: EntryError | null;
	}
	const key = $derived(`${item.position}:${item.logged?.id ?? 'new'}`);
	let edits = $state.raw<Edits>({ key: '', values: {}, error: null });
	const mine = $derived(edits.key === key ? edits : { key, values: {}, error: null });
	const values = $derived<SegmentValues>({ ...prefillOf(item), ...mine.values });
	const edit = (change: Partial<SegmentValues>) =>
		(edits = { ...mine, values: { ...mine.values, ...change }, error: null });

	function send(...actions: [Mutation | LocalAction, ...(Mutation | LocalAction)[]]) {
		active.store?.dispatch(...actions);
	}

	function log() {
		const error = entryError(values);
		if (error) return void (edits = { ...mine, error });
		send(...segmentActions(view, items, item, normalized(values), new Date().toISOString()));
		edits = { key: '', values: {}, error: null };
	}

	const goTo = (to: number) => send({ type: 'goTo', workoutId: view.workout.id, position: to });

	function saveRun(change: { rpe?: number | null; notes?: string | null }) {
		const m = runFieldMutation(view, change, new Date().toISOString());
		if (m) send(m);
	}

	let notes = $state<string | null>(null);
	function saveNotes() {
		if (notes === null) return;
		saveRun({ notes: notes.trim() || null });
		notes = null;
	}

	const retry = async () => {
		for (const { id } of snapshot.notSaved) await active.store?.retry(id);
	};

	const run = $derived(view.run);
	const done = $derived(items.filter((i) => i.logged).length);
</script>

<nav class="side" aria-label="Segments" data-testid="run-side">
	<p class="title" aria-hidden="true">Segments · {done} of {items.length} done</p>
	<ol>
		{#each items as i (i.position)}
			<SegmentRow
				position={i.position}
				title={segmentTitle(i)}
				line={i.logged ? actualText(i.logged, unit) : targetText(i.target, unit)}
				current={i === planned}
				done={i.logged !== null}
				onselect={() => goTo(i.position)}
			/>
		{/each}
	</ol>
	{#if planned}
		<Button
			variant="secondary"
			icon="plus"
			onclick={() => goTo(nextFreePosition(items))}
			data-testid="add-segment">Add a segment</Button
		>
	{/if}
</nav>

<div class="main" data-testid="run-main">
	<!-- Graphite 2004's Status Display (RunStatus.svelte), first in both layouts; nothing on today's
	     design, where the entry's header, Totals and the segment list say the same. -->
	<StatusSlot
		load={() => import('./RunStatus.svelte')}
		props={{ input: { items, item, planned: !!planned, totals: run, unit } }}
		room="9rem"
	/>
	<section class="card entry" aria-labelledby="segment-name" data-testid="run-entry">
		<header class="head">
			<p class="place">
				{planned ? `Segment ${item.position} of ${items.length}` : 'A segment of your own'}
			</p>
			<h2 id="segment-name">{segmentTitle(item)}</h2>
			<p class="target">{targetText(item.target, unit)}</p>
		</header>
		{#if !planned}
			<ChoiceGroup legend="Segment type" options={kinds} bind:value={freeKind} />
		{/if}
		<SegmentFields {values} {unit} error={mine.error} onchange={edit} />
		{#if snapshot.notSaved.length > 0}
			<Notice tone="danger" title="Not saved on this device" data-testid="not-saved">
				This browser couldn't save it.
				<Button size="sm" variant="secondary" icon="refresh" onclick={retry}>Retry</Button>
			</Notice>
		{/if}
		<Button block icon="check" disabled={!active.store} onclick={log} data-testid="log-segment">
			{item.logged ? 'Save changes' : 'Log segment'}
		</Button>
	</section>

	<section class="card" aria-labelledby="run-totals" data-testid="run-totals">
		<h2 id="run-totals" class="small">Totals</h2>
		<ul class="stats">
			<Stat
				as="li"
				level={2}
				label="Distance"
				value={run?.distanceMetres != null ? distanceText(run.distanceMetres, unit) : null}
			/>
			<Stat
				as="li"
				level={2}
				label="Time"
				value={run?.durationSeconds != null ? formatDuration(run.durationSeconds) : null}
			/>
			<Stat
				as="li"
				level={2}
				label="Pace"
				value={run?.paceSecondsPerKm != null ? paceText(run.paceSecondsPerKm, unit) : null}
			/>
			<Stat
				as="li"
				level={2}
				label="Average HR"
				value={run?.avgHr != null ? `${run.avgHr} bpm` : null}
			/>
		</ul>
	</section>

	<section class="card" aria-labelledby="run-effort" data-testid="run-effort">
		<h2 id="run-effort" class="small">How it felt</h2>
		<RpeChips chips={RUN_RPE_CHIPS} value={run?.rpe ?? null} onchange={(rpe) => saveRun({ rpe })} />
		<div onfocusout={saveNotes}>
			<TextArea
				label="Notes"
				optional
				maxlength={500}
				bind:value={() => notes ?? run?.notes ?? '', (text) => (notes = text)}
				data-testid="run-notes"
			/>
		</div>
	</section>
</div>

<style>
	ol {
		display: grid;
		gap: var(--space-1);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.side,
	.main {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		min-width: 0;
	}

	.title {
		padding: 0 var(--space-3);
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	.card {
		display: grid;
		gap: var(--space-4);
		padding: var(--space-4);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-surface-1);
	}

	.entry {
		box-shadow: var(--elevation-1);
	}

	.head {
		display: grid;
		gap: var(--space-1);
	}

	.place,
	.target {
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
	}

	.target {
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
		color: var(--color-text);
	}

	h2 {
		font-family: var(--font-display);
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-tight);
		overflow-wrap: anywhere;
	}

	h2.small {
		font-size: var(--text-lg);
	}

	.stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
		gap: var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* One column: the entry first, then the segments, then the totals and the effort. */
	@media (width < 64rem) {
		.main {
			display: contents;
		}

		.entry {
			order: 1;
		}

		.side {
			order: 2;
		}

		.main > :not(.entry) {
			order: 3;
		}

		.side,
		.main > * {
			margin-bottom: var(--space-4);
		}
	}

	@media (width >= 64rem) {
		.side {
			position: sticky;
			top: var(--space-6);
		}
	}
</style>
