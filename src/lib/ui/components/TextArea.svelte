<!--
  @component
  Multi-line text (notes, constraints): label above, 16 px text so iOS never zooms, hint and
  error wired with aria-describedby, grows with its content (CSS `field-sizing` where supported).
-->
<script lang="ts">
	interface Props {
		label: string;
		value: string | null;
		hint?: string;
		error?: string | null;
		placeholder?: string;
		maxlength?: number;
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
	const describedBy = $derived(
		[hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') ||
			undefined
	);
</script>

<div class="field" class:invalid={Boolean(error)}>
	<label class="label" for={id}>
		{label}{#if optional}<span class="optional">Optional</span>{/if}
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
		align-items: baseline;
		justify-content: space-between;
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}

	.optional {
		font-size: var(--text-2xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
		color: var(--color-text-tertiary);
	}

	.input {
		width: 100%;
		min-height: 5.5rem;
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		background: var(--color-surface-2);
		box-shadow: inset 0 1px 0 0 var(--color-highlight);
		font-size: max(1rem, var(--text-base));
		line-height: var(--leading-normal);
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

	.hint,
	.error {
		font-size: var(--text-xs);
		color: var(--color-text-tertiary);
	}

	.error {
		color: var(--color-danger);
	}
</style>
