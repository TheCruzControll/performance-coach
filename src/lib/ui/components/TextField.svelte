<!--
  @component
  Labelled single-line text input. Large (56 px) for thumbs, a visible label above (never a
  placeholder-as-label), hint or error text wired to the input with aria-describedby, and a
  16 px font so iOS Safari does not zoom on focus. `type="date"` takes and gives `YYYY-MM-DD`.
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
		/** Monospace, tracked-out text (codes). */
		mono?: boolean;
		input?: HTMLInputElement;
		oninput?: (event: Event & { currentTarget: HTMLInputElement }) => void;
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

<div class="field" data-ui="field" class:invalid={Boolean(error)}>
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
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}

	.input {
		width: 100%;
		min-height: 3.5rem;
		padding: 0 var(--space-4);
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		background: var(--color-surface-2);
		box-shadow: inset 0 1px 0 0 var(--color-highlight);
		color: var(--color-text);
		font: inherit;
		/* ≥ 16px: iOS Safari zooms into smaller inputs on focus. */
		font-size: max(1rem, var(--text-base));
		transition:
			border-color var(--duration-fast) var(--ease-standard),
			box-shadow var(--duration-fast) var(--ease-standard);
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
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-ring);
	}

	.input:disabled {
		opacity: 0.5;
	}

	.mono {
		font-family: var(--font-numeric);
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.mono::placeholder {
		text-transform: none;
		letter-spacing: normal;
	}

	.invalid .input {
		border-color: var(--color-danger);
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
