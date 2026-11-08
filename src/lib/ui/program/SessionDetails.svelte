<!--
  @component
  A session at a glance: its duration and target RPE as two stats (the intensity under the RPE),
  then an other session's metrics (rounds, round length, sparring, focus) as label and value
  rows. It lays out session-words.ts's detailsView: nothing here computes or invents a number.
  In a wide column (WIDE_DETAILS below) the metrics sit beside the two stats.
-->
<script lang="ts">
	import Section from '../components/Section.svelte';
	import Stat from '../components/Stat.svelte';
	import Surface from '../components/Surface.svelte';
	import type { DetailsView } from './session-words.ts';

	interface Props {
		details: DetailsView;
		'data-testid'?: string;
	}

	let { details, 'data-testid': testId }: Props = $props();
</script>

<div class="details" data-testid={testId}>
	<div class="layout">
		<ul class="facts">
			{#each details.facts as fact (fact.label)}
				<Stat
					as="li"
					level={2}
					label={fact.label}
					value={fact.value}
					unit={fact.unit ?? undefined}
					caption={fact.caption ?? undefined}
				/>
			{/each}
		</ul>

		{#if details.metrics.length}
			<Section title="Metrics">
				<Surface padding="none">
					<dl class="metrics">
						{#each details.metrics as metric (metric.label)}
							<div class="metric">
								<dt>{metric.label}</dt>
								<dd>{metric.value}</dd>
							</div>
						{/each}
					</dl>
				</Surface>
			</Section>
		{/if}
	</div>
</div>

<style>
	/* Its parts adapt to its own width (the column it is in), never the window's. */
	.details {
		container-type: inline-size;
	}

	.layout {
		display: grid;
		gap: var(--space-6);
	}

	.facts {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.metrics {
		display: grid;
		margin: 0;
	}

	/* A grouped list: label left, value right, hairlines between, ≥ 44 px a row. */
	.metric {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-4);
		min-height: var(--touch-target);
		padding: var(--space-3) var(--space-4);
	}

	.metric + .metric {
		border-top: 1px solid var(--color-hairline);
	}

	dt {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	dd {
		margin: 0;
		font-weight: var(--weight-semibold);
		text-align: right;
		overflow-wrap: anywhere;
	}

	/*
	 * WIDE_DETAILS: at least 35rem wide (a class's details in the session's main column on a
	 * desktop, a readable column from 640 px), the stats stack in a narrower column beside the
	 * metrics. Above the phone column (34rem), so an iPhone never sees it; in the session's side
	 * column, narrower, they stay as on a phone.
	 */
	@container (min-width: 35rem) {
		.layout:has(.metrics) {
			grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
			align-items: start;
		}

		.layout:has(.metrics) .facts {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
