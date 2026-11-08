<!--
  @component
  Today once a program exists (plan.server.ts): the week on a WeekStrip with today selected and
  its sessions as cards, each opening its detail, then 'Up next' across weeks. A rest day names
  the next session; before week 1, 'Starts Monday' over week 1; once the first block is over,
  'Nothing planned yet' with its summary, an empty Up next and the way to Train. The plan is
  streamed: its skeleton holds the room until it arrives, and a failed read is a designed error
  with Retry. Code-split behind PanelLoader.
-->
<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { navigating } from '$app/state';
	import type { IsoDate } from '#lib/domain/calendar.ts';
	import Badge from '#lib/ui/components/Badge.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import Card from '#lib/ui/components/Card.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import Skeleton from '#lib/ui/components/Skeleton.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';
	import SessionCard from '#lib/ui/program/SessionCard.svelte';
	import WeekStrip from '#lib/ui/program/WeekStrip.svelte';
	import type { PageData } from '../$types';

	type TodayPlanView = Awaited<NonNullable<PageData['plan']>>;
	type PlanCard = Omit<Extract<TodayPlanView, { failed: false }>['upNext'][number], 'when'>;

	interface Props {
		/** Settled when Today was server-rendered; a promise after a client navigation. */
		plan: TodayPlanView | Promise<TodayPlanView>;
	}

	let { plan }: Props = $props();

	/** The day the owner tapped on the strip; until then the plan's (today, or week 1's first). */
	let chosen = $state<IsoDate | null>(null);

	const sessionHref = (lineage: string) => resolve('/(app)/train/session/[key]', { key: lineage });
	const TRAIN_HREF = resolve('/(app)/train');

	let retrying = $state(false);
	async function retry() {
		retrying = true;
		await invalidateAll();
		retrying = false;
	}
</script>

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

<div class="plan" data-testid="today-plan">
	{#await plan}
		<div class="pending" aria-busy="true">
			<span class="visually-hidden">Loading today’s plan…</span>
			<Skeleton height="4.5rem" radius="var(--radius-md)" />
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

			{#if view.week}
				{@const week = view.week}
				{@const selected = chosen ?? week.selected}
				{@const day = week.days.find((d) => d.date === selected) ?? week.days[0]!}
				<WeekStrip
					days={week.strip}
					today={week.today}
					{selected}
					label={week.label}
					onselect={(date) => (chosen = date)}
					data-testid="week-strip"
				/>
				<Section title={day.heading} data-testid="today-day">
					{#snippet action()}
						{#if day.date === week.today}<Badge tone="accent">Today</Badge>{/if}
					{/snippet}
					{#each day.cards as card (card.lineage)}
						{@render cardFor(card, 'session-card')}
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
</style>
