<!--
  @component
  Add or edit one goal in a bottom sheet (code-split: loaded on first intent by GoalsEditor).
  Event goals ask for the event, its date, weight class, target and constraints; general goals
  for what to improve and how progress is measured. Validated with the shared schema, saved
  through the page's `?/saveGoal` action.
-->
<script module lang="ts">
	import type { Goal } from '#lib/domain/profile/types.ts';
	import type { GoalDraft } from './forms';

	export interface GoalSheetProps {
		open: boolean;
		draft: GoalDraft | null;
		manage?: boolean;
		onsaved: (goals: Goal[]) => void;
		ondeleted: (goals: Goal[]) => void;
	}
</script>

<script lang="ts">
	import { save } from '#lib/client/profile-form.ts';
	import {
		DISCIPLINES,
		DISCIPLINE_INFO,
		EVENT_TYPE_SUGGESTIONS,
		GOAL_STATUSES,
		GOAL_STATUS_LABEL
	} from '#lib/domain/profile/catalog.ts';
	import type { FieldErrors } from '#lib/domain/profile/schemas.ts';
	import BottomSheet from '../components/BottomSheet.svelte';
	import Button from '../components/Button.svelte';
	import ChoiceGroup from '../components/ChoiceGroup.svelte';
	import Notice from '../components/Notice.svelte';
	import SegmentedControl from '../components/SegmentedControl.svelte';
	import TextArea from '../components/TextArea.svelte';
	import TextField from '../components/TextField.svelte';
	import { newGoal } from './forms';

	let { open = $bindable(), draft, manage = false, onsaved, ondeleted }: GoalSheetProps = $props();

	// The working copy: switching kind keeps what both kinds share.
	let goal = $state<GoalDraft>(newGoal('event'));
	let errors = $state<FieldErrors>({});
	let failed = $state<string | null>(null);
	let busy = $state(false);
	let confirmDelete = $state(false);

	$effect.pre(() => {
		if (open && draft) {
			goal = structuredClone($state.snapshot(draft)) as GoalDraft;
			errors = {};
			failed = null;
			confirmDelete = false;
		}
	});

	function setKind(kind: 'event' | 'general') {
		goal.kind = kind;
	}

	const suggestions = $derived(
		[...new Set(goal.disciplines.flatMap((d) => EVENT_TYPE_SUGGESTIONS[d]))].slice(0, 4)
	);

	async function submit() {
		busy = true;
		failed = null;
		const outcome = await save<{ goals: Goal[] }>('?/saveGoal', goal, 'goal');
		busy = false;
		errors = outcome.errors;
		if (outcome.ok && outcome.data) onsaved(outcome.data.goals);
		else
			failed =
				outcome.failed ?? (Object.keys(errors).length ? 'Check the highlighted fields.' : null);
	}

	async function remove() {
		if (!confirmDelete) {
			confirmDelete = true;
			return;
		}
		busy = true;
		const outcome = await save<{ goals: Goal[] }>('?/deleteGoal', { id: goal.id });
		busy = false;
		if (outcome.ok && outcome.data) ondeleted(outcome.data.goals);
		else failed = outcome.failed ?? 'Couldn’t delete the goal. Try again.';
	}
</script>

<BottomSheet
	bind:open
	title={goal.id ? 'Edit goal' : 'New goal'}
	description={goal.kind === 'event'
		? 'Something with a date: a meet, race, fight or test.'
		: 'Something to improve, and how you’ll know it’s working.'}
	data-testid="goal-sheet"
