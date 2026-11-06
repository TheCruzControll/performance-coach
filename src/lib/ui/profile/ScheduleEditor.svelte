<!--
  @component
  Profile → Schedule: how many days a week and how long, the days the owner can train and when,
  and the commitments already in the week (Muay Thai classes on Tue/Thu, a club run) that the
  plan is built around. With nothing saved, the two steppers show a suggestion and say so: Save
  keeps it, and changing one makes it the owner's own.

  Radios cannot be cleared, so a commitment's optional single choices each have a way back:
  its time starts unpicked and "It varies" is the answer for no fixed time; its intensity
  offers "Not sure", which stores none.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import {
		DISCIPLINE_INFO,
		INTENSITIES,
		TIMES_OF_DAY,
		TIME_OF_DAY_LABEL
	} from '#lib/domain/profile/catalog.ts';
	import type { FieldErrors } from '#lib/domain/profile/schemas.ts';
	import Button from '../components/Button.svelte';
	import ChoiceGroup from '../components/ChoiceGroup.svelte';
	import DayPicker from '../components/DayPicker.svelte';
	import Icon from '../components/Icon.svelte';
	import IconButton from '../components/IconButton.svelte';
	import Notice from '../components/Notice.svelte';
	import NumberField from '../components/NumberField.svelte';
	import NumberStepper from '../components/NumberStepper.svelte';
	import Section from '../components/Section.svelte';
	import Surface from '../components/Surface.svelte';
	import TextArea from '../components/TextArea.svelte';
	import TextField from '../components/TextField.svelte';
	import type { EditorProps } from './editors';
	import {
		SUGGESTED,
		blankCommitment,
		commitmentDisciplines,
		commitmentErrors,
		commitmentSummary,
		suggestedDays,
		type CommitmentDraft,
		type ScheduleDraft
	} from './schedule';

	let { value = $bindable(), errors = {}, context }: EditorProps<ScheduleDraft> = $props();

	/** The schema's limit (src/lib/domain/profile/schemas.ts). */
	const MAX_COMMITMENTS = 20;
	const uid = $props.id();
	const times = TIMES_OF_DAY.map((t) => ({ value: t, label: TIME_OF_DAY_LABEL[t] }));
	const intensities = [
		...INTENSITIES.map((i) => ({ value: i, label: i[0]!.toUpperCase() + i.slice(1) })),
		{ value: 'unsure' as const, label: 'Not sure' }
	];
	const disciplines = (c: CommitmentDraft) =>
		commitmentDisciplines(context.disciplines, c.discipline).map((d) => ({
			value: d,
			label: d === 'custom' ? DISCIPLINE_INFO[d].label : DISCIPLINE_INFO[d].short,
			tone: DISCIPLINE_INFO[d].tone
		}));
	const nameOf = (c: CommitmentDraft) => c.label.trim() || 'New commitment';

	/**
	 * A save's errors, pinned to the cards that were there when they came back (and only then:
	 * not again when cards come and go), so a card removed afterwards takes its errors with it
	 * instead of handing them to the card that moves up.
	 */
	let pinnedFrom: FieldErrors | undefined;
	let pinned: Record<string, FieldErrors> = {};
	const cardErrors = $derived.by(() => {
		if (errors !== pinnedFrom) {
			pinnedFrom = errors;
			pinned = commitmentErrors(errors, value.commitments);
		}
		return pinned;
	});

	let root = $state<HTMLElement>();
	let announcement = $state('');
	let timer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => () => clearTimeout(timer));

	/** Clear, then set: a live region speaks only when its text changes, even to the same words. */
	function announce(text: string) {
		announcement = '';
		clearTimeout(timer);
		timer = setTimeout(() => (announcement = text), 100);
	}

	const cards = () => [...(root?.querySelectorAll<HTMLElement>('.commitment') ?? [])];

	async function add() {
		value.commitments.push(blankCommitment(context.disciplines, value.commitments));
		announce('Added a commitment');
		await tick();
		// Straight to what the new card needs first: its name.
		const field = cards().at(-1)?.querySelector('input');
		field?.focus({ preventScroll: true });
		field?.scrollIntoView({ block: 'center' });
	}

	async function remove(index: number) {
		const removed = value.commitments[index]!;
		const focused = cards()[index]?.contains(document.activeElement);
		value.commitments.splice(index, 1);
		announce(`Removed ${nameOf(removed)}`);
		if (!focused) return;
		// Keep keyboard focus in the list: the next card's Remove, else the one before, else Add.
		await tick();
		const next = cards()[index] ?? cards()[index - 1];
		(next ?? root)?.querySelector<HTMLElement>(next ? '.head button' : '.add button')?.focus();
	}
</script>

