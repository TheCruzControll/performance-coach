<!--
  @component
  Add or edit one goal in a bottom sheet, which GoalsEditor loads on first intent. Either kind
  has a name and its disciplines (your own one included). An event goal adds the event
  (suggested for the disciplines picked), its date, a weight class, a target and its
  requirements; a general goal adds what to improve, how it is measured and a target date.
  Switching kind keeps what was typed for the other, but only the chosen kind's fields are
  saved. Checked with the shared schema, then saved through the route's `?/saveGoal` action,
  which answers with the ranking. On Profile (`manage`) a stored goal's status changes here too.
  A stored goal is deleted through `?/deleteGoal`, after a second tap that says it is for good.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { focusFirstError, save } from '#lib/client/profile-form.ts';
	import {
		DISCIPLINES,
		DISCIPLINE_INFO,
		EVENT_TYPE_SUGGESTIONS,
		GOAL_STATUSES,
		GOAL_STATUS_LABEL
	} from '#lib/domain/profile/catalog.ts';
	import type { FieldErrors } from '#lib/domain/profile/schemas.ts';
	import type { Goal } from '#lib/domain/profile/types.ts';
	import BottomSheet from '../components/BottomSheet.svelte';
	import Button from '../components/Button.svelte';
	import ChoiceGroup from '../components/ChoiceGroup.svelte';
	import Notice from '../components/Notice.svelte';
	import SegmentedControl from '../components/SegmentedControl.svelte';
	import TextArea from '../components/TextArea.svelte';
	import TextField from '../components/TextField.svelte';
	import type { GoalDraft } from './goals';

	interface Props {
		open: boolean;
		/** What it edits: a stored goal's draft or a new one. */
		draft: GoalDraft;
		/** Profile: a stored goal's status can change too. */
		manage?: boolean;
		/** Saved: the goals as the services rank them. */
		onsaved: (goals: Goal[]) => void;
		/** Deleted: the goals left, as the services rank them. */
		ondeleted: (goals: Goal[]) => void;
	}

	let { open = $bindable(), draft, manage = false, onsaved, ondeleted }: Props = $props();
	const id = $props.id();

	// The draft is read once: another goal is another sheet (GoalsEditor mounts one per draft),
	// so an edit is kept only once it is saved.
	const start = () => ({ ...draft, disciplines: [...draft.disciplines] });
	let goal = $state(start());
	let errors = $state<FieldErrors>({});
	let failed = $state<string | null>(null);
	let busy = $state(false);
	let deleting = $state(false);
	/** Delete was tapped once: the next tap deletes the goal for good. */
	let confirming = $state(false);
	let fields = $state<HTMLElement>();
	let warning = $state<HTMLElement>();

	const disciplines = DISCIPLINES.map((d) => ({
		value: d,
		label: DISCIPLINE_INFO[d].short,
		tone: DISCIPLINE_INFO[d].tone
	}));
	const statuses = GOAL_STATUSES.map((s) => ({ value: s, label: GOAL_STATUS_LABEL[s] }));
	const kinds: { value: GoalDraft['kind']; label: string }[] = [
		{ value: 'event', label: 'Event' },
		{ value: 'general', label: 'General' }
	];
	const suggestions = $derived(
		[...new Set(goal.disciplines.flatMap((d) => EVENT_TYPE_SUGGESTIONS[d]))].slice(0, 6)
	);

	/** The errors on screen were said about the other kind's fields; Save checks this one. */
	function switched() {
		errors = {};
		failed = null;
	}

	async function submit(event: MouseEvent) {
		const button = event.currentTarget as HTMLElement;
		busy = true;
		failed = null;
		// Posted as a JSON copy: `$state.snapshot` would add its helper to every route's runtime.
		const payload = JSON.parse(JSON.stringify(goal)) as GoalDraft;
		const outcome = await save<{ goals: Goal[] }>('?/saveGoal', payload, 'goal');
		busy = false;
		errors = outcome.errors;
		if (outcome.ok) {
			if (outcome.data) onsaved(outcome.data.goals);
			return;
		}
		const invalid = Object.keys(errors).length > 0;
		failed = outcome.failed ?? errors[''] ?? (invalid ? 'Check the highlighted fields.' : null);
		if (invalid) return focusFirstError(fields);
		await refocus(button);
	}

	async function remove(event: MouseEvent) {
		if (!confirming) {
			confirming = true;
			// What a second tap does is said under the button: bring it into view too.
			await tick();
			warning?.scrollIntoView({ block: 'nearest' });
			return;
		}
		const button = event.currentTarget as HTMLElement;
		deleting = true;
		failed = null;
		const outcome = await save<{ goals: Goal[] }>('?/deleteGoal', { id: goal.id });
		deleting = false;
		if (outcome.ok) {
			if (outcome.data) ondeleted(outcome.data.goals);
			return;
		}
		failed = outcome.failed ?? 'That didn’t delete. Try again.';
		await refocus(button);
	}

	/** A button is disabled while it posts, which drops keyboard focus: give it back. */
	async function refocus(button: HTMLElement) {
		await tick();
		if (document.activeElement === document.body) button.focus();
	}
