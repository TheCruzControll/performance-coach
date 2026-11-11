<!--
  @component
  Today once a program exists (plan.server.ts): the week on a WeekStrip with today selected and
  its sessions as cards, each opening its detail, then 'Up next' across weeks. A rest day names
  the next session; before week 1, 'Starts Monday' over week 1; once the first block is over,
  'Nothing planned yet' with its summary, an empty Up next and the way to Train. The plan is
  streamed: its skeleton holds the room until it arrives, and a failed read is a designed error
  with Retry. Today's sessions each offer Start workout or Done · View (start-link.ts, composed
  on the server), or Resume for the workout in progress on this device, and the day offers 'Log
  something else'. Once the plan shows and the browser is idle, Today saves the kits of the
  sessions still to do today and in the next two days, so they start in a gym with no signal, even
  one looked at the night before: with Train, the only places outside the workout pages that
  create the device's database (coming-kits.ts). Last, Ask the coach opens Coach with
  'What should I focus on next week?' (a link: ui/ask-link.ts). In a bridge week between blocks,
  'Between blocks' names the day the next block starts, with 'Log something else', in place of
  the week. When a week or a block completes, its review prompt leads (ReviewPrompt: create and
  open it, or 'See your review'). Code-split behind PanelLoader.
-->
<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { navigating } from '$app/state';
	import { deviceWorkout } from '#lib/client/workout/device-workout.svelte.ts';
	import type { IsoDate } from '#lib/domain/calendar.ts';
	import ReviewPrompt from '#lib/ui/analytics/ReviewPrompt.svelte';
	import { ASK_QUESTIONS, askHref } from '#lib/ui/ask-link.ts';
	import Badge from '#lib/ui/components/Badge.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import Card from '#lib/ui/components/Card.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import Skeleton from '#lib/ui/components/Skeleton.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';
	import SessionCard from '#lib/ui/program/SessionCard.svelte';
	import { resumeLink } from '#lib/ui/program/start-link.ts';
	import WeekStrip from '#lib/ui/program/WeekStrip.svelte';
	import type { PageData } from '../$types';

	type TodayPlanView = Awaited<NonNullable<PageData['plan']>>;
	type PlanCard = Omit<
		Extract<TodayPlanView, { failed: false }>['upNext'][number],
		'when' | 'date'
	>;

	interface Props {
		/** Settled when Today was server-rendered; a promise after a client navigation. */
		plan: TodayPlanView | Promise<TodayPlanView>;
	}

	let { plan }: Props = $props();

	/** The day the owner tapped on the strip; until then the plan's (today, or week 1's first). */
	let chosen = $state<IsoDate | null>(null);

	const sessionHref = (lineage: string) => resolve('/(app)/train/session/[key]', { key: lineage });
	const TRAIN_HREF = resolve('/(app)/train');

	/**
	 * Once the idle pass has run: 'saved' with the coming days' kits on this device (coming-kits.ts),
	 * 'none' with none to save (rest days ahead: nothing created). What the specs wait for.
	 */
	let kits = $state<'saved' | 'none'>();

	/** Once the plan shows and the browser is idle: never on the server, once a plan. */
	$effect(() => {
		let live = true;
		const shown = plan;
		const save = async () => {
			const view = await shown;
			let saved: string[] = [];
			if (!view.failed) {
				const coming = await import('#lib/client/workout/coming-kits.ts');
				saved = await coming.saveComingKits(datedSessions(view), view.today);
			}
			if (live) kits = saved.length ? 'saved' : 'none';
		};
		const go = () => live && void save().catch(() => {});
		if ('requestIdleCallback' in window) requestIdleCallback(go, { timeout: 2000 });
		else setTimeout(go, 800);
		return () => (live = false);
	});

	/** The week's sessions on their days, then Up next's, which may cross into the next week. */
	const datedSessions = (view: Extract<TodayPlanView, { failed: false }>) => [
		...(view.week?.days.flatMap((d) => d.cards.map((c) => ({ ...c, date: d.date }))) ?? []),
		...view.upNext
	];

	let retrying = $state(false);
	async function retry() {
		retrying = true;
		await invalidateAll();
		retrying = false;
	}
</script>

