<!--
  @component
  A chart's table twin (docs/design-system.md, Data visualisation): the same numbers as the plot,
  server-rendered behind 'Show as table', so they read without JavaScript, to a screen reader and
  when the chart's code fails. Scoped headers with units, every value (a missing one is 'No data'),
  and the week in progress marked 'so far'. Values come formatted: the table never computes.
-->
<script lang="ts">
	import Icon from '../components/Icon.svelte';
	import type { ChartTableData } from './table.ts';

	let { title, rowHeader, columns, rows }: ChartTableData & { title: string } = $props();
</script>

<details class="twin" data-testid="chart-table">
	<summary><Icon name="chevron-right" size={16} strokeWidth={2} />Show as table</summary>
	<!-- A table wider than the phone scrolls on its own, and a keyboard can scroll it too. -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div class="scroll" role="region" aria-label={`${title}, table`} tabindex="0">
		<table>
			<caption class="visually-hidden">{title}</caption>
			<thead>
				<tr>
					<th scope="col">{rowHeader}</th>
					{#each columns as column (column.label)}
						<th scope="col">
							{column.label}{#if column.unit}<span class="unit">&nbsp;({column.unit})</span>{/if}
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each rows as row (row.label)}
					<tr data-in-progress={row.inProgress || undefined}>
						<th scope="row">
							{row.label}{#if row.inProgress}<span class="so-far">&nbsp;so far</span>{/if}
						</th>
						{#each row.values as value, i (i)}
							<td>
								{#if value === null}<span aria-hidden="true">—</span><span class="visually-hidden"
										>No data</span
									>{:else}{value}{/if}
							</td>
						{/each}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</details>

<style>
	.twin {
		min-width: 0;
	}

	summary {
		display: flex;
		align-items: center;
		gap: var(--space-1-5);
		min-height: var(--touch-target);
		width: fit-content;
		padding: 0 var(--space-2);
		margin-inline: calc(var(--space-2) * -1);
		border-radius: var(--radius-sm);
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		cursor: pointer;
		list-style: none;
		transition: background-color var(--duration-fast) var(--ease-standard);
	}

	summary::-webkit-details-marker {
		display: none;
	}

	summary :global(.icon) {
		transition: transform var(--duration-fast) var(--ease-standard);
	}

	.twin[open] summary :global(.icon) {
		transform: rotate(90deg);
	}

	summary:active {
		background: var(--color-surface-2);
	}

	@media (hover: hover) and (pointer: fine) {
		summary:hover {
			background: var(--color-surface-2);
			color: var(--color-text);
		}
	}

	.scroll {
		overflow-x: auto;
		margin-top: var(--space-2);
		border-radius: var(--radius-sm);
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--text-sm);
		font-variant-numeric: tabular-nums;
	}

	th,
	td {
		padding: var(--space-2) var(--space-3);
		border-bottom: 1px solid var(--color-hairline);
		text-align: end;
		white-space: nowrap;
	}

	th:first-child {
		padding-inline-start: 0;
		text-align: start;
	}

	thead th {
		color: var(--color-text-secondary);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
	}

	tbody th {
		font-weight: var(--weight-medium);
	}

	.unit {
		font-weight: var(--weight-regular);
	}

	.so-far {
		color: var(--color-text-secondary);
		font-weight: var(--weight-regular);
	}

	tr[data-in-progress] td {
		color: var(--color-text-secondary);
	}

	@media (prefers-reduced-motion: reduce) {
		summary,
		summary :global(.icon) {
			transition: none;
		}
	}
</style>
