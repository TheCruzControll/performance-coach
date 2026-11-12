<script lang="ts">
	import { onMount, type ComponentProps } from 'svelte';
	import { goto, invalidateAll, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { navigating, page } from '$app/state';
	import { preferences } from '#lib/client/preferences.svelte.ts';
	import Badge from '#lib/ui/components/Badge.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';
	import ProgramHeader from '#lib/ui/program/ProgramHeader.svelte';
	import SessionCard from '#lib/ui/program/SessionCard.svelte';
	import type PlanSheetType from '#lib/ui/program/PlanOverviewSheet.svelte';
	import WeekStrip from '#lib/ui/program/WeekStrip.svelte';
	import { LazySheet } from './lazy-sheet.svelte.ts';
	import type PlateSheetType from './PlateSheet.svelte';
	import type RestTimerSheetType from './RestTimerSheet.svelte';
	import type { PageProps, Snapshot } from './$types';

	let { data }: PageProps = $props();

	/**
	 * Where 'no program yet' sends the owner: Today builds a program once the training profile is
	 * complete (Build my program); until then the profile is filled in from Profile's sections.
	 * Decision: point SETUP at M2's onboarding screen once it has a route.
	 */
	const BUILD_HREF = resolve('/(app)/today');
	const SETUP_HREF = resolve('/(app)/profile');

	const weekHref = (n: number) => `${resolve('/(app)/train')}?week=${n}`;
	const HISTORY_HREF = resolve('/(app)/train/history/[[version]]', {});

	// ---- The week shown ----------------------------------------------------------------------

	const view = $derived(data.state === 'program' ? data : null);
	const week = $derived(view?.week.planned ? view.week : null);

	/** A week change in flight: Train itself, with another ?week (or none). */
	const loading = $derived(
		navigating.to?.url.pathname === page.url.pathname &&
			navigating.to.url.search !== page.url.search
	);
	const pendingWeek = $derived(
		loading ? Number(navigating.to?.url.searchParams.get('week')) || null : null
	);

	/** The state card's next step as a link (none for Retry); `inTrain` when it changes week. */
	const next = $derived.by(() => {
		const to = data.card?.next.to;
		if (to === 'today') return { href: BUILD_HREF };
		if (to === 'profile') return { href: SETUP_HREF };
		if (to === 'this-week') return { href: resolve('/(app)/train'), inTrain: true };
		if (typeof to === 'object')
			return 'href' in to ? { href: to.href } : { href: weekHref(to.week), inTrain: true };
		return { href: undefined };
	});

	/** The weekday the owner tapped, kept across weeks; until then today, else the first session. */
	let chosen = $state<number | null>(null);
	const selectedIndex = $derived.by(() => {
		if (chosen !== null || !week) return chosen ?? 0;
		const today = week.days.findIndex((d) => d.date === view!.today);
		return today >= 0
			? today
			: Math.max(
					0,
					week.days.findIndex((d) => d.sessions.length > 0)
				);
	});
	const day = $derived(week?.days[selectedIndex]);
	/** That day in words, from the server. */
	const words = $derived(view?.days[selectedIndex]);

	/** Back from a session (history) comes back to the weekday the owner had picked. */
	export const snapshot: Snapshot<number | null> = {
		capture: () => chosen,
		restore: (value) => (chosen = value)
	};

	const sessionHref = (lineage: string) => resolve('/(app)/train/session/[key]', { key: lineage });

	// ---- The coming days' kits, for a gym with no signal --------------------------------------

	/** Once the idle pass has run: 'saved' or 'none', as on Today. What the specs wait for. */
	let kits = $state<'saved' | 'none'>();

	/**
	 * Once the week shows and the browser is idle, its sessions still to do today and in the next
	 * two days (coming-kits.ts): never on the server, again for each week shown.
	 */
	$effect(() => {
		let live = true;
		const sessions = week ? week.days.flatMap((d) => d.sessions) : [];
		const today = view?.today;
		const save = async () => {
			let saved: string[] = [];
			if (today) {
				const coming = await import('#lib/client/workout/coming-kits.ts');
				saved = await coming.saveComingKits(sessions, today);
			}
			if (live) kits = saved.length ? 'saved' : 'none';
		};
		const go = () => live && void save().catch(() => {});
		if ('requestIdleCallback' in window) requestIdleCallback(go, { timeout: 2000 });
		else setTimeout(go, 800);
		return () => (live = false);
	});

	let reloading = $state(false);
	async function reload() {
		reloading = true;
		await invalidateAll();
		reloading = false;
	}

	// ---- The sheets: the plate calculator, the rest timer and the plan ----------------------

	// Each is code-split with the BottomSheet it opens in and loads on intent (lazy-sheet.svelte.ts).
	// Each is left out of the server build, which never renders it: SvelteKit links into a page the
	// CSS of every dynamic import its server build can reach (check-budgets.ts), and a sheet's own
	// stylesheets arrive with it.
	const plates = new LazySheet<ComponentProps<typeof PlateSheetType>>(
		() =>
			import.meta.env.SSR
				? Promise.reject(new Error('client only'))
				: import('./PlateSheet.svelte'),
		'plates'
	);
	/** It opens no workout: 'Log a session' arrives with the other ways into one. */
	const restTimer = new LazySheet<ComponentProps<typeof RestTimerSheetType>>(
		() =>
			import.meta.env.SSR
				? Promise.reject(new Error('client only'))
				: import('./RestTimerSheet.svelte'),
		'rest'
	);
	const plan = new LazySheet<ComponentProps<typeof PlanSheetType>>(
		() =>
			import.meta.env.SSR
				? Promise.reject(new Error('client only'))
				: import('#lib/ui/program/PlanOverviewSheet.svelte'),
		'plan'
	);

	/** A week tapped in the plan: shown as a week pill shows it (keeping scroll and focus), pending
	 * state included. */
	const openWeek = (week: number) =>
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() + a query
		goto(weekHref(week), { replace: true, reset: false });

	/** The notice can appear under the bottom navigation: bring it into view. */
	const reveal = (node: HTMLElement) => node.scrollIntoView({ block: 'nearest' });

	onMount(() => {
		preferences.load();
		const tool = page.url.searchParams.get('tool');
		if (tool === 'plates') plates.show();
		if (tool === 'plan' && view) plan.show();
		if (tool === 'rest') restTimer.show();
		// A rest left running (a reload, or back from another screen) shows under its row again,
		// with its alarm and keep-awake, without a tap. The key literal keeps standalone-rest.ts
		// out of Train's own chunk; blocked storage throws and means no rest.
		try {
			if (localStorage.getItem('pc:rest:v1')) restTimer.prefetch();
		} catch {
			// no storage, no rest
		}
		return () => {
			plates.leave();
			restTimer.leave();
			plan.leave();
		};
	});

	function closeSheet() {
		if (page.url.searchParams.has('tool')) replaceState(resolve('/(app)/train'), {});
	}
</script>

<svelte:head>
	<title>Train · Performance Coach</title>
</svelte:head>

<PageHeader title="Train" eyebrow="Program" />

<!-- Wide from 1024 px (docs/design-system.md, Responsive layout → Screens): the header and the
     strip span the content, the day's sessions sit beside the week's brief and the tools. -->
<div class="stack" data-layout="wide">
	{#if view}
		<ProgramHeader
			title={view.program.title}
			position={view.position}
			weeks={Array.from({ length: view.program.plannedWeeks }, (_, i) => ({
				number: i + 1,
				href: weekHref(i + 1),
				mark: view.marks[i + 1]
			}))}
			shown={view.shown}
			current={view.program.currentWeek}
			pending={pendingWeek}
			previous={view.shown > 1 ? weekHref(Math.min(view.shown - 1, view.totalWeeks)) : undefined}
			next={view.shown < view.totalWeeks ? weekHref(view.shown + 1) : undefined}
			status={view.status}
			line={view.weekLine}
			kind={view.weekKind}
		>
			{#snippet actions()}
				<button
					type="button"
					class="action"
					aria-haspopup="dialog"
					aria-busy={plan.busy}
					onpointerdown={plan.prefetch}
					onpointerenter={plan.prefetch}
					onclick={plan.show}
					data-testid="open-plan"
				>
					<Icon name="progress" size={18} />Plan
				</button>
				<a
					class="action"
					href={HISTORY_HREF}
					aria-busy={navigating.to?.url.pathname === HISTORY_HREF}
					data-testid="open-history"
				>
					<Icon name="clock" size={18} />History
				</a>
				{#if plan.failed}
					<div class="plan-failed">
						<Notice tone="danger" title="Couldn’t open your plan">
							<button type="button" class="retry" onclick={plan.show}>Try again</button>
						</Notice>
					</div>
				{/if}
			{/snippet}
		</ProgramHeader>
		<p class="visually-hidden" role="status">{loading ? 'Loading the week…' : ''}</p>
	{/if}

	<!-- Busy while the next week loads; only the week's own strip and cards go inert, never the
	     state card's link, which may hold the focus of the change it started. -->
	<div
		class="week"
		aria-busy={loading}
		inert={loading && !data.card}
		data-testid="train-week"
		data-kits={kits}
	>
		{#if data.card}
			{@const card = data.card}
			<Surface padding="none" radius="xl">
				<EmptyState
					icon={card.icon}
					tone={card.tone}
					title={card.title}
					description={card.description}
					data-testid={card.id}
				/>
			</Surface>
			<div
				class="tool"
				aria-busy={reloading}
				data-sveltekit-replacestate={next.inTrain ? '' : undefined}
				data-sveltekit-reset={next.inTrain ? 'false' : undefined}
			>
				<ListRow
					icon={card.next.icon}
					title={card.next.title}
					subtitle={card.next.subtitle}
					href={next.href}
					onclick={next.href ? undefined : reload}
					data-testid="train-next"
				/>
			</div>
			<!-- A bridge week's workouts, which no plan holds: each says Off-plan. One box, so the
			     desktop subgrid gives them one row. -->
			{#if view?.offPlan.length}
				<div class="logged">
					{#each view.offPlan as workout (workout.id)}
						<SessionCard session={workout} data-testid="off-plan-workout" />
					{/each}
				</div>
			{/if}
		{:else if week}
			<WeekStrip
				days={view!.strip}
				today={view!.today}
				selected={day?.date ?? null}
				label={`Week ${week.number}`}
				onselect={(date) => (chosen = week.days.findIndex((d) => d.date === date))}
				data-testid="week-strip"
			/>

			{#if day && words}
				<Section title={words.heading} data-testid="day-sessions">
					{#snippet action()}
						{#if day.date === view!.today}<Badge tone="accent">Today</Badge>{/if}
					{/snippet}
					{#each words.cards as card (card.lineage)}
						{@const href = sessionHref(card.lineage)}
						<SessionCard
							session={card}
							{href}
							baseline={card.baseline}
							pending={loading || navigating.to?.url.pathname === href}
							data-testid="session-card"
						/>
						<!-- A week finding (m7/04): one line under its card, its why behind it. -->
						{#if card.note}
							<details class="note" data-tone={card.note.tone}>
								<summary>{card.note.text}</summary>
								<p>{card.note.why}</p>
							</details>
						{/if}
						<!-- Why this day (m7/14): the decisions that put it here, closed by default. -->
						{#if card.why}
							<details class="why">
								<summary>{card.why.title}</summary>
								<ul>
									{#each card.why.lines as line, i (i)}<li>{line}</li>{/each}
								</ul>
							</details>
						{/if}
					{:else}
						<Surface padding="none" radius="lg">
							<EmptyState
								compact
								icon="moon"
								tone="neutral"
								title="Rest day"
								description={words.rest ?? undefined}
								data-testid="rest-day"
							/>
						</Surface>
					{/each}
				</Section>
			{/if}

			{#if view!.aside.length}
				<!-- The side column on desktop: the week's brief and what a review changed in it. -->
				<div class="aside">
					{#each view!.aside as panel (panel.id)}
						<Surface
							as="section"
							tone={panel.tone}
							aria-labelledby="{panel.id}-title"
							data-testid={panel.id}
						>
							<div class="brief">
								<span class="eyebrow">{panel.eyebrow}</span>
								<h2 id="{panel.id}-title" class="brief-title">{panel.title}</h2>
								<p>{panel.lead}</p>
								<ul>
									{#each panel.points as point, i (i)}
										<li><strong>{point.lead}</strong> {point.text}</li>
									{/each}
								</ul>
								<!-- eslint-disable svelte/no-navigation-without-resolve -- paths from cards.server.ts -->
								{#each panel.links as link (link.id)}
									<a class="link" href={link.href} data-testid={link.id}>{link.label}</a>
								{/each}
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
							</div>
						</Surface>
					{/each}
				</div>
			{/if}
		{/if}
	</div>

	<Section title="Tools">
		<div class="tool" aria-busy={plates.busy}>
			<ListRow
				icon="plate"
				tone="strength"
				title="Plate calculator"
				subtitle="Exact loading in kg or lb"
				onpointerdown={plates.prefetch}
				onpointerenter={plates.prefetch}
				onclick={plates.show}
				data-testid="open-plates"
			/>
			{#if plates.failed}
				<Notice tone="danger" title="Couldn’t open the plate calculator">
					<button type="button" class="retry" onclick={plates.show} use:reveal>Try again</button>
				</Notice>
			{/if}
		</div>
		<div class="tool" aria-busy={restTimer.busy}>
			<ListRow
				icon="timer"
				title="Rest timer"
				subtitle="Outside a workout"
				onpointerdown={restTimer.prefetch}
				onpointerenter={restTimer.prefetch}
				onclick={restTimer.show}
				data-testid="open-rest-timer"
			/>
			{#if restTimer.failed}
				<Notice tone="danger" title="Couldn’t open the rest timer">
					<button type="button" class="retry" onclick={restTimer.show} use:reveal>Try again</button>
				</Notice>
			{/if}
			<!-- A running rest shows here, under its row, with the sheet closed. -->
			<restTimer.component bind:open={restTimer.open} onclose={closeSheet} />
		</div>
		<ListRow
			icon="plus"
			title="Log a session"
			subtitle="A run, a class or anything off the plan"
			href={resolve('/workout')}
			data-testid="log-a-session"
		/>
	</Section>
</div>

<!-- Each renders nothing until its code has arrived (a dynamic component that is null). -->
<plates.component bind:open={plates.open} unit={preferences.units} onclose={closeSheet} />
{#if view}
	<plan.component
		bind:open={plan.open}
		title={view.program.title}
		blocks={view.plan}
		{weekHref}
		onweek={openWeek}
		onclose={closeSheet}
	/>
{/if}

<style>
	.stack,
	.week {
		display: grid;
		gap: var(--space-6);
	}

	/* Loading the next week: the week stays where it is, dimmed, while its cards show their
	   progress line; after a beat, so a fast load shows nothing. */
	.week {
		transition: opacity var(--duration-base) var(--ease-standard);
	}

	.week[aria-busy='true'] {
		opacity: 0.55;
		transition-delay: 150ms;
	}

	/*
	 * Desktop (wide): two columns under the full-width header and strip. The day's sessions take
	 * the main column, at most the readable width (cards, never a stretched phone column); the
	 * week's brief and the tools take the side column, at least --content-list. CSS only: the one
	 * selected day renders as on a phone, in the same order, so Tab reads left column then right.
	 *
	 * Rows: the header, the strip, the side column's first item, then a row that takes the rest of
	 * the session column, so the tools sit right under the brief however long the day is. The week
	 * is a subgrid over rows 2 to the end, so its strip, sessions and brief share the screen's
	 * columns while it keeps its own box (busy, dimmed and inert as on a phone); its box lets
	 * clicks through to the tools it overlaps.
	 */
	@media (width >= 64rem) {
		.stack {
			grid-template-columns: minmax(0, var(--content-readable)) minmax(var(--content-list), 1fr);
			grid-template-rows: auto auto auto 1fr;
			column-gap: var(--space-8);
			align-items: start;
		}

		.stack > :global(*) {
			grid-column: 1 / -1;
		}

		.week {
			grid-row: 2 / -1;
			grid-template-columns: subgrid;
			grid-template-rows: subgrid;
			gap: normal;
			align-items: start;
			pointer-events: none;
		}

		/* No program: no header, so the week starts at the top. */
		.week:first-child {
			grid-row: 1 / -1;
		}

		.week > :global(*) {
			grid-column: 1;
			pointer-events: auto;
		}

		.week > :global([role='radiogroup']) {
			grid-column: 1 / -1;
		}

		.week > :global([role='radiogroup'] + *) {
			grid-row: span 2;
		}

		.week > :global(.aside) {
			grid-column: 2;
		}

		/* The tools (the stack's last section): under the brief (.aside), else right under the
		   strip; beside a state card (no strip), level with it. */
		.stack > :global(section:last-child) {
			grid-column: 2;
			grid-row: 3 / -1;
		}

		.stack:has(:global(.aside)) > :global(section:last-child) {
			grid-row: 4;
		}

		.stack:not(:has(:global([role='radiogroup']))) > :global(section:last-child) {
			grid-row: 2 / -1;
		}

		.stack > .week:first-child ~ :global(section:last-child) {
			grid-row: 1 / -1;
		}
	}

	.brief {
		display: grid;
		gap: var(--space-3);
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
		color: var(--color-text-secondary);
	}

	/* The eyebrow and title as Card sets them, closer together than the paragraphs. */
	.brief-title {
		margin-top: calc(var(--space-2) * -1);
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-tight);
		line-height: var(--leading-snug);
		color: var(--color-text);
	}

	.brief ul {
		display: grid;
		gap: var(--space-1-5);
		margin: 0;
		padding-left: var(--space-5);
	}

	.aside {
		display: grid;
		gap: var(--space-6);
	}

	.brief strong {
		font-weight: var(--weight-semibold);
		color: var(--color-text);
	}

	/*
	 * A week finding under its card (m7/04): the summary of a native <details>, a 44 px target
	 * that opens without JavaScript; its body is the why. A CSS glyph and the words carry the
	 * meaning; caution fills the glyph with the warning colour, never the danger tone. Here, not
	 * in SessionCard, so Today and History load none of it (docs/performance.md).
	 */
	.note,
	.why {
		margin-top: calc(var(--space-2) * -1);
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.note summary,
	.why summary {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		min-height: var(--touch-target);
		padding: var(--space-3) var(--space-4);
		list-style: none;
	}

	.note summary::-webkit-details-marker,
	.why summary::-webkit-details-marker {
		display: none;
	}

	.note summary::before {
		content: '';
		flex: none;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		box-shadow: inset 0 0 0 1.5px;
	}

	.note[data-tone='caution'] summary::before {
		background: var(--color-warning);
	}

	@media (hover: hover) and (pointer: fine) {
		:is(.note, .why) summary:hover {
			color: var(--color-text);
			cursor: pointer;
		}
	}

	.note p,
	.why ul {
		padding: 0 var(--space-4);
	}

	/* Each decision on its own lines, the newest first, under the title that says which day. */
	.why ul {
		display: grid;
		gap: var(--space-2);
		padding-bottom: var(--space-3);
		list-style: none;
	}

	/* A link in a panel: a full 44 px row, as the session screen's notices set theirs. */
	.link {
		display: flex;
		align-items: center;
		min-height: var(--touch-target);
		font-weight: var(--weight-semibold);
	}

	.logged {
		display: grid;
		gap: var(--space-2);
	}

	.tool {
		position: relative;
		display: grid;
		gap: var(--space-2);
	}

	/* The plan's failure notice: under its button, the row's whole width. */
	.plan-failed {
		flex-basis: 100%;
	}

	/* Pending (tapped, the sheet's code on its way): a spinner takes the chevron's place after
	   a beat, so a fast fetch shows nothing. Drawn here from aria-busy, so the state adds no
	   component (no Spinner, no ListRow prop) to Train's initial JavaScript. */
	.tool[aria-busy='true']::after {
		content: '';
		position: absolute;
		top: 50%;
		right: calc(var(--space-4) + 1px);
		width: 20px;
		height: 20px;
		margin-top: -10px;
		border: 2.5px solid color-mix(in srgb, currentColor 25%, transparent);
		border-top-color: currentColor;
		border-radius: var(--radius-full);
		color: var(--color-text-tertiary);
		background: var(--color-surface-1);
		box-shadow: 0 0 0 4px var(--color-surface-1);
		opacity: 0;
		animation:
			spin 0.8s linear infinite,
			appear var(--duration-fast) var(--ease-out) 150ms forwards;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@keyframes appear {
		to {
			opacity: 1;
		}
	}

	/* The notice's inline action, styled as the notice styles its links (and the toast its
	   action): accent, underlined, with a full 44 × 44 px target that clears the bottom
	   navigation when scrolled into view. The negative margin keeps the word under the title
	   and the notice compact. */
	.retry {
		display: flex;
		align-items: center;
		min-width: var(--touch-target);
		min-height: var(--touch-target);
		padding: 0 var(--space-2);
		margin: calc(var(--space-2) * -1);
		scroll-margin-bottom: calc(var(--nav-inset-bottom) + var(--space-4));
		font-size: var(--text-sm);
		font-weight: var(--weight-bold);
		color: var(--color-accent-text);
		text-decoration: underline;
		text-underline-offset: 3px;
	}
</style>
