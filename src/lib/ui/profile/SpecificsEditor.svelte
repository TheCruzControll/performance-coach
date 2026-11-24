<!--
  @component
  Profile → Running and Muay Thai (Paper, 9 · "Running and Muay Thai", "A race"): groups of rows,
  each with its answer in words ("24 km in 3 runs", "5:45 a km") and each opening a short sheet of
  fields. Running is a usual week, the longest run, the easy pace and Recent races; Heart rate is
  max, resting and threshold (max or threshold sets the run zones in bpm, and resting refines them
  with max); Muay Thai is a usual week and fights so far. Every number is optional. Recent races
  is a sub-screen (subscreens.svelte.ts) of race rows, even with one race, each race a sheet: its
  time, when, its distance and Remove this race; a race needs its distance and time. Each part is
  shown while its discipline is in play or something about it is saved, and either can be added
  here. Times go in on the phone's decimal keypad: "1.45.30" reads as 1:45:30. Saved with the
  section's Save.
-->
<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { RACE_DISTANCES, RACE_DISTANCE_INFO } from '#lib/domain/profile/catalog.ts';
	import Button from '../components/Button.svelte';
	import ChoiceGroup from '../components/ChoiceGroup.svelte';
	import ListRow from '../components/ListRow.svelte';
	import NumberField from '../components/NumberField.svelte';
	import SheetRow from '../components/SheetRow.svelte';
	import TextField from '../components/TextField.svelte';
	import type { EditorProps } from './editors';
	import {
		bpmValue,
		distanceValue,
		fightsValue,
		muayThaiDraft,
		muayThaiWeekValue,
		newRace,
		paceValue,
		raceName,
		racesValue,
		runningDraft,
		runningWeekValue,
		timeError,
		type RaceDraft,
		type SpecificsDraft
	} from './specifics';
	import { useSubScreens } from './subscreens.svelte.ts';

	let { value = $bindable(), errors = {}, context }: EditorProps<SpecificsDraft> = $props();

	const id = $props.id();
	// "Other" is "Another distance" here: the question is the race's distance.
	const distances = RACE_DISTANCES.map((d) => ({
		value: d,
		label: d === 'other' ? 'Another distance' : RACE_DISTANCE_INFO[d].label
	}));
	const PACE_FORMAT = 'Type it as m.ss, like 5.45';
	const TIME_FORMAT = 'Type it as h.mm.ss or m.ss, like 1.45.30';
	const HEART_RATE =
		'Your max or threshold heart rate sets your run zones in beats per minute; resting refines them with max.';
	const RACES = 'races';

	/** The host's sub-screens: none where an editor is rendered alone (a test). */
	const subs = useSubScreens();
	const racesOpen = $derived(subs?.top?.id === RACES && !!value.running);

	// Errors come keyed by position when a save answers. They stay with the races they were for
	// when one above is removed, and a race added since has none.
	const erred = $derived.by(() => {
		void errors;
		return untrack(() => value.running?.races.map((r) => r.key) ?? []);
	});
	const raceError = (key: string, field: string) => {
		const i = erred.indexOf(key);
		return i === -1 ? undefined : errors[`running.races.${i}.${field}`];
	};
	/** A race's errors as its fields show them: the time's says how to type one. */
	const raceErrors = (race: RaceDraft) => ({
		distance: raceError(race.key, 'distance'),
		time: timeError(race.time, raceError(race.key, 'timeSeconds'), TIME_FORMAT),
		customDistance: raceError(race.key, 'customDistance'),
		racedOn: raceError(race.key, 'racedOn')
	});
	/** The first thing wrong with a race, for the line under its row. */
	const raceRowError = (race: RaceDraft) => {
		const e = raceErrors(race);
		return e.distance ?? e.time ?? e.customDistance ?? e.racedOn;
	};
	/** Something about the races needs fixing: the Recent races row says so, in words. */
	const racesErred = $derived(
		!!errors['running.races'] || !!value.running?.races.some((r) => raceRowError(r))
	);

	let root = $state<HTMLElement>();
	let announcement = $state('');
	let timer: ReturnType<typeof setTimeout> | undefined;

	/** Clear, then set: a live region speaks only when its text changes, even to the same words. */
	function announce(text: string) {
		announcement = '';
		clearTimeout(timer);
		timer = setTimeout(() => (announcement = text), 100);
	}

	/** Once it is on screen, straight to the first row of what was just added. */
	async function focusFirstRow(group: string) {
		await tick();
		root?.querySelector<HTMLElement>(`[data-group="${group}"] .row`)?.focus();
	}

	function addRunning() {
		value.running = runningDraft(null, context.units.distance);
		announce('Added running');
		void focusFirstRow('running');
	}

	function addMuayThai() {
		value.muayThai = muayThaiDraft(null);
		announce('Added Muay Thai');
		void focusFirstRow('muay-thai');
	}

	function openRaces() {
		subs?.open({
			id: RACES,
			title: 'Recent races',
			back: 'Running and Muay Thai',
			lede: 'A recent race time tells the coach what shape you’re in.'
		});
	}

	/** A new race, and its sheet open at once: from its row, so the focus comes back there. */
	async function addRace() {
		value.running?.races.push(newRace());
		announce('Added a race');
		await tick();
		const row = [...(root?.querySelectorAll<HTMLElement>('[data-testid="race"]') ?? [])].at(-1);
		row?.focus();
		row?.click();
	}

	/** Its row goes, and its sheet with it: the focus goes to the next race, the one before, or Add. */
	async function removeRace(race: RaceDraft) {
		const running = value.running!;
		const i = running.races.findIndex((r) => r.key === race.key);
		announce(`Removed ${raceName(race, running.unit)}`);
		running.races.splice(i, 1);
		await tick();
		const rows = root?.querySelectorAll<HTMLElement>('[data-testid="race"]') ?? [];
		(
			rows[i] ??
			rows[i - 1] ??
			root?.querySelector<HTMLElement>('[data-testid="add-race"]')
		)?.focus();
	}

	// Without running (a save from elsewhere, a remount), Recent races has nothing to show.
	$effect(() => {
		if (subs?.top?.id === RACES && !value.running) subs.reset();
	});
