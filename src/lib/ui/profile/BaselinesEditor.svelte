<!--
  @component
  Strength baselines — every one optional (PRD §3). "I don't know my 1RMs" is a first-class
  answer: week one establishes them with RPE-based sets. A known max is either measured
  (tested, competition) or estimated (from a recent set, or a best guess) and the two are never
  mixed: the server derives the kind from the source, and an estimate from a set is computed
  with the same e1RM function shown live here.
-->
<script lang="ts">
	import { estimateOneRepMax } from '#lib/domain/e1rm.ts';
	import {
		BASELINE_SOURCES,
		BASELINE_SOURCE_KIND,
		BASELINE_SOURCE_LABEL,
		LIFT_LABEL,
		type Lift
	} from '#lib/domain/profile/catalog.ts';
	import type { FieldErrors } from '#lib/domain/profile/schemas.ts';
	import type { WeightUnit } from '#lib/domain/units.ts';
	import ChoiceGroup from '../components/ChoiceGroup.svelte';
	import Icon from '../components/Icon.svelte';
	import IconButton from '../components/IconButton.svelte';
	import Notice from '../components/Notice.svelte';
	import NumberField from '../components/NumberField.svelte';
	import TextField from '../components/TextField.svelte';
	import Toggle from '../components/Toggle.svelte';
	import { liftName, trim, type LiftDraft } from './forms';

	interface Props {
		value: { unknown: boolean; lifts: LiftDraft[] };
		suggested: Lift[];
		unit: WeightUnit;
		errors?: FieldErrors;
	}

	let { value = $bindable(), suggested, unit, errors = {} }: Props = $props();

	const sources = BASELINE_SOURCES.map((s) => ({ value: s, label: BASELINE_SOURCE_LABEL[s] }));
	const addable = $derived(
		[...suggested.filter((l) => !value.lifts.some((x) => x.lift === l)), 'custom' as const].map(
			(l) => ({ value: l, label: l === 'custom' ? 'Other lift…' : LIFT_LABEL[l] })
		)
	);

	let adding = $state<Lift | null>(null);
	function add() {
		if (!adding) return;
		value.lifts.push({
			lift: adding,
			customLabel: null,
			source: 'tested',
			value: null,
			unit,
			achievedOn: null,
			setWeight: null,
			setReps: null,
			setRpe: null,
			notes: null
		});
		adding = null;
	}

	function estimate(lift: LiftDraft) {
		if (lift.source !== 'set' || !lift.setWeight || !lift.setReps) return null;
		return estimateOneRepMax({ weight: lift.setWeight, reps: lift.setReps, rpe: lift.setRpe });
	}

	const err = (i: number, field: string) => errors[`lifts.${i}.${field}`];
</script>

