<!--
  @component
  The weekly review's sections after its trends (sections.ts): RPE against target as diverging
  bars, volume and intensity with hard sets per group as range bars against the week's range and
  planned tick, running, Muay Thai, recovery and fatigue with its reasons, conflicting demands
  with their why, and PRs. Each section is a disclosure whose summary is its title and verdict
  line: on a phone it starts collapsed to that line; from 1024 px every section shows in full.
  The body follows its <details> rather than sitting inside it, so a closed disclosure hides it
  only below 1024 px, in every engine (WebKit treats what a closed <details> holds as hidden,
  whatever the CSS). Every figure carries its canonical value in data-value. A chart's room is
  reserved on the server and its frame loads after hydration; without JavaScript its title,
  summary and numbers are a table in that room. If the frame fails to load, the room says so,
  with Retry.
-->
<script lang="ts">
	import Button from '#lib/ui/components/Button.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import type { SectionView } from './sections';

	let { sections }: { sections: readonly SectionView[] } = $props();

	// A chart's frame loads after hydration, never on the server (guarded as bodies.ts guards a
	// body), so ChartFrame, the bodies and their styles are neither initial JS nor render-blocking
	// CSS (the m6-plan budget lever). Until then the server's reserved room stays. If it fails,
	// Retry reloads the page: Chromium keeps a failed module fetch for the document's lifetime.
	const never = () => new Promise<never>(() => {});
	const block = import.meta.env.SSR ? never() : import('./ChartBlock.svelte');
</script>

{#each sections as section (section.id)}
	<div class="section" data-testid="review-section" data-section={section.id}>
		<details>
			<summary>
				<span class="head">
					<h3>{section.title}</h3>
					<span class="verdict" data-level={section.verdict.level} data-testid="section-verdict"
						>{section.verdict.words}</span
					>
				</span>
				<Icon name="chevron-down" size={20} class="chevron" />
			</summary>
		</details>
		<div class="body">
			{#if section.chart}
				{#await block}
					<figure class="slot" style:--plot={section.chart.height} aria-busy="true">
						<noscript>
							<table data-testid="chart-table">
								<caption>{section.chart.title}: {section.chart.summary}</caption>
								<thead>
									<tr>
										<th scope="col">{section.chart.table.rowHeader}</th>
										{#each section.chart.table.columns as column (column.label)}
											<th scope="col">{column.label}{column.unit ? ` (${column.unit})` : ''}</th>
										{/each}
									</tr>
								</thead>
								<tbody>
									{#each section.chart.table.rows as row (row.label)}
										<tr>
											<th scope="row">{row.label}</th>
											{#each row.values as value, i (i)}<td>{value ?? 'No data'}</td>{/each}
										</tr>
									{/each}
								</tbody>
							</table>
						</noscript>
					</figure>
				{:then { default: Block }}
					<Block chart={section.chart} />
				{:catch}
					<figure class="slot">
						<p>Couldn’t load this chart.</p>
						<Button variant="secondary" icon="refresh" onclick={() => location.reload()}
							>Try again</Button
						>
					</figure>
				{/await}
			{/if}
			<ul class="items">
				{#each section.items as item (item.id)}
					<li class="item" data-testid="review-item" data-id={item.id}>
						<h4>{item.label}</h4>
						<p class="words" data-testid="item-words">{item.words}</p>
						<ul class="reasons">
							{#each item.reasons as reason (reason)}<li>{reason}</li>{/each}
						</ul>
						<dl class="figures">
							{#each item.figures as figure (figure.label)}
								<div data-label={figure.label} data-value={figure.value}>
									<dt>{figure.label}</dt>
									<dd class="numeric">{figure.words}</dd>
								</div>
							{/each}
						</dl>
					</li>
				{/each}
			</ul>
		</div>
	</div>
{/each}

<style>
	.section {
		border-top: 1px solid var(--color-border);
	}

	summary {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-height: var(--touch-target);
		padding-block: var(--space-3);
		cursor: pointer;
		list-style: none;
	}

	summary::-webkit-details-marker {
		display: none;
	}

	summary:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	.head {
		display: grid;
		flex: 1;
		gap: var(--space-0-5);
	}

	h3 {
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
	}

	.verdict,
	.words,
	.slot p,
	.reasons {
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
	}

	.verdict {
		color: var(--color-text-secondary);
	}

	/* One to watch reads stronger; its words say why, never the colour alone. */
	.verdict[data-level='watch'],
	.verdict[data-level='low'] {
		font-weight: var(--weight-medium);
		color: var(--color-text);
	}

	[open] :global(.chevron) {
		rotate: 180deg;
	}

	.body,
	.items,
	.item {
		display: grid;
		gap: var(--space-3);
	}

	.body {
		padding-bottom: var(--space-4);
	}

	.items {
		gap: var(--space-2);
		padding: 0;
		list-style: none;
	}

	.item {
		gap: var(--space-2);
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-lg);
		background: var(--color-surface-1);
	}

	h4,
	dd {
		font-weight: var(--weight-semibold);
	}

	.reasons {
		padding-left: var(--space-5);
	}

	/* A list with nothing in it takes no room (only Svelte's comment markers inside). */
	ul:empty,
	dl:empty {
		display: none;
	}

	.figures {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-5);
	}

	dt {
		font-size: var(--text-xs);
		color: var(--color-text-secondary);
	}

	/* Below 1024 px a section's body shows once its disclosure is open. */
	@media (width < 64rem) {
		details:not([open]) + .body {
			display: none;
		}
	}

	/* From 1024 px every section shows in full: nothing to open. */
	@media (width >= 64rem) {
		summary {
			cursor: auto;
		}

		summary :global(.chevron) {
			display: none;
		}
	}

	/* ChartFrame's room: its plot, and about its caption, padding and table toggle around it. */
	.slot {
		display: grid;
		align-content: center;
		justify-items: start;
		gap: var(--space-3);
		min-block-size: calc(var(--plot) + 9.5rem);
		padding: var(--space-4);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
	}

	.slot table {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	th,
	td {
		padding: var(--space-1) var(--space-2);
		text-align: start;
	}
</style>
