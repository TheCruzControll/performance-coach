<!--
  @component
  Pick one (radio) or several (checkbox) from a short list, as wrapping pills or full-width
  cards with a hint. Native inputs inside a fieldset: arrow keys, Space and screen readers
  work without any ARIA of our own. Every option is at least 44 px tall.
-->
<script lang="ts" generics="T extends string">
	import type { DisciplineTone } from '#lib/domain/profile/catalog.ts';

	interface Option {
		value: T;
		label: string;
		hint?: string;
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
		/** Multiple choice. */
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
	const describedBy = $derived(
		[hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') ||
			undefined
	);

	function toggle(option: T, checked: boolean) {
		if (multiple) {
			values = checked
				? [...values.filter((v) => v !== option), option]
				: values.filter((v) => v !== option);
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
	aria-describedby={describedBy}
	data-testid={testId}
>
	<legend class={hideLegend ? 'visually-hidden' : 'legend'}>{legend}</legend>
	{#if hint}<p class="hint" id="{id}-hint">{hint}</p>{/if}
	<div class="options">
		{#each options as option (option.value)}
			<label class="option">
				<input
					class="input"
					type={multiple ? 'checkbox' : 'radio'}
					name={id}
					value={option.value}
					checked={multiple ? values.includes(option.value) : value === option.value}
					onchange={(e) => toggle(option.value, e.currentTarget.checked)}
				/>
				<span class="face">
					{#if option.tone}<span
							class="dot"
							style:background={`var(--color-${option.tone})`}
							aria-hidden="true"
						></span>{/if}
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
		padding: 0;
		border: 0;
	}

	.legend {
		margin-bottom: var(--space-1);
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

	.input {
		position: absolute;
		opacity: 0;
		inset: 0;
		margin: 0;
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
		pointer-events: none;
		transition:
			background-color var(--duration-fast) var(--ease-standard),
			border-color var(--duration-fast) var(--ease-standard),
			color var(--duration-fast) var(--ease-standard);
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

	.input:focus-visible + .face {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	.option:active .face {
		transform: scale(0.98);
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
		text-align: left;
	}

	.label {
		color: inherit;
	}

	[data-variant='card'] .label {
		font-size: var(--text-base);
		font-weight: var(--weight-semibold);
		color: var(--color-text);
	}

	.sub,
	.hint {
		font-size: var(--text-xs);
		font-weight: var(--weight-regular);
		color: var(--color-text-tertiary);
	}

	.mark {
		flex: none;
		width: 1.25rem;
		height: 1.25rem;
		border-radius: 50%;
		border: 1.5px solid var(--color-border-strong);
	}

	.input:checked + .face .mark {
		border: 6px solid var(--color-accent);
		background: var(--color-on-accent);
	}

	.error {
		font-size: var(--text-xs);
		color: var(--color-danger);
	}

	.invalid .face {
		border-color: color-mix(in srgb, var(--color-danger) 45%, transparent);
	}
</style>
