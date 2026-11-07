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
  Its fields keep their place from set to set, so nothing shifts as sets are logged.
-->
<script lang="ts">
	import type { SetFields } from '#lib/domain/workout/logging.ts';
	import type { LoggedSet } from '#lib/domain/workout/index.ts';
	import type { Snippet } from 'svelte';
	import { formatDuration } from '#lib/domain/units.ts';
	import Button from '../components/Button.svelte';
	import NumberStepper from '../components/NumberStepper.svelte';
	import RpeChips from './RpeChips.svelte';

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
		children
	}: Props = $props();

	/** Asked when a weighted set has none. */
	const NEEDS_WEIGHT = 'Enter the weight you used';
	/** Asked when a timed or distance set has none. */
	const NEEDS_AMOUNT = { seconds: 'Enter the time', metres: 'Enter the distance' } as const;

	type Missing = 'load' | 'amount' | null;
	let edits = $state.raw<{ key: string; set: Partial<LoggedSet>; error: Missing }>({
		key: '',
		set: {},
		error: null
	});
	const mine = $derived(edits.key === setKey ? edits : { key: setKey, set: {}, error: null });
	const set = $derived<LoggedSet>({ ...values, ...mine.set });

	const edit = (change: Partial<LoggedSet>) =>
		(edits = { key: setKey, set: { ...mine.set, ...change }, error: null });

	const column = $derived(fields.load === 'assistance' ? 'assistance' : 'weight');
	const amount = $derived(fields.amount);
	const AMOUNT_STEPS = {
		reps: { min: 0, step: 1, bigStep: 5, max: 100, unit: 'reps' },
		seconds: { min: 1, step: 5, bigStep: 30, max: 3600, unit: undefined },
		metres: { min: 1, step: 10, bigStep: 100, max: 100_000, unit: 'm' }
	} as const;

	/** '1:30' or '90' as seconds; null for anything else. */
	function parseTime(text: string): number | null {
		const match = /^(\d+)(?::(\d{1,2}))?$/.exec(text.trim());
		if (!match) return null;
		return match[2] === undefined ? Number(match[1]) : Number(match[1]) * 60 + Number(match[2]);
	}

	function complete(event: MouseEvent) {
		if (fields.load === 'weight' && !((set.weight ?? 0) > 0)) {
			edits = { ...mine, error: 'load' };
			return;
		}
		const done = set[amount] ?? 0;
		if (done < AMOUNT_STEPS[amount].min) {
			edits = { ...mine, error: 'amount' };
			return;
		}
		oncomplete({ ...set, [amount]: done }, event);
	}
</script>

<section class="logger" aria-labelledby="logger-heading" data-testid="set-logger">
	{@render children?.()}
	<h3 id="logger-heading" class="heading">{heading}</h3>
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
				hint={loadHint ?? undefined}
				error={mine.error === 'load' ? NEEDS_WEIGHT : null}
				onchange={(v) => edit({ [column]: fields.load === 'weight' || v > 0 ? v : null })}
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
			parse={amount === 'seconds' ? parseTime : undefined}
			error={mine.error === 'amount' && amount !== 'reps' ? NEEDS_AMOUNT[amount] : null}
			onchange={(v) => edit({ [amount]: v })}
			data-testid="logger-amount"
		/>
	</div>
	<RpeChips chips={rpeChips} value={set.rpe} onchange={(rpe) => edit({ rpe })} />
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

	.heading {
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		color: var(--color-text-secondary);
		overflow-wrap: anywhere;
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
			.steppers > :global(.stepper) {
				grid-template-columns: minmax(0, 1fr) auto;
				align-items: center;
				column-gap: var(--space-3);
				row-gap: var(--space-1);
			}

			.steppers > :global(.stepper > .label),
			.steppers > :global(.stepper > .hint) {
				text-align: start;
			}

			.steppers > :global(.stepper > .hint) {
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
