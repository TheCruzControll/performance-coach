<script lang="ts">
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import BrandMark from '#lib/ui/components/BrandMark.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import Card from '#lib/ui/components/Card.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import IconButton from '#lib/ui/components/IconButton.svelte';
	import NumberStepper from '#lib/ui/components/NumberStepper.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import SegmentedControl from '#lib/ui/components/SegmentedControl.svelte';
	import Skeleton from '#lib/ui/components/Skeleton.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';
	import Tabs from '#lib/ui/components/Tabs.svelte';
	import { icons, type IconName } from '#lib/ui/icons/icons.ts';
	import { toast } from '#lib/ui/toast.svelte.ts';

	let reps = $state(5);
	let rpe = $state(8);
	let range = $state<'4w' | '12w' | '1y'>('12w');
	let tab = $state<'buttons' | 'inputs' | 'feedback'>('buttons');
	let sheet = $state(false);

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
				{:else if id === 'inputs'}
					<div class="grid">
						<Surface padding="lg" radius="xl">
							<div class="grid">
								<NumberStepper bind:value={reps} label="Reps" min={0} max={50} />
								<NumberStepper
									bind:value={rpe}
									label="RPE"
									min={6}
									max={10}
									step={0.5}
									hint="Reps in reserve: {10 - rpe}"
								/>
							</div>
						</Surface>
						<SegmentedControl
							label="Range"
							bind:value={range}
							options={[
								{ value: '4w', label: '4 weeks' },
								{ value: '12w', label: '12 weeks' },
								{ value: '1y', label: '1 year' }
							]}
						/>
					</div>
				{:else}
					<div class="grid">
						<div class="inline">
							<Button
								variant="secondary"
								onclick={() => toast.show('Set logged · 140 kg × 5 @ 8', { tone: 'positive' })}
								>Toast</Button
							>
							<Button
								variant="secondary"
								onclick={() =>
									toast.show('Sync failed — will retry', {
										tone: 'danger',
										action: { label: 'Retry', onclick: () => {} }
									})}>Error toast</Button
							>
							<Button variant="secondary" onclick={() => (sheet = true)} data-testid="open-sheet"
								>Bottom sheet</Button
							>
						</div>
						<Card eyebrow="Loading" title="Skeleton">
							<div class="skeletons" aria-busy="true">
								<Skeleton circle height="2.5rem" />
								<div class="grid tight">
									<Skeleton width="60%" />
									<Skeleton width="85%" height="0.75rem" />
								</div>
							</div>
						</Card>
						<Surface padding="none" radius="xl">
							<EmptyState
								icon="pulse"
								tone="running"
								title="No runs yet"
								description="Log a run and your pace trend appears here."
								compact
							/>
						</Surface>
					</div>
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

<BottomSheet bind:open={sheet} title="Substitute exercise" description="Same pattern, same intent.">
	<div class="grid">
		{#each ['Safety-bar squat', 'Hack squat', 'Belt squat'] as option (option)}
			<Surface padding="md" interactive>
				<div class="inline between">
					<span>{option}</span><Icon name="chevron-right" size={18} />
				</div>
			</Surface>
		{/each}
	</div>
	{#snippet footer()}
		<Button block onclick={() => (sheet = false)}>Done</Button>
	{/snippet}
</BottomSheet>

<style>
	.design {
		max-width: var(--content-max);
		margin: 0 auto;
		padding: var(--safe-top) var(--gutter) calc(var(--safe-bottom) + var(--space-16));
	}

	.section {
		display: grid;
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

	.type-row {
		display: flex;
		align-items: baseline;
		gap: var(--space-3);
		line-height: 1.2;
		padding: var(--space-1) 0;
		white-space: nowrap;
		overflow: hidden;
	}

	.type-step {
		flex: none;
		width: 2.5rem;
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

	.tight {
		flex: 1;
		gap: var(--space-2);
	}

	.inline {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.between {
		justify-content: space-between;
	}

	.skeletons {
		display: flex;
		align-items: center;
		gap: var(--space-3);
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
