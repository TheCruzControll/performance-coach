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
	import { icons, type IconName } from '#lib/ui/icons/icons.ts';

	type Group = 'buttons' | 'inputs' | 'data' | 'feedback';
	let tab = $state<Group>('buttons');

	// Only the first group ships with the page; the others load when their tab opens, so the
	// reference page stays inside the same initial-JS budget as the app screens.
	const PANELS: Record<Exclude<Group, 'buttons'>, () => Promise<{ default: Component }>> = {
		inputs: () => import('./InputsPanel.svelte'),
		data: () => import('./DataPanel.svelte'),
		feedback: () => import('./FeedbackPanel.svelte')
	};

	const colors = [
		['canvas', 'surface-1', 'surface-2', 'surface-3'],
		['text', 'text-secondary', 'text-tertiary', 'accent'],
		['strength', 'running', 'combat', 'hypertrophy', 'conditioning'],
		['positive', 'warning', 'danger', 'info']
	];
	const iconNames = Object.keys(icons) as IconName[];
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
				{ id: 'feedback', label: 'Feedback' }
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
		<h2 class="h">Icons</h2>
		<div class="icons">
			{#each iconNames as name (name)}
				<span class="icon-cell" title={name}><Icon {name} /></span>
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
</style>
