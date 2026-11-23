<script lang="ts">
	import { onMount, tick, type ComponentProps } from 'svelte';
	import { afterNavigate, invalidateAll, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { navigating, page } from '$app/state';
	import { preferences } from '#lib/client/preferences.svelte.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import type { IconName } from '#lib/ui/icons/icons.ts';
	import type AddSessionSheetType from '#lib/ui/program/AddSessionSheet.svelte';
	import WeekLines from '#lib/ui/program/WeekLines.svelte';
	import { LazySheet } from './lazy-sheet.svelte.ts';
	import type MoreSheetType from './MoreSheet.svelte';
	import type PlateSheetType from './PlateSheet.svelte';
	import type RestTimerSheetType from './RestTimerSheet.svelte';
	import type WeekNoteSheetType from './WeekNoteSheet.svelte';
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

	// ---- The week shown ----------------------------------------------------------------------

	const view = $derived(data.state === 'program' ? data : null);
	const week = $derived(view?.week.planned ? view.week : null);

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

	// ---- The sheets: More, the week's note, and the tools More opens -------------------------

	// Each is code-split with the BottomSheet it opens in and loads on intent (lazy-sheet.svelte.ts).
	// Each is left out of the server build, which never renders it: SvelteKit links into a page the
	// CSS of every dynamic import its server build can reach (check-budgets.ts), and a sheet's own
	// stylesheets arrive with it.
	/** More (v2/07a2): the plan, history and tools, each tool opening over it. */
	const more = new LazySheet<ComponentProps<typeof MoreSheetType>>(
		() =>
			import.meta.env.SSR ? Promise.reject(new Error('client only')) : import('./MoreSheet.svelte'),
		'more'
	);
	/** The week's note, behind the one line under the week (v2/07a2). */
	const note = new LazySheet<ComponentProps<typeof WeekNoteSheetType>>(
		() =>
			import.meta.env.SSR
				? Promise.reject(new Error('client only'))
				: import('./WeekNoteSheet.svelte'),
		'note'
	);
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
	/** Add a session to the week shown (AddSessionSheet): loaded on its row's first tap. */
	const addSession = new LazySheet<ComponentProps<typeof AddSessionSheetType>>(
		() =>
			import.meta.env.SSR
				? Promise.reject(new Error('client only'))
				: import('#lib/ui/program/AddSessionSheet.svelte'),
		'add'
	);

	/** A session added: More, which Add session opened over, closes with it, so the new line is in
	 * view and the focus goes back to More's own opener. */
	const added = () => (more.open = false);

	/**
	 * A tool asked for on arrival (`?tool=`): it opens over More, once More is open, as a tap on its
	 * row would have, so closing it leaves the owner in More, and its row is there to hold its notice
	 * if it fails to load. Its row never held the focus, though: nothing did on arrival, so More's
	 * sheet takes it as it opens, and the tool hands it back to More's sheet, not to the row.
	 * Closing More then leaves it on the page, where the arrival found it. Should More's own code
	 * fail, the tool opens alone.
	 */
	let asked = $state.raw<{ show: () => void } | null>(null);
	$effect(() => {
		const tool = asked;
		if (!tool || !(more.component || more.failed)) return;
		asked = null;
		// After this update, in which More's dialog opens: the tool's opens over it.
		void tick().then(tool.show);
	});

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
		const inMore =
			tool === 'plates'
				? plates
				: tool === 'rest'
					? restTimer
					: tool === 'add' && view?.addable.length
						? addSession
						: null;
		// Each of More's tools arrives over More, opened first (`asked`, above). The plan is a page
		// now (/train/plan): an old `?tool=plan` opens nothing.
		if (tool === 'more' || inMore) more.show();
		if (inMore) {
			inMore.prefetch();
			asked = inMore;
		}
		if (tool === 'note' && view?.note?.opens) note.show();
		// A rest left running (a reload, or back from another screen) shows on Train again, with
		// its alarm and keep-awake, without a tap. The key literal keeps standalone-rest.ts out of
		// Train's own chunk; blocked storage throws and means no rest.
		try {
			if (localStorage.getItem('pc:rest:v1')) restTimer.prefetch();
		} catch {
			// no storage, no rest
		}
		return () => {
			for (const sheet of [more, note, plates, restTimer, addSession]) sheet.leave();
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
			<!-- The one line about the week. It opens the week's note (WeekNoteSheet): the findings,
			     a review's changes, the week's kind, week 1's brief, a re-plan and why each day holds
			     its session. With nothing to open, it is a plain line. -->
			{#if view.note?.opens}
				<div class="tool" aria-busy={note.busy}>
					<button
						type="button"
						class="quiet"
						aria-haspopup="dialog"
						onpointerdown={note.prefetch}
						onpointerenter={note.prefetch}
						onclick={note.show}
						data-testid="week-line"
					>
						<span>{view.note.text}</span>{@render chevron()}
					</button>
					{#if note.failed}
						<Notice tone="danger" title="Couldn’t open the week’s note">
							<button type="button" class="retry" onclick={note.show} use:reveal>Try again</button>
						</Notice>
					{/if}
				</div>
			{:else if view.note}
				<p class="quiet" data-testid="week-line">{view.note.text}</p>
			{/if}
		</div>
	{/if}

	<!-- More, or Back to this week on any other week (a 'Not planned yet' week already ends with
	     it, as its next step). More opens its sheet (MoreSheet): the plan, history and tools. -->
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
		<div class="tool" aria-busy={more.busy}>
			<button
				type="button"
				class="quiet"
				aria-haspopup="dialog"
				onpointerdown={more.prefetch}
				onpointerenter={more.prefetch}
				onclick={more.show}
				data-testid="open-more"
			>
				<span>More</span>{@render chevron()}
			</button>
			{#if more.failed}
				<Notice tone="danger" title="Couldn’t open More">
					<button type="button" class="retry" onclick={more.show} use:reveal>Try again</button>
				</Notice>
			{/if}
		</div>
	{/if}
</div>
<p class="visually-hidden" role="status">{loading ? 'Loading the week…' : ''}</p>

<!-- A running rest still shows on Train with its sheet closed (v2/09 redesigns it). Each sheet
     renders nothing until its code has arrived (a dynamic component that is null). More's tools
     open over it. -->
<more.component
	bind:open={more.open}
	onclose={closeSheet}
	program={!!view}
	{plates}
	rest={restTimer}
	add={view?.addable.length ? addSession : null}
	movable={!!view?.movable}
/>
{#if view?.note?.opens}
	<note.component
		bind:open={note.open}
		title={view.note.text}
		parts={view.noteParts}
		onclose={closeSheet}
	/>
{/if}
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
		onadded={added}
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
		text-align: start;
		text-decoration: none;
	}

	.quiet :global(.chevron) {
		flex: none;
		color: var(--color-text-tertiary);
	}

	/* The week's line and More: the row, and a notice under it should its sheet fail to load. */
	.tool {
		position: relative;
		display: grid;
		gap: var(--space-2);
		margin-top: var(--space-3-5);
	}

	.tool > .quiet {
		margin-top: 0;
	}

	@media (hover: hover) and (pointer: fine) {
		.quiet:is(a, button):hover {
			color: var(--color-text);
		}

		.arrow:is(a):hover {
			color: var(--color-text);
		}
	}

	@media (width >= 64rem) {
		.screen:has(.state) {
			min-height: 0;
		}

		.state {
			margin-top: 0;
		}

		/* Paper, 11 · Desktop: a 60 px row with a hairline above. */
		.quiet,
		.tool {
			margin-top: 0;
		}

		.quiet {
			min-height: 3.75rem;
			border-top: 1px solid var(--color-hairline);
		}
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
