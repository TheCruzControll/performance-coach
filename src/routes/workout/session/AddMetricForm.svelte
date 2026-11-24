<!--
  @component
  "Track something else" (Paper 4 · Train "More to keep"), the body of its sheet: the metric's
  name and how it is recorded (a number, yes or no, or a few words), then Add. A name Save could
  not use is said under the field (session-log.ts addMetric); an added one goes to `onadd` with
  the session's metrics, and the sheet closes.
-->
<script lang="ts">
	import type { CustomMetric } from '#lib/domain/training/types.ts';
	import type { MetricType } from '#lib/domain/workout/other.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import ChoiceGroup from '#lib/ui/components/ChoiceGroup.svelte';
	import TextField from '#lib/ui/components/TextField.svelte';
	import { addMetric, METRIC_LIMITS } from './session-log.ts';

	interface Props {
		metrics: readonly CustomMetric[];
		onadd: (metrics: CustomMetric[]) => void;
	}

	let { metrics, onadd }: Props = $props();

	const RECORDED_AS: { value: MetricType; label: string }[] = [
		{ value: 'number', label: 'A number' },
		{ value: 'yes_no', label: 'Yes or no' },
		{ value: 'text', label: 'A short text' }
	];

	let name = $state('');
	let recordedAs = $state<MetricType | null>('number');
	let error = $state<string | null>(null);

	function add() {
		const result = addMetric(metrics, name, recordedAs ?? 'number');
		if (!result.ok) return void (error = result.error);
		onadd(result.metrics);
	}
</script>

<div class="add">
	<TextField
		label="Metric name"
		bind:value={name}
		maxlength={METRIC_LIMITS.label}
		{error}
		placeholder="Bike calories"
		autocapitalize="sentences"
		data-testid="metric-name"
	/>
	<ChoiceGroup legend="Recorded as" variant="card" options={RECORDED_AS} bind:value={recordedAs} />
	<Button size="lg" block onclick={add} data-testid="confirm-metric">Add</Button>
</div>

<style>
	.add {
		display: grid;
		gap: var(--space-5);
	}
</style>
