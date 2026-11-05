<!-- /design: data and status primitives (loaded when its tab opens). -->
<script lang="ts">
	import Badge from '#lib/ui/components/Badge.svelte';
	import Chip from '#lib/ui/components/Chip.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import Stat from '#lib/ui/components/Stat.svelte';
</script>

<div class="grid">
	<Section title="Stat">
		<div class="stats">
			<Stat label="Est. 1RM" value="182.5" unit="kg" caption="Back squat" />
			<Stat label="Sessions" caption="this week" />
			<Stat label="Volume" value="12.4" unit="t" caption="per week" />
		</div>
		<div class="stats">
			<Stat
				level={2}
				label="LCP"
				value="908"
				unit="ms"
				rating={{ tone: 'positive', label: 'Good' }}
			/>
			<Stat
				level={2}
				label="INP"
				value="240"
				unit="ms"
				rating={{ tone: 'warning', label: 'Needs work' }}
			/>
			<Stat level={2} label="CLS" value="0.31" rating={{ tone: 'danger', label: 'Poor' }} />
		</div>
	</Section>
	<Section title="Badge & chip">
		<div class="inline">
			<Badge>Soon</Badge>
			<Badge tone="accent" icon="target">First step</Badge>
			<Badge tone="positive" icon="check">Logged</Badge>
			<Badge tone="warning">Deload</Badge>
			<Badge tone="danger" icon="alert">Missed</Badge>
		</div>
		<ul class="inline chips">
			<Chip as="li" tone="strength">Strength</Chip>
			<Chip as="li" tone="running">Running</Chip>
			<Chip as="li" tone="combat">Muay Thai</Chip>
			<Chip as="li">Barbell</Chip>
		</ul>
	</Section>
	<Section title="List row">
		<ListRow
			icon="plate"
			tone="strength"
			title="Plate calculator"
			subtitle="Exact loading in kg or lb"
			onclick={() => {}}
		/>
		<ListRow icon="timer" title="Rest timer" subtitle="Arrives with workout logging" disabled>
			{#snippet trailing()}<Badge>Soon</Badge>{/snippet}
		</ListRow>
	</Section>
</div>

<style>
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

	.stats {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--space-2);
	}

	.chips {
		margin: 0;
		padding: 0;
		list-style: none;
	}
</style>
