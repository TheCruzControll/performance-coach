<!--
  @component
  The strength view's logger, loaded right after the first render, as the store is: the set at
  hand prefilled for the exercise the slot performs (prefill.ts's nextSet), in the SetLogger, or
  'All sets logged' once its planned sets are done. Complete set dispatches the set.log and its
  follow-up (log.ts) at once, and records performance.measure('pc:set-confirmed') from the tap
  to the frame after the row changed. At its top, what this device could not save, with
  Retry: the sets stay on screen meanwhile, marked 'Not saved on this device'.
  The prefill's rules (logging, M3's e1RM and load arithmetic, the vocabulary's labels) and the
  mutation builder stay out of /workout's initial JavaScript; the view shows it once the store
  has loaded its workout, so a write is synchronous from the first tap.
-->
<script lang="ts">
	import type { NotSaved, WorkoutStore } from '#lib/client/workout/store.ts';
	import { DEFAULT_LOAD_INCREMENT } from '#lib/domain/units.ts';
	import type { LoggedSet, SlotView, WorkoutView } from '#lib/domain/workout/index.ts';
	import { nextSet, RPE_CHIPS } from '#lib/domain/workout/prefill.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import SetLogger from '#lib/ui/workout/SetLogger.svelte';
	import { loadHint } from '#lib/ui/workout/logger-words.ts';
	import { targetText } from '#lib/ui/workout/set-words.ts';
	import { logSet } from './log.ts';

	interface Props {
		view: WorkoutView;
		slot: SlotView;
		/** Whether a planned set is left to do (the set rows have a current one). */
		open: boolean;
		/** What this device could not save (the store's snapshot), with Retry. */
		notSaved: NotSaved[];
		/** The active workout's store, its workout loaded: a write through it is synchronous. */
		store: WorkoutStore;
	}

	let { view, slot, open, notSaved, store }: Props = $props();

	/** Complete set: the set.log and its follow-up (log.ts), dispatched at once. */
	function complete(setIndex: number, set: LoggedSet, event: MouseEvent) {
		const start = event.timeStamp;
		const { mutation, followUps } = logSet(
			view,
			slot.position,
			setIndex,
			set,
			new Date().toISOString()
		);
		store.dispatch(mutation, ...followUps);
		// The row changes in this task; the frame that shows it comes next.
		requestAnimationFrame(() =>
			performance.measure('pc:set-confirmed', { start, end: performance.now() })
		);
	}

	const retry = async () => {
		for (const { id } of notSaved) await store.retry(id);
	};

	const logger = $derived.by(() => {
		if (!open && slot.kit) return null;
		const exercise = view.exercises[slot.exerciseId];
		// The owner's decision on units (the M4 plan's open question 15), with the plan's default: a
		// set logs in the training profile's weight unit, as the kit carries it, never the device's.
		const unit = view.kit?.units.weight ?? 'kg';
		const performed = {
			exerciseId: slot.exerciseId,
			measure: exercise?.measure ?? 'reps',
			loadType: exercise?.loadType ?? 'external',
			attached: view.device.attached[slot.exerciseId]
		};
		const prefill = nextSet(performed, slot.sets, slot.kit, unit);
		const total = slot.kit?.sets.length;
		const target = prefill.planned && targetText(prefill.planned);
		return {
			prefill,
			key: `${slot.position}:${prefill.setIndex}`,
			heading: [`Set ${prefill.setIndex}${total ? ` of ${total}` : ''}`, target]
				.filter(Boolean)
				.join(' · '),
			hint: loadHint(prefill),
			increment: slot.kit?.exercise.increment ?? DEFAULT_LOAD_INCREMENT[unit]
		};
	});
</script>

<!-- Compact, as the thumb zone's top line: the Notice tones, Retry beside the words. -->
{#snippet unsaved()}
	{#if notSaved.length > 0}
		<div class="unsaved" role="alert" data-testid="not-saved">
			<p class="words">
				<strong>Not saved on this device</strong>
				<span>
					{notSaved.some((n) => n.reason === 'quota')
						? 'The device is out of space.'
						: "This browser couldn't save it."}
				</span>
			</p>
			<Button size="sm" variant="secondary" icon="refresh" onclick={retry}>Retry</Button>
		</div>
	{/if}
{/snippet}

{#if logger}
	<SetLogger
		setKey={logger.key}
		heading={logger.heading}
		fields={logger.prefill.fields}
		values={logger.prefill.values}
		increment={logger.increment}
		loadHint={logger.hint}
		rpeChips={RPE_CHIPS}
		oncomplete={(set, event) => complete(logger.prefill.setIndex, set, event)}
	>
		{@render unsaved()}
	</SetLogger>
{:else}
	{@render unsaved()}
	<p class="all-done" role="status" data-testid="exercise-done">All sets logged</p>
{/if}

<style>
	.unsaved {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2) var(--space-3);
		padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--color-danger) 30%, transparent);
		background: color-mix(in srgb, var(--color-danger) 9%, var(--color-surface-1));
	}

	.words {
		display: grid;
		min-width: 0;
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.words strong {
		color: var(--color-danger);
		font-weight: var(--weight-semibold);
	}

	.all-done {
		padding: var(--space-4);
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border);
		color: var(--color-text-secondary);
		font-weight: var(--weight-medium);
		text-align: center;
	}
</style>
