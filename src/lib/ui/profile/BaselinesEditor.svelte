<!--
  @component
  Profile → Strength (Paper, 9 · "Strength", "A lift", "Strength unknown"): the owner's best
  lifts, every one optional (PRD §3). A lift is a row with what is known of it ("102.5 kg × 5",
  "About 150 kg", "140 kg"), opening a sheet that takes the set or the max, when, and how the
  owner knows it: measured (tested, or lifted in competition) or estimated (from a recent set, or
  a best guess). The server derives the kind from that, and works out a set's 1RM with the same
  function the sheet's line shows live. "Add a lift" picks one from a sheet and opens its own.
  "I don't know my numbers" is an answer of its own, and the section then says one thing: week
  one establishes them with RPE-based sets.
-->
<script lang="ts">
	import { tick, untrack } from 'svelte';
	import {
		BASELINE_SOURCES,
		BASELINE_SOURCE_LABEL,
		LIFTS,
		LIFT_LABEL,
		type Lift
	} from '#lib/domain/profile/catalog.ts';
	import BottomSheet from '../components/BottomSheet.svelte';
	import Button from '../components/Button.svelte';
	import ChoiceGroup from '../components/ChoiceGroup.svelte';
	import ListRow from '../components/ListRow.svelte';
	import NumberField from '../components/NumberField.svelte';
	import SheetRow from '../components/SheetRow.svelte';
	import TextField from '../components/TextField.svelte';
	import type { EditorProps } from './editors';
	import {
		estimateLine,
		liftName,
		liftValue,
		newLift,
		suggestedLifts,
		type BaselinesDraft
	} from './strength';

	let { value = $bindable(), errors = {}, context }: EditorProps<BaselinesDraft> = $props();

	const id = $props.id();
	const sources = BASELINE_SOURCES.map((s) => ({ value: s, label: BASELINE_SOURCE_LABEL[s] }));
	const suggested = $derived(suggestedLifts(context.disciplines));
	const listed = $derived(new Set(value.lifts.map((l) => l.lift)));
	/** The named lifts not listed yet, suggestions first, then one of the owner's own. */
	const addable = $derived(
		[...suggested, ...LIFTS.filter((l) => l !== 'custom' && !suggested.includes(l))]
			.filter((l) => !listed.has(l))
			.concat('custom')
			.map((l) => ({ value: l, label: LIFT_LABEL[l] }))
	);

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
	/** In the sheet's order: the row shows the first, and opening it shows each by its field. */
	const FIELDS = ['customLabel', 'setWeight', 'setReps', 'setRpe', 'value', 'achievedOn', 'source'];
	const liftError = (key: string) => FIELDS.map((field) => err(key, field)).find(Boolean);

	let root = $state<HTMLElement>();
	/** The lift whose sheet is open: its row opened it, or it was just added. */
	let opened = $state<string | null>(null);
	let adding = $state(false);
	let choice = $state<Lift | null>(null);

	let announcement = $state('');
	let timer: ReturnType<typeof setTimeout> | undefined;

	/** Clear, then set: a live region speaks only when its text changes, even to the same words. */
	function announce(text: string) {
		announcement = '';
		clearTimeout(timer);
		timer = setTimeout(() => (announcement = text), 100);
	}

	const rows = () => [
		...(root?.querySelectorAll<HTMLElement>('[data-testid="baseline-lift"]') ?? [])
	];
	const byTestId = (testId: string) =>
		root?.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

	/** Resolves once `dialog` has closed (at once if it is not open). */
	function closed(dialog: HTMLDialogElement | null | undefined): Promise<void> {
		return new Promise((resolve) => {
			if (!dialog?.open) resolve();
			else dialog.addEventListener('close', () => resolve(), { once: true });
		});
	}

	function startAdding() {
		choice = null;
		adding = true;
	}

	/** A lift picked from "Add a lift": listed, then its own sheet opens over its new row. */
	async function add(lift: Lift) {
		if (!adding) return;
		adding = false;
		const draft = newLift(lift, context.units.weight);
		value.lifts.push(draft);
		announce(`Added ${liftName(draft)}`);
		// Once "Add a lift" has gone, the new row takes the focus, so its sheet hands it back there.
		await closed(root?.querySelector<HTMLDialogElement>('[data-testid="add-lift-sheet"]'));
		await tick();
		rows()[value.lifts.findIndex((l) => l.key === draft.key)]?.focus();
		opened = draft.key;
	}

	/** An arrow key is moving the pick: the change it fires adds nothing. */
	let stepping = false;
	const isRadio = (target: EventTarget | null): target is HTMLInputElement =>
		target instanceof HTMLInputElement && target.type === 'radio';

	function picked() {
		const stepped = stepping;
		stepping = false;
		if (!stepped && choice) void add(choice);
	}

	/** Arrows step through the lifts; Enter or Space adds the focused one. */
	function onAddKey(event: KeyboardEvent) {
		if (!isRadio(event.target)) return;
		stepping = event.key.startsWith('Arrow');
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		void add(event.target.value as Lift);
	}

	/** A tap adds the lift, also the one an arrow key had stepped to (it fires no change). */
	function onAddClick(event: MouseEvent) {
		if (isRadio(event.target) && event.detail > 0) void add(event.target.value as Lift);
	}

	async function remove(key: string) {
		const i = value.lifts.findIndex((l) => l.key === key);
		if (i === -1) return;
		announce(`Removed ${liftName(value.lifts[i]!)}`);
		opened = null;
		value.lifts.splice(i, 1);
		// Its row went with its sheet: the focus takes its place, on the next lift, the one
		// before, or Add a lift.
		await tick();
		const left = rows();
		(left[i] ?? left[i - 1] ?? byTestId('add-lift'))?.focus();
	}

	/** "I don't know my numbers", or back: the focus goes to the row that turns it round. */
	async function setUnknown(unknown: boolean) {
		value.unknown = unknown;
		await tick();
		byTestId(unknown ? 'baselines-known' : 'baselines-unknown')?.focus();
	}
