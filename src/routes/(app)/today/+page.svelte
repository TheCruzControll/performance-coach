<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { preferences } from '#lib/client/preferences.svelte.ts';
	import Badge from '#lib/ui/components/Badge.svelte';
	import Card from '#lib/ui/components/Card.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import Stat from '#lib/ui/components/Stat.svelte';

	const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

	// Dates depend on the device's time zone, so they render after hydration.
	let today = $state<Date | null>(null);
	onMount(() => (today = new Date()));

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
			<span class="dot" aria-hidden="true"></span>
		</li>
	{/each}
</ol>

<div class="stack">
	<Card tone="accent" padding="lg" data-testid="today-session">
		<div class="session">
			<Badge tone="accent" icon="target">First step</Badge>
			<h2 class="session-title">Nothing scheduled yet</h2>
			<p class="session-copy">
				Your coach plans each week around your goals, schedule and recent training. Your training
				profile unlocks the first week — 1RMs are optional; week one establishes your baseline.
			</p>
			<p class="session-next" data-testid="today-next-step">
				<Icon name="lock" size={16} />
				<span class="next-text">Training profile</span>
				<Badge>Coming next</Badge>
			</p>
		</div>
	</Card>

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

	.stats {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--space-2);
	}
</style>
