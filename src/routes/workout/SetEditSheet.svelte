<!--
  @component
  A logged set's editor, in a BottomSheet (a centred dialog from 1024 px): the fields its
  exercise records (logging-rules' setFields: the load, the amount), missed reps on a reps set,
  RPE, and whether it was a warm-up. Save hands back every value (set.edit is absolute); Delete
  asks first, because there is no undo (an undelete would be a new mutation type). A skipped set
  has no values to edit: it offers Delete, after which the set can be logged.
  Code-split: the strength view loads it on intent (a row's hover, focus or touch), so neither it
  nor logging-rules weigh on /workout's initial JavaScript. The sync sheet reuses it as the Fix
  editor for set mutations (`fix`: why the server refused the change, shown first; Discard is the
  sync sheet's, so the editor offers Delete only for a skip).
-->
<script lang="ts">
	import type { LoggedSet } from '#lib/domain/workout/index.ts';
	import { setFields } from '#lib/domain/workout/logging.ts';
	import { RPE_CHIPS } from '#lib/domain/workout/prefill.ts';
	import type { LoadType, Measure } from '#lib/domain/training/vocabulary.ts';
	import { formatDuration } from '#lib/domain/units.ts';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import NumberStepper from '#lib/ui/components/NumberStepper.svelte';
	import Toggle from '#lib/ui/components/Toggle.svelte';
	import RpeChips from '#lib/ui/workout/RpeChips.svelte';
	import {
		AMOUNT_STEPS,
		MISSED_REPS_MAX,
		missingInput,
		NEEDS_AMOUNT,
		NEEDS_WEIGHT,
		parseTime
	} from '#lib/ui/workout/set-input.ts';
	import { tick } from 'svelte';

	interface Props {
		open: boolean;
		/** Which edit this is: a new one starts again from `values`. */
		editKey: string;
		setIndex: number;
		exercise: { name: string; measure: Measure; loadType: LoadType };
		/** The set as it is now. */
		values: LoggedSet;
		skipped: boolean;
		/** The weight step: the exercise's increment. */
		increment: number;
		/** Every value after the edit. */
		onsave: (set: LoggedSet) => void;
		/** Confirmed: the set goes. */
		ondelete: () => void;
		onclose?: () => void;
		/** Fixing a refused change: why it was refused. */
		fix?: string;
	}

	let {
		open = $bindable(),
		editKey,
		setIndex,
		exercise,
		values,
		skipped,
		increment,
		onsave,
		ondelete,
		onclose,
		fix
	}: Props = $props();

	const fields = $derived(setFields(exercise.measure, exercise.loadType));
	const column = $derived(fields.load === 'assistance' ? 'assistance' : 'weight');
	const amount = $derived(fields.amount);

	interface Edits {
		key: string;
		set: Partial<LoggedSet>;
		error: 'load' | 'amount' | null;
		/** Delete was tapped: the confirmation shows. */
		confirming: boolean;
	}
	const fresh = (key: string): Edits => ({ key, set: {}, error: null, confirming: false });
	let edits = $state.raw<Edits>(fresh(''));
	const mine = $derived(edits.key === editKey ? edits : fresh(editKey));
	const set = $derived<LoggedSet>({ ...values, ...mine.set });
	const edit = (change: Partial<LoggedSet>) =>
		(edits = { ...mine, set: { ...mine.set, ...change }, error: null });

	let keep: HTMLDivElement | undefined = $state();

	async function confirmDelete(confirming: boolean) {
		edits = { ...mine, confirming };
		await tick();
		// Focus stays in the footer: on Keep it when asked, else back on Delete.
		keep
			?.querySelector<HTMLElement>(
				confirming ? '[data-testid="keep-set"]' : '[data-testid="delete-set"]'
			)
			?.focus();
	}

	function save() {
		const error = missingInput(fields, set);
		if (error) {
			edits = { ...mine, error };
			return;
		}
		onsave({ ...set, missedReps: amount === 'reps' ? set.missedReps : 0 });
		open = false;
	}

	function remove() {
		ondelete();
		open = false;
	}
</script>

<BottomSheet
	bind:open
	title={skipped ? `Set ${setIndex} · Skipped` : `Edit set ${setIndex}`}
	description={exercise.name}
	{onclose}
	data-testid="set-editor"
>
	{#if fix}
		<p class="fix" data-testid="fix-reason">Not synced · {fix}</p>
	{/if}
	{#if skipped}
		<p class="note">You skipped this set. Delete the skip to log the set instead.</p>
	{:else}
		<div class="fields">
			{#if fields.load}
				<NumberStepper
					label={fields.labels.load ?? 'Weight'}
					value={set[column] ?? 0}
					step={increment}
					bigStep={increment * 4}
					max={1000}
					unit={set.unit}
					decimals={String(increment).split('.')[1]?.length ?? 0}
					error={mine.error === 'load' ? NEEDS_WEIGHT : null}
					onchange={(v) => edit({ [column]: fields.load === 'weight' || v > 0 ? v : null })}
					data-testid="edit-load"
				/>
			{/if}
			<NumberStepper
				label={fields.labels.amount}
				value={set[amount] ?? 0}
				min={AMOUNT_STEPS[amount].min}
				step={AMOUNT_STEPS[amount].step}
				bigStep={AMOUNT_STEPS[amount].bigStep}
				max={AMOUNT_STEPS[amount].max}
				unit={AMOUNT_STEPS[amount].unit}
				format={amount === 'seconds' ? formatDuration : undefined}
				parse={amount === 'seconds' ? parseTime : undefined}
				error={mine.error === 'amount' && amount !== 'reps' ? NEEDS_AMOUNT[amount] : null}
				onchange={(v) => edit({ [amount]: v })}
				data-testid="edit-amount"
			/>
			{#if amount === 'reps'}
				<NumberStepper
					label="Missed reps"
					value={set.missedReps}
					max={MISSED_REPS_MAX}
					hint="Reps you attempted and failed"
					onchange={(v) => edit({ missedReps: v })}
					data-testid="edit-missed"
				/>
			{/if}
			<RpeChips chips={RPE_CHIPS} value={set.rpe} onchange={(rpe) => edit({ rpe })} />
			<Toggle
				label="Warm-up"
				description="A warm-up counts toward no estimated 1RM, volume or record."
				checked={set.isWarmup}
				onchange={(isWarmup) => edit({ isWarmup })}
				data-testid="edit-warmup"
			/>
		</div>
	{/if}

	{#snippet footer()}
		<div class="actions" bind:this={keep}>
			{#if mine.confirming}
				<p class="confirm" role="alert">
					{skipped ? `Delete the skip of set ${setIndex}?` : `Delete set ${setIndex}?`} There's no undo.
				</p>
				<div class="row">
					<Button variant="secondary" onclick={() => confirmDelete(false)} data-testid="keep-set">
						Keep it
					</Button>
					<Button variant="danger" icon="trash" onclick={remove} data-testid="confirm-delete">
						{skipped ? 'Delete skip' : 'Delete set'}
					</Button>
				</div>
			{:else}
				<div class="row">
					{#if !fix || skipped}
						<Button
							variant="ghost"
							icon="trash"
							onclick={() => confirmDelete(true)}
							data-testid="delete-set"
						>
							{skipped ? 'Delete skip' : 'Delete set'}
						</Button>
					{/if}
					{#if !skipped}
						<Button icon="check" onclick={save} data-testid="save-set">Save</Button>
					{/if}
				</div>
			{/if}
		</div>
	{/snippet}
</BottomSheet>

<style>
	.note {
		color: var(--color-text-secondary);
	}

	.fix {
		margin-bottom: var(--space-4);
		color: light-dark(color-mix(in srgb, var(--color-warning) 82%, #000), var(--color-warning));
		font-weight: var(--weight-medium);
	}

	.fields {
		display: grid;
		gap: var(--space-4);
		container-type: inline-size;
	}

	/*
	 * Each stepper on one row where the sheet has room (the label beside the controls, the hint
	 * under both), as the logger's are on a phone, so the whole set fits without scrolling; at a
	 * larger text size they stack as usual.
	 */
	@container (width >= 21rem) {
		.fields > :global(.stepper) {
			grid-template-columns: minmax(0, 1fr) auto;
			align-items: center;
			column-gap: var(--space-3);
			row-gap: var(--space-1);
		}

		.fields > :global(.stepper > .label),
		.fields > :global(.stepper > .hint) {
			text-align: start;
		}

		.fields > :global(.stepper > .hint) {
			grid-column: 1 / -1;
		}

		.fields :global(.row) {
			gap: var(--space-2);
		}

		/* Room for most values, so the controls keep their place as the value changes. */
		.fields :global(.value-wrap) {
			min-width: 7.5rem;
		}

		.fields :global(.value) {
			font-size: var(--text-3xl);
		}
	}

	.actions {
		display: grid;
		gap: var(--space-3);
	}

	.confirm {
		font-weight: var(--weight-semibold);
		color: var(--color-danger);
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.row > :global(:last-child) {
		flex: 1;
		max-width: 14rem;
		margin-left: auto;
	}
</style>