</script>

<div class="strength" bind:this={root}>
	{#if value.unknown}
		<div class="explainer" data-testid="baselines-explainer">
			<h2 class="statement">Week one finds your numbers</h2>
			<p class="lede">
				I’ll set manageable sets. You log the weight, the reps and how hard it felt. No maxing out.
			</p>
			{#if value.lifts.length}
				<p class="note">Saving sets your lifts aside; any you saved before stay in your history.</p>
			{/if}
		</div>
		<div class="rows">
			<ListRow
				title="I know some of my lifts"
				onclick={() => setUnknown(false)}
				data-testid="baselines-known"
			/>
		</div>
	{:else}
		{#if value.lifts.length}
			<div class="rows">
				{#each value.lifts as lift (lift.key)}
					<SheetRow
						label={liftName(lift)}
						value={liftValue(lift)}
						placeholder="Choose"
						error={liftError(lift.key)}
						bind:open={() => opened === lift.key, (open) => (opened = open ? lift.key : null)}
						data-testid="baseline-lift"
					>
						{#if lift.lift === 'custom'}
							<TextField
								label="Lift name"
								bind:value={() => lift.customLabel ?? '', (v) => (lift.customLabel = v || null)}
								error={err(lift.key, 'customLabel')}
								placeholder="e.g. Zercher squat"
								maxlength={40}
							/>
						{/if}
						{#if lift.source === 'set'}
							<div class="group" role="group" aria-labelledby="{id}-{lift.key}-set">
								<p class="label" id="{id}-{lift.key}-set">A recent hard set</p>
								<div class="set">
									<!-- Weight and reps share a row; RPE and the date get their own, so a date
									     input never has to shrink below what the browser draws it at. -->
									<div class="pair">
										<NumberField
											label="Weight"
											unit={lift.unit}
											bind:value={lift.setWeight}
											error={err(lift.key, 'setWeight')}
											enterkeyhint="next"
										/>
										<NumberField
											label="Reps"
											integer
											bind:value={lift.setReps}
											error={err(lift.key, 'setReps')}
											enterkeyhint="next"
										/>
									</div>
									<div class="hinted">
										<NumberField
											label="RPE"
											optional
											bind:value={lift.setRpe}
											error={err(lift.key, 'setRpe')}
											placeholder="8"
										/>
										<p class="estimate" role="status" data-testid="baseline-estimate">
											{estimateLine(lift)}
										</p>
									</div>
								</div>
							</div>
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
						<div class="group">
							<!-- The list's own legend names it for assistive tech. -->
							<p class="label" aria-hidden="true">How you know</p>
							<ChoiceGroup
								legend="How you know"
								hideLegend
								variant="card"
								options={sources}
								bind:value={lift.source}
								error={err(lift.key, 'source')}
							/>
						</div>
						<ListRow
							title="Remove this lift"
							danger
							onclick={() => remove(lift.key)}
							data-testid="baseline-remove"
						/>
					</SheetRow>
				{/each}
			</div>
		{/if}
		{#if errors.lifts}<p class="error" role="alert">{errors.lifts}</p>{/if}
		<!-- A text link as wide as its words (Paper), 8 px under the last row. -->
		<div class="more">
			<Button variant="link" onclick={startAdding} data-testid="add-lift">Add a lift</Button>
		</div>
		<div class="rows unknown">
			<ListRow
				title="I don’t know my numbers"
				onclick={() => setUnknown(true)}
				data-testid="baselines-unknown"
			/>
		</div>

		<BottomSheet bind:open={adding} title="Add a lift" data-testid="add-lift-sheet">
			<!-- The radios' keys and clicks bubble here: the group itself is the native one. -->
			<div
				role="presentation"
				onkeydown={onAddKey}
				onclick={onAddClick}
				onpointerdown={() => (stepping = false)}
			>
				<ChoiceGroup
					legend="Add a lift"
					hideLegend
					variant="card"
					options={addable}
					bind:value={choice}
					onchange={picked}
				/>
			</div>
		</BottomSheet>
	{/if}
	<p class="visually-hidden" role="status">{announcement}</p>
</div>

<style>
	.strength,
	.rows {
		display: grid;
	}

	.more {
		padding-top: var(--space-2);
	}

	/* "I don't know my numbers": 28 px under Add a lift. */
	.unknown {
		margin-top: var(--space-7);
	}

	/* The answer that replaces the lifts, at the top (on a phone the tab bar has the foot). */
	.explainer {
		display: grid;
		gap: var(--space-4);
		padding-bottom: var(--space-6);
	}

	.statement {
		font: var(--type-statement);
		letter-spacing: var(--tracking-statement);
	}

	.lede {
		font: var(--type-body);
		color: var(--color-text-secondary);
	}

	.note,
	.estimate {
		font: var(--type-caption);
		color: var(--color-text-tertiary);
	}

	/* A group's label sits directly on what it labels. */
	.group {
		display: grid;
		gap: var(--space-2);
	}

	.label {
		font: var(--type-secondary);
		color: var(--color-text-tertiary);
	}

	.set {
		display: grid;
		gap: var(--space-5);
	}

	.pair {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-3);
		align-items: start;
	}

	/* The estimate is RPE's hint: 8 px under it. */
	.hinted {
		display: grid;
		gap: var(--space-2);
	}

	.error {
		font: var(--type-caption);
		color: var(--color-danger);
	}
</style>
