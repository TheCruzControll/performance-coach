<!--
  @component
  Schedule and availability: how many days, which days, when, how long — and the commitments
  already in the week (e.g. Muay Thai classes Tue/Thu) so the plan is built around them.
-->
<script lang="ts">
	import {
		DISCIPLINE_INFO,
		INTENSITIES,
		TIMES_OF_DAY,
		TIME_OF_DAY_LABEL,
		type Discipline
	} from '#lib/domain/profile/catalog.ts';
	import type { CommitmentInput, FieldErrors } from '#lib/domain/profile/schemas.ts';
	import Button from '../components/Button.svelte';
	import ChoiceGroup from '../components/ChoiceGroup.svelte';
	import DayPicker from '../components/DayPicker.svelte';
	import IconButton from '../components/IconButton.svelte';
	import NumberField from '../components/NumberField.svelte';
	import NumberStepper from '../components/NumberStepper.svelte';
	import TextArea from '../components/TextArea.svelte';
	import TextField from '../components/TextField.svelte';

	export interface ScheduleDraft {
		daysPerWeek: number;
		availableDays: CommitmentInput['days'];
		preferredTimes: (typeof TIMES_OF_DAY)[number][];
		sessionMinutes: number;
		constraints: string | null;
		commitments: CommitmentInput[];
	}

	interface Props {
		value: ScheduleDraft;
		disciplines: Discipline[];
		errors?: FieldErrors;
	}

	let { value = $bindable(), disciplines, errors = {} }: Props = $props();

	const times = TIMES_OF_DAY.map((t) => ({ value: t, label: TIME_OF_DAY_LABEL[t] }));
	const intensities = INTENSITIES.map((t) => ({
		value: t,
		label: t[0]!.toUpperCase() + t.slice(1)
	}));
	const commitmentDisciplines = $derived(
		[...new Set<Discipline>([...disciplines, 'muay_thai', 'running', 'athletic'])].map((d) => ({
			value: d,
			label: DISCIPLINE_INFO[d].short,
			tone: DISCIPLINE_INFO[d].tone
		}))
	);

	function addCommitment() {
		const muayThai = disciplines.includes('muay_thai');
		value.commitments.push({
			discipline: muayThai ? 'muay_thai' : (disciplines[0] ?? 'athletic'),
			label: muayThai ? 'Muay Thai class' : '',
			days: [],
			timeOfDay: null,
			durationMinutes: muayThai ? 90 : null,
			intensity: null,
			notes: null
		});
	}

	const err = (i: number, field: string) => errors[`commitments.${i}.${field}`];
</script>

<div class="schedule">
	<section class="block">
		<NumberStepper
			label="Training days a week"
			bind:value={value.daysPerWeek}
			min={1}
			max={7}
			hint={errors.daysPerWeek ?? 'Lifting, running and classes all count.'}
			data-testid="days-per-week"
		/>
	</section>
	<DayPicker
		legend="Days you can train"
		bind:value={value.availableDays}
		hint="Leave empty if any day works."
		error={errors.availableDays}
		data-testid="available-days"
	/>
	<ChoiceGroup
		legend="Best time of day"
		multiple
		bind:values={value.preferredTimes}
		options={times}
		error={errors.preferredTimes}
		data-testid="preferred-times"
	/>
	<section class="block">
		<NumberStepper
			label="Session length"
			unit="min"
			bind:value={value.sessionMinutes}
			min={15}
			max={240}
			step={5}
			bigStep={15}
			hint={errors.sessionMinutes ?? 'A typical session, warm-up included.'}
			data-testid="session-minutes"
		/>
	</section>

	<section class="commitments" aria-labelledby="commitments-title">
		<h2 class="title" id="commitments-title">Already in your week</h2>
		<p class="note">Classes, club runs, team training — the plan is built around them.</p>
		{#each value.commitments as c, i (i)}
			<div class="commitment" data-testid="commitment">
				<div class="head">
					<TextField
						label="What"
						bind:value={c.label}
						error={err(i, 'label')}
						placeholder="Muay Thai class"
						maxlength={60}
						data-testid="commitment-label"
					/>
					<IconButton
						icon="trash"
						size="sm"
						label={`Remove ${c.label || 'this commitment'}`}
						onclick={() => value.commitments.splice(i, 1)}
					/>
				</div>
				<ChoiceGroup
					legend="Discipline"
					bind:value={c.discipline}
					options={commitmentDisciplines}
				/>
				<DayPicker
					legend="Days"
					bind:value={c.days}
					error={err(i, 'days')}
					data-testid="commitment-days"
				/>
				<ChoiceGroup legend="Time" bind:value={c.timeOfDay} options={times} />
				<div class="pair">
					<NumberField
						label="Minutes"
						integer
						bind:value={c.durationMinutes}
						error={err(i, 'durationMinutes')}
						optional
					/>
					<ChoiceGroup legend="Intensity" bind:value={c.intensity} options={intensities} />
				</div>
			</div>
		{/each}
		<Button
			variant="secondary"
			icon="plus"
			block
			onclick={addCommitment}
			data-testid="add-commitment">Add a class or commitment</Button
		>
	</section>

	<TextArea
		label="Anything else about your schedule?"
		bind:value={() => value.constraints ?? '', (v) => (value.constraints = v || null)}
		error={errors.constraints}
		optional
		rows={2}
		placeholder="Night shifts every other week; travel in March…"
		maxlength={500}
	/>
</div>

<style>
	.schedule,
	.commitments,
	.commitment {
		display: grid;
		gap: var(--space-5);
	}

	.block {
		padding: var(--space-4);
		border-radius: var(--radius-xl);
		border: 1px solid var(--color-border);
		background: var(--color-surface-1);
		box-shadow: var(--elevation-1);
	}

	.commitments {
		gap: var(--space-3);
	}

	.title {
		font-family: var(--font-display);
		font-size: var(--text-lg);
		font-weight: var(--weight-bold);
	}

	.note {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.commitment {
		padding: var(--space-4);
		border-radius: var(--radius-xl);
		border: 1px solid var(--color-border);
		background: var(--color-surface-1);
	}

	.head {
		display: flex;
		align-items: flex-end;
		gap: var(--space-2);
	}

	.head > :global(:first-child) {
		flex: 1;
	}

	.pair {
		display: grid;
		grid-template-columns: 1fr 1.4fr;
		gap: var(--space-3);
		align-items: start;
	}
</style>