>
	<div class="form">
		<SegmentedControl
			label="Kind of goal"
			value={goal.kind}
			onchange={setKind}
			options={[
				{ value: 'event', label: 'Event' },
				{ value: 'general', label: 'General' }
			]}
			data-testid="goal-kind"
		/>
		<TextField
			label="Goal"
			bind:value={goal.title}
			error={errors.title}
			placeholder={goal.kind === 'event' ? 'First Muay Thai fight' : 'Build a stronger deadlift'}
			maxlength={80}
			data-testid="goal-title-input"
		/>
		<ChoiceGroup
			legend="Disciplines"
			multiple
			bind:values={goal.disciplines}
			error={errors.disciplines}
			options={DISCIPLINES.map((d) => ({
				value: d,
				label: DISCIPLINE_INFO[d].short,
				tone: DISCIPLINE_INFO[d].tone
			}))}
			data-testid="goal-disciplines"
		/>
		{#if goal.disciplines.includes('custom')}
			<TextField
				label="Name your discipline"
				value={goal.customDiscipline ?? ''}
				oninput={(e) => (goal.customDiscipline = e.currentTarget.value)}
				error={errors.customDiscipline}
				placeholder="Bouldering"
				maxlength={40}
			/>
		{/if}

		{#if goal.kind === 'event'}
			<div class="with-suggestions">
				<TextField
					label="Event"
					bind:value={goal.eventType}
					error={errors.eventType}
					placeholder="Muay Thai fight, marathon, meet…"
					maxlength={60}
					data-testid="goal-event-type"
				/>
				{#if suggestions.length}
					<div class="suggestions" role="group" aria-label="Suggestions">
						{#each suggestions as s (s)}
							<button type="button" class="suggestion" onclick={() => (goal.eventType = s)}
								>{s}</button
							>
						{/each}
					</div>
				{/if}
			</div>
			<TextField
				label="Date"
				type="date"
				bind:value={goal.eventDate}
				error={errors.eventDate}
				data-testid="goal-event-date"
			/>
			<div class="pair">
				<TextField
					label="Weight class"
					value={goal.weightClass ?? ''}
					oninput={(e) => (goal.weightClass = e.currentTarget.value)}
					hint="If there is one"
					placeholder="−71 kg"
					maxlength={40}
				/>
				<TextField
					label="Target"
					value={goal.targetPerformance ?? ''}
					oninput={(e) => (goal.targetPerformance = e.currentTarget.value)}
					hint="Optional"
					placeholder="Sub 3:30, a 200 kg total…"
					maxlength={200}
					data-testid="goal-target"
				/>
			</div>
			<TextArea
				label="Requirements or constraints"
				bind:value={() => goal.requirements ?? '', (v) => (goal.requirements = v || null)}
				error={errors.requirements}
				optional
				rows={2}
				placeholder="Make weight the day before; rules; travel…"
				maxlength={500}
			/>
		{:else}
			<TextField
				label="What do you want to improve?"
				bind:value={goal.focus}
				error={errors.focus}
				placeholder="Deadlift strength, upper-body size, 10K pace…"
				maxlength={200}
				data-testid="goal-focus"
			/>
			<TextField
				label="How will you measure progress?"
				bind:value={goal.measure}
				error={errors.measure}
				placeholder="e1RM trend, tape measure, a time trial…"
				maxlength={200}
				data-testid="goal-measure"
			/>
			<TextField
				label="Target date"
				type="date"
				value={goal.targetDate ?? ''}
				oninput={(e) => (goal.targetDate = e.currentTarget.value || null)}
				error={errors.targetDate}
				hint="Optional"
			/>
		{/if}

		{#if manage && goal.id}
			<ChoiceGroup
				legend="Status"
				bind:value={() => goal.status ?? 'active', (v) => (goal.status = v ?? 'active')}
				options={GOAL_STATUSES.map((s) => ({ value: s, label: GOAL_STATUS_LABEL[s] }))}
				hint="Achieved and dropped goals leave the ranking but stay in your history."
				data-testid="goal-status"
			/>
		{/if}

		{#if failed}<Notice tone="danger" data-testid="goal-sheet-error">{failed}</Notice>{/if}
	</div>

	{#snippet footer()}
		<div class="actions">
			{#if goal.id}
				<Button variant="danger" onclick={remove} disabled={busy} data-testid="goal-delete"
					>{confirmDelete ? 'Delete for good' : 'Delete'}</Button
				>
			{/if}
			<Button block loading={busy} onclick={submit} data-testid="goal-save">Save goal</Button>
		</div>
	{/snippet}
</BottomSheet>

<style>
	.form {
		display: grid;
		gap: var(--space-5);
		padding-bottom: var(--space-2);
	}

	.with-suggestions {
		display: grid;
		gap: var(--space-2);
	}

	.suggestions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.suggestion {
		min-height: var(--touch-target);
		padding: 0 var(--space-3);
		border-radius: var(--radius-full);
		border: 1px dashed var(--color-border-strong);
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.pair {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-3);
	}

	.actions {
		display: flex;
		gap: var(--space-2);
	}
</style>
