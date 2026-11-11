<!--
  @component
  The strength view's logger, loaded once the first render has painted, as the store is: the set at
  hand prefilled for the exercise the slot performs (prefill.ts's nextSet), in the SetLogger, or
  'All sets logged' once its planned sets are done, with Add a set (an extra set beyond the plan,
  one at a time, with Cancel). Skip set skips the planned set at hand, and Missed reps records
  the misses, prefilled from its target. Complete set dispatches the set.log and its
  follow-ups (log.ts: the move, and the rest the device's settings start) at once, as Skip set does the set.skip, and records performance.measure('pc:set-confirmed') from the tap
  to the frame after the row changed. At its top, what this device could not save, with
  Retry: the sets stay on screen meanwhile, marked 'Not saved on this device'.
  The prefill's rules (logging, M3's e1RM and load arithmetic, the vocabulary's labels) and the
  mutation builder stay out of /workout's initial JavaScript. The view shows it as soon as it has
  loaded (performance.mark('pc:logger-ready'), once per page); a write is synchronous once the
  store has loaded its workout, and a tap before then waits for it (ActiveWorkout.write): Complete
  set or Skip set once per set, however often it is tapped meanwhile, on the workout as the store
  has it, at the time of the tap.
-->
<script lang="ts">
	import { readWorkoutSettings } from '#lib/client/workout/settings.ts';
	import type { StoreWrite } from '#lib/client/workout/active.svelte.ts';
	import type { NotSaved } from '#lib/client/workout/store.ts';
	import { DEFAULT_LOAD_INCREMENT } from '#lib/domain/units.ts';
	import type { LoggedSet, SlotView, WorkoutView } from '#lib/domain/workout/index.ts';
	import { defaultMissedReps, nextSet, RPE_CHIPS } from '#lib/domain/workout/prefill.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import SetLogger from '#lib/ui/workout/SetLogger.svelte';
	import { loadHint } from '#lib/ui/workout/logger-words.ts';
	import { targetText } from '#lib/ui/workout/set-words.ts';
	import { onMount, tick } from 'svelte';
	import { logSet, skipSet } from './log.ts';

	interface Props {
		view: WorkoutView;
		slot: SlotView;
		/** Whether a planned set is left to do (the set rows have a current one). */
		open: boolean;
		/** What this device could not save (the store's snapshot), with Retry. */
		notSaved: NotSaved[];
		/**
		 * Writes through the active workout's store (ActiveWorkout.write): at once once it has
		 * loaded its workout, so the write is synchronous, and as it opens before then.
		 */
		write: StoreWrite;
	}

	let { view, slot, open, notSaved, write }: Props = $props();

	onMount(() => {
		if (performance.getEntriesByName('pc:logger-ready', 'mark').length === 0)
			performance.mark('pc:logger-ready');
	});

	/** Complete set: the set.log and its follow-up (log.ts), dispatched at once. */
	function complete(setIndex: number, set: LoggedSet, event: MouseEvent) {
		const start = event.timeStamp;
		const { position } = slot;
		const at = new Date().toISOString();
		const extra = logger.extra;
		write((store) => {
			// Read at each set, so a change in the settings applies to the next rest.
			const settings = readWorkoutSettings();
			const { mutation, followUps } = logSet(view, position, setIndex, set, at, {
				autoStart: settings.autoStartRest,
				defaults: settings.rest
			});
			store.dispatch(mutation, ...followUps);
			// The row changes in this task; the frame that shows it comes next.
			requestAnimationFrame(() =>
				performance.measure('pc:set-confirmed', { start, end: performance.now() })
			);
			// An extra set closes its logger: focus goes to Add a set, for another.
			if (extra) void tick().then(() => focusOn('[data-testid="add-set"]'));
		}, `set:${logger.key}`);
	}

	const focusOn = (selector: string) => document.querySelector<HTMLElement>(selector)?.focus();

	/** Skip set: the set.skip and its follow-up, at once. */
	function skip(setIndex: number, unit: LoggedSet['unit']) {
		const { position } = slot;
		const at = new Date().toISOString();
		write((store) => {
			const { mutation, followUps } = skipSet(view, position, setIndex, unit, at);
			store.dispatch(mutation, ...followUps);
		}, `set:${logger.key}`);
	}

	/** The extra set asked for with Add a set, by its key; it closes once logged or cancelled. */
	let adding = $state<string | null>(null);

	async function add(key: string) {
		adding = key;
		await tick();
		focusOn('#logger-heading');
	}

	async function cancel() {
		adding = null;
		await tick();
		focusOn('[data-testid="add-set"]');
	}

	const retry = () =>
		write(async (store) => {
			for (const { id } of notSaved) await store.retry(id);
		});

	const logger = $derived.by(() => {
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
		// A substitute never shows the planned exercise's load (prefill.ts).
		const substitute = slot.kit !== null && slot.kit.exercise.id !== slot.exerciseId;
		const target =
			prefill.planned &&
			targetText(substitute ? { ...prefill.planned, prescribedWeight: null } : prefill.planned);
		// Per exercise performed: a swap never carries the original's edits into the substitute.
		const key = `${slot.position}:${slot.exerciseId}:${prefill.setIndex}`;
		// Every planned set done: an extra set only when asked for.
		const extra = !open && slot.kit !== null;
		if (extra && adding !== key) return { key, extra, prefill: null };
		return {
			prefill,
			key,
			extra,
			heading: [
				`Set ${prefill.setIndex}${extra ? ' · Extra' : total ? ` of ${total}` : ''}`,
				target
			]
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

{#if logger.prefill}
	{@const { prefill } = logger}
	<SetLogger
		setKey={logger.key}
		heading={logger.heading}
		fields={prefill.fields}
		values={prefill.values}
		increment={logger.increment}
		loadHint={logger.hint}
		rpeChips={RPE_CHIPS}
		oncomplete={(set, event) => complete(prefill.setIndex, set, event)}
		missedFor={(reps) => defaultMissedReps(prefill.planned, reps)}
		secondary={logger.extra
			? { label: 'Cancel', icon: 'close', onclick: cancel }
			: prefill.planned
				? {
						label: 'Skip set',
						icon: 'arrow-right',
						onclick: () => skip(prefill.setIndex, prefill.values.unit)
					}
				: null}
	>
		{@render unsaved()}
	</SetLogger>
{:else}
	{@render unsaved()}
	<div class="all-done">
		<p role="status" data-testid="exercise-done">All sets logged</p>
		<Button variant="secondary" icon="plus" onclick={() => add(logger.key)} data-testid="add-set">
			Add a set
		</Button>
	</div>
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
		display: grid;
		justify-items: center;
		gap: var(--space-3);
		padding: var(--space-4);
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border);
		color: var(--color-text-secondary);
		font-weight: var(--weight-medium);
		text-align: center;
	}
</style>