<div class="baselines">
	<div class="unknown" class:on={value.unknown}>
		<Toggle
			label="I don’t know my 1RMs"
			description="Totally fine — most people don’t, and you never have to test one."
			bind:checked={value.unknown}
			data-testid="baselines-unknown"
		/>
		{#if value.unknown}
			<div class="explain" data-testid="baselines-explainer">
				<p class="explain-title"><Icon name="bolt" size={18} /> Week one finds your numbers</p>
				<ol class="explain-steps">
					<li>Your coach sets manageable working sets — no maxing out.</li>
					<li>You log weight, reps and how hard it felt (RPE, 1–10).</li>
					<li>Those sets estimate your strength and set your working weights and progression.</li>
				</ol>
				<p class="explain-note">
					Week one is a baseline week: loading stays conservative until the data is in.
				</p>
			</div>
		{/if}
	</div>

	{#if !value.unknown}
		<p class="lede">
			Add only what you know. Every lift can stay blank — the coach treats an estimate as an
			estimate, never as a tested max.
		</p>
		{#each value.lifts as lift, i (`${lift.lift}:${i}`)}
			{@const e1rm = estimate(lift)}
			<section class="lift" aria-labelledby={`lift-${i}`} data-testid="baseline-lift">
				<header class="head">
					<h2 class="name" id={`lift-${i}`}>{liftName(lift)}</h2>
					<span class="kind" data-kind={BASELINE_SOURCE_KIND[lift.source]}
						>{BASELINE_SOURCE_KIND[lift.source] === 'measured' ? 'Measured' : 'Estimated'}</span
					>
					<IconButton
						icon="close"
						size="sm"
						label={`Remove ${liftName(lift)}`}
						onclick={() => value.lifts.splice(i, 1)}
					/>
				</header>
				{#if lift.lift === 'custom'}
					<TextField
						label="Lift"
						value={lift.customLabel ?? ''}
						oninput={(e) => (lift.customLabel = e.currentTarget.value)}
						error={err(i, 'customLabel')}
						maxlength={40}
					/>
				{/if}
				<ChoiceGroup legend="How do you know it?" bind:value={lift.source} options={sources} />
				{#if lift.source === 'set'}
					<div class="trio">
						<NumberField
							label="Weight"
							{unit}
							bind:value={lift.setWeight}
							error={err(i, 'setWeight')}
						/>
						<NumberField label="Reps" integer bind:value={lift.setReps} error={err(i, 'setReps')} />
						<NumberField
							label="RPE"
							bind:value={lift.setRpe}
							error={err(i, 'setRpe')}
							placeholder="8"
						/>
					</div>
					<p class="estimate" aria-live="polite">
						{#if e1rm}
							≈ <strong class="numeric">{trim(e1rm.value)} {unit}</strong> estimated 1RM ·
							{e1rm.confidence} confidence
						{:else}
							Enter a recent set — RPE is how hard it felt (10 = nothing left).
						{/if}
					</p>
				{:else}
					<div class="pair">
						<NumberField label="1RM" {unit} bind:value={lift.value} error={err(i, 'value')} />
						<TextField
							label="When"
							type="date"
							value={lift.achievedOn ?? ''}
							oninput={(e) => (lift.achievedOn = e.currentTarget.value || null)}
							error={err(i, 'achievedOn')}
							hint="Optional"
						/>
					</div>
				{/if}
			</section>
		{/each}

		{#if errors.lifts}<Notice tone="danger">{errors.lifts}</Notice>{/if}

		<ChoiceGroup
			legend={value.lifts.length ? 'Add another lift' : 'Add a lift you know'}
			bind:value={adding}
			onchange={add}
			options={addable}
			data-testid="baseline-add"
		/>
	{/if}
</div>

<style>
	.baselines {
		display: grid;
		gap: var(--space-4);
	}

	.unknown {
		display: grid;
		gap: var(--space-4);
		padding: var(--space-4);
		border-radius: var(--radius-xl);
		border: 1px solid var(--color-border);
		background: var(--color-surface-1);
		box-shadow: var(--elevation-1);
		transition: border-color var(--duration-base) var(--ease-standard);
	}

	.unknown.on {
		border-color: color-mix(in srgb, var(--color-accent) 45%, var(--color-border));
	}

	.explain {
		display: grid;
		gap: var(--space-3);
		padding-top: var(--space-4);
		border-top: 1px solid var(--color-hairline);
	}

	.explain-title {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-weight: var(--weight-semibold);
		color: var(--color-accent-text);
	}

	.explain-steps {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding-left: var(--space-5);
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
	}

	.explain-note,
	.lede,
	.estimate {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.estimate strong {
		color: var(--color-text);
	}

	.lift {
		display: grid;
		gap: var(--space-4);
		padding: var(--space-4);
		border-radius: var(--radius-xl);
		border: 1px solid var(--color-border);
		background: var(--color-surface-1);
	}

	.head {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin: calc(-1 * var(--space-1)) calc(-1 * var(--space-2)) 0 0;
	}

	.name {
		flex: 1;
		font-family: var(--font-display);
		font-size: var(--text-lg);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-tight);
	}

	.kind {
		padding: 2px var(--space-2);
		border-radius: var(--radius-full);
		font-size: var(--text-2xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
		background: var(--color-surface-2);
		color: var(--color-text-secondary);
	}

	.kind[data-kind='measured'] {
		background: var(--color-accent-subtle);
		color: var(--color-accent-text);
	}

	.pair,
	.trio {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-3);
	}

	.trio {
		grid-template-columns: 1.3fr 1fr 1fr;
	}
</style>