{#snippet go(card: PlanCard)}
	{@const next = resumeLink(card.lineage, card.start, deviceWorkout.active)}
	{#if next}
		<Button
			variant={next.icon === 'check' ? 'secondary' : 'primary'}
			icon={next.icon}
			href={next.href}
			block
			data-testid={next.id}>{next.label}</Button
		>
	{/if}
{/snippet}

{#snippet cardFor(card: PlanCard, testId: string)}
	{@const href = sessionHref(card.lineage)}
	<SessionCard
		session={card}
		{href}
		baseline={card.baseline}
		pending={navigating.to?.url.pathname === href}
		data-testid={testId}
	/>
{/snippet}

<div class="plan" data-testid="today-plan" data-kits={kits}>
	{#await plan}
		<div class="pending" aria-busy="true">
			<span class="visually-hidden">Loading today’s plan…</span>
			<!-- The strip's room: Today's STRIP_ROOM on a desktop screen, where it spans the columns. -->
			<Skeleton height="var(--today-strip-room, 4.5rem)" radius="var(--radius-md)" />
			<Skeleton height="12rem" radius="var(--radius-lg)" />
			<Skeleton height="16rem" radius="var(--radius-lg)" />
		</div>
	{:then view}
		{#if view.failed}
			<Card padding="lg" data-testid="today-plan-error">
				<EmptyState
					compact
					icon="alert"
					tone="combat"
					title="Couldn’t load today’s plan"
					description="Your plan is safe. Check your connection, then try again."
				>
					{#snippet actions()}
						<Button variant="secondary" icon="refresh" loading={retrying} onclick={retry}>
							Retry
						</Button>
					{/snippet}
				</EmptyState>
			</Card>
		{:else}
			{#if view.review}
				<ReviewPrompt review={view.review} />
			{/if}

			{#if view.starts}
				<Card tone="accent" padding="lg" data-testid="today-starts">
					<div class="note">
						<Badge tone="accent" icon="today">Week 1</Badge>
						<h2 class="note-title">{view.starts.title}</h2>
						<p class="note-copy">{view.starts.description}</p>
					</div>
				</Card>
			{/if}

			{#if view.complete}
				<Surface padding="none" radius="xl">
					<EmptyState
						icon="check"
						tone="accent"
						title={view.complete.title}
						description={view.complete.description}
						data-testid="today-block-complete"
					/>
				</Surface>
				<ListRow
					icon="train"
					title="Open Train"
					subtitle="Look back at every planned week"
					href={TRAIN_HREF}
					data-testid="today-train-link"
				/>
			{/if}

			{#if view.bridge}
				<Surface padding="none" radius="xl">
					<EmptyState
						icon="clock"
						tone="neutral"
						title={view.bridge.title}
						description={view.bridge.description}
						data-testid="today-bridge"
					>
						{#snippet actions()}
							<Button
								variant="secondary"
								icon="plus"
								href={resolve('/workout')}
								data-testid="log-something-else"
							>
								Log something else
							</Button>
						{/snippet}
					</EmptyState>
				</Surface>
			{/if}

			{#if view.week}
				{@const week = view.week}
				{@const selected = chosen ?? week.selected}
				{@const day = week.days.find((d) => d.date === selected) ?? week.days[0]!}
				{@const isToday = day.date === week.today}
				<WeekStrip
					days={week.strip}
					today={week.today}
					{selected}
					label={week.label}
					onselect={(date) => (chosen = date)}
					data-testid="week-strip"
				/>
				<Section title={day.heading} gap={isToday ? 'md' : 'sm'} data-testid="today-day">
					{#snippet action()}
						{#if isToday}<Badge tone="accent">Today</Badge>{/if}
					{/snippet}
					{#each day.cards as card (card.lineage)}
						{#if isToday}
							<div class="session" data-testid="today-session">
								{@render cardFor(card, 'session-card')}
								{@render go(card)}
							</div>
						{:else}
							{@render cardFor(card, 'session-card')}
						{/if}
					{:else}
						<Surface padding="none" radius="lg">
							<EmptyState
								compact
								icon="moon"
								tone="neutral"
								title="Rest day"
								description={day.rest ?? undefined}
								data-testid="today-rest"
							/>
						</Surface>
					{/each}
					{#if isToday}
						<Button
							variant="ghost"
							icon="plus"
							href={resolve('/workout')}
							data-testid="log-something-else"
						>
							Log something else
						</Button>
					{/if}
				</Section>
			{/if}

			<Section title="Up next" data-testid="today-up-next">
				{#if view.upNext.length}
					<ol class="up-next">
						{#each view.upNext as card (card.lineage)}
							<li class="next">
								<span class="when">{card.when}</span>
								{@render cardFor(card, 'up-next-card')}
							</li>
						{/each}
					</ol>
				{:else}
					<Surface padding="none" radius="lg">
						<EmptyState
							compact
							icon="clock"
							tone="neutral"
							title="Nothing up next"
							description="Your next sessions appear here once they are planned."
							data-testid="today-up-next-empty"
						/>
					</Surface>
				{/if}
			</Section>

			<ListRow
				icon="coach"
				title="Ask the coach"
				subtitle={ASK_QUESTIONS.today}
				href={askHref(ASK_QUESTIONS.today, 'today')}
				data-testid="ask-coach"
			/>
		{/if}
	{/await}
</div>

<style>
	.plan,
	.pending {
		display: grid;
		gap: var(--space-6);
	}

	.note {
		display: grid;
		justify-items: start;
		gap: var(--space-3);
	}

	.note-title {
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-display);
		line-height: var(--leading-tight);
	}

	.note-copy {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.session {
		display: grid;
		gap: var(--space-2);
	}

	.up-next {
		display: grid;
		gap: var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.next {
		display: grid;
		gap: var(--space-1-5);
	}

	.when {
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
		color: var(--color-text-secondary);
	}

	/*
	 * Desktop: the plan lies on Today's tracks (+page.svelte) as a subgrid, so its week strip spans
	 * both columns in the first row while the day and Up next take the main column beside Today's
	 * side column. Its skeleton does the same: the strip's room across, the rest in the column.
	 */
	@media (width >= 64rem) {
		.plan,
		.pending {
			grid-column: 1 / -1;
			grid-row: 1 / -1;
			grid-template-columns: subgrid;
			grid-template-rows: subgrid;
			gap: normal;
			align-items: start;
		}

		.plan > :global(*:not(.pending)),
		.pending > :global(*) {
			grid-column: 1;
		}

		.plan > :global([role='radiogroup']),
		.pending > :global(.visually-hidden + *) {
			grid-column: 1 / -1;
			grid-row: 1;
		}
	}
</style>
