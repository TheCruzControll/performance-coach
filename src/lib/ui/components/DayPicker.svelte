<!--
  @component
  Days of the week, Monday first: seven round toggles in one thumb-width row, a picked day
  filled and ticked (never colour alone). Native checkboxes in a fieldset, each named with the
  full day ("Tuesday"); the value is always in week order, whatever order the days were tapped
  in. Each hit area is the whole cell plus half of each gap, so a day stays ≥ 44 × 44 px inside
  a padded card on a 393 px phone and neighbours meet without overlapping.
-->
<script lang="ts">
	import { WEEKDAYS, WEEKDAY_INFO, type Weekday } from '#lib/domain/profile/catalog.ts';

	interface Props {
		legend: string;
		value: Weekday[];
		hint?: string;
		/** Replaces the hint while shown. */
		error?: string | null;
		onchange?: () => void;
		'data-testid'?: string;
	}

	let {
		legend,
		value = $bindable([]),
		hint,
		error = null,
		onchange,
		'data-testid': testId
	}: Props = $props();

	const id = $props.id();
	// Only the message on screen describes the group: the error replaces the hint.
	const describedBy = $derived(error ? `${id}-error` : hint ? `${id}-hint` : undefined);

	function toggle(day: Weekday, on: boolean) {
		value = WEEKDAYS.filter((d) => (d === day ? on : value.includes(d)));
		onchange?.();
	}
</script>

<fieldset
	class="days"
	class:invalid={Boolean(error)}
	aria-describedby={describedBy}
	data-testid={testId}
>
	<legend class="legend">{legend}</legend>
	<div class="row">
		{#each WEEKDAYS as day (day)}
			<label class="day">
				<input
					class="input"
					type="checkbox"
					bind:checked={() => value.includes(day), (on) => toggle(day, on)}
					aria-label={WEEKDAY_INFO[day].label}
					aria-invalid={error ? 'true' : undefined}
				/>
				<span class="face" aria-hidden="true"
					>{WEEKDAY_INFO[day].letter}<span class="tick"></span></span
				>
			</label>
		{/each}
	</div>
	{#if error}
		<p class="error" id="{id}-error" role="alert">{error}</p>
	{:else if hint}
		<p class="hint" id="{id}-hint">{hint}</p>
	{/if}
</fieldset>

<style>
	.days {
		--gap: var(--space-1-5);
		display: grid;
		gap: var(--space-2);
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.legend {
		margin-bottom: var(--space-2);
		padding: 0;
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}

	.row {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		gap: var(--gap);
	}

	.day {
		position: relative;
		display: grid;
		place-items: center;
		min-height: var(--touch-target);
	}

	/* The hit area: the cell's full height and half the gap on each side, so neighbours meet
	   without overlapping. */
	.input {
		position: absolute;
		top: 0;
		left: calc(var(--gap) / -2);
		z-index: 1;
		width: calc(100% + var(--gap));
		height: 100%;
		margin: 0;
		appearance: none;
		opacity: 0;
		cursor: pointer;
	}

	.face {
		position: relative;
		display: grid;
		place-items: center;
		width: min(100%, var(--touch-target));
		aspect-ratio: 1;
		/* Lifts the letter clear of the tick. */
		padding-bottom: 0.25rem;
		border-radius: 50%;
		border: 1px solid var(--color-border);
		background: var(--color-surface-2);
		font-weight: var(--weight-semibold);
		color: var(--color-text-secondary);
		transition:
			background-color var(--duration-fast) var(--ease-standard),
			border-color var(--duration-fast) var(--ease-standard),
			color var(--duration-fast) var(--ease-standard),
			transform var(--duration-fast) var(--ease-out);
	}

	.input:checked + .face {
		background: var(--color-accent);
		border-color: transparent;
		color: var(--color-on-accent);
	}

	/* A drawn tick under the letter: selected is never the fill colour alone. */
	.tick {
		display: none;
		position: absolute;
		bottom: 10%;
		left: calc(50% - 0.125rem);
		width: 0.25rem;
		height: 0.4375rem;
		border: solid currentColor;
		border-width: 0 1.5px 1.5px 0;
		transform: rotate(45deg);
	}

	.input:checked + .face .tick {
		display: block;
	}

	.invalid .input:not(:checked) + .face {
		border-color: var(--color-danger);
	}

	.input:focus-visible + .face {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	.input:active + .face {
		transform: scale(0.94);
	}

	.hint,
	.error {
		font-size: var(--text-xs);
		line-height: var(--leading-normal);
		color: var(--color-text-tertiary);
	}

	.error {
		color: var(--color-danger);
	}

	@media (hover: hover) and (pointer: fine) {
		.input:not(:checked):hover + .face {
			border-color: var(--color-border-strong);
			background: var(--color-surface-3);
			color: var(--color-text);
		}

		.input:checked:hover + .face {
			background: var(--color-accent-hover);
		}
	}
</style>
