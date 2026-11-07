<!--
  @component
  Adjust a session's prescription, inside EditSheetHost, which loads it when the sheet opens. One
  sheet of NumberSteppers, shaped by what it adjusts (`values`, adjustValues in session-words.ts):
  - an exercise's set prescription (`exercise`): sets, reps, RPE, load and rest;
  - a run segment: repeats (its whole repeat group's), distance, duration, pace range and RPE;
  - another session (Muay Thai, a class): its length and target RPE.
  An exercise or run with several prescriptions or segments picks one first. Only the values the
  row has get a stepper: Adjust changes values, never what a set is measured in or how its load
  is set. Each stepper stops at its lowest valid value; above, a typed or stepped value is never
  silently changed: Save checks every value with the services' own schema (zod, loaded with the
  sheet) and shows what is out of range on its stepper, announced, before anything is posted.
  The server checks again, the row whole (reps low to high, a load in range for its unit).
-->
<script lang="ts">
	import { applyAction, type ActionResult } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { focusFirstError, post } from '#lib/client/profile-form.ts';
	import {
		convertPace,
		DEFAULT_LOAD_INCREMENT,
		formatDuration,
		parseDuration
	} from '#lib/domain/units.ts';
	import type { FieldErrors } from '#lib/domain/validation.ts';
	import Button from '../components/Button.svelte';
	import ChoiceGroup from '../components/ChoiceGroup.svelte';
	import Notice from '../components/Notice.svelte';
	import NumberStepper from '../components/NumberStepper.svelte';
	import TextArea from '../components/TextArea.svelte';
	import type { AdjustSegment, AdjustSet, AdjustValues } from './session-words';

	interface Props {
		/** The session, by lineage, on the version the screen shows. */
		sessionLineage: string;
		version: number;
		values: AdjustValues;
		/** The planned exercise adjusted, by lineage: a strength session's sheet is about one. */
		exercise?: string;
		/** What the toast names: the exercise, or the session. */
		name: string;
	}

	let { sessionLineage, version, values, exercise, name }: Props = $props();

	const UNREACHABLE = 'Can’t reach the server. Check your connection, then try again.';
	const NOT_SAVED = 'That didn’t save. Try again.';

	/** Where each kind posts, and the schema it is checked with first. */
	const ACTION = { strength: 'adjust', run: 'adjustSegment', other: 'adjustDetails' } as const;
	const SCHEMA = {
		strength: 'adjustSetSchema',
		run: 'adjustRunSegmentSchema',
		other: 'adjustDetailsSchema'
	} as const;

	const checker = Promise.all([
		import('#lib/domain/training/edits.ts'),
		import('#lib/domain/validation.ts')
	]).then(
		([edits, { validate }]) =>
			(value: unknown) =>
				validate(edits[SCHEMA[values.kind]], value)
	);
	checker.catch(() => {});

	/** One stepper: the payload fields it writes (two for reps held equal) and how it steps. */
	interface Field {
		keys: string[];
		label: string;
		min: number;
		step: number;
		bigStep?: number;
		unit?: string;
		hint?: string;
		format?: (value: number) => string;
		parse?: (text: string) => number | null;
	}

	type Row = AdjustSet | AdjustSegment;
	const rows = $derived<Row[]>(
		values.kind === 'strength'
			? (values.exercises[exercise ?? ''] ?? [])
			: values.kind === 'run'
				? values.segments
				: []
	);

	/** The row adjusted: by default a run's first repeated segment, whose repeats change most. */
	let picked = $state<string | null>(null);
	const row = $derived(
		rows.find((r) => String(r.position) === picked) ??
			rows.find((r) => 'repeats' in r && r.repeats !== null) ??
			rows[0]
	);

	const clock = { format: formatDuration, parse: parseDuration };
	const rpe = (min: number): Field => ({
		keys: ['targetRpe'],
		label: 'Target RPE',
		min,
		step: 0.5,
		hint: 'How hard it should feel, 10 the hardest.'
	});

	function setFields(set: AdjustSet): Field[] {
		const fields: Field[] = [{ keys: ['sets'], label: 'Sets', min: 1, step: 1 }];
		if (set.repsMin !== null && set.repsMin === set.repsMax) {
			fields.push({ keys: ['repsMin', 'repsMax'], label: 'Reps', min: 1, step: 1 });
		} else if (set.repsMin !== null) {
			fields.push({ keys: ['repsMin'], label: 'Reps, at least', min: 1, step: 1 });
			fields.push({ keys: ['repsMax'], label: 'Reps, at most', min: 1, step: 1 });
		}
		if (set.targetRpe !== null) fields.push(rpe(5));
		const load = set.load;
		if (load?.unit === '%') {
			fields.push({
				keys: ['loadValue'],
				label: 'Load',
				unit: '% of 1RM',
				min: 0.01,
				step: 0.01,
				bigStep: 0.05,
				format: (v) => String(Math.round(v * 1000) / 10),
				parse: (text) => Number(text.replace(',', '.')) / 100
			});
		} else if (load) {
			const step = DEFAULT_LOAD_INCREMENT[load.unit];
			fields.push({ keys: ['loadValue'], label: 'Load', unit: load.unit, min: step, step });
		}
		if (set.restSeconds !== null) {
			fields.push({
				keys: ['restSeconds'],
				label: 'Rest',
				min: 0,
				step: 15,
				bigStep: 60,
				...clock
			});
		}
		return fields;
	}

	function segmentFields(s: AdjustSegment, unit: 'km' | 'mi'): Field[] {
		const fields: Field[] = [];
		if (s.repeats !== null) {
			const hint = 'Every segment of the repeat group runs this many times.';
			fields.push({ keys: ['repeats'], label: 'Repeats', min: 2, step: 1, hint });
		}
		if (s.distanceMetres !== null) {
			const step = s.distanceMetres < 1000 ? 50 : 100;
			fields.push({ keys: ['distanceMetres'], label: 'Distance', unit: 'm', min: step, step });
		}
		if (s.durationSeconds !== null) {
			const step = s.durationSeconds < 600 ? 15 : 60;
			fields.push({ keys: ['durationSeconds'], label: 'Duration', min: step, step, ...clock });
		}
		// Paces are kept per km and shown per the owner's unit.
		const pace = {
			min: 120,
			step: 5,
			unit: `/${unit}`,
			format: (v: number) => formatDuration(convertPace(v, 'km', unit)),
			parse: (text: string) => {
				const seconds = parseDuration(text);
				return seconds === null ? null : Math.round(convertPace(seconds, unit, 'km'));
			}
		};
		if (s.paceMinSecondsPerKm !== null) {
			fields.push({ keys: ['paceMinSecondsPerKm'], label: 'Pace, fastest', ...pace });
		}
		if (s.paceMaxSecondsPerKm !== null) {
			fields.push({ keys: ['paceMaxSecondsPerKm'], label: 'Pace, slowest', ...pace });
		}
		if (s.targetRpe !== null) fields.push(rpe(1));
		return fields;
	}

	const fields = $derived.by((): Field[] => {
		if (values.kind === 'other') {
			const length: Field = {
				keys: ['durationMinutes'],
				label: 'Duration',
				unit: 'min',
				min: 10,
				step: 5,
				bigStep: 15
			};
			return values.targetRpe === null ? [length] : [length, rpe(1)];
		}
		if (!row) return [];
		return values.kind === 'run'
			? segmentFields(row as AdjustSegment, values.paceUnit)
			: setFields(row as AdjustSet);
	});

	/** The row's values as posted: each field's keys, from the row as stored. */
	function initial(): Record<string, number> {
		const source: Record<string, unknown> =
			values.kind === 'other'
				? values
				: values.kind === 'strength'
					? { ...row, loadValue: (row as AdjustSet | undefined)?.load?.value }
					: { ...row };
		const out: Record<string, number> = {};
		for (const key of fields.flatMap((f) => f.keys)) out[key] = source[key] as number;
		return out;
	}

	/** The values as stepped: the row's stored ones until changed, and again on another row. */
	let draft = $derived<Record<string, number>>(initial());
	let reason = $state<string | null>('');
	let errors = $state<FieldErrors>({});
	let failure = $state<string | null>(null);
	/** The page's version is no longer the current one: nothing can be saved from it. */
	let conflict = $state(false);
	let reloading = $state(false);
	let form = $state<HTMLElement>();

	/** Another row: its stored values, with nothing to fix. */
	function pick(position: string | null) {
		picked = position;
		errors = {};
		failure = null;
	}

	function payload() {
		const target =
			values.kind === 'strength'
				? { plannedExerciseLineage: exercise, position: row?.position }
				: values.kind === 'run'
					? { position: row?.position }
					: {};
		return { sessionLineage, ...target, ...draft, reason: reason?.trim() || undefined };
	}

	/** After a refused Save, each change checks again, so a fixed value loses its error. */
	async function recheck() {
		if (!Object.keys(errors).length) return;
		const checked = (await checker.catch(() => null))?.(payload());
		errors = checked && !checked.ok ? checked.errors : {};
	}

	const errorOf = (field: Field) => field.keys.map((k) => errors[k]).find(Boolean) ?? null;

	/** EditSheetHost's Save: validate, then post the adjustment with the version shown. */
	export async function submit(): Promise<string | null> {
		failure = null;
		const adjustment = payload();
		const checked = (await checker.catch(() => null))?.(adjustment);
		if (checked && !checked.ok) {
			errors = checked.errors;
			focusFirstError(form);
			return null;
		}
		errors = {};
		let result: ActionResult;
		try {
			result = await post(`?/${ACTION[values.kind]}`, { ...adjustment, version });
		} catch {
			failure = UNREACHABLE;
			return null;
		}
		if (result.type === 'success') {
			return `Adjusted ${name} · version ${(result.data as { version: number }).version}`;
		}
		if (result.type === 'failure') {
			const data = result.data;
			const found = (data?.errors ?? {}) as FieldErrors;
			if (data?.reason === 'version') conflict = true;
			else if (Object.keys(found).length) {
				errors = found;
				failure = found.sessionLineage ?? found.position ?? found[''] ?? null;
				focusFirstError(form);
			} else failure = typeof data?.message === 'string' ? data.message : NOT_SAVED;
		} else await applyAction(result);
		return null;
	}

	async function reload() {
		reloading = true;
		await invalidateAll();
		reloading = false;
		conflict = false;
	}
