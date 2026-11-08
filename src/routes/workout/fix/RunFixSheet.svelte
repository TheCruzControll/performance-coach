<!--
  @component
  Fix for a refused run.segment or run.log (fix/run.ts), in a BottomSheet (a centred dialog from
  1024 px): why the server refused it first, then the values it carries, as the run view asks for
  them (SegmentFields: distance, time, heart rate), and for a run.log its RPE and notes when it
  carries them. Save hands back the change with the corrected values, under the same id; the sync
  sheet checks it and re-queues it in its place. A corrected segment also hands back the run's
  totals worked out again (a run.log, queued after every older change). Discard is the sync
  sheet's.
-->
<script lang="ts">
	import type { RunSegmentFields } from '#lib/domain/workout/index.ts';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import TextArea from '#lib/ui/components/TextArea.svelte';
	import RpeChips from '#lib/ui/workout/RpeChips.svelte';
	import {
		entryError,
		normalized,
		RUN_RPE_CHIPS,
		segmentTitle,
		totalsMutation
	} from '../run/run-log.ts';
	import type { EntryError, SegmentValues } from '../run/run-log.ts';
	import SegmentFields from '../run/SegmentFields.svelte';
	import type { FixEditorProps } from './registry.ts';

	let { open = $bindable(), m, problem, view, onsave }: FixEditorProps = $props();

	const unit = $derived(view?.kit?.units.distance ?? 'km');
	const AMOUNTS = ['distanceMetres', 'durationSeconds', 'avgHr'] as const;
	/** The values the change carries: every one for a segment, only its own for a run.log. */
	const given = $derived(
		Object.fromEntries(
			AMOUNTS.filter((k) => (m.payload as Partial<SegmentValues>)[k] !== undefined).map((k) => [
				k,
				(m.payload as Partial<SegmentValues>)[k]
			])
		) as Partial<SegmentValues>
	);
	const segment = $derived(m.type === 'run.segment' ? (m.payload as RunSegmentFields) : null);
	const log = $derived(m.type === 'run.log' ? m.payload : null);

	let values = $state.raw<Partial<SegmentValues>>({});
	let rpe = $state.raw<number | null | undefined>(undefined);
	let notes = $state<string | null>(null);
	let error = $state<EntryError | null>(null);
	const shown = $derived({ ...given, ...values });

	function save() {
		const failed = entryError(shown);
		if (failed) return void (error = failed);
		const amounts = normalized({
			distanceMetres: null,
			durationSeconds: null,
			avgHr: null,
			...shown
		});
		const corrected = Object.fromEntries(
			AMOUNTS.filter((k) => k in shown).map((k) => [k, amounts[k]])
		);
		const extra = {
			...(rpe !== undefined && { rpe }),
			...(notes !== null && { notes: notes.trim() || null })
		};
		const next = { ...m, payload: { ...m.payload, ...corrected, ...extra } } as typeof m;
		const totals =
			next.type === 'run.segment' && view?.workout.id === next.workoutId
				? totalsMutation(view, next.entityId, normalized(next.payload), new Date().toISOString())
				: null;
		onsave(next, totals ?? undefined);
		open = false;
	}
</script>

<BottomSheet
	bind:open
	title={segment
		? `Fix ${segmentTitle({ kind: segment.kind, repeat: null, repeats: null })}`
		: 'Fix the run'}
	description={segment ? `Segment ${segment.position}` : 'Its totals, effort and notes'}
	data-testid="run-fix"
>
	<p class="fix" data-testid="fix-reason">Not synced · {problem}</p>
	<div class="fields">
		{#if Object.keys(given).length > 0}
			<SegmentFields
				values={shown}
				{unit}
				{error}
				onchange={(change) => ((values = { ...values, ...change }), (error = null))}
			/>
		{/if}
		{#if log && log.rpe !== undefined}
			<RpeChips
				chips={RUN_RPE_CHIPS}
				value={rpe === undefined ? log.rpe : rpe}
				onchange={(v) => (rpe = v)}
			/>
		{/if}
		{#if log && log.notes !== undefined}
			<TextArea
				label="Notes"
				maxlength={500}
				bind:value={() => notes ?? log.notes ?? '', (text) => (notes = text)}
			/>
		{/if}
	</div>

	{#snippet footer()}
		<Button block icon="check" onclick={save} data-testid="save-fix">Save</Button>
	{/snippet}
</BottomSheet>

<style>
	.fix {
		margin-bottom: var(--space-4);
		color: light-dark(color-mix(in srgb, var(--color-warning) 82%, #000), var(--color-warning));
		font-weight: var(--weight-medium);
	}

	.fields {
		display: grid;
		gap: var(--space-4);
	}
</style>
