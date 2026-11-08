<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { preferences } from '#lib/client/preferences.svelte.ts';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import Stat from '#lib/ui/components/Stat.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';
	import Tabs from '#lib/ui/components/Tabs.svelte';

	type TabId = 'strength' | 'running' | 'general';
	let tab = $state<TabId>('strength');

	// Units follow the device preferences (Profile → Preferences).
	onMount(() => preferences.load());
	const weight = $derived(preferences.units);
	const distance = $derived(preferences.distance);

	const panels: Record<
		TabId,
		{
			tone: 'strength' | 'running' | 'conditioning';
			icon: 'train' | 'pulse' | 'flame';
			title: string;
			description: string;
			metrics: { label: string; unit: string }[];
		}
	> = $derived({
		strength: {
			tone: 'strength',
			icon: 'train',
			title: 'Strength trends start with your first sessions',
			description:
				'Estimated 1RMs, PRs and weekly volume per muscle group appear after two logged sessions — always labelled as estimated until you test a max.',
			metrics: [
				{ label: 'Est. 1RM', unit: weight },
				{ label: 'Volume', unit: `${weight} / wk` },
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
				{ label: 'Distance', unit: `${distance} / wk` },
				{ label: 'Avg pace', unit: `min / ${distance}` },
				{ label: 'Long run', unit: distance }
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
	});
</script>

<svelte:head>
	<title>Progress · Performance Coach</title>
</svelte:head>

<!-- A dashboard: wide from 1024 px (docs/design-system.md, Responsive layout → Content width). -->
<div data-layout="wide">
	<PageHeader title="Progress" eyebrow="Trends" />

	<div class="history">
		<ListRow
			title="Workout history"
			subtitle="Every finished workout, with its sets and notes"
			icon="clock"
			href={resolve('/(app)/progress/workouts/[[id]]', {})}
			data-testid="workout-history-row"
		/>
	</div>

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
			<div class="panel">
				<div class="metrics">
					{#each p.metrics as m (m.label)}
						<Stat label={m.label} caption={m.unit} />
					{/each}
				</div>

				<Surface padding="none" radius="xl" tone={p.tone}>
					<svg
						class="ghost-chart"
						viewBox="0 0 320 120"
						preserveAspectRatio="none"
						aria-hidden="true"
					>
						<!-- An empty plot: gridlines and a flat, neutral baseline. Never a made-up trend. -->
						{#each [24, 52, 80, 108] as y (y)}
							<line x1="0" x2="320" y1={y} y2={y} class="grid" />
						{/each}
						<line x1="0" x2="320" y1="66" y2="66" class="baseline" />
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
</div>

<style>
	.history {
		margin-bottom: var(--space-5);
	}

	.panel {
		display: grid;
		gap: var(--space-4);
	}

	.metrics {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--space-2);
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

	.baseline {
		stroke: var(--color-border-strong);
		stroke-width: 2;
		stroke-dasharray: 4 6;
		stroke-linecap: round;
	}

	/* A wider panel: roomier tiles over a taller plot, the three tiles still in one row. */
	@media (width >= 64rem) {
		.panel,
		.metrics {
			gap: var(--space-4);
		}

		.ghost-chart {
			height: 12rem;
		}
	}
</style>
