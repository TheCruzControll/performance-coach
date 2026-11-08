<!--
  @component
  The set at hand, ready to log in one tap (PRD §7–§8): big steppers for exactly the fields its
  exercise records (logging-rules' setFields: a weight, an added weight or the assistance, and
  reps, a time in m:ss, or metres), the RPE chips, and Complete set.
  - It starts from the prefilled values; what the owner changes is kept for this set only, so
    the next set starts from its own prefill.
  - A weighted exercise's set needs a weight: Complete set asks for one instead of logging 0. An
    added weight or an assistance of 0 is none (bodyweight only, no help). A time or a distance
    is at least 1 (LOG_LIMITS); 0 reps is a set (a failed attempt).
  - Below 1024 px it sits in the thumb zone, stuck to the bottom of the screen above the home
    indicator (--safe-bottom); from 1024 px it sits in the main column under the set rows, the
    two steppers side by side from 640 px (each one row below it, so the logger stays short).
  - Missed reps (a reps set only) is a disclosure, closed for every set: opened, it records the
    misses, prefilled from the target (`missedFor`, prefill.ts's defaultMissedReps) until the
    owner sets them; closed, the set records none.
  - Beside it, the secondary action the strength view gives: Skip set for a planned set, Cancel
    for an extra one.
  Its fields keep their place from set to set, so nothing shifts as sets are logged.
-->
<script lang="ts">
	import type { SetFields } from '#lib/domain/workout/logging.ts';
	import type { LoggedSet } from '#lib/domain/workout/index.ts';
	import type { Snippet } from 'svelte';
	import { formatDuration } from '#lib/domain/units.ts';
	import type { IconName } from '../icons/icons.ts';
	import Button from '../components/Button.svelte';
	import NumberStepper from '../components/NumberStepper.svelte';
	import RpeChips from './RpeChips.svelte';
	import {
		AMOUNT_STEPS,
		MISSED_REPS_MAX,
		missingInput,
		NEEDS_AMOUNT,
		NEEDS_WEIGHT,
		parseTime
	} from './set-input.ts';

	interface Props {
		/** Which set this is: a change starts again from `values`. */
		setKey: string;
		/** 'Set 2 of 4 · 5 reps · ≈ 100 kg'. */
		heading: string;
		fields: SetFields;
		/** The prefilled values (prefill.ts's nextSet). */
		values: LoggedSet;
		/** The weight step: the exercise's increment. */
		increment: number;
		/** Under the load: where its value came from, or what to pick. */
		loadHint: string | null;
		rpeChips: readonly number[];
		oncomplete: (set: LoggedSet, event: MouseEvent) => void;
		/** A reps set's missed reps by default, from its target and the reps done. */
		missedFor: (reps: number | null) => number;
		/** Beside Missed reps: Skip set, or Cancel for an extra set. */
		secondary: { label: string; icon: IconName; onclick: () => void } | null;
		/** Above the set, in the thumb zone: what could not be saved, with Retry. */
		children?: Snippet;
	}

	let {
		setKey,
		heading,
		fields,
		values,
		increment,
		loadHint,
		rpeChips,
		oncomplete,
		missedFor,
		secondary,
		children
	}: Props = $props();

	const id = $props.id();
	type Missing = 'load' | 'amount' | null;
	interface Edits {
		key: string;
		set: Partial<LoggedSet>;
		error: Missing;
		/** Missed reps opened; `missed` is what the owner set them to, null to follow the reps. */
		missedOpen: boolean;
		missed: number | null;
	}
	const fresh = (key: string): Edits => ({
		key,
		set: {},
		error: null,
		missedOpen: false,
		missed: null
	});
	let edits = $state.raw<Edits>(fresh(''));
	const mine = $derived(edits.key === setKey ? edits : fresh(setKey));
	const set = $derived<LoggedSet>({ ...values, ...mine.set });
	const missed = $derived(mine.missed ?? missedFor(set.reps));

	const edit = (change: Partial<Edits>) => (edits = { ...mine, error: null, ...change });
	const editSet = (change: Partial<LoggedSet>) => edit({ set: { ...mine.set, ...change } });

	const column = $derived(fields.load === 'assistance' ? 'assistance' : 'weight');
	const amount = $derived(fields.amount);

	function complete(event: MouseEvent) {
		const error = missingInput(fields, set);
		if (error) {
			edits = { ...mine, error };
			return;
		}
		const missedReps = amount === 'reps' && mine.missedOpen ? missed : 0;
		oncomplete({ ...set, [amount]: set[amount] ?? 0, missedReps }, event);
	}
</script>

<section class="logger" aria-labelledby="logger-heading" data-testid="set-logger">
	{@render children?.()}
	<h3 id="logger-heading" class="heading" tabindex="-1">{heading}</h3>
	<div class="steppers">
		{#if fields.load}
			<NumberStepper
				label={fields.labels.load ?? 'Weight'}
				value={set[column] ?? 0}
				step={increment}
				bigStep={increment * 4}
				max={1000}
				unit={set.unit}
				decimals={String(increment).split('.')[1]?.length ?? 0}
				chars={5}
				hint={loadHint ?? undefined}
				error={mine.error === 'load' ? NEEDS_WEIGHT : null}
				onchange={(v) => editSet({ [column]: fields.load === 'weight' || v > 0 ? v : null })}
				data-testid="logger-load"
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
			chars={AMOUNT_STEPS[amount].chars}
			parse={amount === 'seconds' ? parseTime : undefined}
			error={mine.error === 'amount' && amount !== 'reps' ? NEEDS_AMOUNT[amount] : null}
			onchange={(v) => editSet({ [amount]: v })}
			data-testid="logger-amount"
		/>
		{#if amount === 'reps' && mine.missedOpen}
			<div id="{id}-missed">
				<NumberStepper
					label="Missed reps"
					value={missed}
					max={MISSED_REPS_MAX}
					hint="Reps you attempted and failed"
					onchange={(v) => edit({ missed: v })}
					data-testid="logger-missed"
				/>
			</div>
		{/if}
	</div>
	<RpeChips chips={rpeChips} value={set.rpe} onchange={(rpe) => editSet({ rpe })} />
	<div class="more">
		{#if amount === 'reps'}
			<Button
				variant="ghost"
				iconEnd="chevron-down"
				aria-expanded={mine.missedOpen}
				aria-controls={mine.missedOpen ? `${id}-missed` : undefined}
				onclick={() => edit({ missedOpen: !mine.missedOpen })}
				data-testid="missed-toggle"
			>
				Missed reps
			</Button>
		{/if}
		{#if secondary}
			<Button
				variant="ghost"
				icon={secondary.icon}
				onclick={secondary.onclick}
				data-testid="logger-secondary"
			>
				{secondary.label}
			</Button>
		{/if}
	</div>
	<Button size="lg" block icon="check" onclick={complete} data-testid="complete-set">
		Complete set
	</Button>
</section>

<style>
	.logger {
		display: grid;
		gap: var(--space-3);
		/* Stuck to the screen's foot, full-bleed, above the home indicator. */
		position: sticky;
		bottom: 0;
		z-index: var(--z-sticky);
		margin: auto calc(-1 * max(var(--gutter), var(--safe-right)))
			calc(-1 * (var(--space-8) + var(--safe-bottom)))
			calc(-1 * max(var(--gutter), var(--safe-left)));
		padding: var(--space-3) max(var(--gutter), var(--safe-right))
			calc(var(--space-3) + var(--safe-bottom)) max(var(--gutter), var(--safe-left));
		border-top: 1px solid var(--color-border);
		background: var(--color-surface-1);
		box-shadow: var(--elevation-2);
	}

	/* Focused from Add a set, so a screen reader hears which set this is; not a control. */
	.heading:focus {
		outline: none;
	}

	.heading {
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		color: var(--color-text-secondary);
		overflow-wrap: anywhere;
	}

	.more {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: var(--space-2);
		margin: calc(-1 * var(--space-1)) 0;
	}

	/* The last action keeps the right edge, Missed reps or not. */
	.more > :global(:last-child) {
		margin-left: auto;
	}

	.more :global([aria-expanded='true'] svg) {
		transform: rotate(180deg);
	}

	.steppers {
		display: grid;
		gap: var(--space-3);
		container-type: inline-size;
	}

	/*
	 * Below 640 px each stepper is one row where the logger has room for it (the label beside the
	 * controls, the hint under both), so the logger stays short in the thumb zone; at a larger text
	 * size it has none, and they stack as usual. Here rather than in NumberStepper, so no other
	 * screen's stylesheet carries it.
	 */
	@media (width < 40rem) {
		@container (width >= 22rem) {
			.steppers :global(.stepper) {
				grid-template-columns: minmax(0, 1fr) auto;
				align-items: center;
				column-gap: var(--space-3);
				row-gap: var(--space-1);
			}

			.steppers :global(.stepper > .label),
			.steppers :global(.stepper > .hint) {
				text-align: start;
			}

			.steppers :global(.stepper > .hint) {
				grid-column: 1 / -1;
			}

			.steppers :global(.row) {
				gap: var(--space-2);
			}

			/* Room for '102.5 kg', so the controls keep their place as the value changes. */
			.steppers :global(.value-wrap) {
				min-width: 9rem;
			}

			.steppers :global(.value) {
				font-size: var(--text-3xl);
			}
		}
	}

	@media (width >= 40rem) {
		.steppers {
			grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
			align-items: start;
			column-gap: var(--space-8);
		}
	}

	/* In the main column under the set rows, as a card: not fixed, nothing over the content. */
	@media (width >= 64rem) {
		.logger {
			position: static;
			gap: var(--space-4);
			margin: 0;
			padding: var(--space-5);
			border: 1px solid var(--color-border);
			border-radius: var(--radius-lg);
			box-shadow: var(--elevation-1);
		}
	}
</style>
