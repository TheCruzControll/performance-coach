<!--
  @component
  Profile → Running & Muay Thai: running volume, easy pace and recent race times; Muay Thai
  sessions, sparring and fights. Each part is shown while its discipline is in play or something
  about it is saved, and either can be added here. Every number is optional, heart rate included
  (it sets the run zones in bpm); a race needs its distance and time. Times go in on the phone's decimal keypad: "1.45.30" reads as 1:45:30.
-->
<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { RACE_DISTANCES, RACE_DISTANCE_INFO } from '#lib/domain/profile/catalog.ts';
	import Button from '../components/Button.svelte';
	import Card from '../components/Card.svelte';
	import ChoiceGroup from '../components/ChoiceGroup.svelte';
	import EmptyState from '../components/EmptyState.svelte';
	import IconButton from '../components/IconButton.svelte';
	import Notice from '../components/Notice.svelte';
	import NumberField from '../components/NumberField.svelte';
	import Section from '../components/Section.svelte';
	import TextField from '../components/TextField.svelte';
	import type { EditorProps } from './editors';
	import {
		muayThaiDraft,
		newRace,
		raceName,
		runningDraft,
		timeError,
		type SpecificsDraft
	} from './specifics';

	let { value = $bindable(), errors = {}, context }: EditorProps<SpecificsDraft> = $props();

	const distances = RACE_DISTANCES.map((d) => ({ value: d, label: RACE_DISTANCE_INFO[d].label }));
	const PACE_FORMAT = 'Type it as m.ss, like 5.45';
	const TIME_FORMAT = 'Type it as h.mm.ss or m.ss, like 1.45.30';

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

	let root = $state<HTMLElement>();
	let announcement = $state('');
	let timer: ReturnType<typeof setTimeout> | undefined;

	/** Clear, then set: a live region speaks only when its text changes, even to the same words. */
	function announce(text: string) {
		announcement = '';
		clearTimeout(timer);
		timer = setTimeout(() => (announcement = text), 100);
	}

	/** Once it is on screen, straight to the first field of what was just added. */
	async function focusFirstField(selector: string) {
		await tick();
		const field = [...(root?.querySelectorAll(selector) ?? [])].at(-1)?.querySelector('input');
		field?.focus({ preventScroll: true });
		field?.scrollIntoView({ block: 'center' });
	}

	function addRunning() {
		value.running = runningDraft(null, context.units.distance);
		announce('Added running');
		void focusFirstField('.running');
	}

	function addMuayThai() {
		value.muayThai = muayThaiDraft(null);
		announce('Added Muay Thai');
		void focusFirstField('.muay-thai');
	}

	function addRace() {
		value.running?.races.push(newRace());
		announce('Added a race');
		void focusFirstField('.race');
	}

	async function removeRace(i: number) {
		const running = value.running!;
		const card = root?.querySelectorAll('.race')[i];
		const focused = card?.contains(document.activeElement);
		announce(`Removed ${raceName(running.races[i]!, running.unit)}`);
		running.races.splice(i, 1);
		if (!focused) return;
		// Keep keyboard focus in the list: the next race's Remove, else the one before, else Add.
		await tick();
		const removes = root?.querySelectorAll<HTMLElement>('.race header button') ?? [];
		(removes[i] ?? removes[i - 1] ?? root?.querySelector<HTMLElement>('.add-race button'))?.focus();
	}
</script>

