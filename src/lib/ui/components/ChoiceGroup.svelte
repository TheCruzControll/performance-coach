<!--
  @component
  Pick one (radio) or several (checkbox) from a short list, as wrapping pills or full-width
  cards with a hint. Native inputs inside a fieldset: Tab, arrow keys, Space and screen readers
  work without any ARIA of our own. Every option is at least 44 px tall, and a selected option
  shows a tick (pills) or a filled mark (cards), never colour alone.

  It records a choice and is never an "add" action. An optional single choice offers an
  explicit option ("Not set", "Any") that the caller maps to null: radios cannot be cleared.
-->
<script lang="ts" generics="T extends string">
	import type { DisciplineTone } from '#lib/domain/profile/catalog.ts';

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
		multiple?: boolean;
		/** Single choice. */
		value?: T | null;
		/** Multiple choice, always in the options' order. */
		values?: T[];
		onchange?: () => void;
		'data-testid'?: string;
	}

	let {
		legend,
		hideLegend = false,
		hint,
		error = null,
		options,
		variant = 'pill',
		multiple = false,
		value = $bindable(null),
		values = $bindable([]),
		onchange,
		'data-testid': testId
	}: Props = $props();

	const id = $props.id();
	// The hint above the options and the error below them are both on screen while shown.
	const describedBy = $derived(
		[hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined
	);

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
					name={id}
					value={option.value}
					{...{ checked: multiple ? values.includes(option.value) : value === option.value }}
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
						{#if option.hint && variant === 'card'}<span class="sub">{option.hint}</span>{/if}
					</span>
					{#if variant === 'card'}<span class="mark" aria-hidden="true"></span>{/if}
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

	[data-variant='card'] .options {
		display: grid;
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

	.face {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		width: 100%;
		min-height: var(--touch-target);
		padding: 0 var(--space-4);
		border-radius: var(--radius-full);
		border: 1px solid var(--color-border);
		background: var(--color-surface-2);
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		transition:
			background-color var(--duration-fast) var(--ease-standard),
			border-color var(--duration-fast) var(--ease-standard),
			color var(--duration-fast) var(--ease-standard),
			transform var(--duration-fast) var(--ease-out);
	}

	[data-variant='card'] .face {
		min-height: 3.5rem;
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-md);
	}

	.input:checked + .face {
		border-color: var(--color-accent);
		background: var(--color-accent-subtle);
		color: var(--color-text);
	}

	.invalid .input:not(:checked) + .face {
		border-color: var(--color-danger);
	}

	.input:focus-visible + .face {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	.input:active + .face {
		transform: scale(0.97);
	}

	/* A drawn tick (no icon in the bundle): hidden until checked. */
	.tick {
		display: none;
		flex: none;
		width: 0.375rem;
		height: 0.75rem;
		margin: -0.125rem 0.125rem 0 0;
		border: solid var(--color-accent-text);
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

	[data-variant='card'] .label {
		font-size: var(--text-base);
		font-weight: var(--weight-semibold);
		color: var(--color-text);
	}

	/* Secondary, not tertiary: it must stay ≥ 4.5:1 on the accent tint of a selected card. */
	.sub {
		font-size: var(--text-xs);
		font-weight: var(--weight-regular);
		color: var(--color-text-secondary);
	}

	.mark {
		flex: none;
		width: 1.25rem;
		height: 1.25rem;
		border-radius: 50%;
		border: 1.5px solid var(--color-border-strong);
		transition: border-width var(--duration-fast) var(--ease-spring);
	}

	[data-multiple] .mark {
		border-radius: var(--radius-xs);
	}

	.input:checked + .face .mark {
		border: 6px solid var(--color-accent);
		background: var(--color-on-accent);
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
</style>