<div class="schedule" bind:this={root}>
	<Surface padding="lg" radius="xl">
		<div class="week">
			<NumberStepper
				label="Training days a week"
				bind:value={
					() => value.daysPerWeek ?? suggestedDays(value.availableDays),
					(days) => (value.daysPerWeek = days)
				}
				min={1}
				max={7}
				hint={value.daysPerWeek === null
					? 'Suggested to start: keep it or change it. Lifting, runs and classes all count.'
					: 'Lifting, runs and classes all count.'}
				error={errors.daysPerWeek}
				data-testid="days-per-week"
			/>
			<hr class="rule" />
			<NumberStepper
				label="Session length"
				unit="min"
				bind:value={
					() => value.sessionMinutes ?? SUGGESTED.sessionMinutes,
					(minutes) => (value.sessionMinutes = minutes)
				}
				min={10}
				max={300}
				step={5}
				bigStep={15}
				hint={value.sessionMinutes === null
					? 'Suggested to start: keep it or change it. Warm-up included.'
					: 'A typical session, warm-up included.'}
				error={errors.sessionMinutes}
				data-testid="session-minutes"
			/>
		</div>
	</Surface>

	<DayPicker
		legend="Days you can train"
		bind:value={value.availableDays}
		hint="Leave them all clear if any day works."
		error={errors.availableDays}
		data-testid="available-days"
	/>
	<ChoiceGroup
		legend="Best times to train"
		hint="Pick any that usually work."
		multiple
		bind:values={value.preferredTimes}
		options={times}
		error={errors.preferredTimes}
		data-testid="preferred-times"
	/>

	<Section title="Already in your week" gap="md" data-testid="commitments">
		<p class="note">Classes, club runs, team training: the plan is built around them.</p>
		{#if errors.commitments}
			<Notice tone="danger">{errors.commitments}</Notice>
		{/if}
		{#each value.commitments as c, i (c.key)}
			{@const name = nameOf(c)}
			{@const own = cardErrors[c.key] ?? {}}
			{@const summary = commitmentSummary(c)}
			<Surface
				as="section"
				radius="xl"
				tone={DISCIPLINE_INFO[c.discipline].tone}
				class="commitment"
				aria-labelledby="{uid}-{c.key}"
				data-testid="commitment"
			>
				<div class="card">
					<header class="head">
						<span class="dot" aria-hidden="true"></span>
						<div class="titles">
							<h3 class="title" id="{uid}-{c.key}">{name}</h3>
							<p class="summary">{summary || 'Pick its days below'}</p>
						</div>
						<IconButton icon="trash" size="sm" label="Remove {name}" onclick={() => remove(i)} />
					</header>
					<TextField
						label="What is it?"
						bind:value={c.label}
						error={own.label}
						placeholder="Muay Thai class"
						maxlength={60}
						data-testid="commitment-label"
					/>
					<ChoiceGroup
						legend="Discipline"
						bind:value={c.discipline}
						error={own.discipline}
						options={disciplines(c)}
					/>
					<DayPicker legend="Days" bind:value={c.days} error={own.days} />
					<ChoiceGroup
						legend="Time"
						bind:value={c.timeOfDay}
						error={own.timeOfDay}
						options={times}
					/>
					<div class="length">
						<NumberField
							label="Length"
							unit="min"
							integer
							optional
							bind:value={c.durationMinutes}
							error={own.durationMinutes}
						/>
					</div>
					<ChoiceGroup
						legend="Intensity"
						bind:value={
							() => c.intensity ?? 'unsure', (v) => (c.intensity = v && v !== 'unsure' ? v : null)
						}
						error={own.intensity}
						options={intensities}
					/>
				</div>
			</Surface>
		{:else}
			<div class="empty" data-testid="no-commitments">
				<Icon name="clock" size={20} />
				<p>Nothing fixed in your week yet.</p>
			</div>
		{/each}
		<div class="add">
			<Button
				variant="secondary"
				icon="plus"
				block
				disabled={value.commitments.length >= MAX_COMMITMENTS}
				onclick={add}
				data-testid="add-commitment">Add a class or commitment</Button
			>
			{#if value.commitments.length >= MAX_COMMITMENTS}
				<p class="note">That’s the most the coach plans around.</p>
			{/if}
		</div>
		<p class="visually-hidden" role="status">{announcement}</p>
	</Section>

	<TextArea
		label="Anything else about your schedule?"
		bind:value={() => value.constraints ?? '', (text) => (value.constraints = text || null)}
		error={errors.constraints}
		optional
		rows={2}
		placeholder="Night shifts every other week; travel in March…"
		maxlength={500}
	/>
</div>

<style>
	.schedule {
		display: grid;
		gap: var(--space-6);
	}

	.week {
		display: grid;
		gap: var(--space-5);
	}

	.rule {
		margin: 0;
		border: 0;
		border-top: 1px solid var(--color-hairline);
	}

	.note {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.card {
		display: grid;
		gap: var(--space-5);
	}

	.head {
		display: flex;
		align-items: flex-start;
		gap: var(--space-3);
	}

	.dot {
		flex: none;
		width: 8px;
		height: 8px;
		margin-top: 0.5rem;
		border-radius: 50%;
		/* The card's discipline colour (Surface sets it). */
		background: var(--tone);
	}

	.titles {
		flex: 1;
		display: grid;
		gap: var(--space-0-5);
		min-width: 0;
	}

	.title {
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-tight);
		overflow-wrap: anywhere;
	}

	.summary {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.length {
		max-width: 11rem;
	}

	.empty {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-height: 4rem;
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-xl);
		border: 1px dashed var(--color-border-strong);
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.add {
		display: grid;
		gap: var(--space-2);
	}
</style>
