<script lang="ts">
	import { onMount } from 'svelte';
	import { afterNavigate, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { deviceWorkout } from '#lib/client/workout/device-workout.svelte.ts';
	import Badge from '#lib/ui/components/Badge.svelte';
	import Chip from '#lib/ui/components/Chip.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';
	import type { IconName } from '#lib/ui/icons/icons.ts';
	import BaselineCallout from '#lib/ui/program/BaselineCallout.svelte';
	import ExerciseBlock from '#lib/ui/program/ExerciseBlock.svelte';
	import RunSegments from '#lib/ui/program/RunSegments.svelte';
	import SessionDetails from '#lib/ui/program/SessionDetails.svelte';
	import type EditSheetHost from '#lib/ui/program/EditSheetHost.svelte';
	import type { EditKind } from '#lib/ui/program/EditSheetHost.svelte';
	import type { SwapOptions, SwapTarget } from '#lib/ui/program/session-words.ts';
	import { toast } from '#lib/ui/toast.svelte.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const session = $derived(data.state === 'session' ? data : null);

	/** Its status as SessionCard words it; a planned session shows none. */
	const STATUS: Record<string, { tone: 'neutral' | 'positive'; icon: IconName }> = {
		skipped: { tone: 'neutral', icon: 'close' },
		moved: { tone: 'neutral', icon: 'today' },
		completed: { tone: 'positive', icon: 'check' }
	};
	const status = $derived(session && STATUS[session.status]);

	/**
	 * Decision (desk-train-detail): on a desktop window the session details sit in the side column,
	 * except a class's: its metrics (rounds, sparring, focus) are what it asks of the owner, so they
	 * take the main column, where a lift's exercises and a run's steps go.
	 */
	const detailsInMain = $derived(!!session?.details.metrics.length);

	/**
	 * Start workout or Done · View, composed on the server (start-link.ts), or Resume when it is the
	 * workout in progress on this device, as the resume bar's idle probe read it
	 * (device-workout.svelte.ts): resumeLink's rule, written out because importing it would cost
	 * this route a chunk. The screen never opens the database itself.
	 */
	const go = $derived(
		session?.start && deviceWorkout.active?.plannedLineage === session.lineage
			? {
					id: 'resume-workout',
					label: 'Resume',
					href: deviceWorkout.active.href,
					icon: 'play' as const
				}
			: session?.start
	);

	// ---- Back -------------------------------------------------------------------------------

	/**
	 * Decision: opened from Train, Back goes back in history, to the same week, day (Train's
	 * snapshot) and scroll; opened any other way (a link, a reload), it is Train's current week.
	 */
	const TRAIN = resolve('/(app)/train');
	let fromTrain = false;
	afterNavigate(({ from }) => (fromTrain = from?.route.id === '/(app)/train'));

	function back(event: MouseEvent) {
		const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
		if (!fromTrain || modified || event.button !== 0) return;
		event.preventDefault();
		history.back();
	}

	let reloading = $state(false);
	async function reload() {
		reloading = true;
		await invalidateAll();
		reloading = false;
	}

	// ---- Edits ------------------------------------------------------------------------------

	// The edit sheets open in EditSheetHost, code-split with its BottomSheet and fetched on first
	// intent (pointerdown, hover) or on tap, so the screen ships neither; the host fetches the
	// edit's own sheet. A failed fetch is a toast with Retry, which fetches again in place (WebKit
	// fetches anew); failing again online, the screen reloads asking for the sheet (?edit=move),
	// which opens once its code arrives: Chromium keeps a failed module fetch for the document's
	// lifetime (Train's plate calculator does the same). An edit of one exercise names it there.
	const edits = $derived(session?.edits);
	let Host = $state.raw<typeof EditSheetHost>();
	let hosting: Promise<{ default: typeof EditSheetHost }> | undefined;
	let editing = $state(false);
	let retried = false;
	/** The edit the host opens, and the exercise an edit of one (Swap, Adjust) is about. */
	let kind = $state<EditKind>('move');
	let about = $state<string | null>(null);
	/** Each edit's button, by its kind, or its kind and exercise: focus returns to it. */
	const triggers: Record<string, HTMLButtonElement> = $state({});
	const keyOf = (edit: EditKind, lineage: string | null) => (lineage ? `${edit}:${lineage}` : edit);

	/** What Swap offers, once streamed: undefined while it streams, null if it failed. */
	let swaps = $state.raw<SwapOptions | null | undefined>();
	$effect(() => {
		const streamed = session?.swaps;
		swaps = undefined;
		if (!streamed) return;
		let current = true;
		streamed.then((options) => current && (swaps = options));
		return () => (current = false);
	});

	const exerciseTarget = $derived.by((): SwapTarget | undefined => {
		const exercise = session?.exercises.find((e) => e.lineage === about);
		if (!exercise) return undefined;
		// Swap's alternatives, as they stream; Adjust needs none.
		let choices: SwapTarget['choices'] = undefined;
		if (kind === 'swap') choices = swaps ? (swaps[exercise.lineage] ?? null) : swaps;
		return { lineage: exercise.lineage, name: exercise.name, choices };
	});

	function loadHost() {
		if (hosting) return;
		// Never in the server build: SvelteKit would link the sheets' CSS into this page.
		hosting = import.meta.env.SSR
			? Promise.reject(new Error('client only'))
			: import('#lib/ui/program/EditSheetHost.svelte');
		// Kept apart from the import() expression, which Vite would move into its preloader.
		hosting.then((module) => (Host = module.default), unloaded);
	}

	function unloaded() {
		hosting = undefined;
		if (!editing) return; // a prefetch on hover says nothing
		editing = false;
		if (retried && navigator.onLine) {
			return location.replace(about ? `?edit=${kind}&exercise=${about}` : `?edit=${kind}`);
		}
		toast.show('Couldn’t open the editor. Check your connection.', {
			tone: 'danger',
			action: {
				label: 'Retry',
				onclick: () => {
					retried = true;
					edit(kind, about);
				}
			}
		});
	}

	function edit(next: EditKind, lineage: string | null = null) {
		kind = next;
		about = lineage;
		editing = true;
		loadHost();
	}

	/** Move's 'Skip this session', when no day is left: its sheet gives way to Skip's. */
	function skipInstead() {
		editing = false;
		edit('skip');
	}

	onMount(() => {
		const asked = page.url.searchParams.get('edit') as EditKind | null;
		if (edits?.locked !== null || !asked) return;
		const exercise = page.url.searchParams.get('exercise');
		// Only an edit the screen offers: its button is there.
		if (keyOf(asked, exercise) in triggers) edit(asked, exercise);
	});
</script>

<svelte:head>
	<title>{session?.title ?? 'Session'} · Train · Performance Coach</title>
</svelte:head>

<a class="back" href={TRAIN} onclick={back} data-testid="back-to-train">
	<Icon name="chevron-left" size={18} /> Train
</a>

{#if session}
	<PageHeader title={session.title} eyebrow={session.when} />

	<!-- Wide from 1024 px (docs/design-system.md, Responsive layout → Screens): the side column
	     (what it is and what can change) beside the main one (what to do). Below that the columns
	     are no boxes, so the phone's one column reads in the same order. -->
	<div class="stack" data-layout="wide" data-testid="session-detail">
		<div class="meta">
			<Chip tone={session.tone}>{session.discipline}</Chip>
			{#if session.baseline}<Badge icon="target">Baseline</Badge>{/if}
			{#if status}
				<Badge tone={status.tone} icon={status.icon} data-testid="session-status">
					{session.statusWords}
				</Badge>
			{/if}
		</div>

		{#if session.older}
			{@const older = session.older}
			<div class="banner">
				<Notice icon="clock" title="Older version · read-only" data-testid="older-version">
					Version {older.number} of your plan, as it was then.
					{#if older.inCurrent}
						<a
							class="current"
							href={resolve('/(app)/train/session/[key]', { key: session.lineage })}
							data-testid="current-version">See the current version</a
						>
					{:else}
						Your current plan no longer has this session.
					{/if}
				</Notice>
			</div>
		{/if}

		<div class="side" data-testid="session-side">
			{#if go}
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- app paths from start-link.ts and the resume bar -->
				<a class="edit go" class:done={go.icon === 'check'} href={go.href} data-testid={go.id}>
					<Icon name={go.icon} size={20} />
					{go.label}
				</a>
			{/if}

			{#if session.status === 'skipped'}
				<Notice icon="close" title="Skipped" data-testid="session-skipped">
					It’s off your week and stays as it was planned: a skipped session can’t be moved or
					changed. The reason, if you gave one, is kept with the change.
					<a class="current" href={resolve('/(app)/train/history/[[version]]', {})}
						>See why in History</a
					>
				</Notice>
			{:else if edits}
				<div class="edits" role="group" aria-label="Change this session">
					{@render editButton('move', 'today', 'Move', 'move-session')}
					{#if session.adjust && session.adjust.kind !== 'strength'}
						{@render editButton('adjust', 'pencil', 'Adjust', 'adjust-session')}
					{/if}
					{@render editButton('skip', 'close', 'Skip', 'skip-session')}
					{#if edits.locked}<p class="locked" id="edits-locked">{edits.locked}</p>{/if}
				</div>
			{/if}

			{#if !detailsInMain}
				<SessionDetails details={session.details} data-testid="session-facts" />
			{/if}

			{#if session.baseline}
				<BaselineCallout {...session.baseline} data-testid="baseline-callout" />
			{/if}
		</div>

		<div class="main" data-testid="session-main">
			{#if detailsInMain}
				<SessionDetails details={session.details} data-testid="session-facts" />
			{/if}

			{#if session.instructions || session.notes}
				<div class="notes">
					{#if session.instructions}<p>{session.instructions}</p>{/if}
					{#if session.notes}<p>{session.notes}</p>{/if}
				</div>
			{/if}

			{#if session.exercises.length}
				<Section title="Exercises" gap="md" data-testid="exercises">
					{#each session.exercises as exercise (exercise.lineage)}
						<ExerciseBlock {exercise} data-testid="exercise">
							{#snippet action()}
								{#if session.adjust?.kind === 'strength' || session.swaps}
									<div class="exercise-edits">
										{#if session.adjust?.kind === 'strength'}
											{@render editButton(
												'adjust',
												'pencil',
												'Adjust',
												'adjust-exercise',
												exercise
											)}
										{/if}
										{#if session.swaps}
											{@render editButton('swap', 'refresh', 'Swap', 'swap-exercise', exercise)}
										{/if}
									</div>
								{/if}
							{/snippet}
						</ExerciseBlock>
					{/each}
				</Section>
			{/if}

			{#if session.steps.length}
				<Section title="The run" data-testid="run">
					<Surface>
						<RunSegments label={session.title} steps={session.steps} />
					</Surface>
				</Section>
			{/if}
		</div>
	</div>

	<!-- One host per kind, each opening on its own sheet; a sheet's content mounts on each open. -->
	{#if Host}
		{#key kind}
			<Host
				bind:open={editing}
				{kind}
				{session}
				trigger={triggers[keyOf(kind, about)]}
				exercise={exerciseTarget}
				onskip={skipInstead}
			/>
		{/key}
	{/if}

	<!-- An edit's button: a quiet pill, beside an exercise's name a step smaller. -->
	{#snippet editButton(
		next: EditKind,
		icon: IconName,
		label: string,
		testId: string,
		exercise?: { lineage: string; name: string }
	)}
		{@const lineage = exercise?.lineage ?? null}
		<button
			bind:this={triggers[keyOf(next, lineage)]}
			type="button"
			class={['edit', exercise && 'small']}
			disabled={!!edits?.locked}
			aria-label={exercise ? `${label} ${exercise.name}` : undefined}
			aria-busy={editing && !Host && kind === next && about === lineage}
			aria-describedby={edits?.locked ? 'edits-locked' : undefined}
			onpointerdown={loadHost}
			onpointerenter={loadHost}
			onclick={() => edit(next, lineage)}
			data-testid={testId}
		>
			<Icon name={icon} size={exercise ? 18 : 20} />
			{label}
		</button>
	{/snippet}
{:else if data.state === 'error'}
	<PageHeader title="Session" eyebrow="Train" />
	<Surface padding="none" radius="xl">
		<EmptyState
			icon="alert"
			tone="combat"
			title={data.error.title}
			description={data.error.description}
			data-testid="session-error"
		>
			{#snippet actions()}
				<!-- Train's inline Retry (its plate notice), not a Button: the route stays in budget. -->
				<button
					type="button"
					class="retry"
					aria-busy={reloading}
					disabled={reloading}
					onclick={reload}
					data-testid="session-retry"
				>
					<Icon name="refresh" size={18} /> Retry
				</button>
			{/snippet}
		</EmptyState>
	</Surface>
{/if}

<style>
	.back {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		min-height: var(--touch-target);
		margin-top: var(--space-2);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}

	@media (hover: hover) and (pointer: fine) {
		.back:hover {
			color: var(--color-text);
		}
	}

	.stack {
		display: grid;
		gap: var(--space-6);
	}

	/* On a phone or a tablet the columns are no boxes: their parts are the stack's, in order. */
	.side,
	.main {
		display: contents;
	}

	/*
	 * Desktop (wide): the chips span the content; the side column (the edits, the details, the
	 * baseline callout), at least --content-list, sits left of the main column (the exercises, the
	 * run, a class's metrics), at most the readable width. Side first, as in the markup, so Tab and
	 * the eye go the same way. An older version's banner tops the main column.
	 */
	@media (width >= 64rem) {
		.stack {
			grid-template-columns: minmax(var(--content-list), 1fr) minmax(0, var(--content-readable));
			grid-template-areas: 'meta meta' 'side main';
			column-gap: var(--space-8);
			align-items: start;
		}

		.stack:has(> .banner) {
			grid-template-areas: 'meta meta' 'side banner' 'side main';
		}

		.meta {
			grid-area: meta;
		}

		.banner {
			grid-area: banner;
		}

		.side,
		.main {
			display: grid;
			gap: var(--space-6);
			min-width: 0;
		}

		.side {
			grid-area: side;
		}

		.main {
			grid-area: main;
		}
	}

	/* Under the title, the eyebrow and the title already spaced by PageHeader. */
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		margin-top: calc(var(--space-3) * -1);
	}

	.notes {
		display: grid;
		gap: var(--space-2);
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
		color: var(--color-text-secondary);
	}

	/* An accent text action with a 44 × 44 px target, as Train's notices word their Retry. */
	.retry {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1-5);
		min-width: var(--touch-target);
		min-height: var(--touch-target);
		padding: 0 var(--space-3);
		font-size: var(--text-sm);
		font-weight: var(--weight-bold);
		color: var(--color-accent-text);
	}

	.retry:disabled {
		cursor: progress;
		opacity: 0.6;
	}

	@media (hover: hover) and (pointer: fine) {
		.retry:hover:not(:disabled) {
			text-decoration: underline;
			text-underline-offset: 3px;
		}
	}

	/* The edit row: quiet pill actions with a 44 px target, as Button's secondary variant looks,
	   drawn here so the screen ships no Button. */
	.edits {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
	}

	.edit {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		min-height: var(--touch-target);
		padding: 0 var(--space-5) 0 var(--space-4);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-full);
		background: var(--color-surface-2);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		color: var(--color-text);
		transition:
			background-color var(--duration-fast) var(--ease-standard),
			transform var(--duration-fast) var(--ease-out);
	}

	/* Start or Resume: the screen's one primary action, the width of the column. */
	.go {
		justify-content: center;
	}

	.go:not(.done) {
		border-color: transparent;
		background: var(--color-accent);
		color: var(--color-on-accent);
	}

	.edit:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	.edit:active:not(:disabled) {
		transform: scale(0.97);
	}

	.edit:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	/* Its sheet's code on the way: a beat later, so a fast fetch shows nothing. */
	.edit[aria-busy='true'] {
		cursor: progress;
		animation: busy var(--duration-base) var(--ease-standard) 150ms forwards;
	}

	@keyframes busy {
		to {
			opacity: 0.6;
		}
	}

	@media (hover: hover) and (pointer: fine) {
		.edit:hover:not(:disabled) {
			background: var(--color-surface-3);
		}

		.go:not(.done):hover {
			background: var(--color-accent-hover);
		}
	}

	/* Beside an exercise's name: the same quiet pills, a step smaller. */
	.exercise-edits {
		display: flex;
		flex: none;
		gap: var(--space-2);
	}

	.small {
		flex: none;
		gap: var(--space-1-5);
		padding: 0 var(--space-4) 0 var(--space-3);
	}

	.locked {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	/* The notice styles its links (accent, underlined): on a line of its own, a 44 px target. */
	.current {
		display: flex;
		align-items: center;
		min-height: var(--touch-target);
		margin-bottom: calc(var(--space-2) * -1);
		font-weight: var(--weight-semibold);
	}
</style>
