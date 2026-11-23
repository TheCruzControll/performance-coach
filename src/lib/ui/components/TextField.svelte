<!--
  @component
  Labelled single-line text input. Large (56 px) for thumbs, a visible label above (never a
  placeholder-as-label), hint or error text wired to the input with aria-describedby, and a
  16 px font so iOS Safari does not zoom on focus. `type="date"` takes and gives `YYYY-MM-DD`;
  `min` and `max` bound a date in that form.
-->
<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';

	interface Props {
		label: string;
		value?: string;
		name?: string;
		type?: 'text' | 'search' | 'date';
		hint?: string;
		/** Replaces the hint while shown. */
		error?: string | null;
		/** Show "Optional" beside the label. */
		optional?: boolean;
		placeholder?: string;
		autocomplete?: HTMLInputAttributes['autocomplete'];
		autocapitalize?: HTMLInputAttributes['autocapitalize'];
		inputmode?: HTMLInputAttributes['inputmode'];
		enterkeyhint?: HTMLInputAttributes['enterkeyhint'];
		spellcheck?: boolean;
		required?: boolean;
		disabled?: boolean;
		maxlength?: number;
		/** The earliest and latest a date field takes, `YYYY-MM-DD`. */
		min?: string;
		max?: string;
		/** Monospace, tracked-out text (codes). */
		mono?: boolean;
		input?: HTMLInputElement;
		oninput?: (event: Event & { currentTarget: HTMLInputElement }) => void;
		onchange?: (event: Event & { currentTarget: HTMLInputElement }) => void;
		'data-testid'?: string;
	}

	let {
		label,
		value = $bindable(''),
		type = 'text',
		hint,
		error = null,
		optional = false,
		mono = false,
		input = $bindable(),
		'data-testid': testId,
		...rest
	}: Props = $props();

	const id = $props.id();
	// Only the message on screen: the error replaces the hint.
	const describedBy = $derived(error ? `${id}-error` : hint ? `${id}-hint` : undefined);
</script>

<div class="field" class:invalid={Boolean(error)}>
	<label class="label" for={id}>
		{label}{#if optional}<span class="eyebrow">&nbsp;Optional</span>{/if}
	</label>
	<input
		bind:this={input}
		bind:value
		{id}
		{type}
		class="input"
		class:mono
		aria-invalid={error ? 'true' : undefined}
		aria-describedby={describedBy}
		data-testid={testId}
		{...rest}
	/>
	{#if error}
		<p class="error" id="{id}-error" role="alert">{error}</p>
	{:else if hint}
		<p class="hint" id="{id}-hint">{hint}</p>
	{/if}
</div>

<style>
	.field {
		display: grid;
		gap: var(--space-2);
	}

	.label {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-2);
		font: var(--type-secondary);
		color: var(--color-text-secondary);
	}

	/* Instrument v2: 56 px, 14 px corners, no border. The font is 17 px, so iOS never zooms. */
	.input {
		width: 100%;
		min-height: 3.5rem;
		padding: 0 var(--space-4-5);
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: var(--color-surface-2);
		color: var(--color-text);
		font: var(--type-row);
		transition: box-shadow var(--duration-fast) var(--ease-standard);
	}

	.input::placeholder {
		color: var(--color-text-tertiary);
	}

	/* iOS Safari centres a date's value; keep it aligned with every other field's text. */
	.input::-webkit-date-and-time-value {
		text-align: start;
	}

	.input:focus-visible {
		/* The ring is the shadow; forced colours drop shadows and draw this outline instead. */
		outline: 2px solid transparent;
		box-shadow: 0 0 0 3px var(--color-accent-ring);
	}

	.input:disabled {
		opacity: 1;
		color: var(--color-text-disabled);
	}

	.mono {
		font-family: var(--font-numeric);
		font-variant-numeric: tabular-nums;
		text-transform: uppercase;
	}

	.mono::placeholder {
		text-transform: none;
	}

	/* No red border: the error is one red line under the field (the words are the message). */
	.hint,
	.error {
		font: var(--type-secondary);
		color: var(--color-text-tertiary);
	}

	/* 8 px field gap plus 2 px: the error sits 10 px under the field. */
	.error {
		padding-top: var(--space-0-5);
		color: var(--color-danger);
	}
</style>
