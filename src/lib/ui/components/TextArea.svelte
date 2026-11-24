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
		font: var(--type-secondary);
		color: var(--color-text-secondary);
	}

	/* Instrument v2: 14 px corners, no border, the body's 17/26 text (≥ 16 px: no iOS zoom). */
	.input {
		width: 100%;
		min-height: 5.5rem;
		padding: var(--space-4) var(--space-4-5);
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		/* Surface-2 on the page; a sheet sets surface-3 (BottomSheet's --field-fill). */
		background: var(--field-fill, var(--color-surface-2));
		color: var(--color-text);
		font: var(--type-body);
		resize: vertical;
		field-sizing: content;
	}

	.input::placeholder {
		color: var(--field-quiet, var(--color-text-tertiary));
	}

	.input:focus-visible {
		/* The ring is the shadow; forced colours drop shadows and draw this outline instead. */
		outline: 2px solid transparent;
		box-shadow: 0 0 0 3px var(--color-accent-ring);
	}

	/* The error replaces the hint: one red line under the field, no red border. */
	.message {
		font: var(--type-secondary);
		color: var(--color-text-tertiary);
	}

	.error {
		padding-top: var(--space-0-5);
		color: var(--color-danger);
	}
</style>
