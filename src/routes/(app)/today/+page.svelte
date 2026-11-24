<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { preferences } from '#lib/client/preferences.svelte.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import { isStale } from './freshness';
	import { PANELS } from './panels';
	import PanelLoader from './panels/PanelLoader.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const setup = $derived(data.setup);

	/** The setup card failed to load: Retry runs the load again. */
	let retrying = $state(false);
	async function retry() {
		retrying = true;
		await invalidateAll();
		retrying = false;
	}

	/**
	 * Room the setup and Build cards hold while their code loads or after it fails: about their
	 * height on a phone, so they arrive in place. Setup keeps its room once it arrives too (its
	 * card fills it, Continue at the foot); from 1024 px it takes its own height. The plan has no
	 * room of its own: it fills the column to its foot (PanelLoader).
	 */
	const SETUP_HEIGHT = '24rem';
	const BUILD_HEIGHT = '17rem';
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
	const date = $derived(
		today
			? `${DAY_NAMES[today.getDay()]} ${today.getDate()} ${MONTH_NAMES[today.getMonth()]}`
			: '\u00a0'
	);
</script>

<svelte:head>
	<title>Today · Performance Coach</title>
</svelte:head>

<svelte:document onvisibilitychange={refreshIfStale} />

<!-- Instrument v2 (Paper, 3 · Today): the tab's name stays the page's heading, for screen
     readers; the date is the top line and the day's title the display line. A readable screen:
     on a desktop it is the 560 px column, 200 px from the rail, the right side empty. -->
<h1 class="visually-hidden">Today</h1>
<div class="today" data-testid="today-screen">
	<div class="top">
		<p class="date" data-testid="today-date">{date}</p>
		<a
			class="avatar-link today-avatar"
			href={resolve('/(app)/profile')}
			aria-label="Profile"
			data-testid="today-avatar"><Icon name="profile" size={16} /></a
		>
	</div>

	{#if building}
		<!-- Build my program takes Today's place until the owner starts week 1 or closes it; it
		     lays out across the wide main until v2/06c draws it as one column. -->
		<div class="building" data-layout="wide">
			<PanelLoader load={PANELS.preview} height={PREVIEW_HEIGHT} props={{ onclose: closeBuild }} />
		</div>
	{/if}

	<div class="state" hidden={building}>
		<!-- The state's panel is code-split (panels/index.ts): the server sends it as markup, kept as
		     sent until its code arrives, and a client navigation shows 'Getting today' until then. -->
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
		{:else if setup && data.program === 'active'}
			<PanelLoader
				load={PANELS.program}
				props={{ plan: data.plan! }}
				served={data.served.program}
			/>
		{:else}
			<section
				class="statement-wrap"
				data-testid="today-setup-error"
				aria-labelledby="today-setup-failed"
			>
				<h2 id="today-setup-failed" class="statement">Couldn’t load today</h2>
				<p class="lead">Your profile is safe. Check your connection and try again.</p>
				<Button
					variant="secondary"
					size="lg"
					block
					loading={retrying}
					onclick={retry}
					data-testid="today-retry">Try again</Button
				>
			</section>
		{/if}
	</div>
</div>

<style>
	/* The screen fills the window above the tab bar, so the day can stand at its foot. */
	.today {
		display: flex;
		flex-direction: column;
		min-height: calc(100svh - var(--nav-inset-bottom) - var(--safe-top) - var(--space-12));
	}

	/* The date, and the avatar (layout.css's .avatar-link, Profile's way in) at the end. */
	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		min-height: var(--touch-target);
		margin-top: var(--space-3);
	}

	.date {
		font: var(--type-secondary);
		color: var(--color-text-secondary);
	}

	.state {
		display: flex;
		flex-direction: column;
		flex: 1;
	}

	.state[hidden] {
		display: none;
	}

	.setup-room {
		display: grid;
		min-height: var(--room);
	}

	/* Couldn't load the setup: one statement at the foot, with Try again (as the plan's). */
	.statement-wrap {
		margin-top: auto;
		padding-bottom: var(--space-14);
	}

	.statement {
		font: var(--type-statement);
		letter-spacing: var(--tracking-statement);
		color: var(--color-text);
	}

	.lead {
		padding: var(--space-3) 0 var(--space-7);
		font: var(--type-body);
		color: var(--color-text-secondary);
	}

	/* From 1024 px the rail's foot has the avatar, and the column starts 48 px down (Paper). The
	   setup card takes its own height there: nothing sits under it in its column. */
	@media (width >= 64rem) {
		.today-avatar {
			display: none;
		}

		.top {
			margin-top: var(--space-12);
		}

		.setup-room.setup {
			min-height: 0;
		}

		/* Build my program's code loading, or its Retry: in the main column, where the preview's
		   week 1 will be (BuildPreview.svelte), not stretched across the wide main. */
		.building > :global([data-testid='today-panel']) {
			max-width: var(--content-readable);
		}
	}
</style>
