<!--
  @component
  Profile → Strength: the owner's 1RMs, every one optional (PRD §3). "I don't know my 1RMs" is
  an answer of its own: week one establishes them with RPE-based sets. A known max is measured
  (tested, or lifted in competition) or estimated (from a recent set, or a best guess), and the
  owner says which: the server derives the kind from that, and works out a set's 1RM with the
  same function this screen shows live.
-->
<script lang="ts">
	import { tick, untrack } from 'svelte';
	import {
		BASELINE_SOURCES,
		BASELINE_SOURCE_KIND,
		BASELINE_SOURCE_LABEL,
		LIFTS,
		LIFT_LABEL,
		type Lift
	} from '#lib/domain/profile/catalog.ts';
	import { roundEstimate } from '#lib/domain/units.ts';
	import Badge from '../components/Badge.svelte';
	import Button from '../components/Button.svelte';
	import ChoiceGroup from '../components/ChoiceGroup.svelte';
	import Icon from '../components/Icon.svelte';
	import IconButton from '../components/IconButton.svelte';
	import Notice from '../components/Notice.svelte';
	import NumberField from '../components/NumberField.svelte';
	import Section from '../components/Section.svelte';
	import Surface from '../components/Surface.svelte';
	import TextField from '../components/TextField.svelte';
	import Toggle from '../components/Toggle.svelte';
	import type { EditorProps } from './editors';
	import {
		liftName,
		liveEstimate,
		newLift,
		suggestedLifts,
		trim,
		type BaselinesDraft
	} from './strength';

	let { value = $bindable(), errors = {}, context }: EditorProps<BaselinesDraft> = $props();

	const id = $props.id();
	const sources = BASELINE_SOURCES.map((s) => ({ value: s, label: BASELINE_SOURCE_LABEL[s] }));
	const suggested = $derived(suggestedLifts(context.disciplines));
	const others = $derived(LIFTS.filter((l) => l !== 'custom' && !suggested.includes(l)));
	const listed = $derived(new Set(value.lifts.map((l) => l.lift)));
	let more = $state(false);
	/** The named lifts not on the list yet: suggestions first, the others once asked for. */
	const addable = $derived([...suggested, ...(more ? others : [])].filter((l) => !listed.has(l)));
	const moreToShow = $derived(!more && others.some((l) => !listed.has(l)));

	// Errors come keyed by position when a save answers. They stay with the rows they were for
	// when a row above is removed, and a row added since has none.
	const erred = $derived.by(() => {
		void errors;
		return untrack(() => value.lifts.map((l) => l.key));
	});
	const err = (key: string, field: string) => {
		const i = erred.indexOf(key);
		return i === -1 ? undefined : errors[`lifts.${i}.${field}`];
	};

	let root = $state<HTMLElement>();
	let announcement = $state('');

	async function add(lift: Lift) {
		const draft = newLift(lift, context.units.weight);
		value.lifts.push(draft);
		await tick();
		document.getElementById(`${id}-${draft.key}`)?.focus();
	}

	async function remove(i: number) {
		const card = root?.querySelectorAll('.lift')[i];
		const focused = card?.contains(document.activeElement);
		announcement = `Removed ${liftName(value.lifts[i]!)}`;
		value.lifts.splice(i, 1);
		if (!focused || !root) return;
		// Keyboard focus moves to the next lift's Remove, or the one before, or the add buttons.
		await tick();
		const removes = root.querySelectorAll<HTMLElement>('.lift header button');
		(removes[i] ?? removes[i - 1] ?? root.querySelector<HTMLElement>('.add button'))?.focus();
	}

	async function showMore() {
		const first = addable.length;
		more = true;
		await tick();
		root?.querySelectorAll<HTMLElement>('.add button')[first]?.focus();
	}
</script>

