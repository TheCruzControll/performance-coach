<!--
  @component
  A number that may be left blank (a 1RM, a body weight, a race distance). Opens the decimal or
  numeric keypad on phones, keeps the unit beside the value, and never invents a number: an
  empty field is `null`. For counts and durations people nudge, use NumberStepper.
-->
<script lang="ts">
	interface Props {
		label: string;
		value: number | null | undefined;
		unit?: string;
		hint?: string;
		error?: string | null;
		/** Whole numbers only (numeric keypad). */
		integer?: boolean;
		/** Show "Optional" beside the label. */
		optional?: boolean;
		placeholder?: string;
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
		oninput,
		'data-testid': testId
	}: Props = $props();

	const id = $props.id();
	const describedBy = $derived(
		[hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') ||
			undefined
	);

	// The text as typed ("82." while typing 82.5); `value` is what it means.
	let text = $state('');
	let last: number | null | undefined;
	$effect.pre(() => {
		if (value !== last) {
			text = value == null ? '' : String(value);
			last = value;
		}
	});

	function input(event: Event & { currentTarget: HTMLInputElement }) {
		const raw = event.currentTarget.value.replace(',', '.');
		// Keep digits and one decimal point; anything else never reaches the value.
		let clean = raw.replace(integer ? /[^\d]/g : /[^\d.]/g, '');
		const dot = clean.indexOf('.');
		if (dot !== -1) clean = clean.slice(0, dot + 1) + clean.slice(dot + 1).replace(/\./g, '');
		if (clean !== event.currentTarget.value) event.currentTarget.value = clean;
		text = clean;
		const next = clean === '' || clean === '.' ? null : Number(clean);
		last = next;
		value = next;
		oninput?.(next);
	}
</script>

<div class="field" class:invalid={Boolean(error)}>
	<label class="label" for={id}>
		{label}{#if optional}<span class="optional">Optional</span>{/if}
	</label>
	<div class="control">
		<input
			{id}
			class="input numeric"
			type="text"
			inputmode={integer ? 'numeric' : 'decimal'}
			autocomplete="off"
			enterkeyhint="done"
			{placeholder}
			value={text}
			aria-invalid={error ? 'true' : undefined}
			aria-describedby={describedBy}
			oninput={input}
			data-testid={testId}
		/>
		{#if unit}<span class="unit" aria-hidden="true">{unit}</span>{/if}
	</div>
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
		min-width: 0;
	}

	.label {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-2);
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
		color: var(--color-text);
		font-family: var(--font-numeric);
		font-size: var(--text-xl);
		font-weight: var(--weight-semibold);
		font-variant-numeric: lining-nums proportional-nums;
		letter-spacing: var(--tracking-tight);
	}

	.input::placeholder {
		color: var(--color-text-tertiary);
		font-weight: var(--weight-regular);
	}

	.input:focus-visible {
		outline: none;
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

	.hint,
	.error {
		font-size: var(--text-xs);
		color: var(--color-text-tertiary);
	}

	.error {
		color: var(--color-danger);
	}
</style>
