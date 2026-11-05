<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import Button from '#lib/ui/components/Button.svelte';
	import Card from '#lib/ui/components/Card.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';

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

	const stats = [
		{ label: 'Sessions', unit: 'this week' },
		{ label: 'Load', unit: 'AU' },
		{ label: 'Distance', unit: 'km' }
	];
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
			<span class="badge"><Icon name="target" size={16} /> Week 1 · Baseline</span>
			<h2 class="session-title">Nothing scheduled yet</h2>
			<p class="session-copy">
				Your coach plans each week around your goals, schedule and recent training. Set up your
				profile to get your first week — 1RMs are optional; week one establishes your baseline.
			</p>
			<div class="session-actions">
				<Button href={resolve('/(app)/profile')} iconEnd="arrow-right" block
					>Set up your profile</Button
				>
			</div>
		</div>
	</Card>

	<section aria-labelledby="week-heading">
		<h2 id="week-heading" class="section-title">This week</h2>
		<div class="stats">
			{#each stats as stat (stat.label)}
				<Surface padding="md" radius="lg">
					<p class="stat-label">{stat.label}</p>
					<p class="stat-value numeric">—</p>
					<p class="stat-unit">{stat.unit}</p>
				</Surface>
			{/each}
		</div>
	</section>

	<Surface padding="md" radius="lg" href={resolve('/(app)/train?tool=plates')}>
		<div class="row-link">
			<span class="row-icon"><Icon name="plate" size={22} /></span>
			<span class="row-text">
				<span class="row-title">Plate calculator</span>
				<span class="row-sub">Load the bar in kg or lb</span>
			</span>
			<Icon name="chevron-right" size={20} />
		</div>
	</Surface>
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

	.badge {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1-5);
		justify-self: start;
		padding: var(--space-1) var(--space-3) var(--space-1) var(--space-2);
		border-radius: var(--radius-full);
		background: var(--color-accent-subtle);
		color: var(--color-accent-text);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
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

	.session-actions {
		margin-top: var(--space-2);
	}

	.section-title {
		margin-bottom: var(--space-3);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-normal);
		color: var(--color-text-secondary);
	}

	.stats {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--space-2);
	}

	.stat-label {
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}

	.stat-value {
		margin: var(--space-2) 0 0;
		font-size: var(--text-3xl);
		font-weight: var(--weight-bold);
		line-height: 1;
		color: var(--color-text-tertiary);
	}

	.stat-unit {
		margin-top: var(--space-1);
		font-size: var(--text-2xs);
		color: var(--color-text-tertiary);
		text-transform: uppercase;
		letter-spacing: var(--tracking-caps);
	}

	.row-link {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		color: var(--color-text-tertiary);
	}

	.row-icon {
		display: grid;
		place-items: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--color-strength) 14%, transparent);
		color: var(--color-strength);
	}

	.row-text {
		flex: 1;
		display: grid;
	}

	.row-title {
		font-weight: var(--weight-semibold);
		color: var(--color-text);
	}

	.row-sub {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}
</style>