</script>

<div class="specifics" bind:this={root}>
	{#if racesOpen && value.running}
		{@const run = value.running}
		<div class="races">
			{#if run.races.length}
				<div class="rows">
					{#each run.races as race (race.key)}
						{@const own = raceErrors(race)}
						<SheetRow
							label={raceName(race, run.unit)}
							title="A recent race"
							value={race.time || undefined}
							error={raceRowError(race)}
							data-testid="race"
						>
							<TextField
								label="Your time"
								bind:value={race.time}
								hint="h.mm.ss or m.ss, like 1.45.30"
								error={own.time}
								inputmode="decimal"
								autocomplete="off"
								enterkeyhint="next"
								placeholder="h.mm.ss"
							/>
							<TextField
								label="When"
								type="date"
								optional
								bind:value={() => race.racedOn ?? '', (v) => (race.racedOn = v || null)}
								error={own.racedOn}
							/>
							<ChoiceGroup
								legend="Distance"
								hideLegend
								variant="card"
								bind:value={race.distance}
								error={own.distance}
								options={distances}
							/>
							{#if race.distance === 'other'}
								<NumberField
									label="How far?"
									unit={run.unit}
									bind:value={race.customDistance}
									error={own.customDistance}
								/>
							{/if}
							<ListRow
								title="Remove this race"
								danger
								onclick={() => removeRace(race)}
								data-testid="race-remove"
							/>
						</SheetRow>
					{/each}
				</div>
			{/if}
			<div class="more">
				<Button variant="link" onclick={addRace} data-testid="add-race">Add a race</Button>
			</div>
			{#if errors['running.races']}
				<p class="error" role="alert">{errors['running.races']}</p>
			{/if}
		</div>
	{:else}
		{#if value.running}
			{@const run = value.running}
			<section class="group" aria-labelledby="{id}-run" data-group="running">
				<h2 class="label" id="{id}-run">Running</h2>
				<SheetRow
					label="A usual week"
					value={runningWeekValue(run)}
					error={errors['running.weeklyDistance'] ?? errors['running.runsPerWeek']}
					data-testid="run-week"
				>
					<div class="pair">
						<NumberField
							label="Weekly distance"
							unit={run.unit}
							bind:value={run.weeklyDistance}
							error={errors['running.weeklyDistance']}
							enterkeyhint="next"
						/>
						<NumberField
							label="Runs"
							unit="a week"
							bind:value={run.runsPerWeek}
							error={errors['running.runsPerWeek']}
						/>
					</div>
				</SheetRow>
				<SheetRow
					label="Longest run"
					value={distanceValue(run.longestRun, run.unit)}
					error={errors['running.longestRun']}
					data-testid="run-longest"
				>
					<NumberField
						label="Longest run"
						unit={run.unit}
						bind:value={run.longestRun}
						error={errors['running.longestRun']}
					/>
				</SheetRow>
				<SheetRow
					label="Easy pace"
					value={paceValue(run.easyPace, run.unit)}
					error={timeError(run.easyPace, errors['running.easyPaceSeconds'], PACE_FORMAT)}
					data-testid="run-pace"
				>
					<TextField
						label="Easy pace"
						bind:value={run.easyPace}
						hint="m.ss per {run.unit}, like 5.45"
						error={timeError(run.easyPace, errors['running.easyPaceSeconds'], PACE_FORMAT)}
						inputmode="decimal"
						autocomplete="off"
						enterkeyhint="done"
						placeholder="m.ss"
					/>
				</SheetRow>
				<ListRow
					title="Recent races"
					value={racesErred ? 'Needs an answer' : racesValue(run.races, run.unit)}
					valueTone={racesErred ? 'warning' : undefined}
					onclick={openRaces}
					aria-invalid={racesErred ? 'true' : undefined}
					data-opens={RACES}
					data-testid="races-row"
				/>
			</section>

			<section class="group" aria-labelledby="{id}-hr" data-group="heart-rate">
				<h2 class="label" id="{id}-hr">Heart rate</h2>
				<SheetRow
					label="Max"
					title="Max heart rate"
					description={HEART_RATE}
					value={bpmValue(run.heartRate.max)}
					error={errors['running.heartRate.max']}
					data-testid="hr-max"
				>
					<NumberField
						label="Max heart rate"
						unit="bpm"
						integer
						bind:value={run.heartRate.max}
						error={errors['running.heartRate.max']}
					/>
				</SheetRow>
				<SheetRow
					label="Resting"
					title="Resting heart rate"
					description={HEART_RATE}
					value={bpmValue(run.heartRate.resting)}
					error={errors['running.heartRate.resting']}
					data-testid="hr-resting"
				>
					<NumberField
						label="Resting heart rate"
						unit="bpm"
						integer
						bind:value={run.heartRate.resting}
						error={errors['running.heartRate.resting']}
					/>
				</SheetRow>
				<SheetRow
					label="Threshold"
					title="Threshold heart rate"
					description={HEART_RATE}
					value={bpmValue(run.heartRate.threshold)}
					error={errors['running.heartRate.threshold']}
					data-testid="hr-threshold"
				>
					<NumberField
						label="Threshold heart rate"
						unit="bpm"
						integer
						bind:value={run.heartRate.threshold}
						error={errors['running.heartRate.threshold']}
					/>
				</SheetRow>
			</section>
		{/if}

		{#if value.muayThai}
			{@const mt = value.muayThai}
			<section class="group" aria-labelledby="{id}-mt" data-group="muay-thai">
				<h2 class="label" id="{id}-mt">Muay Thai</h2>
				<SheetRow
					label="A usual week"
					value={muayThaiWeekValue(mt)}
					error={errors['muayThai.sessionsPerWeek'] ?? errors['muayThai.sparringPerWeek']}
					data-testid="mt-week"
				>
					<div class="pair">
						<NumberField
							label="Sessions"
							unit="a week"
							bind:value={mt.sessionsPerWeek}
							error={errors['muayThai.sessionsPerWeek']}
							enterkeyhint="next"
						/>
						<NumberField
							label="Sparring"
							unit="a week"
							bind:value={mt.sparringPerWeek}
							error={errors['muayThai.sparringPerWeek']}
						/>
					</div>
				</SheetRow>
				<SheetRow
					label="Fights so far"
					value={fightsValue(mt.fights)}
					error={errors['muayThai.fights']}
					data-testid="mt-fights"
				>
					<NumberField
						label="Fights"
						hint="So far"
						integer
						bind:value={mt.fights}
						error={errors['muayThai.fights']}
					/>
				</SheetRow>
			</section>
		{/if}

		{#if !value.running || !value.muayThai}
			<div
				class="missing"
				data-testid={!value.running && !value.muayThai ? 'specifics-empty' : undefined}
			>
				{#if !value.running && !value.muayThai}
					<p class="empty">
						If you also run or train Muay Thai, add it: the coach plans your week around it.
					</p>
				{/if}
				<div class="links">
					{#if !value.running}
						<Button variant="link" onclick={addRunning}>Add running</Button>
					{/if}
					{#if !value.muayThai}
						<Button variant="link" onclick={addMuayThai}>Add Muay Thai</Button>
					{/if}
				</div>
			</div>
		{/if}
	{/if}

	<p class="visually-hidden" role="status">{announcement}</p>
</div>

<style>
	.specifics,
	.group,
	.races,
	.rows {
		display: grid;
	}

	/* Each group's label sits directly on its rows, 28 px under the group before (Paper). */
	.group + .group {
		margin-top: var(--space-7);
	}

	.label {
		font: var(--type-secondary);
		color: var(--color-text-tertiary);
	}

	/* Two short numbers side by side in a sheet, on a phone and in a desktop dialog alike. */
	.pair {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-3);
		align-items: start;
	}

	/* A text link as wide as its words, 8 px under the last row (Paper). */
	.more {
		padding-top: var(--space-2);
	}

	.missing {
		display: grid;
		gap: var(--space-2);
	}

	.group + .missing {
		margin-top: var(--space-7);
	}

	.links {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-6);
	}

	.empty {
		font: var(--type-body);
		color: var(--color-text-secondary);
	}

	/* An error about the whole list: one red line under it. */
	.error {
		padding-top: var(--space-2);
		font: var(--type-caption);
		color: var(--color-danger);
	}
</style>