<div class="strength" bind:this={root}>
	<Surface padding="md" radius="xl" tone={value.unknown ? 'accent' : 'default'}>
		<Toggle
			label="I don’t know my 1RMs"
			description="Totally fine — most people don’t, and you never have to test one."
			bind:checked={value.unknown}
			data-testid="baselines-unknown"
		/>
		{#if value.unknown}
			<div class="explainer" data-testid="baselines-explainer">
				<h2 class="explainer-title">
					<Icon name="bolt" size={18} /> Week one finds your numbers
				</h2>
				<ol class="steps">
					<li>Your coach sets manageable working sets — no maxing out.</li>
					<li>You log the weight, the reps and how hard each set felt (RPE, 1–10).</li>
					<li>Those sets estimate your strength and set your working weights from then on.</li>
				</ol>
				<p class="note">
					Week one is a baseline week: loading stays conservative until the data is in.
					{#if value.lifts.length}
						Saving sets your lifts aside; any you saved before stay in your history.
					{/if}
				</p>
			</div>
		{/if}
	</Surface>

	{#if !value.unknown}
		<p class="lede">
			Add only what you know. Every lift can stay blank — the coach treats an estimate as an
			estimate, never as a tested max.
		</p>

		{#each value.lifts as lift, i (lift.key)}
			{@const name = liftName(lift)}
			{@const kind = lift.source && BASELINE_SOURCE_KIND[lift.source]}
			{@const estimate = liveEstimate(lift)}
			<Surface
				as="section"
				class="lift"
				padding="md"
				radius="xl"
				aria-labelledby="{id}-{lift.key}"
				data-testid="baseline-lift"
			>
				<div class="card">
					<header class="head">
						<h2 class="name" id="{id}-{lift.key}" tabindex="-1">{name}</h2>
						{#if kind === 'measured'}
							<Badge tone="positive" icon="check" data-testid="baseline-kind">Measured</Badge>
						{:else if kind === 'estimated'}
							<Badge data-testid="baseline-kind">Estimated</Badge>
						{/if}
						<IconButton icon="close" size="sm" label="Remove {name}" onclick={() => remove(i)} />
					</header>
					{#if lift.lift === 'custom'}
						<TextField
							label="Lift name"
							bind:value={() => lift.customLabel ?? '', (v) => (lift.customLabel = v || null)}
							error={err(lift.key, 'customLabel')}
							placeholder="e.g. Zercher squat"
							maxlength={40}
						/>
					{/if}
					<ChoiceGroup
						legend="How do you know it?"
						bind:value={lift.source}
						error={err(lift.key, 'source')}
						options={sources}
					/>
					{#if lift.source === 'set'}
						<NumberField
							label="Weight"
							unit={lift.unit}
							bind:value={lift.setWeight}
							error={err(lift.key, 'setWeight')}
							enterkeyhint="next"
						/>
						<div class="pair">
							<NumberField
								label="Reps"
								integer
								bind:value={lift.setReps}
								error={err(lift.key, 'setReps')}
								enterkeyhint="next"
							/>
							<NumberField
								label="RPE"
								optional
								bind:value={lift.setRpe}
								error={err(lift.key, 'setRpe')}
								placeholder="8"
							/>
						</div>
						<p class="estimate" role="status" data-testid="baseline-estimate">
							{#if estimate}
								≈ <strong class="numeric"
									>{trim(roundEstimate(estimate.value, lift.unit))}&nbsp;{lift.unit}</strong
								>
								estimated 1RM · {estimate.confidence} confidence
							{:else if lift.setWeight != null && lift.setReps != null}
								Can’t estimate from that set — use 1–12 reps at RPE 6–10.
							{:else}
								Enter a recent hard set. RPE is how hard it felt: 10 = nothing left.
							{/if}
						</p>
					{:else if lift.source}
						<NumberField
							label="1RM"
							unit={lift.unit}
							bind:value={lift.value}
							error={err(lift.key, 'value')}
						/>
					{/if}
					{#if lift.source}
						<TextField
							label="When"
							type="date"
							optional
							bind:value={() => lift.achievedOn ?? '', (v) => (lift.achievedOn = v || null)}
							error={err(lift.key, 'achievedOn')}
						/>
					{/if}
				</div>
			</Surface>
		{/each}

		{#if errors.lifts}<Notice tone="danger">{errors.lifts}</Notice>{/if}

		<Section title={value.lifts.length ? 'Add another lift' : 'Add a lift you know'}>
			<div class="add">
				{#each addable as lift (lift)}
					<Button variant="secondary" size="sm" icon="plus" onclick={() => add(lift)}>
						{LIFT_LABEL[lift]}
					</Button>
				{/each}
				<Button variant="secondary" size="sm" icon="plus" onclick={() => add('custom')}>
					Other lift
				</Button>
				{#if moreToShow}
					<Button variant="ghost" size="sm" iconEnd="chevron-down" onclick={showMore}>
						More lifts
					</Button>
				{/if}
			</div>
		</Section>
	{/if}
	<p class="visually-hidden" role="status">{announcement}</p>
</div>

<style>
	.strength {
		display: grid;
		gap: var(--space-4);
	}

	.explainer {
		display: grid;
		gap: var(--space-3);
		margin-top: var(--space-4);
		padding-top: var(--space-4);
		border-top: 1px solid var(--color-hairline);
	}

	.explainer-title {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-base);
		color: var(--color-accent-text);
	}

	.steps {
		display: grid;
		gap: var(--space-2);
		padding-left: var(--space-5);
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.note,
	.lede,
	.estimate {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.estimate strong {
		color: var(--color-text);
		font-weight: var(--weight-semibold);
	}

	.card {
		display: grid;
		gap: var(--space-4);
	}

	.head {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		/* The remove button's hit area reaches into the card's padding, not past the name. */
		margin: calc(var(--space-1) * -1) calc(var(--space-2) * -1) 0 0;
	}

	.name {
		flex: 1;
		min-width: 0;
		font-size: var(--text-lg);
	}

	/* Reps and RPE are a digit or two: they share a row. A weight or a date gets its own, so a
	   date input never has to shrink below what the browser draws it at. */
	.pair {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-3);
		align-items: start;
	}

	.add {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
</style>
