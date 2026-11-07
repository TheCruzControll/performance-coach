<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { preferences } from '#lib/client/preferences.svelte.ts';
	import { STEP_INFO } from '#lib/domain/profile/onboarding.ts';
	import Badge from '#lib/ui/components/Badge.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import Card from '#lib/ui/components/Card.svelte';
	import Chip from '#lib/ui/components/Chip.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import Skeleton from '#lib/ui/components/Skeleton.svelte';
	import Stat from '#lib/ui/components/Stat.svelte';
	import { stepHref } from '../../onboarding/paths';
	import type { weeksUntil as WeeksUntil } from '#lib/ui/profile/goals.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** The setup card failed to load: Retry runs the load again (the card streams in afresh). */
	let retrying = $state(false);
	async function retry() {
		retrying = true;
		await invalidateAll();
		retrying = false;
	}

	const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

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

	// Formatted without Intl: the first Intl.DateTimeFormat costs ~20 ms of main-thread time
	// during hydration (measured with a CPU profile); these names never change.
	const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
	const MONTH_NAMES = [
		'January',
		'February',
		'March',
		'April',
		'May',
		'June',
		'July',
		'August',
		'September',
		'October',
		'November',
		'December'
	];
	const eyebrow = $derived(
		today
			? `${DAY_NAMES[today.getDay()]} ${today.getDate()} ${MONTH_NAMES[today.getMonth()]}`
			: '\u00a0'
	);
	const week = $derived.by(() => {
		if (!today) return WEEKDAYS.map((letter) => ({ letter, date: null, isToday: false }));
		const y = today.getFullYear();
		const m = today.getMonth();
		const mondayOffset = (today.getDay() + 6) % 7;
		return WEEKDAYS.map((letter, i) => {
			const d = new Date(y, m, today!.getDate() - mondayOffset + i);
			return { letter, date: d.getDate(), isToday: i === mondayOffset };
		});
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

	const stats = $derived([
		{ label: 'Sessions', caption: 'this week' },
		{ label: 'Load', caption: 'AU' },
		{ label: 'Distance', caption: preferences.distance }
	]);
</script>

<svelte:head>
	<title>Today · Performance Coach</title>
</svelte:head>

<PageHeader title="Today" {eyebrow} />

<ol class="week" aria-label="This week">
	{#each week as day, i (i)}
		<li class="day" class:today={day.isToday} aria-current={day.isToday ? 'date' : undefined}>
			<span class="letter">{day.letter}</span>
			<span class="date numeric">{day.date ?? '·'}</span>
			<!-- Once set up: a ring on the days free to train, a discipline dot on booked ones. -->
			{#await data.setup}
				<span class="dot" aria-hidden="true"></span>
			{:then setup}
				{@const mark = setup?.complete ? setup.week.days[i] : undefined}
				{@const booked = mark?.booked[0]}
				<span
					class="dot"
					class:free={mark?.available}
					style:background={booked ? `var(--color-${booked.tone})` : undefined}
					aria-hidden="true"
					data-testid={booked ? 'today-day-booked' : undefined}
				></span>
				{#if mark?.booked.length}
					<span class="visually-hidden">{mark.booked.map((b) => b.label).join(', ')}</span>
				{/if}
			{/await}
		</li>
	{/each}
</ol>

<div class="stack">
	<!-- The setup card streams in (+page.server.ts): a skeleton of its shape until then. -->
	{#await data.setup}
		<Card padding="lg" data-testid="today-setup-loading">
			<div class="session" aria-busy="true">
				<Skeleton width="6.5rem" height="1.5rem" radius="var(--radius-full)" />
				<Skeleton width="80%" height="1.875rem" radius="var(--radius-sm)" />
				<div class="lines">
					<Skeleton height="0.875rem" />
					<Skeleton height="0.875rem" />
					<Skeleton width="60%" height="0.875rem" />
				</div>
				<div class="progress">
					<Skeleton width="8rem" height="0.875rem" />
					<Skeleton height="0.375rem" radius="var(--radius-full)" />
				</div>
				<Skeleton height="var(--touch-target)" radius="var(--radius-full)" />
				<span class="visually-hidden">Loading your setup…</span>
			</div>
		</Card>
	{:then setup}
		{#if setup && !setup.complete}
			{@const started = setup.done > 0}
			<Card tone="accent" padding="lg" data-testid="today-setup">
				<div class="session">
					<Badge tone="accent" icon="target">{started ? 'Setup in progress' : 'First step'}</Badge>
					<h2 class="session-title">
						{started ? 'Finish setting up your profile' : 'Set up your training profile'}
					</h2>
					<p class="session-copy">
						Your coach plans each week around your goals, schedule and recent training. About five
						minutes: skip what you don’t know yet, and change anything later in Profile.
					</p>
					<div class="progress">
						<p class="count numeric" data-testid="today-setup-count">
							{setup.done} of {setup.total} steps done
						</p>
						<!-- The count above says it in words; the bar only shows it. -->
						<span class="bar" aria-hidden="true">
							<span class="fill" style:width="{(setup.done / setup.total) * 100}%"></span>
						</span>
					</div>
					<Button
						href={stepHref(setup.next)}
						iconEnd="arrow-right"
						block
						data-testid="today-setup-continue"
					>
						{started ? `Continue: ${STEP_INFO[setup.next].title}` : 'Start setup'}
					</Button>
				</div>
			</Card>
		{:else if setup}
			<Card tone="accent" padding="lg" data-testid="today-session">
				<div class="session">
					<Badge tone="accent" icon="target">First week</Badge>
					<h2 class="session-title">Nothing scheduled yet</h2>
					<p class="session-copy">
						Your coach plans each week around your goals, schedule and recent training. Week one
						establishes your baseline, so 1RMs are optional.
					</p>
					<p class="session-next" data-testid="today-next-step">
						<Icon name="check" size={16} />
						<span class="next-text">Training profile</span>
						<Badge tone="positive">Ready</Badge>
					</p>
				</div>
			</Card>
		{:else}
			<Card padding="lg" data-testid="today-setup-error">
				<EmptyState
					compact
					icon="alert"
					tone="combat"
					title="Couldn’t load your setup"
					description="Your profile is safe. Check your connection, then try again."
				>
					{#snippet actions()}
						<Button variant="secondary" icon="refresh" loading={retrying} onclick={retry}>
							Retry
						</Button>
					{/snippet}
				</EmptyState>
			</Card>
		{/if}
	{/await}

	<Section title="This week">
		<div class="stats">
			{#each stats as stat (stat.label)}
				<Stat label={stat.label} caption={stat.caption} />
			{/each}
		</div>
	</Section>

	<ListRow
		href={resolve('/(app)/train?tool=plates')}
		icon="plate"
		tone="strength"
		title="Plate calculator"
		subtitle="Load the bar in kg or lb"
	/>

	<!-- Streamed after the rows above, so it only adds below what is already painted (no CLS). -->
	{#await data.setup then setup}
		{#if setup?.complete}
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
								<Button variant="secondary" icon="plus" href={profileHref('goals')}>
									Add a goal
								</Button>
							{/snippet}
						</EmptyState>
					</Card>
				{/if}
			</Section>

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
	{/await}
</div>

<style>
	.week {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		gap: var(--space-1-5);
		margin: 0 0 var(--space-6);
		padding: 0;
		list-style: none;
	}

	.day {
		display: grid;
		justify-items: center;
		gap: var(--space-1);
		padding: var(--space-2) 0 var(--space-2-5, 0.625rem);
		border-radius: var(--radius-md);
		border: 1px solid transparent;
	}

	.day.today {
		background: var(--color-surface-1);
		border-color: var(--color-border);
		box-shadow: var(--elevation-1);
	}

	.letter {
		font-size: var(--text-2xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		color: var(--color-text-tertiary);
	}

	.date {
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
		color: var(--color-text-secondary);
		min-height: 1.5rem;
	}

	.today .date {
		color: var(--color-text);
	}

	.dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--color-border-strong);
	}

	.today .dot {
		background: var(--color-accent);
		box-shadow: 0 0 10px var(--color-accent);
	}

	.stack {
		display: grid;
		gap: var(--space-6);
	}

	.session {
		display: grid;
		gap: var(--space-3);
	}

	.session-title {
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-display);
		line-height: var(--leading-tight);
	}

	.session-copy {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.lines {
		display: grid;
		gap: var(--space-2);
	}

	.progress {
		display: grid;
		gap: var(--space-2);
	}

	.count {
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}

	.bar {
		display: block;
		height: 0.375rem;
		border-radius: var(--radius-full);
		background: var(--color-surface-3);
		overflow: hidden;
	}

	.fill {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--color-accent);
	}

	.session-next {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-top: var(--space-1);
		padding-top: var(--space-4);
		border-top: 1px solid var(--color-hairline);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}

	.next-text {
		flex: 1;
	}

	.day:not(.today) .dot.free {
		background: transparent;
		box-shadow: inset 0 0 0 1px var(--color-text-tertiary);
	}

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

	.stats {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--space-2);
	}
</style>
