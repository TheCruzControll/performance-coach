<!--
  @component
  A number that may be left blank (a 1RM, a body weight, a race distance). Opens the decimal or
  numeric keypad on phones, keeps the unit beside the value (and in the accessible description),
  and never invents a number: an empty field is `null`, never 0. Non-negative values only. For
  counts and durations people nudge, use NumberStepper.
-->
<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';

	interface Props {
		label: string;
		value: number | null | undefined;
		/** A short unit shown inside the field (kg, km, min). */
		unit?: string;
		hint?: string;
		/** Replaces the hint while shown. */
		error?: string | null;
		/** Whole numbers only (numeric keypad). */
		integer?: boolean;
		/** Show "Optional" beside the label. */
		optional?: boolean;
		placeholder?: string;
		/** Return-key label on phone keyboards (`next` inside a multi-field form). */
		enterkeyhint?: HTMLInputAttributes['enterkeyhint'];
		oninput?: (value: number | null) => void;
		'data-testid'?: string;
	}

	let {
		label,
		value = $bindable(null),
		unit,
		hint,
		error = null,
		integer = false,
		optional = false,
		placeholder = '—',
		enterkeyhint = 'done',
		oninput,
		'data-testid': testId
	}: Props = $props();

	const id = $props.id();
	// Only ids that are on screen: the error replaces the hint.
	const describedBy = $derived(
		[unit && `${id}-unit`, error ? `${id}-error` : hint && `${id}-hint`]
			.filter(Boolean)
			.join(' ') || undefined
	);

	// What was typed ("82." on the way to 82.5) is shown while `value` still holds the number it
	// means; any other value (set from outside) is shown as that number.
	let typed = $state('');
	let typedValue = $state<number | null>();
	const text = $derived(value === typedValue ? typed : value == null ? '' : String(value));

	function input(event: Event & { currentTarget: HTMLInputElement }) {
		const field = event.currentTarget;
		// Keep digits and one decimal point (a comma counts as one); nothing else reaches `value`.
		let clean = field.value.replace(/,/g, '.').replace(integer ? /\D/g : /[^\d.]/g, '');
		const dot = clean.indexOf('.');
		if (dot !== -1) clean = clean.slice(0, dot + 1) + clean.slice(dot + 1).replace(/\./g, '');
		if (clean !== field.value) field.value = clean;
		const next = clean === '' || clean === '.' ? null : Number(clean);
		typed = clean;
		typedValue = next;
		value = next;
		oninput?.(next);
	}
</script>

<div class="field" data-ui="field" class:invalid={Boolean(error)}>
	<label class="label" for={id}>
		{label}{#if optional}<span class="eyebrow">&nbsp;Optional</span>{/if}
	</label>
	<div class="control">
		<input
			{id}
			class="input numeric"
			type="text"
			inputmode={integer ? 'numeric' : 'decimal'}
			autocomplete="off"
			{enterkeyhint}
			{placeholder}
			value={text}
			aria-invalid={error ? 'true' : undefined}
			aria-describedby={describedBy}
			oninput={input}
			data-testid={testId}
		/>
		{#if unit}
			<span class="unit" aria-hidden="true">{unit}</span>
			<span class="visually-hidden" id="{id}-unit">{unit}</span>
		{/if}
	</div>
	{#if error}
		<p class="message error" id="{id}-error" role="alert">{error}</p>
	{:else if hint}
		<p class="message" id="{id}-hint">{hint}</p>
	{/if}
</div>

<style>
	.field {
		display: grid;
		gap: var(--space-2);
		min-width: 0;
	}

	.label {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-2);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}

	.control {
		position: relative;
		display: flex;
		align-items: center;
	}

	.input {
		width: 100%;
		min-height: 3.5rem;
		padding: 0 3.25rem 0 var(--space-4);
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		background: var(--color-surface-2);
		box-shadow: inset 0 1px 0 0 var(--color-highlight);
		font-size: var(--text-xl);
		font-weight: var(--weight-semibold);
	}

	.input::placeholder {
		color: var(--color-text-tertiary);
		font-weight: var(--weight-regular);
	}

	.input:focus-visible {
		/* The ring is the shadow; forced colours drop shadows and draw this outline instead. */
		outline: 2px solid transparent;
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-ring);
	}

	.unit {
		position: absolute;
		right: var(--space-4);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-text-tertiary);
		pointer-events: none;
	}

	.invalid .input {
		border-color: var(--color-danger);
	}

	.message {
		font-size: var(--text-xs);
		color: var(--color-text-tertiary);
	}

	.error {
		color: var(--color-danger);
	}
</style>
