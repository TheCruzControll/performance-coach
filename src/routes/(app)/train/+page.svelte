<script lang="ts">
	import { onMount, type ComponentProps } from 'svelte';
	import { afterNavigate, goto, invalidateAll, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { navigating, page } from '$app/state';
	import { preferences } from '#lib/client/preferences.svelte.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import type { IconName } from '#lib/ui/icons/icons.ts';
	import type AddSessionSheetType from '#lib/ui/program/AddSessionSheet.svelte';
	import type PlanSheetType from '#lib/ui/program/PlanOverviewSheet.svelte';
	import WeekLines from '#lib/ui/program/WeekLines.svelte';
	import { LazySheet } from './lazy-sheet.svelte.ts';
	import type PlateSheetType from './PlateSheet.svelte';
	import type RestTimerSheetType from './RestTimerSheet.svelte';
	import type { AsidePanel } from './cards.server';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/**
	 * Where 'no program yet' sends the owner: Today builds a program once the training profile is
	 * complete (Build my program); until then the profile is filled in from Profile's sections.
	 * Decision: point SETUP at M2's onboarding screen once it has a route.
	 */
	const BUILD_HREF = resolve('/(app)/today');
	const SETUP_HREF = resolve('/(app)/profile');
	const TRAIN = resolve('/(app)/train');

	const weekHref = (n: number) => `${TRAIN}?week=${n}`;
	const HISTORY_HREF = resolve('/(app)/train/history/[[version]]', {});
	const START_HREF = resolve('/(app)/train/start');
	const COACH_HREF = resolve('/(app)/coach/[[thread]]', {});

	// ---- The week shown ----------------------------------------------------------------------

	const view = $derived(data.state === 'program' ? data : null);
	const week = $derived(view?.week.planned ? view.week : null);
	const parts = $derived(view?.noteParts);
	/** The week's note has more than one part: each says what it is. */
	const headed = $derived(
		parts
			? [
					parts.kind,
					parts.findings.length,
					parts.review,
					parts.baseline,
					parts.replan,
					parts.why.length
				].filter(Boolean).length > 1
			: false
	);

	/** A week change in flight: Train itself, with another ?week (or none). */
	const loading = $derived(
		navigating.to?.url.pathname === page.url.pathname &&
			navigating.to.url.search !== page.url.search
	);

	/** The state's next step as a link (none for Retry); `inTrain` when it changes week. */
	const next = $derived.by(() => {
		const to = data.card?.next.to;
		if (to === 'today') return { href: BUILD_HREF };
		if (to === 'profile') return { href: SETUP_HREF };
		if (to === 'this-week') return { href: TRAIN, inTrain: true };
		if (typeof to === 'object')
			return 'href' in to ? { href: to.href } : { href: weekHref(to.week), inTrain: true };
		return { href: undefined };
	});

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
	/** Add a session to the week shown (AddSessionSheet): loaded on its row's first tap. */
	const addSession = new LazySheet<ComponentProps<typeof AddSessionSheetType>>(
		() =>
			import.meta.env.SSR
				? Promise.reject(new Error('client only'))
				: import('#lib/ui/program/AddSessionSheet.svelte'),
		'add'
	);

	/** A week tapped in the plan: shown as an arrow shows it (keeping scroll and focus). */
	const openWeek = (week: number) =>
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() + a query
		goto(weekHref(week), { replace: true, reset: false });

	/** More's disclosure. It opens on a tap, or on arrival asking for one of its tools (`?tool=`),
	 * so the tool's row is there to return the focus to, and to hold its notice if it fails to
	 * load. Set once mounted, never bound: a disclosure opened before hydration stays open. */
	let moreEl = $state<HTMLDetailsElement>();

	/** Back to this week was followed: once there, the focus it held goes to More, in its place. */
	let backed = false;
	afterNavigate(() => {
		if (!backed) return;
		backed = false;
		const lost = !document.activeElement || document.activeElement === document.body;
		if (lost) document.querySelector<HTMLElement>('[data-testid="open-more"]')?.focus();
	});

	/** The notice can appear under the bottom navigation: bring it into view. */
	const reveal = (node: HTMLElement) => node.scrollIntoView({ block: 'nearest' });

	onMount(() => {
		preferences.load();
		const tool = page.url.searchParams.get('tool');
		if (tool && ['plates', 'rest', 'plan', 'add'].includes(tool) && moreEl) moreEl.open = true;
		if (tool === 'plates') plates.show();
		if (tool === 'plan' && view) plan.show();
		if (tool === 'add' && view) addSession.show();
		if (tool === 'rest') restTimer.show();
		// A rest left running (a reload, or back from another screen) shows on Train again, with
		// its alarm and keep-awake, without a tap. The key literal keeps standalone-rest.ts out of
		// Train's own chunk; blocked storage throws and means no rest.
		try {
			if (localStorage.getItem('pc:rest:v1')) restTimer.prefetch();
		} catch {
			// no storage, no rest
		}
		return () => {
			plates.leave();
			restTimer.leave();
			plan.leave();
			addSession.leave();
		};
	});

	function closeSheet() {
		if (page.url.searchParams.has('tool')) replaceState(TRAIN, {});
	}
</script>

<svelte:head>
	<title>Train · Performance Coach</title>
</svelte:head>

{#snippet arrow(href: string | null, label: string, icon: IconName, testId: string)}
	{#if href}
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- from week.server.ts -->
		<a class="arrow" {href} aria-label={label} data-testid={testId}>
			<Icon name={icon} size={16} />
		</a>
	{:else}
		<span class="arrow" aria-hidden="true" data-off><Icon name={icon} size={16} /></span>
	{/if}
{/snippet}

{#snippet chevron()}
	<Icon name="chevron-right" size={14} class="chevron" />
{/snippet}

<!-- A part of the week's note: what a review changed (each change, then its links), or week 1's
     brief (its three facts as rows). -->
{#snippet panel(part: AsidePanel)}
	<section data-testid={part.id}>
		{#if headed}<h3>{part.title}</h3>{/if}
		<p class="lead">{part.lead}</p>
		{#if part.id === 'review-notice'}
			<ul class="changes" role="list">
				{#each part.points as point, i (i)}
					<li>
						{#if point.lead}<strong>{point.lead}</strong>{/if}
						{point.text}
					</li>
				{/each}
			</ul>
		{:else}
			{#each part.points as point, i (i)}
				<ListRow static title={point.text} />
			{/each}
		{/if}
		<!-- eslint-disable svelte/no-navigation-without-resolve -- paths from cards.server.ts -->
		{#each part.links as link (link.id)}
			<ListRow title={link.label} href={link.href} data-testid={link.id} />
		{/each}
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
	</section>
{/snippet}

<!-- Instrument v2 (Paper, 4 · Train): the tab's name stays the page's heading, for screen
     readers; the week's own title ('This week') is the display line. A readable screen: on a
     desktop it is the 560 px column, 200 px from the rail. -->
<h1 class="visually-hidden">Train</h1>
<div class="screen" data-testid="train-week" aria-busy={loading} data-kits={kits}>
	{#if view && !data.card?.bare}
		<header class="top" data-testid="program-header">
			<p class="position" data-testid="program-position">{view.position}</p>
			<nav
				aria-label="Weeks"
				class="arrows"
				data-sveltekit-replacestate
				data-sveltekit-reset="false"
			>
				{@render arrow(view.previous, 'Previous week', 'chevron-left', 'previous-week')}
				{@render arrow(view.next, 'Next week', 'chevron-right', 'next-week')}
			</nav>
		</header>
	{/if}

	{#if data.card}
		{@const card = data.card}
		<!-- One statement in place of the week, and the one thing to do. Never inert while the
		     next week loads: its link may hold the focus of the change it started. -->
		<section class="state" data-testid={card.id} aria-labelledby="state-title">
			<h2 id="state-title" class="statement">{card.title}</h2>
			<p class="lead">{card.description}</p>
			{#if card.next.style === 'primary'}
				<Button
					size="lg"
					block
					href={next.href}
					onclick={next.href ? undefined : reload}
					loading={reloading}
					data-testid="train-next"
				>
					{card.next.title}
				</Button>
			{:else if card.next.style === 'text'}
				<button
					type="button"
					class="again"
					aria-busy={reloading}
					onclick={reload}
					data-testid="train-next"
				>
					{card.next.title}
				</button>
			{/if}
		</section>
		<!-- A bridge week's workouts, which no plan holds. -->
		{#if view?.offPlan.length}
			<WeekLines lines={view.offPlan} label="Logged this week" testId="off-plan-workout" />
		{/if}
		{#if card.next.style === 'row'}
			<!-- eslint-disable svelte/no-navigation-without-resolve -- resolved above, or a path from cards.server.ts -->
			<a
				class="quiet"
				href={next.href}
				data-sveltekit-replacestate={next.inTrain ? '' : undefined}
				data-sveltekit-reset={next.inTrain ? 'false' : undefined}
				data-testid="train-next"
			>
				<span>{card.next.title}</span>{@render chevron()}
			</a>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		{/if}
	{:else if view}
		<!-- Busy while the next week loads: dimmed after a beat, and inert, the arrows aside. -->
		<div class="week" inert={loading}>
			<h2 class="title" data-testid="week-title">{view.title}</h2>
			{#if view.status}
				<p class="status" data-testid="program-status">{view.status}</p>
			{/if}
			<WeekLines
				lines={view.lines}
				label={`Week ${view.shown}`}
				href={sessionHref}
				pending={navigating.to?.url.pathname ?? null}
			/>
			<!-- The one line about the week. What it opens shows under it, in place (the week's
			     note): the findings, a review's changes, the week's kind, week 1's brief, a
			     re-plan and why each day holds its session. -->
			{#if view.note && parts}
				{#if view.note.opens}
					<details class="note">
						<summary class="quiet" data-testid="week-line">
							<span>{view.note.text}</span>{@render chevron()}
						</summary>
						<div class="note-body" data-testid="week-note">
							{#if parts.kind}
								<section data-testid="week-kind">
									{#if headed}<h3>{parts.kind.label}</h3>{/if}
									<p class="lead">{parts.kind.why}</p>
								</section>
							{/if}
							{#if parts.findings.length}
								<section data-testid="week-findings">
									{#if headed}<h3>{parts.summary ?? 'Heads-ups'}</h3>{/if}
									{#each parts.findings as finding (finding.text)}
										<p class="finding" data-tone={finding.tone}>{finding.text}</p>
										<p class="why-line">Why: {finding.why}</p>
									{/each}
								</section>
							{/if}
							{#if parts.review}{@render panel(parts.review)}{/if}
							{#if parts.baseline}{@render panel(parts.baseline)}{/if}
							<!-- eslint-disable svelte/no-navigation-without-resolve -- a path from week.server.ts -->
							{#if parts.replan}
								<section>
									{#if headed}<h3>Your coach suggests a new plan</h3>{/if}
									<ListRow
										title="See the plan your coach suggests"
										href={parts.replan.href}
										data-testid="replan-review"
									/>
								</section>
							{/if}
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
							{#if parts.why.length}
								<section data-testid="week-why">
									{#if headed}<h3>Why each day holds its session</h3>{/if}
									{#each parts.why as why, i (i)}
										<details class="why">
											<summary>{why.title}</summary>
											<ul role="list">
												{#each why.lines as line, j (j)}<li>{line}</li>{/each}
											</ul>
										</details>
									{/each}
								</section>
							{/if}
							<ListRow title="Ask the coach about it" href={COACH_HREF} />
						</div>
					</details>
				{:else}
					<p class="quiet" data-testid="week-line">{view.note.text}</p>
				{/if}
			{/if}
		</div>
	{/if}

	<!-- More, or Back to this week on any other week (a 'Not planned yet' week already ends with
	     it, as its next step). More opens the plan, history and tools in place, as a list. -->
	{#if data.card?.next.to === 'this-week'}
		<!-- its next step is Back to this week -->
	{:else if view?.asked && !view.current}
		<a
			class="quiet"
			href={TRAIN}
			data-sveltekit-replacestate
			data-sveltekit-reset="false"
			data-testid="back-to-this-week"
			onclick={() => (backed = true)}
		>
			<span>Back to this week</span>{@render chevron()}
		</a>
	{:else}
		<details class="more" bind:this={moreEl}>
			<summary class="quiet" data-testid="open-more"><span>More</span>{@render chevron()}</summary>
			<!-- Each row in its own item, so each keeps its hairline, a failed tool's notice under it. -->
			<ul class="rows" role="list" data-testid="more-tools">
				{#if view}
					<li class="tool" aria-busy={plan.busy}>
						<ListRow
							title="See the whole plan"
							onpointerdown={plan.prefetch}
							onpointerenter={plan.prefetch}
							onclick={plan.show}
							data-testid="open-plan"
						/>
						{#if plan.failed}
							<Notice tone="danger" title="Couldn’t open your plan">
								<button type="button" class="retry" onclick={plan.show} use:reveal>Try again</button
								>
							</Notice>
						{/if}
					</li>
					<li class="tool">
						<ListRow
							title="See what has changed"
							href={HISTORY_HREF}
							aria-busy={navigating.to?.url.pathname === HISTORY_HREF}
							data-testid="open-history"
						/>
					</li>
				{/if}
				<li class="tool" aria-busy={plates.busy}>
					<ListRow
						title="Work out the plates for a bar"
						onpointerdown={plates.prefetch}
						onpointerenter={plates.prefetch}
						onclick={plates.show}
						data-testid="open-plates"
					/>
					{#if plates.failed}
						<Notice tone="danger" title="Couldn’t open the plate calculator">
							<button type="button" class="retry" onclick={plates.show} use:reveal>Try again</button
							>
						</Notice>
					{/if}
				</li>
				<li class="tool" aria-busy={restTimer.busy}>
					<ListRow
						title="Start a rest timer"
						onpointerdown={restTimer.prefetch}
						onpointerenter={restTimer.prefetch}
						onclick={restTimer.show}
						data-testid="open-rest-timer"
					/>
					{#if restTimer.failed}
						<Notice tone="danger" title="Couldn’t open the rest timer">
							<button type="button" class="retry" onclick={restTimer.show} use:reveal
								>Try again</button
							>
						</Notice>
					{/if}
				</li>
				<li class="tool">
					<ListRow
						title="Log a session that isn’t on the plan"
						href={resolve('/workout')}
						data-testid="log-a-session"
					/>
				</li>
				{#if view?.addable.length}
					<li class="tool" aria-busy={addSession.busy}>
						<ListRow
							title="Add a session to this week"
							onpointerdown={addSession.prefetch}
							onclick={addSession.show}
							data-testid="open-add-session"
						/>
						{#if addSession.failed}
							<Notice tone="danger" title="Couldn’t open adding a session">
								<button type="button" class="retry" onclick={addSession.show} use:reveal
									>Try again</button
								>
							</Notice>
						{/if}
					</li>
				{/if}
				{#if view?.movable}
					<li class="tool">
						<ListRow
							title="Change when the plan starts"
							href={START_HREF}
							aria-busy={navigating.to?.url.pathname === START_HREF}
							data-testid="open-start"
						/>
					</li>
				{/if}
			</ul>
		</details>
	{/if}
</div>
<p class="visually-hidden" role="status">{loading ? 'Loading the week…' : ''}</p>

<!-- A running rest still shows on Train with its sheet closed (v2/09 redesigns it). Each sheet
     renders nothing until its code has arrived (a dynamic component that is null). -->
<restTimer.component bind:open={restTimer.open} onclose={closeSheet} />
<plates.component bind:open={plates.open} unit={preferences.units} onclose={closeSheet} />
{#if view?.addable.length}
	<addSession.component
		bind:open={addSession.open}
		version={view.version}
		addable={view.addable}
		day={view.addable[0]!}
		addIntents={view.addIntents}
		onclose={closeSheet}
	/>
{/if}
{#if view}
	<plan.component
		bind:open={plan.open}
		title={view.program.title}
		blocks={view.plan}
		{weekHref}
		onweek={openWeek}
		onclose={closeSheet}
		road={view.road}
		openGoals={view.openGoals}
	/>
{/if}

<style>
	/* On a phone a state stands at the foot, above the tab bar, with an empty room above it
	   (Paper, 4 · Train "No week to show"); from 1024 px at the top of the column. */
	.screen {
		display: flex;
		flex-direction: column;
	}

	.screen:has(.state) {
		min-height: calc(100svh - var(--nav-inset-bottom) - var(--safe-top) - var(--space-12));
	}

	/* The top line: the week's place, and the arrows at the end, their glyphs on the gutter. */
	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
		min-height: var(--touch-target);
		margin-top: var(--space-3);
	}

	.position {
		min-width: 0;
		font: var(--type-secondary);
		color: var(--color-text-secondary);
	}

	.arrows {
		display: flex;
		flex: none;
		margin-right: calc((var(--touch-target) - 1rem) / -2);
	}

	.arrow {
		display: grid;
		place-items: center;
		width: var(--touch-target);
		height: var(--touch-target);
		color: var(--color-text-secondary);
	}

	.arrow[data-off] {
		opacity: 0.35;
	}

	/* Loading the next week: the week stays where it is, dimmed, after a beat, so a fast load
	   shows nothing. */
	.week,
	.state {
		transition: opacity var(--duration-base) var(--ease-standard);
	}

	.screen[aria-busy='true'] :is(.week, .state) {
		opacity: 0.55;
		transition-delay: 150ms;
	}

	.week {
		display: flex;
		flex-direction: column;
	}

	.title {
		margin-top: var(--space-10);
		font: var(--type-title);
		letter-spacing: var(--tracking-display);
		color: var(--color-text);
	}

	.status {
		margin-top: var(--space-2);
		font: var(--type-body);
		color: var(--color-text-secondary);
	}

	.week > :global(.week-lines) {
		margin-top: var(--space-8);
	}

	.state {
		margin-top: auto;
		padding-top: var(--space-10);
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

	.again {
		min-height: var(--touch-target);
		font: var(--type-button);
		color: var(--color-text);
	}

	/* A quiet row: More, the week's line, Back to this week, a state's row. */
	.quiet {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		width: 100%;
		min-height: var(--touch-target);
		margin-top: var(--space-3-5);
		font: var(--type-secondary);
		color: var(--color-text-secondary);
		text-decoration: none;
		list-style: none;
	}

	summary.quiet {
		cursor: pointer;
	}

	summary.quiet::-webkit-details-marker {
		display: none;
	}

	.quiet :global(.chevron) {
		flex: none;
		color: var(--color-text-tertiary);
		transition: transform var(--duration-fast) var(--ease-standard);
	}

	details[open] > summary.quiet :global(.chevron) {
		transform: rotate(90deg);
	}

	@media (hover: hover) and (pointer: fine) {
		.quiet:is(a, summary):hover {
			color: var(--color-text);
		}

		.arrow:is(a):hover {
			color: var(--color-text);
		}

		.why summary:hover {
			color: var(--color-text);
		}
	}

	/* The week's note, in place under its line. */
	.note-body {
		display: grid;
		gap: var(--space-6);
		padding-bottom: var(--space-3);
	}

	.note-body h3 {
		font: var(--type-row);
		font-weight: var(--weight-semibold);
		color: var(--color-text);
	}

	.note-body .lead {
		padding: var(--space-3) 0 0;
	}

	/* A finding: its words in text colour, label first; a caution keeps its warning dot. */
	.finding {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		padding-top: var(--space-3);
		font: var(--type-body);
		color: var(--color-text);
	}

	.finding::before {
		content: '';
		flex: none;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		box-shadow: inset 0 0 0 1.5px;
		transform: translateY(-0.1em);
	}

	.finding[data-tone='caution']::before {
		background: var(--color-warning);
	}

	.why-line {
		padding: var(--space-3) 0 var(--space-5);
		font: var(--type-secondary);
		color: var(--color-text-tertiary);
	}

	.changes {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-3) 0;
		list-style: none;
		font: var(--type-secondary);
		color: var(--color-text-secondary);
	}

	.changes strong {
		font-weight: var(--weight-semibold);
		color: var(--color-text);
	}

	/* Why a day holds its session (m7/14): closed by default, its decisions under it. */
	.why {
		font: var(--type-secondary);
		color: var(--color-text-secondary);
	}

	.why summary {
		display: flex;
		align-items: center;
		min-height: var(--touch-target);
		list-style: none;
		cursor: pointer;
	}

	.why summary::-webkit-details-marker {
		display: none;
	}

	.why ul {
		display: grid;
		gap: var(--space-2);
		padding-bottom: var(--space-3);
		list-style: none;
	}

	.rows {
		display: grid;
		list-style: none;
	}

	@media (width >= 64rem) {
		.screen:has(.state) {
			min-height: 0;
		}

		.state {
			margin-top: 0;
		}

		/* Paper, 11 · Desktop: a 60 px row with a hairline above. */
		.quiet {
			min-height: 3.75rem;
			margin-top: 0;
			border-top: 1px solid var(--color-hairline);
		}

		.note-body {
			padding-bottom: var(--space-6);
		}
	}

	.tool {
		position: relative;
		display: grid;
		gap: var(--space-2);
	}

	/* Pending (tapped, the sheet's code on its way): a spinner takes the chevron's place after
	   a beat, so a fast fetch shows nothing. Drawn here from aria-busy, so the state adds no
	   component (no Spinner, no ListRow prop) to Train's initial JavaScript. */
	.tool[aria-busy='true']::after {
		content: '';
		position: absolute;
		top: 50%;
		right: 0;
		width: 20px;
		height: 20px;
		margin-top: -10px;
		border: 2.5px solid color-mix(in srgb, currentColor 25%, transparent);
		border-top-color: currentColor;
		border-radius: var(--radius-full);
		color: var(--color-text-tertiary);
		background: var(--color-canvas);
		box-shadow: 0 0 0 4px var(--color-canvas);
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
