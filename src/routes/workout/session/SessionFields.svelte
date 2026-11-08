<!--
  @component
  An other session's fields, as the session view and its Fix editor ask for them: the type (from
  the plan, or picked), the duration in minutes (nudged or typed), the RPE chips, each metric with
  its own control (MetricField), and the notes. On an ad-hoc session the owner adds metrics of
  their own: a name and how it is recorded (a number, yes or no, a short text). Every change goes
  out through onchange, the whole metrics list at once; errors come in by field (session-log.ts
  SessionErrors), a metric's under its key.
-->
<script lang="ts">
	import type { CustomMetric } from '#lib/domain/training/types.ts';
	import type { OtherSessionKind } from '#lib/domain/training/vocabulary.ts';
	import type { OtherFields } from '#lib/domain/workout/index.ts';
	import type { MetricType } from '#lib/domain/workout/other.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import ChoiceGroup from '#lib/ui/components/ChoiceGroup.svelte';
	import NumberStepper from '#lib/ui/components/NumberStepper.svelte';
	import TextArea from '#lib/ui/components/TextArea.svelte';
	import TextField from '#lib/ui/components/TextField.svelte';
	import RpeChips from '#lib/ui/workout/RpeChips.svelte';
	import MetricField from './MetricField.svelte';
	import {
		addMetric,
		KIND_WORDS,
		metricField,
		removable,
		SESSION_MINUTES,
		SESSION_RPE_CHIPS,
		type SessionErrors
	} from './session-log.ts';

	interface Props {
		values: OtherFields;
		errors: SessionErrors;
		/** The plan's metrics, or null on an ad-hoc session (session-log.ts templateOf). */
		template: readonly CustomMetric[] | null;
		onchange: (change: Partial<OtherFields>) => void;
	}

	let { values, errors, template, onchange }: Props = $props();

	const kinds = Object.entries(KIND_WORDS).map(([value, label]) => ({
		value: value as OtherSessionKind,
		label
	}));
	const RECORDED_AS: { value: MetricType; label: string }[] = [
		{ value: 'number', label: 'A number' },
		{ value: 'yes_no', label: 'Yes or no' },
		{ value: 'text', label: 'A short text' }
	];

	const typedAs = (m: CustomMetric) => template?.find((t) => t.key === m.key)?.value ?? m.value;
	const setMetric = (key: string, value: CustomMetric['value']) =>
		onchange({ metrics: values.metrics.map((m) => (m.key === key ? { ...m, value } : m)) });
	const dropMetric = (key: string) =>
		onchange({ metrics: values.metrics.filter((m) => m.key !== key) });

	// The owner's own metric, being named.
	let adding = $state(false);
	let name = $state('');
	let recordedAs = $state<MetricType | null>('number');
	let addError = $state<string | null>(null);

	function add() {
		const result = addMetric(values.metrics, name, recordedAs ?? 'number');
		if (!result.ok) return void (addError = result.error);
		onchange({ metrics: result.metrics });
		name = '';
		addError = null;
		adding = false;
	}
</script>

<div class="fields">
	<ChoiceGroup
		legend="Type"
		options={kinds}
		error={errors.kind}
		bind:value={() => values.kind, (kind) => kind && onchange({ kind })}
		data-testid="session-type"
	/>
	<NumberStepper
		label="Duration"
		value={values.durationMinutes}
		min={SESSION_MINUTES[0]}
		max={SESSION_MINUTES[1]}
		step={1}
		bigStep={5}
		unit="min"
		error={errors.durationMinutes}
		onchange={(durationMinutes) => onchange({ durationMinutes })}
		ondraft={(durationMinutes) => durationMinutes !== null && onchange({ durationMinutes })}
		data-testid="session-duration"
	/>
	<RpeChips chips={SESSION_RPE_CHIPS} value={values.rpe} onchange={(rpe) => onchange({ rpe })} />
	{#if errors.rpe}<p class="error" role="alert">RPE: {errors.rpe}</p>{/if}

	<section class="metrics" aria-labelledby="session-metrics" data-testid="session-metrics">
		<h3 id="session-metrics">What you tracked</h3>
		{#each values.metrics as metric (metric.key)}
			<MetricField
				{metric}
				typedAs={typedAs(metric)}
				error={errors[metricField(metric.key)]}
				onchange={(value) => setMetric(metric.key, value)}
				onremove={removable(template, metric.key) ? () => dropMetric(metric.key) : undefined}
			/>
		{:else}
			<p class="empty">
				{template === null
					? 'Add what you want to keep, like rounds or calories.'
					: 'This session’s plan tracks nothing more.'}
			</p>
		{/each}
		{#if errors.metrics}<p class="error" role="alert">{errors.metrics}</p>{/if}

		{#if template === null}
			{#if adding}
				<div class="add" data-testid="add-metric-form">
					<TextField
						label="Metric name"
						bind:value={name}
						maxlength={40}
						error={addError}
						placeholder="Bike calories"
						autocapitalize="sentences"
						data-testid="metric-name"
					/>
					<ChoiceGroup legend="Recorded as" options={RECORDED_AS} bind:value={recordedAs} />
					<div class="actions">
						<Button variant="ghost" onclick={() => ((adding = false), (addError = null))}>
							Cancel
						</Button>
						<Button icon="check" onclick={add} data-testid="confirm-metric">Add</Button>
					</div>
				</div>
			{:else}
				<Button
					variant="secondary"
					icon="plus"
					onclick={() => (adding = true)}
					data-testid="add-metric">Add a metric</Button
				>
			{/if}
		{/if}
	</section>

	<TextArea
		label="Notes"
		optional
		maxlength={500}
		error={errors.notes}
		bind:value={() => values.notes ?? '', (notes) => onchange({ notes })}
		data-testid="session-notes"
	/>
</div>

<style>
	.fields,
	.metrics,
	.add {
		display: grid;
		gap: var(--space-4);
	}

	h3 {
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
	}

	.empty {
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
	}

	.add {
		padding: var(--space-4);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-surface-2);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
	}

	.error {
		color: var(--color-danger);
		font-size: var(--text-xs);
	}
</style>