</script>

<div class="adjust" bind:this={form} data-testid="adjust-form">
	{#if rows.length > 1}
		<ChoiceGroup
			legend={values.kind === 'run' ? 'Segment' : 'Prescription'}
			variant="card"
			options={rows.map((r) => ({ value: String(r.position), label: r.label }))}
			bind:value={() => (row ? String(row.position) : null), pick}
			data-testid="adjust-rows"
		/>
	{/if}

	<div class="steppers">
		{#each fields as field (field.keys[0])}
			<NumberStepper
				label={field.label}
				bind:value={
					() => draft[field.keys[0]!] ?? 0,
					(v) => (draft = { ...draft, ...Object.fromEntries(field.keys.map((k) => [k, v])) })
				}
				min={field.min}
				step={field.step}
				bigStep={field.bigStep}
				unit={field.unit}
				hint={field.hint}
				format={field.format}
				parse={field.parse}
				error={errorOf(field)}
				onchange={recheck}
				data-testid={`adjust-${field.keys[0]}`}
			/>
		{/each}
	</div>

	<TextArea
		label="Reason"
		optional
		bind:value={reason}
		error={errors.reason}
		hint="Kept with the change, so you can see later why it changed."
		placeholder="Feeling strong, short on time…"
		maxlength={200}
		rows={2}
		data-testid="adjust-reason"
	/>

	{#if conflict}
		<Notice tone="warning" title="Your plan changed" data-testid="adjust-conflict">
			It changed after you opened this session, so nothing was adjusted. Reload to see the latest,
			then adjust it again.
			<div class="reload">
				<Button variant="secondary" size="sm" loading={reloading} onclick={reload}>Reload</Button>
			</div>
		</Notice>
	{/if}
	{#if failure}<Notice tone="danger" data-testid="adjust-failure">{failure}</Notice>{/if}
</div>

<style>
	.adjust {
		display: grid;
		gap: var(--space-5);
		padding-bottom: var(--space-2);
	}

	/* The steppers on one quiet panel, rules between them, as Profile → Schedule lays them out. */
	.steppers {
		display: grid;
		gap: var(--space-4);
		padding: var(--space-4);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-surface-2);
	}
</style>
