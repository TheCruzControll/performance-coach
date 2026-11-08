<script lang="ts">
	import type { Component } from 'svelte';
	import BrandMark from '#lib/ui/components/BrandMark.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import Card from '#lib/ui/components/Card.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import IconButton from '#lib/ui/components/IconButton.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import Skeleton from '#lib/ui/components/Skeleton.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';
	import Tabs from '#lib/ui/components/Tabs.svelte';
	import { ICON_NAMES as iconNames } from '#lib/ui/icons/names.ts';

	type Group = 'buttons' | 'inputs' | 'data' | 'feedback' | 'program' | 'coach';
	let tab = $state<Group>('buttons');

	// Only the first group ships with the page; the others load when their tab opens, so the
	// reference page stays inside the same initial-JS budget as the app screens. The server
	// only renders Buttons, so its build leaves the other imports out: while the server can
	// reach them, SvelteKit links their CSS into the page as render-blocking stylesheets.
	const never = () => new Promise<never>(() => {});
	const PANELS: Record<Exclude<Group, 'buttons'>, () => Promise<{ default: Component }>> = {
		inputs: () => (import.meta.env.SSR ? never() : import('./InputsPanel.svelte')),
		data: () => (import.meta.env.SSR ? never() : import('./DataPanel.svelte')),
		feedback: () => (import.meta.env.SSR ? never() : import('./FeedbackPanel.svelte')),
		program: () => (import.meta.env.SSR ? never() : import('./ProgramPanel.svelte')),
		coach: () => (import.meta.env.SSR ? never() : import('./CoachPanel.svelte'))
	};
	// Charts are a section of their own: a seventh tab would not fit the phone's tab row (the six
	// already sit 4 px apart at 393 px, e2e/design-coach.e2e.ts). Like a tab, it loads on demand.
	const charts = () => (import.meta.env.SSR ? never() : import('./ChartsPanel.svelte'));
	let showCharts = $state(false);

	const colors = [
		['canvas', 'surface-1', 'surface-2', 'surface-3'],
		['text', 'text-secondary', 'text-tertiary', 'accent'],
		['strength', 'running', 'combat', 'hypertrophy', 'conditioning'],
		['positive', 'warning', 'danger', 'info']
	];
	const typeScale = ['6xl', '5xl', '4xl', '3xl', '2xl', 'xl', 'lg', 'base', 'sm', 'xs'];
</script>

<svelte:head>
	<title>Design system · Performance Coach</title>
</svelte:head>

