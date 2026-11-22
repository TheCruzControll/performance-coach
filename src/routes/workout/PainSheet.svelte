<!--
  @component
  This hurts (PRD §7; substitution.ts painChoices, copy.ts PAIN_COPY), in a BottomSheet (a centred
  dialog from 1024 px), loaded when the quick actions' 'This hurts' is tapped, over that sheet.
  - What to do comes first, in order, so Stop is in reach mid-set: Stop this exercise; then the
    kit's gentler options for the chosen area (or why there are none); and End the workout here
    when it is severe.
  - Under them, folded into 'Add details (optional)': where it hurts (which brings the gentler
    options), how bad it is (severe brings End the workout here) and a short note. A choice hands
    back itself and the details (`onreport`); the actions sheet sends them (actions.ts
    reportPain). Nothing needs the network.
  - Last: Profile → Injuries for a lasting problem, and a professional for sharp or
    persisting pain. The words never suggest carrying on through pain and name no diagnosis.
  - Fix (fix/pain.ts) opens it on a refused pain.report, `m`: the refused details, unfolded, with
    the server's errors in place, and Save instead of the choices and the fold; it hands back the
    report with the corrected details under the same id (actions.ts correctedReport).
  Its props are the Fix registry's (FixEditorProps), with `position` and `onreport` for the flow.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { BODY_AREA_LABEL, BODY_AREAS, SEVERITIES } from '#lib/domain/profile/catalog.ts';
	import type { BodyArea, Severity } from '#lib/domain/profile/catalog.ts';
	import type { FieldErrors } from '#lib/domain/validation.ts';
	import { gentlerHeading, noGentler, PAIN_COPY, SEVERITY_COPY } from '#lib/domain/workout/copy.ts';
	import type { Mutation, WorkoutView } from '#lib/domain/workout/index.ts';
	import { slotAt } from '#lib/domain/workout/selectors.ts';
	import { painChoices } from '#lib/domain/workout/substitution.ts';
	import type { PainChoice } from '#lib/domain/workout/substitution.ts';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import ChoiceGroup from '#lib/ui/components/ChoiceGroup.svelte';
	import TextArea from '#lib/ui/components/TextArea.svelte';
	import { untrack } from 'svelte';
	import { correctedReport } from './actions.ts';
	import type { PainDetails } from './actions.ts';
	import AlternativeList from './AlternativeList.svelte';

	interface Props {
		open: boolean;
		view: WorkoutView | null;
		/** The flow: the slot that hurts, and where the choice goes. */
		position?: number;
		onreport?: (choice: PainChoice, details: PainDetails) => void;
		/** Fix: the refused report, why, the server's errors and where the correction goes. */
		m?: Mutation;
		problem?: string;
		errors?: FieldErrors;
		onsave?: (next: Mutation) => void;
	}

	let {
		open = $bindable(),
		view,
		position,
		onreport,
		m,
		problem,
		errors,
		onsave
	}: Props = $props();

	/** The server's note limit (pain.report's payload.note). */
	const NOTE_MAX = 500;
	/** Stands for none in the area and severity choices. */
	const UNSURE = 'unsure';
	type Unsure = typeof UNSURE;

	const refused = $derived(m?.type === 'pain.report' ? m : null);
	const slot = $derived(view && slotAt(view, refused?.payload.position ?? position ?? 0));
	const name = $derived(
		(view && view.exercises[refused?.payload.exerciseId ?? slot?.exerciseId ?? '']?.name) ??
			'Exercise'
	);

	// Each time it opens: empty for the flow, the refused report's for Fix.
	let area = $state<BodyArea | Unsure | null>(null);
	let severity = $state<Severity | Unsure | null>(null);
	let note = $state('');
	/** Whether 'Add details (optional)' is unfolded; Fix always shows the details. */
	let more = $state(false);
	$effect.pre(() => {
		if (!open) return;
		untrack(() => {
			area = refused?.payload.area ?? null;
			severity = refused?.payload.severity ?? null;
			note = refused?.payload.note ?? '';
			more = false;
		});
	});

	const unsure = <T extends string>(value: T | Unsure | null): T | null =>
		value === UNSURE ? null : value;
	const details = (): PainDetails => ({
		area: unsure(area),
		severity: unsure(severity),
		note: note || null
	});
	const chosenArea = $derived(unsure(area));
	const choices = $derived(slot ? painChoices(slot, chosenArea, unsure(severity)) : []);
	const gentler = $derived(choices.flatMap((c) => (c.action === 'substituted' ? [c.option] : [])));
	const ends = $derived(choices.some((c) => c.action === 'ended_workout'));

	const areas = [
		...BODY_AREAS.map((a) => ({ value: a, label: BODY_AREA_LABEL[a] })),
		{ value: UNSURE, label: PAIN_COPY.unsure }
	];
	const severities = [
		...SEVERITIES.map((s) => ({
			value: s,
			label: SEVERITY_COPY[s].label,
			hint: SEVERITY_COPY[s].detail
		})),
		{ value: UNSURE, label: PAIN_COPY.unsure }
	];
	const fieldError = (field: keyof PainDetails) => errors?.[`payload.${field}`] ?? null;

	function choose(choice: PainChoice) {
		open = false;
		onreport?.(choice, details());
	}

	function save() {
		if (!refused) return;
		open = false;
		onsave?.(correctedReport(refused, details()));
	}
