<!--
  @component
  Running and Muay Thai specifics, each shown only when that discipline is in play: running
  volume, easy pace and recent race times; Muay Thai sessions, sparring and fights. Every field
  is optional.
-->
<script lang="ts">
	import { RACE_DISTANCES, RACE_DISTANCE_INFO } from '#lib/domain/profile/catalog.ts';
	import type { FieldErrors, MuayThaiInput } from '#lib/domain/profile/schemas.ts';
	import Button from '../components/Button.svelte';
	import ChoiceGroup from '../components/ChoiceGroup.svelte';
	import IconButton from '../components/IconButton.svelte';
	import NumberField from '../components/NumberField.svelte';
	import TextField from '../components/TextField.svelte';
	import type { RunningDraft } from './forms';

	interface Props {
		value: { running: RunningDraft | null; muayThai: MuayThaiInput | null };
		errors?: FieldErrors;
	}

	let { value = $bindable(), errors = {} }: Props = $props();

	const distances = RACE_DISTANCES.map((d) => ({ value: d, label: RACE_DISTANCE_INFO[d].label }));

	function addRace() {
		value.running?.races.push({
			distance: '10k',
			customDistance: null,
			time: '',
			racedOn: null,
			eventName: null
		});
	}
</script>

<div class="specifics">
	{#if value.running}
		{@const run = value.running}
		<section class="block" aria-labelledby="running-title" data-testid="running-section">
			<h2 class="block-title" id="running-title">
				<span class="dot" style:background="var(--color-running)" aria-hidden="true"></span>Running
			</h2>
			<div class="pair">
				<NumberField
					label="Weekly distance"
					unit={run.unit}
					bind:value={run.weeklyDistance}
					error={errors['running.weeklyDistance']}
					optional
					data-testid="running-weekly"
				/>
				<NumberField
					label="Runs / week"
					bind:value={run.runsPerWeek}
					error={errors['running.runsPerWeek']}
					optional
				/>
				<NumberField
					label="Longest recent run"
					unit={run.unit}
					bind:value={run.longestRun}
					error={errors['running.longestRun']}
					optional
				/>
				<TextField
					label={`Easy pace / ${run.unit}`}
					bind:value={run.easyPace}
					error={errors['running.easyPaceSeconds']}
					inputmode="numeric"
					placeholder="5:45"
					hint="m:ss, optional"
					data-testid="running-pace"
				/>
			</div>

			<div class="races">
				<h3 class="sub">Recent races</h3>
				{#each run.races as race, i (i)}
					<div class="race" data-testid="race-row">
						<div class="race-head">
							<ChoiceGroup
								legend="Distance"
								hideLegend
								bind:value={race.distance}
								options={distances}
							/>
							<IconButton
								icon="close"
								size="sm"
								label="Remove this race"
								onclick={() => run.races.splice(i, 1)}
							/>
						</div>
						<div class="pair">
							{#if race.distance === 'other'}
								<NumberField
									label="Distance"
									unit={run.unit}
									bind:value={race.customDistance}
									error={errors[`running.races.${i}.customDistance`]}
								/>
							{/if}
							<TextField
								label="Time"
								bind:value={race.time}
								error={errors[`running.races.${i}.timeSeconds`]}
								inputmode="numeric"
								placeholder="1:45:30"
								data-testid="race-time"
							/>
							<TextField
								label="When"
								type="date"
								value={race.racedOn ?? ''}
								oninput={(e) => (race.racedOn = e.currentTarget.value || null)}
								error={errors[`running.races.${i}.racedOn`]}
								hint="Optional"
							/>
						</div>
					</div>
				{/each}
				<Button variant="secondary" icon="plus" size="sm" onclick={addRace} data-testid="add-race"
					>Add a race time</Button
				>
			</div>
		</section>
	{/if}

	{#if value.muayThai}
		{@const mt = value.muayThai}
		<section class="block" aria-labelledby="mt-title" data-testid="muay-thai-section">
			<h2 class="block-title" id="mt-title">
				<span class="dot" style:background="var(--color-combat)" aria-hidden="true"></span>Muay Thai
			</h2>
			<div class="pair">
				<NumberField
					label="Sessions / week"
					bind:value={mt.sessionsPerWeek}
					error={errors['muayThai.sessionsPerWeek']}
					optional
					data-testid="mt-sessions"
				/>
				<NumberField
					label="Sparring / week"
					bind:value={mt.sparringPerWeek}
					error={errors['muayThai.sparringPerWeek']}
					optional
				/>
				<NumberField
					label="Fights so far"
					integer
					bind:value={mt.fights}
					error={errors['muayThai.fights']}
					optional
				/>
			</div>
		</section>
	{/if}
</div>

<style>
	.specifics,
	.block,
	.races,
	.race {
		display: grid;
		gap: var(--space-4);
	}

	.block {
		padding: var(--space-4);
		border-radius: var(--radius-xl);
		border: 1px solid var(--color-border);
		background: var(--color-surface-1);
		box-shadow: var(--elevation-1);
	}

	.block-title {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-family: var(--font-display);
		font-size: var(--text-lg);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-tight);
	}

	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
	}

	.sub {
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		color: var(--color-text-secondary);
	}

	.race {
		padding-top: var(--space-4);
		border-top: 1px solid var(--color-hairline);
	}

	.race-head {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
	}

	.pair {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-3);
	}
</style>
