<script lang="ts">
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';
	import Tabs from '#lib/ui/components/Tabs.svelte';

	type TabId = 'strength' | 'running' | 'general';
	let tab = $state<TabId>('strength');

	const panels: Record<
		TabId,
		{
			tone: 'strength' | 'running' | 'conditioning';
			icon: 'train' | 'pulse' | 'flame';
			title: string;
			description: string;
			metrics: { label: string; unit: string }[];
		}
	> = {
		strength: {
			tone: 'strength',
			icon: 'train',
			title: 'Strength trends start with your first sessions',
			description:
				'Estimated 1RMs, PRs and weekly volume per muscle group appear after two logged sessions — always labelled as estimated until you test a max.',
			metrics: [
				{ label: 'Est. 1RM', unit: 'kg' },
				{ label: 'Volume', unit: 'kg / wk' },
				{ label: 'Avg RPE', unit: 'last 7 d' }
			]
		},
		running: {
			tone: 'running',
			icon: 'pulse',
			title: 'No runs logged yet',
			description:
				'Weekly mileage, pace trends and long-run progression build from your logged runs.',
			metrics: [
				{ label: 'Distance', unit: 'km / wk' },
				{ label: 'Avg pace', unit: 'min / km' },
				{ label: 'Long run', unit: 'km' }
			]
		},
		general: {
			tone: 'conditioning',
			icon: 'flame',
			title: 'Total load across disciplines',
			description:
				'Sessions, adherence and session-RPE load across lifting, running and Muay Thai show whether you are improving — and recovering.',
			metrics: [
				{ label: 'Sessions', unit: 'per week' },
				{ label: 'Load', unit: 'AU / wk' },
				{ label: 'Adherence', unit: '%' }
			]
		}
	};
</script>

<svelte:head>
	<title>Progress · Performance Coach</title>
</svelte:head>

<PageHeader title="Progress" eyebrow="Trends" />

<Tabs
	label="Discipline"
	bind:value={tab}
	tabs={[
		{ id: 'strength', label: 'Strength' },
		{ id: 'running', label: 'Running' },
		{ id: 'general', label: 'General' }
	]}
>
	{#snippet panel(id)}
		{@const p = panels[id]}
		<div class="panel" style:--tone={`var(--color-${p.tone})`}>
			<div class="metrics">
				{#each p.metrics as m (m.label)}
					<Surface padding="md" radius="lg">
						<p class="metric-label">{m.label}</p>
						<p class="metric-value numeric">—</p>
						<p class="metric-unit">{m.unit}</p>
					</Surface>
				{/each}
			</div>

			<Surface padding="none" radius="xl" tone={p.tone}>
				<svg
					class="ghost-chart"
					viewBox="0 0 320 120"
					preserveAspectRatio="none"
					aria-hidden="true"
				>
					{#each [24, 52, 80, 108] as y (y)}
						<line x1="0" x2="320" y1={y} y2={y} class="grid" />
					{/each}
					<path class="trend" d="M0 96 C 48 92, 72 84, 112 80 S 176 60, 216 58 S 280 36, 320 30" />
				</svg>
				<EmptyState
					icon={p.icon}
					tone={p.tone}
					title={p.title}
					description={p.description}
					compact
				/>
			</Surface>
		</div>
	{/snippet}
</Tabs>

<style>
	.panel {
		display: grid;
		gap: var(--space-4);
	}

	.metrics {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--space-2);
	}

	.metric-label {
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}

	.metric-value {
		margin-top: var(--space-2);
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
		line-height: 1;
		color: var(--color-text-tertiary);
	}

	.metric-unit {
		margin-top: var(--space-1);
		font-size: var(--text-2xs);
		color: var(--color-text-tertiary);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
	}

	.ghost-chart {
		width: 100%;
		height: 7.5rem;
		margin-top: var(--space-4);
	}

	.grid {
		stroke: var(--color-hairline);
		stroke-width: 1;
	}

	.trend {
		fill: none;
		stroke: color-mix(in srgb, var(--tone) 55%, transparent);
		stroke-width: 2;
		stroke-dasharray: 4 6;
		stroke-linecap: round;
	}
</style>
