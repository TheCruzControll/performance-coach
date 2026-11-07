<!--
  @component
  Today once onboarding is complete: the open goals by rank (weeks to go counted from the device's
  date) and, unless `showWeek` is off, the shape of the week. Code-split behind PanelLoader.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import Badge from '#lib/ui/components/Badge.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import Card from '#lib/ui/components/Card.svelte';
	import Chip from '#lib/ui/components/Chip.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import type { weeksUntil as WeeksUntil } from '#lib/ui/profile/goals.ts';
	import type { PageData } from '../$types';

	interface Props {
		setup: Extract<NonNullable<PageData['setup']>, { complete: true }>;
		/** The schedule's shape (days, session length, commitments); a program's week replaces it. */
		showWeek?: boolean;
	}

	let { setup, showWeek = true }: Props = $props();

	// Dates depend on the device's time zone, so they render after hydration.
	let today = $state<Date | null>(null);
	/**
	 * Weeks to each goal's date, from the device's date. The helper loads after hydration, when the
	 * count can first be shown: it is not part of the screen's initial JS (docs/performance.md).
	 */
	let weeksUntil = $state<typeof WeeksUntil>();
	onMount(() => {
		today = new Date();
		import('#lib/ui/profile/goals.ts').then(
			(m) => (weeksUntil = m.weeksUntil),
			() => {} // Offline or a stale build: the countdown stays blank, as before hydration.
		);
	});

	/** "10 weeks to go", once the helper has loaded (a blank line until then). */
	function countdown(date: string): string {
		if (!weeksUntil) return '\u00a0';
		const weeks = weeksUntil(date, today!);
		if (weeks === null) return 'Date passed';
		if (weeks === 0) return 'Less than a week to go';
		return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} to go`;
	}

	const profileHref = (section: 'goals' | 'schedule') =>
		resolve('/(app)/profile/[section]', { section });
</script>

<Section title="Goals" data-testid="today-goals">
	{#snippet action()}
		<Button size="sm" variant="ghost" href={profileHref('goals')}>Edit goals</Button>
	{/snippet}
	{#if setup.goals.length}
		<Card padding="sm">
			<ol class="goals">
				{#each setup.goals as goal, rank (goal.id)}
					<li class="goal" data-testid="today-goal">
						<span class="rank numeric" aria-hidden="true">{rank + 1}</span>
						<div class="goal-body">
							<div class="goal-head">
								<h3 class="goal-title">{goal.title}</h3>
								{#if rank === 0}<Badge tone="accent">Top priority</Badge>{/if}
								{#if goal.paused}<Badge>Paused</Badge>{/if}
							</div>
							<ul class="chips" aria-label="Disciplines">
								{#each goal.disciplines as discipline, d (d)}
									<Chip as="li" tone={discipline.tone}>{discipline.name}</Chip>
								{/each}
							</ul>
							{#if goal.date}
								<p class="countdown numeric" data-testid="today-goal-countdown">
									{countdown(goal.date)}
								</p>
							{/if}
						</div>
					</li>
				{/each}
			</ol>
		</Card>
	{:else}
		<Card padding="lg" data-testid="today-goals-empty">
			<EmptyState
				compact
				icon="target"
				title="No open goals"
				description="Your coach plans around what you’re training for. Add a goal, or bring back a past one."
			>
				{#snippet actions()}
					<Button variant="secondary" icon="plus" href={profileHref('goals')}>Add a goal</Button>
				{/snippet}
			</EmptyState>
		</Card>
	{/if}
</Section>

{#if showWeek}
	<Section title="Schedule" data-testid="today-schedule">
		{#snippet action()}
			<Button size="sm" variant="ghost" href={profileHref('schedule')}>Edit schedule</Button>
		{/snippet}
		<Card padding="md">
			<div class="schedule">
				<p class="schedule-summary" data-testid="today-schedule-summary">
					{setup.week.summary ?? 'Days per week not set yet'}
				</p>
				{#if setup.week.available}
					<p class="schedule-days">Free to train {setup.week.available}</p>
				{/if}
				{#if setup.week.commitments.length}
					<ul class="commitments">
						{#each setup.week.commitments as commitment (commitment.id)}
							<li class="commitment" data-testid="today-commitment">
								<span
									class="commitment-dot"
									style:background={`var(--color-${commitment.tone})`}
									aria-hidden="true"
								></span>
								<span class="commitment-label">{commitment.label}</span>
								<span class="commitment-when">{commitment.when}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</Card>
	</Section>
{/if}

<style>
	.goals,
	.chips,
	.commitments {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.goals {
		display: grid;
	}

	.goal {
		display: grid;
		grid-template-columns: 1.75rem minmax(0, 1fr);
		gap: var(--space-3);
		padding: var(--space-3) var(--space-2);
	}

	.goal + .goal {
		border-top: 1px solid var(--color-hairline);
	}

	.rank {
		display: grid;
		place-items: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: var(--radius-full);
		background: var(--color-surface-2);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		color: var(--color-text-secondary);
	}

	.goal-body {
		display: grid;
		gap: var(--space-2);
	}

	.goal-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		min-height: 1.75rem;
	}

	.goal-title {
		font-size: var(--text-base);
		font-weight: var(--weight-semibold);
		line-height: var(--leading-tight);
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1-5);
	}

	/* One line, held from the first paint: the words arrive after hydration. */
	.countdown {
		min-height: 1.25rem;
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.schedule {
		display: grid;
		gap: var(--space-2);
	}

	.schedule-summary {
		font-size: var(--text-base);
		font-weight: var(--weight-semibold);
	}

	.schedule-days {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.commitments {
		display: grid;
		gap: var(--space-2);
		margin-top: var(--space-2);
		padding-top: var(--space-3);
		border-top: 1px solid var(--color-hairline);
	}

	.commitment {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: center;
		column-gap: var(--space-2);
		font-size: var(--text-sm);
	}

	.commitment-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
	}

	.commitment-label {
		font-weight: var(--weight-medium);
	}

	.commitment-when {
		grid-column: 2;
		color: var(--color-text-secondary);
	}
</style>
