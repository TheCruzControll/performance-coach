<script lang="ts">
	import { onMount, type Component, type ComponentProps } from 'svelte';
	import { invalidateAll, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { navigating, page } from '$app/state';
	import { preferences } from '#lib/client/preferences.svelte.ts';
	import Badge from '#lib/ui/components/Badge.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';
	import ProgramHeader from '#lib/ui/program/ProgramHeader.svelte';
	import SessionCard from '#lib/ui/program/SessionCard.svelte';
	import WeekStrip from '#lib/ui/program/WeekStrip.svelte';
	import type PlateSheetType from './PlateSheet.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/**
	 * Where 'no program yet' sends the owner: Today builds a program once the training profile is
	 * complete (Build my program); until then the profile is filled in from Profile's sections.
	 * Decision: point SETUP at M2's onboarding screen once it has a route.
	 */
	const BUILD_HREF = resolve('/(app)/today');
	const SETUP_HREF = resolve('/(app)/profile');

	const weekHref = (n: number) => `${resolve('/(app)/train')}?week=${n}`;

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
		if (typeof to === 'object') return { href: weekHref(to.week), inTrain: true };
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

	let reloading = $state(false);
	async function reload() {
		reloading = true;
		await invalidateAll();
		reloading = false;
	}

	// ---- The plate calculator ----------------------------------------------------------------

	// The plate calculator and the sheet it opens in are code-split together (PlateSheet),
	// fetched on first intent (pointerdown/hover), on open, or for ?tool=plates, so Train ships
	// and hydrates without either. A tap made before they arrive is kept: the sheet opens when
	// they do. A failed fetch is forgotten, so the next tap imports again.
	type Sheet = Component<ComponentProps<typeof PlateSheetType>>;
	let fetching: Promise<{ default: Sheet }> | null = null;
	let PlateSheet = $state.raw<Sheet | null>(null);
	let sheetOpen = $state(false);
	let failed = $state(false);
	/** A tap after a reported failure, with the screen still here: failing again online reloads. */
	let retrying = false;

	function loadSheet() {
		if (fetching) return;
		fetching = import('./PlateSheet.svelte');
		// Kept apart from the import() expression: Vite moves `import(…).then(…)` whole into its
		// preloader, whose own failures would then skip these handlers.
		fetching.then(
			(module) => (PlateSheet = module.default),
			() => {
				fetching = null;
				// Resolved against Train's own URL: the same screen, asking for the sheet.
				if (retrying && sheetOpen && navigator.onLine) return location.replace('?tool=plates');
				// A failed tap is reported; a failed prefetch (hover) says nothing, and never takes
				// away a notice already shown.
				failed ||= sheetOpen;
				sheetOpen = false;
			}
		);
	}

	// After a failure, a tap on Retry (or on the row again) imports again in place, which WebKit
	// fetches anew because the sheet's code has no modulepreload tag (a failed one WebKit never
	// fetches again, reloads included: vite.config.ts). Chromium keeps a failed module fetch for
	// the document's lifetime, and after a deploy the old chunk is gone: if the import fails again
	// while online, Train reloads asking for the sheet (?tool=plates), which opens once its code
	// arrives. Offline, the notice stays.
	function openCalculator() {
		retrying ||= failed;
		failed = false;
		sheetOpen = true;
		loadSheet();
	}

	/** The notice can appear under the bottom navigation: bring it into view. */
	const reveal = (node: HTMLElement) => node.scrollIntoView({ block: 'nearest' });

	onMount(() => {
		preferences.load();
		if (page.url.searchParams.get('tool') === 'plates') openCalculator();
		// Left mid-retry: a late failure must not pull the owner back to Train.
		return () => (retrying = false);
	});

	function closeSheet() {
		if (page.url.searchParams.has('tool')) replaceState(resolve('/(app)/train'), {});
	}
</script>

<svelte:head>
	<title>Train · Performance Coach</title>
</svelte:head>

<PageHeader title="Train" eyebrow="Program" />

<div class="stack">
	{#if view}
		<ProgramHeader
			title={view.program.title}
			position={view.position}
			weeks={Array.from({ length: view.program.plannedWeeks }, (_, i) => ({
				number: i + 1,
				href: weekHref(i + 1)
			}))}
			shown={view.shown}
			current={view.program.currentWeek}
			pending={pendingWeek}
			previous={view.shown > 1 ? weekHref(Math.min(view.shown - 1, view.totalWeeks)) : undefined}
			next={view.shown < view.totalWeeks ? weekHref(view.shown + 1) : undefined}
			status={view.status}
		/>
		<p class="visually-hidden" role="status">{loading ? 'Loading the week…' : ''}</p>
	{/if}

	<!-- Busy while the next week loads; only the week's own strip and cards go inert, never the
	     state card's link, which may hold the focus of the change it started. -->
	<div class="week" aria-busy={loading} inert={loading && !data.card} data-testid="train-week">
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
						<SessionCard
							session={card}
							baseline={card.baseline}
							pending={loading}
							data-testid="session-card"
						/>
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

			{#if view!.brief}
				{@const brief = view!.brief}
				<Surface
					as="section"
					tone="accent"
					aria-labelledby="brief-title"
					data-testid="baseline-brief"
				>
					<div class="brief">
						<span class="eyebrow">{brief.eyebrow}</span>
						<h2 id="brief-title" class="brief-title">{brief.title}</h2>
						<p>{brief.lead}</p>
						<ul>
							{#each brief.points as point (point)}<li>{point}</li>{/each}
						</ul>
					</div>
				</Surface>
			{/if}
		{/if}
	</div>

	<Section title="Tools">
		<div class="tool" aria-busy={sheetOpen && !PlateSheet}>
			<ListRow
				icon="plate"
				tone="strength"
				title="Plate calculator"
				subtitle="Exact loading in kg or lb"
				onpointerdown={loadSheet}
				onpointerenter={loadSheet}
				onclick={openCalculator}
				data-testid="open-plates"
			/>
			{#if failed}
				<Notice tone="danger" title="Couldn’t open the plate calculator">
					<button type="button" class="retry" onclick={openCalculator} use:reveal>Retry</button>
				</Notice>
			{/if}
		</div>
		<ListRow icon="timer" title="Rest timer" subtitle="Arrives with workout logging" disabled>
			{#snippet trailing()}<Badge>Soon</Badge>{/snippet}
		</ListRow>
	</Section>
</div>

<!-- Renders nothing until its code has arrived (a dynamic component that is null). -->
<PlateSheet bind:open={sheetOpen} unit={preferences.units} onclose={closeSheet} />

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
