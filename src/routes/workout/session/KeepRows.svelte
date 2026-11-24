<!--
  @component
  More to keep (Paper 4 · Train "More to keep"), the body of its sheet: a row per metric with its
  value, each opening a sheet over this one with the metric's control (MetricField: a stepper,
  yes or no, or a few words; Remove when the session may drop it, which closes that sheet). On an
  ad-hoc session "Track something else" adds one of the owner's own (AddMetricForm.svelte), with
  a line on how; a planned session takes its plan's metrics only. Every change goes to `onchange`
  as the whole list; a metric's error is under its row and at its control.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import type { CustomMetric } from '#lib/domain/training/types.ts';
	import SheetRow from '#lib/ui/components/SheetRow.svelte';
	import AddMetricForm from './AddMetricForm.svelte';
	import MetricField from './MetricField.svelte';
	import { metricField, removable, type SessionErrors } from './session-log.ts';
	import { metricValue } from './session-words.ts';

	interface Props {
		metrics: readonly CustomMetric[];
		/** The plan's metrics, or null on an ad-hoc session (session-log.ts templateOf). */
		template: readonly CustomMetric[] | null;
		errors: SessionErrors;
		onchange: (metrics: CustomMetric[]) => void;
	}

	let { metrics, template, errors, onchange }: Props = $props();

	let list: HTMLElement | undefined = $state();

	const typedAs = (m: CustomMetric) => template?.find((t) => t.key === m.key)?.value ?? m.value;
	const setMetric = (key: string, value: CustomMetric['value']) =>
		onchange(metrics.map((m) => (m.key === key ? { ...m, value } : m)));

	/** Its sheet goes with its row: the focus moves to the list's first row left. */
	async function remove(key: string, close: () => void) {
		close();
		onchange(metrics.filter((m) => m.key !== key));
		await tick();
		list?.querySelector<HTMLElement>('.row')?.focus();
	}

	/** A value not given yet is the row's placeholder ('Add', in tertiary). */
	const shown = (value: string) => (value === 'Add' ? undefined : value);
</script>

<div class="keep" bind:this={list}>
	{#each metrics as metric (metric.key)}
		<SheetRow
			label={metric.label}
			value={shown(metricValue(metric))}
			error={errors[metricField(metric.key)]}
			data-testid="keep-{metric.key}"
		>
			{#snippet children(close)}
				<MetricField
					{metric}
					typedAs={typedAs(metric)}
					error={errors[metricField(metric.key)]}
					onchange={(value) => setMetric(metric.key, value)}
					onremove={removable(template, metric.key)
						? () => void remove(metric.key, close)
						: undefined}
				/>
			{/snippet}
		</SheetRow>
	{/each}
	{#if template === null}
		<div class="add">
			<SheetRow label="Track something else" placeholder="" data-testid="add-metric">
				{#snippet children(close)}
					<AddMetricForm
						{metrics}
						onadd={(next) => {
							onchange(next);
							close();
						}}
					/>
				{/snippet}
			</SheetRow>
		</div>
	{/if}
</div>
{#if errors.metrics}<p class="error" role="alert">{errors.metrics}</p>{/if}
{#if template === null}
	<p class="foot">Name it once and pick number, yes or no, or a few words.</p>
{/if}

<style>
	.keep {
		display: grid;
	}

	.add {
		display: grid;
	}

	/* Paper: the way to add one is quieter than the metrics, its title in secondary. */
	.add > :global(.sheet-row > .row .title) {
		color: var(--color-text-secondary);
	}

	.foot {
		font: var(--type-secondary);
		color: var(--color-text-tertiary);
	}

	.error {
		font: var(--type-secondary);
		color: var(--color-danger);
	}
</style>
