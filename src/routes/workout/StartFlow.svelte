<!--
  @component
  Starting a workout from /workout?start=<lineage> or ?new=strength|run|other (start.ts), loaded
  only then, through the Shell's chunk loader (a chunk gone after a deploy shows 'App updated').
  In the Shell's body, at the readable width, centred from 1024 px.
  - Getting your session ready: a skeleton with aria-busy while the kit is fetched (at most 4 s)
    and the workout is written; then the kind's route replaces this URL.
  - A workout already in progress: the conflict sheet (StartConflictSheet.svelte, lazy) offers
    Resume, or Discard and start this one; dismissed, the page offers both again.
  - Signed out (the kit answered 401): Sign in returns to this URL, which starts the workout.
  - Unreachable with no kit saved on this device, or a session no longer in the plan: why, and a
    session of the owner's own instead. Not saved: this browser refused the write.
  Ad-hoc links reload the page (data-sveltekit-reload): the flow reads the query once mounted.
  Every control is a primitive Button: 44 px, with hover and :focus-visible states.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import { preferences } from '#lib/client/preferences.svelte.ts';
	import type { ChunkLoad } from '#lib/client/workout/active.svelte.ts';
	import { workoutPath } from '#lib/client/workout/kinds.ts';
	import type * as Starter from '#lib/client/workout/start.ts';
	import type { InProgress, StartOutcome } from '#lib/client/workout/start.ts';
	import type { WorkoutStore } from '#lib/client/workout/store.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import Skeleton from '#lib/ui/components/Skeleton.svelte';
	import type StartConflictSheetComponent from './StartConflictSheet.svelte';

	let { load }: { load: ChunkLoad } = $props();

	type Shown = { status: 'loading' } | Exclude<StartOutcome, { status: 'started' }>;
	let shown = $state.raw<Shown>({ status: 'loading' });
	let Sheet = $state.raw<typeof StartConflictSheetComponent | null>(null);
	let sheetOpen = $state(false);
	let discarding = $state(false);
	let starter: typeof Starter | null = null;
	let store: WorkoutStore | null = null;

	// Only ever rendered in the browser, once the page has read the query.
	const next = encodeURIComponent(`${location.pathname}${location.search}`);
	const workoutHome = resolve('/workout');

	/** Only when the server never gave this device the owner's training-profile units (start.ts). */
	function deviceUnits() {
		preferences.load();
		return { weight: preferences.units, distance: preferences.distance };
	}

	async function begin() {
		shown = { status: 'loading' };
		starter ??= await load(() => import('#lib/client/workout/start.ts'));
		if (!starter) return;
		const request = starter.startRequestOf(location.search);
		if (!request) return location.replace(workoutHome);
		let outcome: StartOutcome;
		try {
			store ??= await starter.openStartStore();
			outcome =
				'lineage' in request
					? await starter.startPlanned(request.lineage, { store })
					: await starter.startAdHoc(request.kind, deviceUnits(), { store });
		} catch {
			outcome = { status: 'not-saved' };
		}
		if (outcome.status === 'started') return location.replace(outcome.path);
		shown = outcome;
		if (outcome.status === 'conflict') void openSheet();
	}

	async function openSheet() {
		Sheet ??= (await load(() => import('./StartConflictSheet.svelte')))?.default ?? null;
		sheetOpen = true;
	}

	const resume = (active: InProgress) => location.replace(workoutPath(active.kind));

	async function discard(active: InProgress) {
		discarding = true;
		const done = await starter!.discardInProgress(active, { store: store! }).catch(() => false);
		discarding = false;
		sheetOpen = false;
		if (done) await begin();
		else shown = { status: 'not-saved' };
	}

	const reload = () => location.reload();

	onMount(() => void begin());
</script>

{#snippet adhoc()}
	<Button
		variant="secondary"
		icon="plate"
		href={`${workoutHome}?new=strength`}
		data-testid="start-adhoc-strength">Log strength</Button
	>
	<Button
		variant="secondary"
		icon="pulse"
		href={`${workoutHome}?new=run`}
		data-testid="start-adhoc-run">Log a run</Button
	>
	<Button
		variant="secondary"
		icon="flame"
		href={`${workoutHome}?new=other`}
		data-testid="start-adhoc-other">Muay Thai or other</Button
	>
{/snippet}

<div class="start" data-sveltekit-reload data-testid="workout-start" data-status={shown.status}>
	{#if shown.status === 'loading'}
		<div class="loading" role="status" aria-busy="true" data-testid="workout-start-loading">
			<p class="label">Getting your session ready</p>
			<Skeleton height="4.5rem" radius="var(--radius-lg)" />
			<Skeleton height="10rem" radius="var(--radius-lg)" />
			<Skeleton height="10rem" radius="var(--radius-lg)" />
		</div>
	{:else if shown.status === 'conflict'}
		{@const active = shown.active}
		<EmptyState
			icon="timer"
			title="A workout is already in progress"
			description={`${active.title} is still going. Resume it, or discard it to start this one.`}
			data-testid="workout-start-conflict"
		>
			{#snippet actions()}
				<Button iconEnd="arrow-right" onclick={() => resume(active)}>Resume</Button>
				<Button variant="secondary" onclick={openSheet} data-testid="start-conflict-options"
					>Discard and start</Button
				>
			{/snippet}
		</EmptyState>
		{#if Sheet}
			<Sheet
				bind:open={sheetOpen}
				{active}
				busy={discarding}
				onresume={() => resume(active)}
				ondiscard={() => discard(active)}
			/>
		{/if}
	{:else if shown.status === 'signed-out'}
		<EmptyState
			icon="lock"
			tone="neutral"
			title="Sign in to start this workout"
			description="You're signed out on this device. Sign in and the workout starts straight away."
			data-testid="workout-start-signed-out"
		>
			{#snippet actions()}
				<Button icon="passkey" href={`${resolve('/')}?next=${next}`} data-testid="start-sign-in"
					>Sign in</Button
				>
			{/snippet}
		</EmptyState>
	{:else if shown.status === 'unreachable'}
		<EmptyState
			icon="wifi-off"
			tone="neutral"
			title="This session isn't saved on this device"
			description="The app can't reach the server, and this session wasn't saved here before the signal went. Try again once you're back online, or log a session of your own now: it syncs later."
			data-testid="workout-start-offline"
		>
			{#snippet actions()}
				<Button icon="refresh" onclick={reload}>Try again</Button>
				{@render adhoc()}
			{/snippet}
		</EmptyState>
	{:else if shown.status === 'missing'}
		<EmptyState
			icon="info"
			tone="neutral"
			title="This session isn't in your plan any more"
			description="It may have moved or changed since this link was made. Today shows what's planned now, or log a session of your own."
			data-testid="workout-start-missing"
		>
			{#snippet actions()}
				<Button href={resolve('/(app)/today')} iconEnd="arrow-right">Go to Today</Button>
				{@render adhoc()}
			{/snippet}
		</EmptyState>
	{:else}
		<EmptyState
			icon="database"
			tone="neutral"
			title="The workout couldn't be saved on this device"
			description="This browser wouldn't store it. Private browsing or a full device are the usual causes: open the app in a normal window, or free some space, then try again."
			data-testid="workout-start-not-saved"
		>
			{#snippet actions()}
				<Button icon="refresh" onclick={reload}>Try again</Button>
			{/snippet}
		</EmptyState>
	{/if}
</div>

<style>
	.start {
		width: 100%;
		max-width: var(--content-readable);
		margin: 0 auto;
	}

	.loading {
		display: grid;
		gap: var(--space-4);
	}

	.label {
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}
</style>
