<!--
  @component
  Build my program, in Today's place: the program the generator makes from the owner's profile,
  before anything is saved, then Start week 1, which stores it as version 1 and opens Train.
  - The preview: the block timeline, week 1's sessions on their days, what week 1 is for, and
    every decision grouped (purpose, what we assumed, placement, conflicts, left out, loads), each
    'why' a disclosure. 'Next Monday' or 'This week' previews again with week 1's new dates.
  - The device's time zone goes with both requests, read from Intl as each is sent, so the
    preview and the build agree on today (forms/build.ts).
  - Designed states: a skeleton (aria-busy) holding the room while the preview loads; a failed
    generation and offline, each with Retry; and when the build no longer matches the preview
    ('Your profile changed', 'The exercise library was updated', 'It’s a new day') a notice over
    the preview made again. Start is busy and disabled while it is sent.
  Its words are composed here, in this chunk, never in Today's initial JS (words.ts, timeline.ts).
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { applyAction, deserialize, type ActionResult } from '$app/forms';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { IsoDate } from '#lib/domain/calendar.ts';
	import type { PreviewResult } from '#lib/server/forms/build.ts';
	import BaselineCallout from '#lib/ui/program/BaselineCallout.svelte';
	import BlockTimeline from '#lib/ui/program/BlockTimeline.svelte';
	import SessionCard from '#lib/ui/program/SessionCard.svelte';
	import WeekStrip from '#lib/ui/program/WeekStrip.svelte';
	import { timelineView } from '#lib/ui/program/timeline.ts';
	import { cardView, longDate, shortDate, stripDay } from '#lib/ui/program/words.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import ChoiceGroup from '#lib/ui/components/ChoiceGroup.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import IconButton from '#lib/ui/components/IconButton.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import Skeleton from '#lib/ui/components/Skeleton.svelte';
	import { toast } from '#lib/ui/toast.svelte.ts';

	interface Props {
		/** Close it: Today comes back with the Build card. */
		onclose?: () => void;
	}

	let { onclose }: Props = $props();

	type ProgramStart = PreviewResult['start'];

	const START_LABEL: Record<ProgramStart, string> = {
		next_monday: 'Next Monday',
		this_week: 'This week'
	};

	/** The rationale's headings, in the order the preview lists them. */
	const GROUPS = [
		['purpose', 'Purpose'],
		['assumptions', 'What we assumed'],
		['placement', 'Placement'],
		['conflicts', 'Conflicts'],
		['exclusions', 'Left out'],
		['loads', 'Loads']
	] as const;

	/** What week 1 asks of a baseline week, under its purpose. */
	const BASELINE_POINTS = [
		'Each main lift works up to a target effort (RPE), never to failure.',
		'Log the weight, reps and RPE of every set: from week 2, loads are worked out from them.',
		'Runs and classes go at the effort shown.'
	];

	/** The reasons a build is refused with (409), each with its own notice. */
	const CONFLICTS = ['profile', 'library', 'start_date', 'program_exists'] as const;
	type Notified = (typeof CONFLICTS)[number] | 'failed' | 'offline';

	/** What the notice over the preview says, by why Start did not go through. */
	const NOTICES: Record<Notified, { title: string; body: string; tone: 'warning' | 'danger' }> = {
		profile: {
			title: 'Your profile changed',
			body: 'Week 1 is planned again from your latest profile. Check it, then start.',
			tone: 'warning'
		},
		library: {
			title: 'The exercise library was updated',
			body: 'Week 1 is planned again with the latest exercises. Check it, then start.',
			tone: 'warning'
		},
		start_date: {
			title: 'It’s a new day',
			body: 'Week 1’s dates now count from today. Check them, then start.',
			tone: 'warning'
		},
		program_exists: {
			title: 'You already have a program',
			body: 'It was started from another screen. Open Train to see it.',
			tone: 'warning'
		},
		failed: {
			title: 'Couldn’t start your program',
			body: 'Nothing was saved. Try again in a moment.',
			tone: 'danger'
		},
		offline: {
			title: 'You’re offline',
			body: 'Nothing was saved. Check your connection, then try again.',
			tone: 'danger'
		}
	};

	let phase = $state<'loading' | 'ready' | 'failed' | 'offline'>('loading');
	let result = $state.raw<PreviewResult | null>(null);
	let start = $state<ProgramStart | null>(null);
	let notice = $state<Notified | null>(null);
	let starting = $state(false);
	let heading = $state<HTMLElement>();

	/** The device's IANA time zone, read as each request is sent. */
	const deviceZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

	/**
	 * POST `payload` to one of Today's actions: 'offline' when the request got no answer, 'failed'
	 * when the answer is not an action's (a proxy's error page, say).
	 */
	async function send(
		action: string,
		payload: unknown
	): Promise<ActionResult | 'offline' | 'failed'> {
		const body = new FormData();
		body.set('payload', JSON.stringify(payload));
		let response: Response;
		try {
			response = await fetch(action, {
				method: 'POST',
				body,
				headers: { accept: 'application/json', 'x-sveltekit-action': 'true' }
			});
		} catch {
			return 'offline';
		}
		try {
			return deserialize(await response.text());
		} catch {
			return 'failed';
		}
	}

	/** The latest preview asked for: an earlier one that answers late is dropped. */
	let asked = 0;

	/** Preview week 1 for `start` (the default start the first time). */
	async function preview() {
		const mine = ++asked;
		phase = 'loading';
		const outcome = await send('?/preview', { timeZone: deviceZone(), start: start ?? undefined });
		if (mine !== asked) return;
		if (outcome === 'offline' || outcome === 'failed') phase = outcome;
		else if (outcome.type === 'success') {
			result = outcome.data as unknown as PreviewResult;
			start = result.start;
			phase = 'ready';
		} else if (outcome.type === 'redirect') await applyAction(outcome);
		else phase = 'failed';
	}

	/** Start week 1: store the previewed program, then open Train. */
	async function startWeek() {
		if (!result || !start || starting) return;
		starting = true;
		notice = null;
		const { startsOn, firstPlannedDay, fingerprint, digest } = result.preview;
		const outcome = await send('?/build', {
			timeZone: deviceZone(),
			start,
			startsOn,
			firstPlannedDay,
			fingerprint,
			digest
		});
		if (typeof outcome === 'object' && outcome.type === 'success') {
			toast.show('Your program is ready. Week 1 is on Train.', { tone: 'positive' });
			await goto(resolve('/(app)/train'));
			return;
		}
		starting = false;
		if (outcome === 'offline' || outcome === 'failed') notice = outcome;
		else if (outcome.type === 'redirect') await applyAction(outcome);
		else {
			const reason = outcome.type === 'failure' ? outcome.data?.reason : undefined;
			notice = CONFLICTS.find((c) => c === reason) ?? 'failed';
			// The build no longer matches what was shown: show what it would build now.
			if (notice !== 'failed' && notice !== 'program_exists') await preview();
		}
	}

	onMount(() => {
		heading?.focus();
		preview();
	});

	const view = $derived.by(() => {
		if (!result) return null;
		const { today, preview: p } = result;
		const within = (date: IsoDate) => p.week.startsOn <= date && date <= p.week.endsOn;
		const purpose = p.decisions.purpose.find((d) => d.kind === 'program_purpose');
		return {
			lead: `${p.summary.title} · ${p.summary.plannedWeeks} weeks planned · from ${shortDate(p.firstPlannedDay)}`,
			timeline: timelineView(
				{ startsOn: p.startsOn, blocks: p.summary.blocks },
				{ today, goals: [] }
			),
			stripToday: within(today) ? today : null,
			strip: p.week.days.map((day) =>
				stripDay(
					{ ...day, sessions: day.sessions.map((s) => ({ type: s.type, status: 'planned' })) },
					within(today) ? today : null
				)
			),
			days: p.week.days.map((day) => ({
				date: day.date,
				heading: longDate(day.date),
				before: day.date < p.firstPlannedDay,
				cards: day.sessions.map((s) => ({
					...cardView({ ...s, status: 'planned', movedFrom: null }),
					baseline: p.week.kind === 'baseline' && s.kind === 'strength'
				}))
			})),
			purpose: {
				title: purpose?.summary ?? 'Week 1 starts your program',
				lead: purpose?.why ?? 'It sets the starting point every later week builds on.',
				points: p.week.kind === 'baseline' ? BASELINE_POINTS : []
			},
			groups: GROUPS.map(([key, title]) => ({
				key,
				title,
				items: p.decisions[key].filter((d) => d !== purpose)
			})).filter((g) => g.items.length > 0),
			starts: (Object.keys(result.starts) as ProgramStart[]).map((value) => ({
				value,
				label: START_LABEL[value],
				hint:
					value === 'this_week'
						? `From today, ${shortDate(result!.starts[value]!.firstPlannedDay)}`
						: shortDate(result!.starts[value]!.firstPlannedDay)
			}))
		};
	});
