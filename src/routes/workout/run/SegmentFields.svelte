<!--
  @component
  A segment's (or a run's) distance, time and heart rate, as the run view's entry and its Fix
  editor ask for them: the distance in the owner's unit, nudged in hundredths or typed; the time nudged
  or typed as mm:ss (or h:mm:ss), to the second; the heart rate optional, blank meaning none;
  and the pace, worked out as either is typed, before it commits. Only the values given are
  shown, so a run.log's Fix asks for just what it carries. Steppers take the arrow keys, PageUp
  and PageDown; 0 leaves a value out.
-->
<script lang="ts">
	import type { ProfileDistanceUnit } from '#lib/domain/profile/types.ts';
	import { formatDuration, parseDuration } from '#lib/domain/units.ts';
	import NumberField from '#lib/ui/components/NumberField.svelte';
	import NumberStepper from '#lib/ui/components/NumberStepper.svelte';
	import { parseTime } from '#lib/ui/workout/set-input.ts';
	import { ENTRY_ERRORS, inUnit, paceOf, toStoredMetres } from './run-log.ts';
	import type { EntryError, SegmentValues } from './run-log.ts';

	interface Props {
		values: Partial<SegmentValues>;
		unit: ProfileDistanceUnit;
		error?: EntryError | null;
		onchange: (change: Partial<SegmentValues>) => void;
	}

	let { values, unit, error = null, onchange }: Props = $props();

	// What is being typed, ahead of its commit, so the pace follows each keystroke.
	let drafts = $state.raw<Partial<SegmentValues>>({});
	const pace = $derived(paceOf({ ...values, ...drafts }, unit));
	/** A field's typed value ahead of its commit; undefined drops it. */
	function draft(key: 'distanceMetres' | 'durationSeconds', value: number | null | undefined) {
		const next = { ...drafts };
		if (value === undefined) delete next[key];
		else next[key] = value;
		drafts = next;
	}
	const metres = (v: number) => (v > 0 ? toStoredMetres(v, unit) : null);
	// A phone's decimal keypad has no colon: '1.32' reads as 1:32, and '92' as 92 seconds.
	const clock = (text: string) => parseDuration(text.replaceAll('.', ':')) ?? parseTime(text);
	const amountError = $derived(error === 'amount' ? ENTRY_ERRORS.amount : null);
</script>

<div class="fields" onfocusout={() => (drafts = {})}>
	{#if 'distanceMetres' in values}
		<NumberStepper
			label="Distance"
			value={values.distanceMetres ? inUnit(values.distanceMetres, unit) : 0}
			step={0.01}
			bigStep={0.1}
			max={unit === 'km' ? 500 : 310}
			{unit}
			error={amountError}
			ondraft={(v) => draft('distanceMetres', v === null ? undefined : metres(v))}
			onchange={(v) => {
				draft('distanceMetres', undefined);
				onchange({ distanceMetres: metres(v) });
			}}
			data-testid="segment-distance"
		/>
	{/if}
	{#if 'durationSeconds' in values}
		<NumberStepper
			label="Time"
			value={values.durationSeconds ?? 0}
			step={1}
			bigStep={60}
			max={86_400}
			hint="Type it as mm:ss"
			error={amountError}
			format={formatDuration}
			parse={clock}
			ondraft={(v) => draft('durationSeconds', v === null ? undefined : v || null)}
			onchange={(v) => {
				draft('durationSeconds', undefined);
				onchange({ durationSeconds: v || null });
			}}
			data-testid="segment-time"
		/>
	{/if}
	{#if 'distanceMetres' in values && 'durationSeconds' in values}
		<p class="pace" data-testid="segment-pace">
			<span class="label">Pace</span>
			<output class="tabular" aria-live="polite">{pace ?? '—'}</output>
		</p>
	{/if}
	{#if 'avgHr' in values}
		<NumberField
			label="Average heart rate"
			value={values.avgHr ?? null}
			unit="bpm"
			integer
			optional
			error={error === 'heart-rate' ? ENTRY_ERRORS['heart-rate'] : null}
			oninput={(avgHr) => onchange({ avgHr })}
			data-testid="segment-hr"
		/>
	{/if}
</div>

<style>
	.fields {
		display: grid;
		gap: var(--space-4);
	}

	.pace {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-running) 10%, var(--color-surface-2));
	}

	.label {
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	output {
		font-family: var(--font-numeric);
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
	}
</style>