</script>

{#snippet entry(words: { label: string; detail: string }, onclick: () => void, testid: string)}
	<button
		type="button"
		class="entry"
		class:end={testid === 'pain-end'}
		{onclick}
		data-testid={testid}
	>
		<span class="label">{words.label}</span>
		<span class="detail">{words.detail}</span>
	</button>
{/snippet}

<BottomSheet
	bind:open
	title={refused ? PAIN_COPY.fixTitle : PAIN_COPY.title}
	description={name}
	data-testid="pain-sheet"
>
	<div class="body">
		{#if problem}
			<p class="error" role="alert" data-testid="pain-error">Not synced · {problem}</p>
		{:else}
			<p class="intro">{PAIN_COPY.intro}</p>
		{/if}
		{#if !refused}
			<section class="choices" aria-labelledby="pain-choices">
				<h3 id="pain-choices" class="heading">{PAIN_COPY.choices}</h3>
				{@render entry(PAIN_COPY.stop, () => choose({ action: 'stopped' }), 'pain-stop')}
				{#if chosenArea}
					<h4 class="heading" data-testid="pain-gentler-heading">{gentlerHeading(chosenArea)}</h4>
					{#if gentler.length > 0}
						<AlternativeList
							alternatives={gentler}
							blocked={[]}
							onchoose={(option) => choose({ action: 'substituted', option })}
						/>
					{:else}
						<p class="detail" data-testid="pain-no-gentler">{noGentler(chosenArea)}</p>
					{/if}
				{/if}
				{#if ends}
					{@render entry(PAIN_COPY.end, () => choose({ action: 'ended_workout' }), 'pain-end')}
				{/if}
			</section>
			<Button
				variant="ghost"
				iconEnd="chevron-down"
				aria-expanded={more}
				aria-controls={more ? 'pain-details' : undefined}
				onclick={() => (more = !more)}
				data-testid="pain-details-toggle"
			>
				Add details (optional)
			</Button>
		{/if}

		{#if refused || more}
			<div class="details" id="pain-details">
				<ChoiceGroup
					legend={PAIN_COPY.area.label}
					bind:value={area}
					error={fieldError('area')}
					options={areas}
					data-testid="pain-area"
				/>
				<ChoiceGroup
					legend={PAIN_COPY.severity.label}
					variant="card"
					bind:value={severity}
					error={fieldError('severity')}
					options={severities}
					data-testid="pain-severity"
				/>
				<TextArea
					label={PAIN_COPY.note.label}
					bind:value={note}
					error={fieldError('note')}
					rows={2}
					placeholder={PAIN_COPY.note.placeholder}
					maxlength={NOTE_MAX}
					data-testid="pain-note"
				/>
			</div>
		{/if}

		{#if refused}
			<Button block icon="check" onclick={save} data-testid="pain-save">{PAIN_COPY.save}</Button>
		{/if}

		<div class="care" data-testid="pain-care">
			<p>{PAIN_COPY.professional}</p>
			<p>
				{PAIN_COPY.injuries.text}
				<a
					href={resolve('/(app)/profile/[section]', { section: 'injuries' })}
					data-testid="pain-injuries"
				>
					{PAIN_COPY.injuries.link}
				</a>
			</p>
		</div>
	</div>
</BottomSheet>

<style>
	.body,
	.choices,
	.details {
		display: grid;
		gap: var(--space-4);
	}

	/* The details' fold, its chevron turned while open. */
	.body > :global([aria-expanded]) {
		justify-self: start;
	}

	.body > :global([aria-expanded='true'] svg) {
		transform: rotate(180deg);
	}

	.choices {
		gap: var(--space-2);
	}

	.intro,
	.care p {
		line-height: var(--leading-normal);
	}

	.intro,
	.detail,
	.care {
		color: var(--color-text-secondary);
	}

	.heading {
		margin: var(--space-2) 0 0;
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		color: var(--color-text-secondary);
	}

	.error {
		color: var(--color-danger);
		font-weight: var(--weight-medium);
	}

	.entry {
		display: grid;
		gap: var(--space-0-5);
		width: 100%;
		min-height: 56px;
		padding: var(--space-3);
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		background: var(--color-surface-2);
		color: var(--color-text);
		font: inherit;
		text-align: start;
		cursor: pointer;
		transition:
			border-color var(--duration-fast) var(--ease-standard),
			background-color var(--duration-fast) var(--ease-standard);
	}

	.entry:active {
		background: var(--color-surface-3);
	}

	.entry:focus-visible,
	.care a:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	.end {
		border-color: var(--color-border-strong);
	}

	@media (hover: hover) and (pointer: fine) {
		.entry:hover {
			border-color: var(--color-border-strong);
			background: var(--color-surface-3);
		}
	}

	.label {
		font-weight: var(--weight-semibold);
	}

	.detail {
		font-size: var(--text-sm);
	}

	.care {
		display: grid;
		gap: var(--space-2);
		padding-top: var(--space-3);
		border-top: 1px solid var(--color-border);
		font-size: var(--text-sm);
	}

	.care a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--color-accent-text);
		font-weight: var(--weight-semibold);
	}

	@media (hover: hover) and (pointer: fine) {
		.care a:hover {
			color: var(--color-accent-hover);
		}
	}
</style>
