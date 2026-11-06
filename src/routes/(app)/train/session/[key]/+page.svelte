<script lang="ts">
	import { afterNavigate, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
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
</script>

<svelte:head>
	<title>{session?.title ?? 'Session'} · Train · Performance Coach</title>
</svelte:head>

<a class="back" href={TRAIN} onclick={back} data-testid="back-to-train">
	<Icon name="chevron-left" size={18} /> Train
</a>

{#if session}
	<PageHeader title={session.title} eyebrow={session.when} />

	<div class="stack" data-testid="session-detail">
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
		{/if}

		<SessionDetails details={session.details} data-testid="session-facts" />

		{#if session.baseline}
			<BaselineCallout {...session.baseline} data-testid="baseline-callout" />
		{/if}

		{#if session.instructions || session.notes}
			<div class="notes">
				{#if session.instructions}<p>{session.instructions}</p>{/if}
				{#if session.notes}<p>{session.notes}</p>{/if}
			</div>
		{/if}

		{#if session.exercises.length}
			<Section title="Exercises" gap="md" data-testid="exercises">
				{#each session.exercises as exercise, i (i)}
					<ExerciseBlock {exercise} data-testid="exercise" />
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

	/* The notice styles its links (accent, underlined): on a line of its own, a 44 px target. */
	.current {
		display: flex;
		align-items: center;
		min-height: var(--touch-target);
		margin-bottom: calc(var(--space-2) * -1);
		font-weight: var(--weight-semibold);
	}
</style>