</script>

<BottomSheet
	bind:open
	title={goal.id ? 'Edit goal' : 'New goal'}
	description={goal.kind === 'event'
		? 'Something with a date: a meet, race, fight or test.'
		: 'Something to improve, and how you’ll know it’s working.'}
	{footer}
	data-testid="goal-sheet"
>
	<div class="fields" bind:this={fields}>
		<SegmentedControl
			label="Kind of goal"
			bind:value={goal.kind}
			options={kinds}
			onchange={switched}
			data-testid="goal-kind"
		/>
		<TextField
			label="Goal"
			bind:value={goal.title}
			error={errors.title}
			placeholder={goal.kind === 'event' ? 'First Muay Thai fight' : 'A stronger deadlift'}
			maxlength={80}
		/>
		<ChoiceGroup
			legend="Disciplines"
			multiple
			bind:values={goal.disciplines}
			error={errors.disciplines}
			options={disciplines}
		/>
		{#if goal.disciplines.includes('custom')}
			<TextField
				label="Name your discipline"
				bind:value={goal.customDiscipline}
				error={errors.customDiscipline}
				placeholder="Bouldering"
				maxlength={40}
			/>
		{/if}
		{#if goal.kind === 'event'}
			<div class="event">
				<TextField
					label="Event"
					bind:value={goal.eventType}
					error={errors.eventType}
					placeholder="A fight, a marathon, a meet…"
					maxlength={60}
				/>
				{#if suggestions.length}
					<div class="suggestions" role="group" aria-label="Suggested events">
						{#each suggestions as suggestion (suggestion)}
							<Button variant="secondary" size="sm" onclick={() => (goal.eventType = suggestion)}>
								{suggestion}
							</Button>
						{/each}
					</div>
				{/if}
			</div>
			<TextField
				label="Event date"
				type="date"
				bind:value={goal.eventDate}
				error={errors.eventDate}
			/>
			<TextField
				label="Weight class"
				bind:value={goal.weightClass}
				error={errors.weightClass}
				optional
				placeholder="−71 kg"
				maxlength={40}
			/>
			<TextField
				label="Target"
				bind:value={goal.targetPerformance}
				error={errors.targetPerformance}
				optional
				placeholder="Sub 3:30, a 200 kg total, win by decision…"
				maxlength={200}
			/>
			<TextArea
				label="Requirements or constraints"
				bind:value={goal.requirements}
				error={errors.requirements}
				optional
				rows={2}
				placeholder="Make weight the day before; rules; travel…"
				maxlength={500}
			/>
		{:else}
			<TextField
				label="What to improve"
				bind:value={goal.focus}
				error={errors.focus}
				placeholder="Deadlift strength, 10K pace, upper-body size…"
				maxlength={200}
			/>
			<TextField
				label="How it’s measured"
				bind:value={goal.measure}
				error={errors.measure}
				placeholder="e1RM trend, a 10K time trial, the tape…"
				maxlength={200}
			/>
			<TextField
				label="Target date"
				type="date"
				bind:value={goal.targetDate}
				error={errors.targetDate}
				optional
			/>
		{/if}
		{#if manage && goal.id}
			<ChoiceGroup
				legend="Status"
				hint="A paused goal keeps its rank. Achieved and dropped goals move to Past goals."
				bind:value={goal.status}
				error={errors.status}
				options={statuses}
				data-testid="goal-status"
			/>
		{/if}
		{#if goal.id}
			<div class="delete">
				<Button
					variant={confirming ? 'danger' : 'secondary'}
					icon="trash"
					loading={deleting}
					disabled={busy}
					onclick={remove}
					aria-describedby={confirming ? `${id}-delete` : undefined}
					data-testid="goal-delete"
				>
					{confirming ? 'Delete for good' : 'Delete goal'}
				</Button>
				<div aria-live="polite">
					{#if confirming}
						<p class="warning" id="{id}-delete" bind:this={warning}>
							Deleting can’t be undone.{manage
								? ' To keep it under Past goals, mark it achieved or dropped instead.'
								: ''}
						</p>
					{/if}
				</div>
			</div>
		{/if}
	</div>
</BottomSheet>

{#snippet footer()}
	<div class="actions">
		{#if failed}<Notice tone="danger" data-testid="goal-sheet-error">{failed}</Notice>{/if}
		<Button block loading={busy} disabled={deleting} onclick={submit} data-testid="goal-save">
			Save goal
		</Button>
	</div>
{/snippet}

<style>
	.fields {
		display: grid;
		gap: var(--space-5);
		padding-bottom: var(--space-2);
	}

	.event,
	.actions {
		display: grid;
		gap: var(--space-3);
	}

	.suggestions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	/* Apart from the fields: deleting is not an edit. */
	.delete {
		display: grid;
		justify-items: start;
		padding-top: var(--space-5);
		border-top: 1px solid var(--color-border);
	}

	.warning {
		margin-top: var(--space-2);
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}
</style>
