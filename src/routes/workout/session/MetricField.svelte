<!--
  @component
  One metric of an other session, with the control its type asks for (domain/workout/other.ts
  metricType, from the plan's value or the owner's when they added it): a stepper for a number
  (rounds, calories), a yes/no Toggle (sparred), a short text field (the class's focus). A metric
  the session may drop (the owner's own, or one its plan lacks) has a Remove button beside it.
  Its error, the view's or the server's, sits under it.
-->
<script lang="ts">
	import type { CustomMetric } from '#lib/domain/training/types.ts';
	import { metricType } from '#lib/domain/workout/other.ts';
	import IconButton from '#lib/ui/components/IconButton.svelte';
	import NumberStepper from '#lib/ui/components/NumberStepper.svelte';
	import TextField from '#lib/ui/components/TextField.svelte';
	import Toggle from '#lib/ui/components/Toggle.svelte';
	import { METRIC_LIMITS } from './session-log.ts';

	interface Props {
		metric: CustomMetric;
		/** How it is entered: the plan's type for a planned metric, else its own. */
		typedAs: CustomMetric['value'];
		error?: string | null;
		onchange: (value: CustomMetric['value']) => void;
		/** Given when the session may drop it. */
		onremove?: () => void;
	}

	let { metric, typedAs, error = null, onchange, onremove }: Props = $props();

	const type = $derived(metricType(typedAs));
	const asNumber = $derived(
		typeof metric.value === 'number' ? metric.value : Number(metric.value) || 0
	);
	// Tenths once the owner types a fraction, or the value has one; whole steps otherwise.
	let typedFraction = $state(false);
	const whole = $derived(!typedFraction && Number.isInteger(asNumber));
	function parse(text: string) {
		const n = Number(text.replace(',', '.'));
		if (Number.isFinite(n) && !Number.isInteger(n)) typedFraction = true;
		return n;
	}
</script>

<div class="metric" data-testid="metric-{metric.key}" data-type={type}>
	<div class="control">
		{#if type === 'number'}
			<NumberStepper
				label={metric.label}
				value={asNumber}
				min={0}
				max={100_000}
				step={whole ? 1 : 0.1}
				bigStep={whole ? 5 : 1}
				unit={metric.unit ?? undefined}
				{error}
				{parse}
				onchange={(v) => onchange(v)}
				ondraft={(v) => v !== null && onchange(v)}
			/>
		{:else if type === 'yes_no'}
			<Toggle
				label={metric.label}
				description={metric.unit ?? undefined}
				checked={metric.value === true}
				onchange={(checked) => onchange(checked)}
			/>
		{:else}
			<TextField
				label={metric.label}
				value={typeof metric.value === 'string' ? metric.value : String(metric.value)}
				maxlength={METRIC_LIMITS.text}
				{error}
				oninput={(e) => onchange(e.currentTarget.value)}
			/>
		{/if}
		{#if error && type === 'yes_no'}
			<p class="error" role="alert">{error}</p>
		{/if}
	</div>
	{#if onremove}
		<IconButton
			icon="trash"
			label="Remove {metric.label}"
			onclick={onremove}
			data-testid="remove-metric"
		/>
	{/if}
</div>

<style>
	.metric {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
	}

	.control {
		display: grid;
		flex: 1;
		gap: var(--space-1);
		min-width: 0;
	}

	.error {
		color: var(--color-danger);
		font-size: var(--text-xs);
		line-height: var(--leading-normal);
	}
</style>
