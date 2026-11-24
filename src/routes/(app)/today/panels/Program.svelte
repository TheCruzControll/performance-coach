<!--
  @component
  Today once a program exists (Instrument v2, v2/06b; plan.server.ts composes every word): the
  week as seven dots, then, at the column's foot, the day as one statement: its title, when, one
  sentence from the coach and one Start (start-link.ts; Resume when it is the device's workout in
  progress), then one line under it (the next session, or a goal) or the quiet link to log
  something. A tap on a dot shows that day, composed on the server with the rest, with no
  request: its session, Open the session and Back to today. Rest, done, skipped, before week 1,
  between blocks and nothing yet are each a day of their own. A block to review is the day, its
  button the review's create form (as ReviewPrompt's: pending, not ready yet, failed with Try
  again, offline); a week to review is the one line under the day, to Progress → Reviews.
  While the plan shows, Today claims the workout in progress from the resume line
  (resume-state.svelte.ts) and draws it as today's day: Resume on this device, Continue here
  from another (resume.ts continueHereFlow), so the line keeps only changes waiting to sync here.
  The plan is streamed: 'Getting today' at the foot until it arrives, and a failed read is one
  statement with Try again. Once the plan shows and the browser is idle, Today saves the
  kits of the sessions still to do today and in the next two days, so they start in a gym with no
  signal (coming-kits.ts). Code-split behind PanelLoader.