<main id="main" class="design">
	<PageHeader title="Design system" eyebrow="Foundations">
		{#snippet trailing()}<BrandMark size={40} title="Performance Coach mark" />{/snippet}
	</PageHeader>

	<section class="section">
		<h2 class="h">Color</h2>
		{#each colors as row, i (i)}
			<div class="swatches">
				{#each row as name (name)}
					<div class="swatch">
						<span class="chip" style:background={`var(--color-${name})`}></span>
						<span class="swatch-name">{name}</span>
					</div>
				{/each}
			</div>
		{/each}
	</section>

	<section class="section">
		<h2 class="h">Type</h2>
		<Surface padding="md">
			{#each typeScale as step (step)}
				<p class="type-row" style:font-size={`var(--text-${step})`}>
					<span class="type-step">{step}</span>
					<span class={step.match(/xl|[3-6]xl/) ? 'display' : ''}>142.5 kg Squat</span>
				</p>
			{/each}
		</Surface>
	</section>

	<section class="section">
		<h2 class="h">Components</h2>
		<Tabs
			label="Component group"
			bind:value={tab}
			tabs={[
				{ id: 'buttons', label: 'Buttons' },
				{ id: 'inputs', label: 'Inputs' },
				{ id: 'data', label: 'Data' },
				{ id: 'feedback', label: 'Feedback' },
				// 'Program' is too wide for a fifth of the row at 393 px; it ran into 'Feedback'.
				{ id: 'program', label: 'Plan' },
				{ id: 'coach', label: 'Coach' }
			]}
		>
			{#snippet panel(id)}
				{#if id === 'buttons'}
					<div class="grid">
						<Button icon="bolt">Start workout</Button>
						<Button variant="secondary" icon="plate">Plate calculator</Button>
						<Button variant="ghost" iconEnd="chevron-right">View history</Button>
						<Button variant="danger" icon="close">Skip exercise</Button>
						<div class="inline">
							<Button size="sm">Small</Button>
							<Button size="md" variant="secondary">Medium</Button>
						</div>
						<Button size="lg" block loading>Saving</Button>
						<Button size="lg" block disabled>Disabled</Button>
						<div class="inline">
							<IconButton icon="plus" label="Add set" variant="accent" />
							<IconButton icon="timer" label="Rest timer" variant="filled" />
							<IconButton icon="close" label="Close" />
							<IconButton icon="minus" label="Remove" variant="filled" size="lg" />
						</div>
					</div>
				{:else}
					{#await PANELS[id]()}
						<div class="grid" aria-busy="true">
							<Skeleton height="10rem" radius="var(--radius-xl)" />
							<Skeleton height="3rem" radius="var(--radius-full)" />
						</div>
					{:then { default: Panel }}
						<Panel />
					{/await}
				{/if}
			{/snippet}
		</Tabs>
	</section>

	<section class="section">
		<h2 class="h">Cards & tones</h2>
		<div class="grid">
			{#each ['strength', 'running', 'combat', 'hypertrophy', 'conditioning'] as const as tone (tone)}
				<Card {tone} eyebrow={tone} title="Discipline surface" padding="md">
					<p class="muted">Tones tint a surface; they never shout.</p>
				</Card>
			{/each}
		</div>
	</section>

	<section class="section">
		<h2 class="h">Charts</h2>
		<div class="inline">
			<Button
				variant="secondary"
				iconEnd="chevron-down"
				aria-expanded={showCharts}
				aria-controls="design-charts"
				onclick={() => (showCharts = !showCharts)}
			>
				{showCharts ? 'Hide charts' : 'Show charts'}
			</Button>
		</div>
		<div id="design-charts">
			{#if showCharts}
				{#await charts()}
					<div class="grid" aria-busy="true">
						<Skeleton height="40rem" radius="var(--radius-lg)" />
					</div>
				{:then { default: Charts }}
					<Charts />
				{/await}
			{/if}
		</div>
	</section>

	<section class="section">
		<h2 class="h">Icons</h2>
		<div class="icons">
			{#each iconNames as name (name)}
				<span class="icon-cell" title={name}><Icon {name} label={name} /></span>
			{/each}
		</div>
	</section>
</main>

<style>
	.design {
		max-width: var(--content-max);
		margin: 0 auto;
		padding: var(--safe-top) var(--gutter) calc(var(--safe-bottom) + var(--space-16));
	}

	.section {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-3);
		margin-bottom: var(--space-10);
	}

	.h {
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		color: var(--color-text-secondary);
		letter-spacing: var(--tracking-normal);
	}

	.swatches {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(4.25rem, 1fr));
		gap: var(--space-2);
	}

	.swatch {
		display: grid;
		gap: var(--space-1);
	}

	.chip {
		height: 2.75rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--color-border);
	}

	.swatch-name {
		font-size: var(--text-2xs);
		color: var(--color-text-tertiary);
	}

	/* Specimens wrap at large steps instead of widening the page on a phone. */
	.type-row {
		display: grid;
		grid-template-columns: 2.5rem minmax(0, 1fr);
		align-items: baseline;
		gap: var(--space-3);
		line-height: 1.1;
		padding: var(--space-1) 0;
		overflow-wrap: anywhere;
	}

	.type-step {
		font-size: var(--text-2xs);
		color: var(--color-text-tertiary);
	}

	.display {
		font-family: var(--font-display);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-display);
		font-variant-numeric: tabular-nums;
	}

	.grid {
		display: grid;
		gap: var(--space-3);
	}

	.inline {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.muted {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.icons {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(3rem, 1fr));
		gap: var(--space-2);
	}

	.icon-cell {
		display: grid;
		place-items: center;
		height: 3rem;
		border-radius: var(--radius-sm);
		background: var(--color-surface-1);
		border: 1px solid var(--color-border);
		color: var(--color-text-secondary);
	}

	/*
	 * A desktop window: the gallery widens to --content-wide and its groups pair up, each at about
	 * the phone column's width, so no specimen is stretched: Color beside Type, Components beside
	 * Cards & tones. The header and the icon grid span both columns, and the grids get larger cells.
	 */
	@media (width >= 64rem) {
		.design {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			column-gap: var(--space-10);
			align-items: start;
			max-width: var(--content-wide);
		}

		.design > :global(*) {
			grid-column: 1 / -1;
		}

		.section:not(:last-child) {
			grid-column: auto;
		}

		.swatches {
			grid-template-columns: repeat(auto-fill, minmax(5rem, 1fr));
		}

		.chip {
			height: 3.5rem;
		}

		.icons {
			grid-template-columns: repeat(auto-fill, minmax(3.5rem, 1fr));
		}

		.icon-cell {
			height: 3.5rem;
		}
	}
</style>
