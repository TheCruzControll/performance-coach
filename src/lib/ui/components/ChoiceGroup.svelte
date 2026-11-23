<!--
  @component
  Pick one (radio) or several (checkbox) from a short list. `pill` (the default) wraps quiet
  pills, a checked one the inverse fill. `card` is the Instrument v2 choice list: full-width
  60 px rows with a hairline between them, the selected row in 600 with a check; a hint sits under
  its label, or at the row's end with `hintPlacement="end"` for a short one. Native inputs inside
  a fieldset: Tab, arrow keys, Space and screen readers work without any ARIA of our own. Every
  option is at least 44 px tall, and a selected option shows a tick (pills) or a check (cards),
  never colour alone. Selected is never amber.

  It records a choice and is never an "add" action. An optional single choice offers an
  explicit option ("Not set", "Any") that the caller maps to null: radios cannot be cleared.
-->
<script lang="ts" generics="T extends string">
	import type { DisciplineTone } from '#lib/domain/profile/catalog.ts';
	import Icon from './Icon.svelte';

	interface Option {
		value: T;
		label: string;
		/** Second line (card variant only). */
		hint?: string;
		/** Discipline-colour dot. */
		tone?: DisciplineTone;
	}

	interface Props {
		legend: string;
		/** Keep the legend for assistive tech only (a heading above already says it). */
		hideLegend?: boolean;
		hint?: string;
		error?: string | null;
		options: readonly Option[];
		variant?: 'pill' | 'card';
		/** Card variant: a hint under its label (default) or at the row's end, for a short one. */
		hintPlacement?: 'below' | 'end';
		multiple?: boolean;
		/** Single choice. */
		value?: T | null;
		/** Multiple choice, always in the options' order. */
		values?: T[];
		onchange?: () => void;
		/** The inputs' form field name, for a choice a form posts; a unique one otherwise. */
		name?: string;
		'data-testid'?: string;
	}

	let {
		legend,
		hideLegend = false,
		hint,
		error = null,
		options,
		variant = 'pill',
		hintPlacement = 'below',
		multiple = false,
		value = $bindable(null),
		values = $bindable([]),
		onchange,
		name,
		'data-testid': testId
	}: Props = $props();

	const id = $props.id();
	// The hint above the options and the error below them are both on screen while shown.
	const describedBy = $derived(
		[hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined
	);

	function isChecked(option: T): boolean {
		return multiple ? values.includes(option) : value === option;
	}

	function toggle(option: T, checked: boolean) {
		if (multiple) {
			// Keep the options' order, whatever order they were tapped in.
			values = options
				.map((o) => o.value)
				.filter((v) => (v === option ? checked : values.includes(v)));
		} else if (checked) {
			value = option;
		}
		onchange?.();
	}
</script>

<fieldset
	class="choices"
	class:invalid={Boolean(error)}
	data-variant={variant}
	data-multiple={multiple || undefined}
	aria-describedby={describedBy}
	data-testid={testId}
>
	<legend class={hideLegend ? 'visually-hidden' : 'legend'}>{legend}</legend>
	{#if hint}<p class="hint" id="{id}-hint">{hint}</p>{/if}
	<div class="options">
		{#each options as option (option.value)}
			<label class="option">
				<!-- `checked` goes through a spread: the code that applies one already ships on every
				     route, where `checked={…}` would add a runtime helper to all of them. -->
				<input
					class="input"
					type={multiple ? 'checkbox' : 'radio'}
					name={name ?? id}
					value={option.value}
					{...{ checked: isChecked(option.value) }}
					aria-invalid={error ? 'true' : undefined}
					onchange={(e) => toggle(option.value, e.currentTarget.checked)}
				/>
				<span class="face">
					{#if variant === 'pill'}<span class="tick" aria-hidden="true"></span>{/if}
					{#if option.tone}
						<span class="dot" style:background="var(--color-{option.tone})" aria-hidden="true"
						></span>
					{/if}
					<span class="text">
						<span class="label">{option.label}</span>
						{#if option.hint && variant === 'card' && hintPlacement === 'below'}<span class="sub"
								>{option.hint}</span
							>{/if}
					</span>
					{#if option.hint && variant === 'card' && hintPlacement === 'end'}<span class="sub end"
							>{option.hint}</span
						>{/if}
					{#if variant === 'card'}
						<span class="mark" aria-hidden="true">
							{#if isChecked(option.value)}<Icon name="check" size={16} />{/if}
						</span>
					{/if}
				</span>
			</label>
		{/each}
	</div>
	{#if error}<p class="error" id="{id}-error" role="alert">{error}</p>{/if}
</fieldset>

<style>
	.choices {
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

	.options {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	/* The choice list: rows that touch, the hairline between them. */
	[data-variant='card'] .options {
		display: grid;
		gap: 0;
	}

	.option {
		position: relative;
		display: flex;
	}

	/* The native control covers the whole face: it is the hit area and the focus target. */
	.input {
		position: absolute;
		inset: 0;
		z-index: 1;
		width: 100%;
		height: 100%;
		margin: 0;
		appearance: none;
		opacity: 0;
		cursor: pointer;
	}

	/* Pill (the default): a quiet surface-2 pill, its border transparent so a bad one can draw one. */
	.face {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		width: 100%;
		min-height: var(--touch-target);
		padding: 0 var(--space-4);
		border-radius: var(--radius-full);
		border: 1px solid transparent;
		background: var(--color-surface-2);
		color: var(--color-text-secondary);
		font: var(--type-secondary);
		transition:
			background-color var(--duration-fast) var(--ease-standard),
			border-color var(--duration-fast) var(--ease-standard),
			color var(--duration-fast) var(--ease-standard),
			transform var(--duration-fast) var(--ease-out);
	}

	/* Card: a 60 px row on the canvas, no fill, a hairline under it (none under the last). */
	[data-variant='card'] .face {
		gap: var(--space-3-5);
		min-height: 3.75rem;
		padding: var(--space-2) 0;
		border: 0;
		border-bottom: 1px solid var(--color-hairline);
		border-radius: 0;
		background: transparent;
		color: var(--color-text);
	}

	[data-variant='card'] .option:last-child .face {
		border-bottom-color: transparent;
	}

	/* A picked pill is the inverse fill (the effort scale's selected circle), never amber. */
	[data-variant='pill'] .input:checked + .face {
		border-color: transparent;
		background: var(--color-surface-inverse);
		color: var(--color-text-inverse);
		font-weight: var(--weight-semibold);
	}

	/* A pill with no choice made draws its red border; a card draws only the error line. */
	[data-variant='pill'].invalid .input:not(:checked) + .face {
		border-color: var(--color-danger);
	}

	.input:focus-visible + .face {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	/* A pill presses in; a card row keeps still and takes the tint instead (below). */
	[data-variant='pill'] .input:active + .face {
		transform: scale(0.97);
	}

	/* A drawn tick (no icon in the bundle): hidden until checked. */
	.tick {
		display: none;
		flex: none;
		width: 0.375rem;
		height: 0.75rem;
		margin: -0.125rem 0.125rem 0 0;
		border: solid currentColor;
		border-width: 0 2px 2px 0;
		transform: rotate(45deg);
	}

	.input:checked + .face .tick {
		display: block;
	}

	.dot {
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: 50%;
	}

	.text {
		display: grid;
		flex: 1;
		gap: 2px;
		text-align: start;
	}

	/* Card rows: the label in the row's font, 600 when picked. */
	[data-variant='card'] .label {
		font: var(--type-row);
		color: var(--color-text);
	}

	[data-variant='card'] .input:checked + .face .label {
		font-weight: var(--weight-semibold);
	}

	/* Several: an unpicked option is tertiary and has no check. */
	[data-variant='card'][data-multiple] .input:not(:checked) + .face .label {
		color: var(--color-text-tertiary);
	}

	/* The hint: under the label, or at the row's end when it is short. */
	[data-variant='card'] .sub {
		font: var(--type-secondary);
		color: var(--color-text-tertiary);
	}

	[data-variant='card'] .input:checked + .face .sub {
		color: var(--color-text-secondary);
	}

	[data-variant='card'] .sub.end {
		flex: none;
		text-align: end;
	}

	/* The check's slot is always there, so the rows line up; the check shows when picked. */
	[data-variant='card'] .mark {
		display: grid;
		flex: none;
		place-items: center;
		width: 1rem;
		height: 1rem;
		color: var(--color-text);
	}

	.hint {
		font: var(--type-secondary);
		color: var(--color-text-tertiary);
	}

	/* One red line under the options, the words say it; no red border on a card. */
	.error {
		padding-top: var(--space-0-5);
		font: var(--type-secondary);
		color: var(--color-danger);
	}

	/* A card row tints to surface-2 when pressed (any pointer) and when hovered (fine pointers).
	   The tint reaches 8 px past the text, so it never moves the layout. */
	[data-variant='card'] .input:active + .face {
		border-radius: var(--radius-sm);
		background: var(--color-surface-2);
		box-shadow: 0 0 0 var(--space-2) var(--color-surface-2);
	}

	@media (hover: hover) and (pointer: fine) {
		[data-variant='pill'] .input:not(:checked):hover + .face {
			background: var(--color-surface-3);
		}

		[data-variant='card'] .input:hover + .face {
			border-radius: var(--radius-sm);
			background: var(--color-surface-2);
			box-shadow: 0 0 0 var(--space-2) var(--color-surface-2);
		}
	}
</style>