-->
<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { applyAction, enhance, type SubmitFunction } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { deviceWorkout } from '#lib/client/workout/device-workout.svelte.ts';
	import { workoutPath } from '#lib/client/workout/kinds.ts';
	import type { IsoDate } from '#lib/domain/calendar.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import { resumeLink } from '#lib/ui/program/start-link.ts';
	import { continueHereFlow, NOTHING } from '../../resume.ts';
	import { resumeState } from '../../resume-state.svelte.ts';
	import type { PageData } from '../$types';

	type TodayPlanView = Awaited<NonNullable<PageData['plan']>>;
	type Ready = Extract<TodayPlanView, { failed: false }>;
	type Day = Ready['day'];
	type Line = Day['lines'][number];
	type Review = NonNullable<Day['review']>;
	/** The day as drawn: the plan's, or the workout in progress Today claimed (3.7). */
	type Shown = Omit<Day, 'state'> & {
		state: Day['state'] | 'in-progress' | 'remote';
		/** The coach's sentence is the screen's one red line (a failure). */
		danger?: boolean;
		/** Under a claimed workout, the plan's own day's state: its lines keep their styling. */
		planState?: Day['state'];
	};

	interface Props {
		/** Settled when Today was server-rendered; a promise after a client navigation. */
		plan: TodayPlanView | Promise<TodayPlanView>;
	}

	let { plan }: Props = $props();

	/** The day tapped in the week; null shows today. */
	let picked = $state<IsoDate | null>(null);
	// A new plan (a refresh, Try again) shows today again.
	$effect.pre(() => {
		void plan;
		picked = null;
	});

	const pick = (date: IsoDate, today: IsoDate) => (picked = date === today ? null : date);

	// ---- The workout in progress, claimed from the resume line -----------------------------------

	/** Today's path, as the shell passes it to the resume line. */
	const TODAY = resolve('/(app)/today');
	/** The plan shows (not failed): only then does Today claim the workout in progress (D13). */
	let showing = $state(false);
	$effect(() => {
		let live = true;
		void Promise.resolve(plan).then(
			(view) => live && (showing = !view.failed),
			() => {}
		);
		return () => (live = false);
	});
	$effect(() => {
		if (!showing) return;
		resumeState.claimed = TODAY;
		return () => {
			if (resumeState.claimed === TODAY) resumeState.claimed = null;
		};
	});
	/** What the resume line last found: the workout in progress, here or on another device. */
	const found = $derived(resumeState.found);

	/** A start time as the device's clock reads it: '9:12 am'. */
	function clock(at: string): string {
		const time = new Date(at);
		const h = time.getHours();
		return `${h % 12 || 12}:${String(time.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
	}

	/** The workout in progress as today's day, under the plan's own day's lines; null with none. */
	function claimedDay(day: Day): Shown | null {
		const as = {
			...day,
			planState: day.state,
			coach: null,
			lead: null,
			review: null,
			rows: [],
			log: null
		};
		if (found.type === 'active')
			return {
				...as,
				state: 'in-progress',
				title: found.workout.title,
				when: 'In progress on this device',
				coach: 'Every set you log is saved on this device.'
			};
		if (found.type !== 'remote') return null;
		return {
			...as,
			state: 'remote',
			title: found.workout.title,
			when: 'In progress on another device',
			coach: resumeState.failed
				? 'Couldn’t bring it over. Check your connection, then try again.'
				: `Started on another device at ${clock(found.workout.startedAt)}. Every set you logged is here too.`,
			danger: resumeState.failed
		};
	}

	/** Continue here: builds the other device's workout here, then opens its page. */
	async function adopt() {
		if (found.type !== 'remote') return;
		const { id, kind } = found.workout;
		const outcome = await continueHereFlow(id, resolve(workoutPath(kind)), {
			goto,
			flags: resumeState
		});
		// Finished or abandoned meanwhile: the plan's day comes back.
		if (outcome === 'gone') resumeState.found = NOTHING;
	}

	// ---- A block to review: its create form, as ReviewPrompt's ----------------------------------

	/** navigator.onLine and its events, as the review list reads them (ReviewList.svelte). */
	let online = $state(true);
	onMount(() => (online = navigator.onLine));
	let reviewing = $state<'pending' | 'failed' | { ready?: string }>();
	const submit: SubmitFunction = ({ cancel }) => {
		if (reviewing === 'pending' || !online) return cancel();
		reviewing = 'pending';
		return async ({ result }) => {
			if (result.type === 'failure' && result.data?.reason === 'not_reviewable')
				reviewing = { ready: result.data.ready };
			else if (result.type === 'redirect') {
				await applyAction(result);
				reviewing = undefined;
			} else reviewing = 'failed';
		};
	};

	/** A block's end: the coach's sentence says when it cannot be created yet, or here now. */
	function blockEnd(day: Day): Shown {
		if (!online)
			return { ...day, coach: 'You’re offline. Review the block once you’re back online.' };
		if (reviewing === 'failed')
			return {
				...day,
				coach: 'Couldn’t create this review. Your training is safe: try again.',
				danger: true
			};
		if (typeof reviewing === 'object' && day.review) {
			const ready = reviewing.ready ? ` · ${reviewing.ready}` : '';
			return { ...day, coach: `${day.review.notReady}${ready}` };
		}
		return day;
	}

	/**
	 * The day drawn: a day tapped in the week; else the workout in progress Today claimed; else
	 * today's, a done day saying its sets are safe here while they wait to sync (D9).
	 */
	function shown(view: Ready): Shown {
		const other = picked && view.others.find((d) => d.date === picked);
		if (other) return other;
		const claimed = claimedDay(view.day);
		if (claimed) return claimed;
		const { day } = view;
		if (day.state === 'block-end') return blockEnd(day);
		if (day.state === 'done' && found.type === 'waiting')
			return {
				...day,
				coach: 'Everything you logged is safe on this device. It goes up when you’re back online.'
			};
		return day;
	}

	/** Back to today from another day: today's dot takes the focus. */
	async function backToToday() {
		picked = null;
		await tick();
		document.querySelector<HTMLElement>('[data-testid="week-dots"] [aria-current="date"]')?.focus();
	}

	/**
	 * Once the idle pass has run: 'saved' with the coming days' kits on this device (coming-kits.ts),
	 * 'none' with none to save (rest days ahead: nothing created). What the specs wait for.
	 */
	let kits = $state<'saved' | 'none'>();

	/** Once the plan shows and the browser is idle: never on the server, once a plan. */
	$effect(() => {
		let live = true;
		const showing = plan;
		const save = async () => {
			const view = await showing;
			let saved: string[] = [];
			if (!view.failed) {
				const coming = await import('#lib/client/workout/coming-kits.ts');
				saved = await coming.saveComingKits(view.coming, view.today);
			}
			if (live) kits = saved.length ? 'saved' : 'none';
		};
		const go = () => live && void save().catch(() => {});
		if ('requestIdleCallback' in window) requestIdleCallback(go, { timeout: 2000 });
		else setTimeout(go, 800);
		return () => (live = false);
	});

	let retrying = $state(false);
	async function retry() {
		retrying = true;
		await invalidateAll();
		retrying = false;
	}

	/** A line's accessible name: its visible words, with a tick read as 'done'. */
	const lineName = (line: Line) =>
		[line.label, line.title, line.end, line.tick ? 'done' : null].filter(Boolean).join(', ');
</script>

{#snippet dots(view: Ready)}
	<div class="dots" role="group" aria-label="This week" data-testid="week-dots">
		{#each view.dots ?? [] as dot (dot.date)}
			<button
				type="button"
				class="dot-day"
				data-mark={dot.mark}
				data-date={dot.date}
				aria-pressed={dot.date === (picked ?? view.today)}
				aria-current={dot.date === view.today ? 'date' : undefined}
				aria-label={dot.name}
				onclick={() => pick(dot.date, view.today)}
			>
				<span class="letter" aria-hidden="true">{dot.letter}</span>
				<span class="mark" aria-hidden="true"></span>
			</button>
		{/each}
	</div>
{/snippet}

{#snippet lineParts(line: Line)}
	<span class="label">{line.label}</span>
	<span class="name">{line.title}</span>
	{#if line.end}
		<span class="end">{line.end}</span>
	{:else if line.tick}
		<Icon name="check" size={16} class="tick" />
	{/if}
	{#if line.chevron}
		<Icon name="chevron-right" size={14} class="chevron" />
	{/if}
{/snippet}

{#snippet dayLine(line: Line)}
	{@const testId = line.kind === 'done' || line.tick ? 'done-workout' : 'today-line'}
	{#if line.href}
		<!-- eslint-disable svelte/no-navigation-without-resolve -- resolved in plan.server.ts -->
		<a
			class="line"
			href={line.href}
			data-kind={line.kind}
			data-quiet={line.quiet || undefined}
			aria-label={lineName(line)}
			data-testid={testId}>{@render lineParts(line)}</a
		>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
	{:else}
		<div
			class="line"
			data-kind={line.kind}
			data-quiet={line.quiet || undefined}
			data-testid={testId}
		>
			{@render lineParts(line)}
		</div>
	{/if}
{/snippet}

{#snippet reviewForm(review: Review)}
	{#if review.create}
		<form class="go" method="POST" action={review.create.action} use:enhance={submit}>
			{#each Object.entries(review.create.fields) as [name, value] (name)}
				<input type="hidden" {name} {value} />
			{/each}
			<Button
				type="submit"
				size="lg"
				block
				loading={reviewing === 'pending'}
				disabled={!online}
				data-testid="review-block"
				>{reviewing === 'failed' ? 'Try again' : 'Review the block'}</Button
			>
		</form>
	{/if}
{/snippet}

{#snippet action(day: Shown)}
	{#if day.state === 'in-progress' && found.type === 'active'}
		<div class="go">
			<Button
				size="lg"
				block
				href={resolve(workoutPath(found.workout.kind))}
				data-testid="resume-workout">Resume</Button
			>
		</div>
	{:else if day.state === 'remote'}
		<div class="go">
			<Button
				size="lg"
				block
				loading={resumeState.continuing}
				onclick={adopt}
				data-testid="continue-here">{resumeState.failed ? 'Try again' : 'Continue here'}</Button
			>
		</div>
	{:else if day.review}
		{@render reviewForm(day.review)}
	{:else if day.lead}
		{@const link = resumeLink(day.lead.lineage, day.lead.link, deviceWorkout.active)!}
		<div class="go">
			<Button size="lg" block href={link.href} data-testid={link.id}>
				{link.id === 'resume-workout' ? 'Resume' : 'Start'}
			</Button>
		</div>
	{/if}
{/snippet}

{#snippet theDay(day: Shown)}
	<section class="day" data-state={day.state} data-testid="today-day" aria-labelledby="today-title">
		<h2 id="today-title" class="title" data-testid="today-title">{day.title}</h2>
		{#if day.when}<p class="when" data-testid="today-when">{day.when}</p>{/if}
		{#if day.coach}
			<p
				class="coach"
				data-danger={day.danger || undefined}
				role="status"
				data-testid="today-coach"
			>
				{day.coach}
			</p>
		{/if}
		{@render action(day)}
	</section>
	{#if day.lines.length}
		<ul
			class="lines"
			data-many={(day.lines.length > 1 && (day.planState ?? day.state) === 'done') || undefined}
		>
			{#each day.lines as line, i (i)}
				<li data-testid={line.kind === 'done' ? 'today-done' : undefined}>
					{@render dayLine(line)}
				</li>
			{/each}
		</ul>
	{/if}
	{#if day.rows.length}
		<ul class="rows">
			{#each day.rows as row, i (i)}
				<li>
					{#if row.href}
						<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved in plan.server.ts -->
						<a class="row" href={row.href} data-testid={row.testId}>
							<span>{row.title}</span>
							<Icon name="chevron-right" size={14} class="chevron" />
						</a>
					{:else}
						<button
							type="button"
							class="row"
							data-secondary={row.secondary || undefined}
							onclick={backToToday}
							data-testid={row.testId}>{row.title}</button
						>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
	{#if day.log}
		<a class="log" href={resolve('/workout')} data-testid="log-something-else">
			{day.log === 'anyway' ? 'Log something anyway' : 'Log something'}
		</a>
	{/if}
{/snippet}

<svelte:window ononline={() => (online = true)} onoffline={() => (online = false)} />

<div class="plan" data-testid="today-plan" data-kits={kits}>
	{#await plan}
		<p class="getting" aria-busy="true" data-testid="today-loading">Getting today</p>
	{:then view}
		{#if view.failed}
			<section class="statement-wrap" data-testid="today-plan-error" aria-labelledby="today-failed">
				<h2 id="today-failed" class="statement">Couldn’t load today</h2>
				<p class="lead">Your plan is safe. Check your connection and try again.</p>
				<Button
					variant="secondary"
					size="lg"
					block
					loading={retrying}
					onclick={retry}
					data-testid="today-retry">Try again</Button
				>
			</section>
		{:else}
			{#if view.dots}{@render dots(view)}{/if}
			{@render theDay(shown(view))}
		{/if}
	{/await}
</div>

<style>
	.plan {
		display: flex;
		flex-direction: column;
		flex: 1;
	}

	/* Loading: one quiet line where the day will stand, no grey blocks (Paper's 180 px foot). */
	.getting {
		margin-top: auto;
		padding-bottom: calc(var(--space-20) * 2 + var(--space-5));
		font: var(--type-secondary);
		color: var(--color-text-quiet);
	}

	/* The week: seven columns, the first and last days' marks on the gutters (Paper's
	   space-between); each day a 44 px tall button over its letter and its 8 px mark. */
	.dots {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		margin-top: var(--space-9);
	}

	.dot-day {
		display: grid;
		grid-template-columns: 1.5rem;
		justify-content: center;
		justify-items: center;
		align-content: center;
		gap: var(--space-2-5);
		min-height: var(--touch-target);
		padding: 0;
		background: none;
		border: 0;
		color: var(--color-text-tertiary);
		font: var(--type-caption);
		line-height: 1rem;
	}

	.dot-day:first-child {
		justify-content: start;
	}

	.dot-day:last-child {
		justify-content: end;
	}

	.mark {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: var(--radius-full);
	}

	[data-mark='done'] .mark {
		background: var(--color-text-tertiary);
	}

	[data-mark='today'] .mark {
		background: var(--color-accent);
	}

	[data-mark='today-done'] .mark {
		background: var(--color-text);
	}

	[data-mark='planned'] .mark {
		box-shadow: inset 0 0 0 1.5px var(--color-text-disabled);
	}

	[data-mark='skipped'] .mark {
		height: 2px;
		border-radius: 1px;
		background: var(--color-text-disabled);
	}

	[data-mark='rest'] .mark {
		visibility: hidden;
	}

	[data-mark='rest'] {
		color: var(--color-text-quiet);
	}

	.dot-day[aria-current='date'],
	.dot-day[aria-pressed='true']:not([aria-current]) {
		color: var(--color-text);
		font-weight: var(--weight-semibold);
	}

	/* A tapped day: a ring over its own mark (a done day keeps its fill). */
	.dot-day[aria-pressed='true']:not([aria-current]) .mark {
		visibility: visible;
		box-shadow: inset 0 0 0 1.5px var(--color-text);
	}

	/* While another day is tapped, today keeps its dot and its letter goes quiet. */
	.dots:has([aria-pressed='true']:not([aria-current])) [aria-current] {
		color: var(--color-text-tertiary);
		font-weight: var(--weight-regular);
	}

	/* The day stands at the foot, the empty room above it. */
	.day {
		margin-top: auto;
		padding-top: var(--space-7);
		padding-bottom: var(--space-7);
	}

	.title {
		font: var(--type-display);
		letter-spacing: var(--tracking-display-lg);
		color: var(--color-text);
		overflow-wrap: anywhere;
	}

	.when {
		margin-top: var(--space-2);
		font: var(--type-body);
		color: var(--color-text-secondary);
	}

	.coach {
		padding-top: var(--space-7);
		font: var(--type-body);
		color: var(--color-text);
	}

	/* Couldn't bring it over, or couldn't create the review: the one red on Today. */
	.coach[data-danger] {
		color: var(--color-danger);
	}

	/* 28 above Start, with a coach sentence or without. */
	.go {
		margin-top: var(--space-7);
	}

	.lines,
	.rows {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.lines {
		padding-bottom: var(--space-8);
	}

	/* The one line: a 96 px label, the title, its end and a chevron when it opens something. */
	.line {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-height: var(--touch-target);
		color: var(--color-text);
		text-decoration: none;
	}

	.label {
		flex: none;
		width: calc(6rem - var(--space-3));
		font: var(--type-secondary);
		color: var(--color-text-tertiary);
	}

	.name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		font: var(--type-body);
		line-height: 1.5rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.end {
		flex: none;
		font: var(--type-secondary);
		color: var(--color-text-secondary);
	}

	.line :global(.chevron),
	.line :global(.tick),
	.row :global(.chevron) {
		flex: none;
		color: var(--color-text-tertiary);
	}

	.line[data-quiet] .name {
		color: var(--color-text-tertiary);
	}

	/* Every line of a done day: 60 px, a hairline between. */
	.lines[data-many] .line {
		min-height: 3.75rem;
	}

	.lines[data-many] .label {
		line-height: 1.2;
	}

	.lines[data-many] .name {
		font: var(--type-row);
	}

	.lines[data-many] li + li,
	.rows li + li {
		border-top: 1px solid var(--color-hairline);
	}

	.rows {
		padding-bottom: var(--space-3);
	}

	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		width: 100%;
		min-height: 3.75rem;
		padding: 0;
		background: none;
		border: 0;
		font: var(--type-row);
		color: var(--color-text);
		text-align: start;
		text-decoration: none;
	}

	.row[data-secondary] {
		color: var(--color-text-secondary);
	}

	/* Logging off the plan: one quiet link with a 44 px hit area. */
	.log {
		display: inline-flex;
		align-items: center;
		align-self: flex-start;
		min-height: var(--touch-target);
		margin-bottom: var(--space-5);
		font: var(--type-secondary);
		color: var(--color-text-secondary);
		text-decoration: underline 1px var(--color-text-disabled);
		text-underline-offset: 4px;
	}

	@media (hover: hover) and (pointer: fine) {
		.line:is(a):hover .name,
		.row:hover,
		.log:hover {
			color: var(--color-text);
		}
	}

	/* Couldn't load: one statement at the foot, with Try again. */
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

	/* At a desk (Paper, 11 · Desktop): the 72/76 title, a 420 px sentence, a 260 px Start, and
	   the one line as a 60 px row with a hairline above. */
	@media (width >= 64rem) {
		.dots {
			max-width: 20.75rem;
			margin-top: var(--space-7);
		}

		.title {
			font-size: 4.5rem;
			line-height: 4.75rem;
		}

		.when {
			margin-top: var(--space-2-5);
		}

		.coach {
			max-width: 26.25rem;
			padding-bottom: var(--space-9);
		}

		.go {
			margin-top: 0;
			margin-bottom: var(--space-10);
		}

		.day:has(.go) {
			padding-bottom: 0;
		}

		.go :global(.btn) {
			width: 16.25rem;
		}

		.lines {
			padding-bottom: 0;
		}

		.line {
			min-height: 3.75rem;
			border-top: 1px solid var(--color-hairline);
		}

		.lines[data-many] li + li {
			border-top: 0;
		}

		.label {
			line-height: 1.2;
		}

		.name {
			font: var(--type-row);
		}

		.log {
			margin-top: var(--space-3);
		}
	}
</style>