<div class="specifics" bind:this={root}>
	{#if value.running}
		{@const run = value.running}
		<div class="running">
			<Card title="Running" tone="running">
				<div class="fields">
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
						enterkeyhint="next"
					/>
					<NumberField
						label="Longest run"
						unit={run.unit}
						bind:value={run.longestRun}
						error={errors['running.longestRun']}
						enterkeyhint="next"
					/>
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
					<NumberField
						label="Max heart rate"
						unit="bpm"
						integer
						hint="Optional — sets your heart-rate zones"
						bind:value={run.heartRate.max}
						error={errors['running.heartRate.max']}
						enterkeyhint="next"
					/>
					<NumberField
						label="Resting heart rate"
						unit="bpm"
						integer
						hint="Optional — sets your heart-rate zones"
						bind:value={run.heartRate.resting}
						error={errors['running.heartRate.resting']}
						enterkeyhint="next"
					/>
					<NumberField
						label="Threshold heart rate"
						unit="bpm"
						integer
						hint="Optional — sets your heart-rate zones"
						bind:value={run.heartRate.threshold}
						error={errors['running.heartRate.threshold']}
						enterkeyhint="next"
					/>
				</div>
			</Card>
		</div>

		<Section title="Recent races" gap="md">
			{#each run.races as race, i (race.key)}
				{@const name = raceName(race, run.unit)}
				<div class="race">
					<Card title={name} data-testid="race">
						{#snippet action()}
							<IconButton
								icon="close"
								size="sm"
								label="Remove {name}"
								onclick={() => removeRace(i)}
							/>
						{/snippet}
						<div class="race-fields">
							<ChoiceGroup
								legend="Distance"
								bind:value={race.distance}
								error={raceError(race.key, 'distance')}
								options={distances}
							/>
							<div class="time">
								<TextField
									label="Time"
									bind:value={race.time}
									hint="h.mm.ss or m.ss, like 1.45.30"
									error={timeError(race.time, raceError(race.key, 'timeSeconds'), TIME_FORMAT)}
									inputmode="decimal"
									autocomplete="off"
									enterkeyhint="next"
									placeholder="h.mm.ss"
								/>
								{#if race.distance === 'other'}
									<NumberField
										label="How far?"
										unit={run.unit}
										bind:value={race.customDistance}
										error={raceError(race.key, 'customDistance')}
										enterkeyhint="next"
									/>
								{/if}
							</div>
							<TextField
								label="When"
								type="date"
								optional
								bind:value={() => race.racedOn ?? '', (v) => (race.racedOn = v || null)}
								error={raceError(race.key, 'racedOn')}
							/>
						</div>
					</Card>
				</div>
			{:else}
				<p class="lede">A recent race time tells the coach what shape you’re in.</p>
			{/each}
			{#if errors['running.races']}<Notice tone="danger">{errors['running.races']}</Notice>{/if}
			<div class="add-race">
				<Button variant="secondary" icon="plus" onclick={addRace}>Add a race</Button>
			</div>
		</Section>
	{/if}

	{#if value.muayThai}
		{@const mt = value.muayThai}
		<div class="muay-thai">
			<Card title="Muay Thai" tone="combat">
				<div class="fields">
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
						enterkeyhint="next"
					/>
					<NumberField
						label="Fights"
						hint="So far"
						integer
						bind:value={mt.fights}
						error={errors['muayThai.fights']}
					/>
				</div>
			</Card>
		</div>
	{/if}

	{#if !value.running && !value.muayThai}
		<EmptyState
			compact
			icon="pulse"
			title="No running or Muay Thai yet"
			description="If you also run or train Muay Thai, add it: the coach plans your week around it."
			data-testid="specifics-empty"
		>
			{#snippet actions()}
				<Button variant="secondary" icon="plus" onclick={addRunning}>Add running</Button>
				<Button variant="secondary" icon="plus" onclick={addMuayThai}>Add Muay Thai</Button>
			{/snippet}
		</EmptyState>
	{:else if !value.running}
		<div><Button variant="secondary" icon="plus" onclick={addRunning}>Add running</Button></div>
	{:else if !value.muayThai}
		<div><Button variant="secondary" icon="plus" onclick={addMuayThai}>Add Muay Thai</Button></div>
	{/if}

	<p class="visually-hidden" role="status">{announcement}</p>
</div>

<style>
	.specifics {
		display: grid;
		gap: var(--space-6);
	}

	/* Two short numbers to a row, on a phone and in a desktop column alike. */
	.fields {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-5) var(--space-3);
		align-items: start;
	}

	.race-fields {
		display: grid;
		gap: var(--space-5);
	}

	/* The time takes the row, or shares it with an "Other" race's distance. A date gets a row of
	   its own, so it never shrinks below what the browser draws it at. */
	.time {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
		gap: var(--space-3);
		align-items: start;
	}

	.lede {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}
</style>
