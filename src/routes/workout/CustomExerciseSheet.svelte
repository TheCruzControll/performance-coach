<!--
  @component
  Add my own exercise (PRD §7; custom-exercise.ts says what is asked and what defaults), in a
  BottomSheet (a centred dialog from 1024 px), loaded when the picker's or the nothing-fits
  state's 'Add my own exercise' is tapped, never before.
  - The name, how it is measured and how it is loaded; a time-measured exercise's bout or hold;
    the movement pattern (prefilled from the exercise being replaced); then, behind a disclosure
    that names what they are now, the main muscles (from the pattern) and its equipment.
  - Save checks it here first, the name against the cached library (`exercises`), so a clash
    shows before anything is sent; it then hands back exercise.create's payload (`oncreate`), and
    the caller adds it to the session or swaps to it in one dispatch.
  - Fix (fix/exercises.ts) opens it on a refused exercise.create, `m`: its values, the server's
    errors in place, and Save hands back the same change under its id with the new values.
  Native inputs throughout: Tab, arrows and Space work, every control is 44 px or more, with
  hover and :focus-visible states.
-->
<script lang="ts">
	import { EQUIPMENT, EQUIPMENT_LABEL } from '#lib/domain/profile/catalog.ts';
	import type { CustomExercise } from '#lib/domain/training/types.ts';
	import {
		LOAD_TYPE_LABEL,
		LOAD_TYPES,
		MEASURE_LABEL,
		MEASURES,
		MOVEMENT_PATTERN_LABEL,
		MOVEMENT_PATTERNS,
		MUSCLE_LABEL,
		MUSCLES
	} from '#lib/domain/training/vocabulary.ts';
	import type { FieldErrors } from '#lib/domain/validation.ts';
	import type { LibraryExercise, Mutation } from '#lib/domain/workout/index.ts';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import ChoiceGroup from '#lib/ui/components/ChoiceGroup.svelte';
	import NumberField from '#lib/ui/components/NumberField.svelte';
	import TextField from '#lib/ui/components/TextField.svelte';
	import { untrack } from 'svelte';
	import {
		checkDraft,
		draftFor,
		draftOf,
		NAME_MAX,
		PATTERN_MUSCLES,
		type DraftField,
		type Replaced
	} from './custom-exercise.ts';

	interface Props {
		open: boolean;
		/** The cached library, for the name check; none in Fix, where the server checks it. */
		exercises?: readonly LibraryExercise[];
		/** The flow: what the name starts as, the exercise being replaced, where the payload goes. */
		name?: string;
		replaced?: (Replaced & { name: string }) | null;
		oncreate?: (exercise: CustomExercise) => void;
		/** Fix: the refused exercise.create, why, the server's errors and where the change goes. */
		m?: Mutation;
		problem?: string;
		errors?: FieldErrors;
		onsave?: (next: Mutation) => void;
	}

	let {
		open = $bindable(),
		exercises = [],
		name = '',
		replaced = null,
		oncreate,
		m,
		problem,
		errors: refusedErrors,
		onsave
	}: Props = $props();

	const refused = $derived(m?.type === 'exercise.create' ? m : null);
	const options = <K extends string>(keys: readonly K[], labels: Record<K, string>) =>
		keys.map((value) => ({ value, label: labels[value] }));

	// Each time it opens: the flow's defaults, or the refused exercise's values.
	let draft = $state(draftFor(null));
	let errors = $state<Partial<Record<DraftField, string>>>({});
	let musclesTouched = false;
	let more = $state(false);
	$effect.pre(() => {
		if (!open) return;
		untrack(() => {
			draft = refused ? draftOf(refused.payload) : { ...draftFor(replaced), name };
			const server = refusedErrors ?? {};
			errors = Object.fromEntries(
				Object.entries(server).flatMap(([path, text]) =>
					path.startsWith('payload.') ? [[path.slice(8).split('.')[0], text]] : []
				)
			);
			musclesTouched = Boolean(refused);
			more = Boolean(errors.primaryMuscles || errors.equipment);
		});
	});

	/** A new pattern brings its muscles, until the owner picks their own. */
	function patternChanged() {
		if (draft.pattern && !musclesTouched) draft.muscles = [...PATTERN_MUSCLES[draft.pattern]];
		errors.pattern = undefined;
	}

	function musclesChanged() {
		musclesTouched = true;
		errors.primaryMuscles = undefined;
	}

	const summary = $derived(
		[
			draft.muscles.map((m) => MUSCLE_LABEL[m]).join(', ') || 'No muscles yet',
			draft.equipment.map((e) => EQUIPMENT_LABEL[e]).join(', ') || 'No equipment'
		].join(' · ')
	);

	function save() {
		const checked = checkDraft(draft, exercises, {
			base: refused?.payload,
			except: refused?.entityId
		});
		if (!checked.ok) {
			errors = checked.errors;
			if (errors.primaryMuscles || errors.equipment) more = true;
			return;
		}
		open = false;
		if (refused) onsave?.({ ...refused, payload: checked.exercise });
		else oncreate?.(checked.exercise);
	}