</script>

<section
	class="preview"
	aria-labelledby="build-preview-title"
	data-testid="build-preview"
	data-first-planned-day={result?.preview.firstPlannedDay}
>
	<header class="head">
		<h2 id="build-preview-title" class="title" tabindex="-1" bind:this={heading}>
			Build my program
		</h2>
		<IconButton icon="close" label="Close" onclick={() => onclose?.()} data-testid="build-close" />
	</header>

	{#if notice}
		<Notice tone={NOTICES[notice].tone} title={NOTICES[notice].title} data-testid="build-notice">
			<span class="notice-body">
				{NOTICES[notice].body}
				{#if notice === 'failed' || notice === 'offline'}
					<Button variant="secondary" size="sm" icon="refresh" onclick={startWeek}>Retry</Button>
				{/if}
			</span>
		</Notice>
	{/if}

	{#if view && view.starts.length > 1}
		<ChoiceGroup
			legend="When to start"
			variant="card"
			options={view.starts}
			bind:value={start}
			onchange={preview}
			data-testid="build-start-choice"
		/>
	{/if}

	{#if phase === 'loading'}
		<div class="body" aria-busy="true" data-testid="build-preview-pending">
			<span class="visually-hidden" role="status">Planning week 1…</span>
			<Skeleton height="1.25rem" width="70%" />
			<Skeleton height="8rem" radius="var(--radius-lg)" />
			<Skeleton height="4rem" radius="var(--radius-lg)" />
			<Skeleton height="4.5rem" radius="var(--radius-lg)" />
			<Skeleton height="4.5rem" radius="var(--radius-lg)" />
			<Skeleton height="10rem" radius="var(--radius-lg)" />
		</div>
	{:else if phase === 'failed' || phase === 'offline'}
		<div class="body" data-testid="build-preview-error">
			<EmptyState
				compact
				icon={phase === 'offline' ? 'wifi-off' : 'alert'}
				tone="combat"
				title={phase === 'offline' ? 'You’re offline' : 'Couldn’t plan week 1'}
				description={phase === 'offline'
					? 'Planning needs a connection. Nothing was saved.'
					: 'Something went wrong while planning. Nothing was saved.'}
			>
				{#snippet actions()}
					<Button variant="secondary" icon="refresh" onclick={preview}>Retry</Button>
				{/snippet}
			</EmptyState>
		</div>
	{:else if view && result}
		<div class="body" data-testid="build-preview-ready">
			<p class="lead" data-testid="build-preview-lead">{view.lead}</p>

			<Section title="Your plan">
				<BlockTimeline blocks={view.timeline} data-testid="build-timeline" />
			</Section>

			<Section title="Week 1">
				<WeekStrip
					days={view.strip}
					today={view.stripToday}
					label="Week 1"
					onselect={(date) =>
						document.getElementById(`build-day-${date}`)?.scrollIntoView({ block: 'start' })}
				/>
				<ol class="days">
					{#each view.days as day (day.date)}
						<li id="build-day-{day.date}" class="day" data-testid="build-day">
							<h3 class="day-heading">{day.heading}</h3>
							{#each day.cards as card, i (i)}
								<SessionCard session={card} baseline={card.baseline} data-testid="build-session" />
							{:else}
								<p class="rest">{day.before ? 'Before your start' : 'Rest day'}</p>
							{/each}
						</li>
					{/each}
				</ol>
			</Section>

			<BaselineCallout
				eyebrow="What week 1 is for"
				title={view.purpose.title}
				lead={view.purpose.lead}
				points={view.purpose.points}
				data-testid="build-week-purpose"
			/>

			<Section title="Why this plan">
				{#each view.groups as group (group.key)}
					<div class="group" data-testid="build-rationale-{group.key}">
						<h3 class="group-title">{group.title}</h3>
						<ul class="items">
							{#each group.items as item, i (i)}
								<li data-testid="build-rationale-item">
									<details class="item">
										<summary>{item.summary}</summary>
										<p class="why">{item.why}</p>
									</details>
								</li>
							{/each}
						</ul>
					</div>
				{/each}
			</Section>
		</div>
	{/if}

	{#if phase === 'ready' || notice === 'program_exists'}
		<div class="start">
			{#if notice === 'program_exists'}
				<Button href={resolve('/(app)/train')} block iconEnd="arrow-right">Open Train</Button>
			{:else}
				<Button block loading={starting} onclick={startWeek} data-testid="build-start">
					Start week 1
				</Button>
			{/if}
		</div>
	{/if}
</section>

<style>
	.preview {
		display: grid;
		gap: var(--space-5);
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.title {
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-display);
		line-height: var(--leading-tight);
	}

	.title:focus {
		outline: none;
	}

	.body {
		display: grid;
		gap: var(--space-6);
	}

	.body[aria-busy='true'] {
		gap: var(--space-4);
		min-height: 36rem;
		align-content: start;
	}

	.lead {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.days,
	.items {
		display: grid;
		gap: var(--space-4);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.days {
		margin-top: var(--space-2);
	}

	.day {
		display: grid;
		gap: var(--space-2);
		scroll-margin-top: var(--space-4);
	}

	.day-heading,
	.group-title {
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		color: var(--color-text-secondary);
	}

	.rest {
		font-size: var(--text-sm);
		color: var(--color-text-tertiary);
	}

	.group {
		display: grid;
		gap: var(--space-2);
	}

	.items {
		gap: var(--space-1);
	}

	.item {
		border-radius: var(--radius-md);
		background: var(--color-surface-1);
		border: 1px solid var(--color-border);
	}

	.item summary {
		display: flex;
		align-items: center;
		min-height: 2.75rem;
		padding: var(--space-2) var(--space-3);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		cursor: pointer;
		border-radius: inherit;
	}

	.item summary:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	@media (hover: hover) and (pointer: fine) {
		.item:hover {
			border-color: var(--color-border-strong);
		}
	}

	.why {
		padding: 0 var(--space-3) var(--space-3);
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.notice-body {
		display: grid;
		justify-items: start;
		gap: var(--space-2);
	}

	/* Column chrome: Start sits at the foot of the preview, above the bar or the window's edge. */
	.start {
		position: sticky;
		bottom: var(--nav-inset-bottom);
		z-index: var(--z-sticky);
		padding: var(--space-6) 0 var(--space-3);
		background: linear-gradient(to bottom, transparent, var(--color-canvas) var(--space-6));
	}
</style>
