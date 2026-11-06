<!--
  @component
  Multi-line text (notes, constraints): label above, 16 px text so iOS never zooms, hint or error
  wired with aria-describedby, grows with its content where CSS `field-sizing` is supported
  (elsewhere it starts at `rows` and can be resized).
-->
<script lang="ts">
	interface Props {
		label: string;
		value: string | null;
		hint?: string;
		/** Replaces the hint while shown. */
		error?: string | null;
		placeholder?: string;
		maxlength?: number;
		/** Show "Optional" beside the label. */
		optional?: boolean;
		rows?: number;
		'data-testid'?: string;
	}

	let {
		label,
		value = $bindable(''),
		hint,
		error = null,
		placeholder,
		maxlength,
		optional = false,
		rows = 3,
		'data-testid': testId
	}: Props = $props();

	const id = $props.id();
	// Only the message on screen: the error replaces the hint.
	const describedBy = $derived(error ? `${id}-error` : hint ? `${id}-hint` : undefined);
</script>

<div class="field" class:invalid={Boolean(error)}>
	<label class="label" for={id}>
		{label}{#if optional}<span class="eyebrow">&nbsp;Optional</span>{/if}
	</label>
	<textarea
		{id}
		class="input"
		{rows}
		{placeholder}
		{maxlength}
		value={value ?? ''}
		oninput={(e) => (value = e.currentTarget.value)}
		aria-invalid={error ? 'true' : undefined}
		aria-describedby={describedBy}
		data-testid={testId}></textarea>
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
		min-height: 5.5rem;
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		background: var(--color-surface-2);
		box-shadow: inset 0 1px 0 0 var(--color-highlight);
		/* ≥ 16px: iOS Safari zooms into smaller inputs on focus. */
		font-size: max(1rem, var(--text-base));
		resize: vertical;
		field-sizing: content;
	}

	.input::placeholder {
		color: var(--color-text-tertiary);
	}

	.input:focus-visible {
		outline: none;
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-ring);
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