</script>

<BottomSheet
	bind:open
	title={refused ? 'Fix your exercise' : 'Add my own exercise'}
	description={refused
		? 'Rename it, or change what it is. Its sets stay with it.'
		: replaced
			? `It replaces ${replaced.name} for this session, and joins your exercises.`
			: 'It joins your exercises and this session, offline too.'}
	data-testid="custom-exercise"
>
	<form
		class="body"
		novalidate
		onsubmit={(event) => {
			event.preventDefault();
			save();
		}}
	>
		{#if problem}
			<p class="error" role="alert" data-testid="custom-exercise-problem">Not synced · {problem}</p>
		{/if}
		<TextField
			label="Name"
			bind:value={draft.name}
			error={errors.name}
			maxlength={NAME_MAX}
			autocomplete="off"
			autocapitalize="sentences"
			enterkeyhint="done"
			oninput={() => (errors.name = undefined)}
			data-testid="custom-name"
		/>
		<ChoiceGroup
			legend="Measured in"
			bind:value={draft.measure}
			error={errors.measure}
			options={options(MEASURES, MEASURE_LABEL)}
			onchange={() => (errors.measure = errors.defaultSeconds = undefined)}
			data-testid="custom-measure"
		/>
		{#if draft.measure === 'time'}
			<NumberField
				label="One bout or hold"
				unit="s"
				integer
				bind:value={draft.seconds}
				error={errors.defaultSeconds}
				hint="What a set of it starts from"
				data-testid="custom-seconds"
			/>
		{/if}
		<ChoiceGroup
			legend="Load"
			bind:value={draft.loadType}
			error={errors.loadType}
			options={options(LOAD_TYPES, LOAD_TYPE_LABEL)}
			onchange={() => (errors.loadType = undefined)}
			data-testid="custom-load"
		/>
		<ChoiceGroup
			legend="Movement"
			bind:value={draft.pattern}
			error={errors.pattern}
			options={options(MOVEMENT_PATTERNS, MOVEMENT_PATTERN_LABEL)}
			onchange={patternChanged}
			data-testid="custom-pattern"
		/>
		<div class="more">
			<Button
				variant="ghost"
				iconEnd="chevron-down"
				aria-expanded={more}
				aria-controls={more ? 'custom-more' : undefined}
				onclick={() => (more = !more)}
				data-testid="custom-more-toggle"
			>
				Muscles and equipment
			</Button>
			{#if !more}<p class="summary" data-testid="custom-summary">{summary}</p>{/if}
		</div>
		{#if more}
			<div class="details" id="custom-more">
				<ChoiceGroup
					legend="Main muscles"
					multiple
					bind:values={draft.muscles}
					error={errors.primaryMuscles}
					options={options(MUSCLES, MUSCLE_LABEL)}
					onchange={musclesChanged}
					data-testid="custom-muscles"
				/>
				<ChoiceGroup
					legend="Equipment it needs"
					hint="Optional"
					multiple
					bind:values={draft.equipment}
					error={errors.equipment}
					options={options(EQUIPMENT, EQUIPMENT_LABEL)}
					data-testid="custom-equipment"
				/>
			</div>
		{/if}
		<Button type="submit" block icon="check" data-testid="custom-save">
			{refused ? 'Save' : replaced ? 'Use it instead' : 'Add it'}
		</Button>
	</form>
</BottomSheet>

<style>
	.body,
	.details {
		display: grid;
		gap: var(--space-4);
	}

	.more {
		display: grid;
		gap: var(--space-1);
		justify-items: start;
		margin: calc(-1 * var(--space-2)) 0;
	}

	.more :global([aria-expanded='true'] svg) {
		transform: rotate(180deg);
	}

	.summary {
		padding-inline: var(--space-3);
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
		overflow-wrap: anywhere;
	}

	.error {
		color: var(--color-danger);
		font-weight: var(--weight-medium);
	}
</style>
