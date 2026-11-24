<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { preferences } from '#lib/client/preferences.svelte.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import Card from '#lib/ui/components/Card.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import { isStale } from './freshness';
	import { PANELS } from './panels';
	import PanelLoader from './panels/PanelLoader.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const setup = $derived(data.setup);
	/** A program exists: its plan (Program) has the week strip, so M2's week shape steps aside. */
	const active = $derived(!!setup?.complete && data.program === 'active');

	/** The setup card failed to load: Retry runs the load again. */
	let retrying = $state(false);
	async function retry() {
		retrying = true;
		await invalidateAll();
		retrying = false;
	}

	const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

	/**
	 * Room each panel holds while its code loads or after it fails: about its height on a phone,
	 * so what sits below it stays put when it arrives. Setup sits above the rest of Today, so it
	 * keeps its room once it arrives too (its card fills it, Continue at the foot): at least its
	 * height on a phone, the tallest it gets at the supported sizes. On the wide layout nothing
	 * sits under it in its column, so it takes its own height there, with no empty room inside.
	 */
	const SETUP_HEIGHT = '24rem';
	const BUILD_HEIGHT = '17rem';
	/** The plan's room: the week strip, a day of two sessions and three up next. */
	const PROGRAM_HEIGHT = '34rem';
	/** Build my program's room while its code or its preview loads: a phone screen of preview. */
	const PREVIEW_HEIGHT = '40rem';

	/** Build my program is open (the Build card was tapped): it takes Today's place. */
	let building = $state(false);

	/** Back to Today from Build my program, focus on the Build card's button again. */
	async function closeBuild() {
		building = false;
		await tick();
		document.querySelector<HTMLElement>('[data-testid="today-build-cta"]')?.focus();
	}

	// Dates depend on the device's time zone, so they render after hydration.
	let today = $state<Date | null>(null);
	onMount(() => {
		preferences.load();
		today = new Date();
	});

	/**
	 * Back in the foreground on another day, or after the TTL (freshness.ts): the date moves on
	 * and Today loads again, so it never shows yesterday's plan. Not while Build my program is
	 * open (its preview is the screen), and offline only the date moves: the load would fail.
	 */
	let loadedAt = new Date();
	$effect.pre(() => {
		void data;
		loadedAt = new Date();
	});
	let refreshing = false;
	async function refreshIfStale() {
		const now = new Date();
		if (document.visibilityState !== 'visible' || refreshing || !isStale(loadedAt, now)) return;
		today = now;
		if (building || !navigator.onLine) return;
		refreshing = true;
		try {
			await invalidateAll();
		} finally {
			refreshing = false;
		}
	}

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
</script>

<svelte:head>
	<title>Today · Performance Coach</title>
</svelte:head>

<svelte:document onvisibilitychange={refreshIfStale} />

<PageHeader title="Today" {eyebrow}>
	{#snippet trailing()}
		<a
			class="avatar-link today-avatar"
			href={resolve('/(app)/profile')}
			aria-label="Profile"
			data-testid="today-avatar"><Icon name="profile" size={16} /></a
		>
	{/snippet}
</PageHeader>

{#if !active}
	<ol class="week" aria-label="This week">
		{#each week as day, i (i)}
			{@const mark = setup?.complete ? setup.week.days[i] : undefined}
			{@const booked = mark?.booked[0]}
			<li class="day" class:today={day.isToday} aria-current={day.isToday ? 'date' : undefined}>
				<span class="letter">{day.letter}</span>
				<span class="date numeric">{day.date ?? '·'}</span>
				<!-- Once set up: a ring on the days free to train, a discipline dot on booked ones. -->
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
			</li>
		{/each}
	</ol>
{/if}

{#if building}
	<!-- Build my program takes Today's place until the owner starts week 1 or closes it. -->
	<PanelLoader load={PANELS.preview} height={PREVIEW_HEIGHT} props={{ onclose: closeBuild }} />
{/if}

<!-- From 1024 px (docs/design-system.md, Responsive layout → Screens): the state's panel in one
     readable column; This week is on Progress, the goals and schedule in Profile (v2/06a). -->
<div class="stack" class:active data-layout="wide" hidden={building}>
	<!-- The state's panel is code-split (panels/index.ts): the server sends it as markup, kept as
	     sent until its code arrives, and a client navigation shows its skeleton until then. -->
	{#if setup && !setup.complete}
		<div class="setup-room setup" style:--room={SETUP_HEIGHT}>
			<PanelLoader
				load={PANELS.setup}
				height={SETUP_HEIGHT}
				props={{ setup }}
				served={data.served.setup}
			/>
		</div>
	{:else if setup && data.program === 'none'}
		<div class="setup-room" style:--room={BUILD_HEIGHT}>
			<PanelLoader
				load={PANELS.build}
				height={BUILD_HEIGHT}
				props={{ onbuild: () => (building = true) }}
				served={data.served.build}
			/>
		</div>
	{:else if active}
		<PanelLoader
			load={PANELS.program}
			height={PROGRAM_HEIGHT}
			props={{ plan: data.plan! }}
			served={data.served.program}
		/>
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
						Try again
					</Button>
				{/snippet}
			</EmptyState>
		</Card>
	{/if}
</div>

<style>
	/*
	 * The avatar (layout.css's .avatar-link, Profile's way in). Paper puts it on the date line,
	 * above the title; PageHeader's trailing slot sits at the title's baseline. Close enough until
	 * v2/06 rebuilds Today's top. From 1024 px the rail's foot has it, so it is hidden here.
	 */
	@media (width >= 64rem) {
		.today-avatar {
			display: none;
		}
	}

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

	.stack[hidden] {
		display: none;
	}

	.setup-room {
		display: grid;
		min-height: var(--room);
	}

	.day:not(.today) .dot.free {
		background: transparent;
		box-shadow: inset 0 0 0 1px var(--color-text-tertiary);
	}

	/*
	 * Desktop (wide until v2/06b): the week across the top, then one column at most the readable
	 * width, as Train's sessions: the state's panel (the setup card, the Build card, the plan, or
	 * their skeleton or Retry). This week is on Progress and the goals and schedule in Profile, so
	 * nothing sits beside it.
	 *
	 * With a program, the plan lies on these rows with subgrid (Program.svelte): the first holds
	 * STRIP_ROOM from the start, so the day sits where it will stay while the plan's code or data
	 * loads.
	 */
	@media (width >= 64rem) {
		.stack {
			/* STRIP_ROOM: WeekStrip's tile from 56rem is 6.03rem + 6 px; a little more holds any zoom. */
			--today-strip-room: 6.5rem;
			grid-template-columns: minmax(0, var(--content-readable));
			align-items: start;
		}

		/* The setup card has its column to itself: as tall as what it says, no empty band inside. */
		.setup-room.setup {
			min-height: 0;
		}

		.stack.active {
			grid-template-rows: minmax(var(--today-strip-room), auto) repeat(3, auto) 1fr;
		}

		/* The plan's code loading, or its Retry: in the main column, from the top. */
		.stack.active > :global([data-testid='today-panel']) {
			grid-column: 1;
			grid-row: 1 / -1;
		}

		/* Build my program's code loading, or its Retry: in the main column, where the preview's
		   week 1 will be (BuildPreview.svelte), not stretched across both. */
		:global(#main > [data-testid='today-panel']) {
			max-width: var(--content-readable);
		}

		/* The week's days as outlined tiles across the content, so the week reads at a glance. */
		.week {
			gap: var(--space-3);
		}

		.day {
			padding-block: var(--space-3);
			border-color: var(--color-border);
		}
	}
</style>
