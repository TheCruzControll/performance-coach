<!--
  @component
  Days of the week, Monday first: seven round toggles in one thumb-width row. Native
  checkboxes in a fieldset; each is named with the full day ("Tuesday"). The hit area reaches
  into the gaps, so a day stays ≥ 44 px wide even inside a padded card.
-->
<script lang="ts">
	import { WEEKDAYS, WEEKDAY_INFO, type Weekday } from '#lib/domain/profile/catalog.ts';

	interface Props {
		legend: string;
		value: Weekday[];
		hint?: string;
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
	// Only the message on screen describes the group (error replaces hint).
	const describedBy = $derived(error ? `${id}-error` : hint ? `${id}-hint` : undefined);

	function toggle(day: Weekday, on: boolean) {
		value = WEEKDAYS.filter((d) => (d === day ? on : value.includes(d)));
		onchange?.();
	}
</script>

<fieldset class="days" aria-describedby={describedBy} data-testid={testId}>
	<legend class="legend">{legend}</legend>
	<div class="row">
		{#each WEEKDAYS as day (day)}
			<label class="day">
				<input
					class="input"
					type="checkbox"
					checked={value.includes(day)}
					onchange={(e) => toggle(day, e.currentTarget.checked)}
					aria-label={WEEKDAY_INFO[day].label}
				/>
				<span class="face" aria-hidden="true">{WEEKDAY_INFO[day].letter}</span>
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
		display: grid;
		gap: var(--space-2);
		min-width: 0;
		padding: 0;
		margin: 0;
		border: 0;
	}

	.legend {
		margin-bottom: var(--space-1);
		padding: 0;
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}

	.row {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		gap: var(--space-1-5);
	}

	.day {
		position: relative;
		display: grid;
	}

	/* Half the gap on each side: neighbours never overlap, the target grows to column + gap. */
	.input {
		position: absolute;
		inset: calc(var(--space-1-5) / -2);
		z-index: 1;
		width: auto;
		height: auto;
		opacity: 0;
		margin: 0;
		cursor: pointer;
	}

	.face {
		display: grid;
		place-items: center;
		aspect-ratio: 1;
		min-height: var(--touch-target);
		border-radius: 50%;
		border: 1px solid var(--color-border);
		background: var(--color-surface-2);
		font-weight: var(--weight-semibold);
		color: var(--color-text-secondary);
		pointer-events: none;
		transition:
			background-color var(--duration-fast) var(--ease-standard),
			color var(--duration-fast) var(--ease-standard);
	}

	.input:checked + .face {
		background: var(--color-accent);
		border-color: transparent;
		color: var(--color-on-accent);
	}

	.input:focus-visible + .face {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	.hint,
	.error {
		font-size: var(--text-xs);
		color: var(--color-text-tertiary);
	}

	.error {
		color: var(--color-danger);
	}
</style>
