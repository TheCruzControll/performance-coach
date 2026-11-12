<!--
  @component
  An exercise's history (the brief's exercise history view), in a BottomSheet (a centred dialog
  from 1024 px), code-split and loaded when an exercise name is tapped: in a History workout's
  detail, and on the workout screen; and by exercise id alone (no name, no session on the device)
  from an exercise source in a coach answer.
  - Its best e1RM, labelled estimated, with the set it comes from; its rep PRs; then its last
    performances: each session's sets in the order they were done, newest session first, a page
    at a time (Show older).
  - Offline it asks nothing: it shows the session this device already has (`fallback`: the kit's
    previous session, or the one attached to the workout) and says so, or that it has none. By
    exercise id alone it says the history needs a connection, with Retry.
  - A request that fails, or gets no answer within HISTORY_TIMEOUT_MS, shows its error with Retry.
  Each new `request` opens it afresh; a null one closes it (History's Back). `onclose` is the
  owner closing it.
-->
<script lang="ts">
	import {
		fetchExerciseHistory,
		sessionsOf,
		type ExerciseHistory,
		type HistoryRequest,
		type HistorySet
	} from '#lib/client/workout/exercise-history.ts';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import Skeleton from '#lib/ui/components/Skeleton.svelte';
	import { shortDate } from '#lib/ui/program/words.ts';
	import { untrack } from 'svelte';
	import {
		bestWords,
		dayOf,
		historySetWords,
		offlineWords,
		repMaxWords,
		sheetTitle
	} from './history-words.ts';

	interface Props {
		/** A new object per tap opens it afresh; null closes it. */
		request: HistoryRequest | null;
		onclose?: () => void;
	}

	let { request, onclose }: Props = $props();

	type State = 'loading' | 'ready' | 'offline' | 'failed' | 'not-found';

	let open = $state(false);
	let shown = $state.raw<HistoryRequest | null>(null);
	let status = $state<State>('loading');
	let history = $state.raw<ExerciseHistory | null>(null);
	let sets = $state.raw<HistorySet[]>([]);
	let older = $state<'idle' | 'loading' | 'failed'>('idle');
	/** Each load's own number: an answer for an earlier request or page is dropped. */
	let ask = 0;

	$effect.pre(() => {
		if (!request) {
			open = false;
			return;
		}
		shown = request;
		// The last exercise's history goes: its name would title this one's sheet while it loads.
		history = null;
		open = true;
		untrack(() => void load());
	});

	async function load() {
		const asked = ++ask;
		status = 'loading';
		older = 'idle';
		const found = await fetchExerciseHistory(shown!.exerciseId);
		if (asked !== ask) return;
		if (found.state === 'ready') {
			history = found.history;
			sets = found.history.sets;
		}
		status = found.state;
	}

	async function showOlder() {
		if (!history || history.next === null || older === 'loading') return;
		const asked = ++ask;
		older = 'loading';
		const found = await fetchExerciseHistory(shown!.exerciseId, { before: history.next });
		if (asked !== ask) return;
		if (found.state !== 'ready') return void (older = 'failed');
		history = { ...history, next: found.history.next };
		sets = [...sets, ...found.history.sets];
		older = 'idle';
	}

	const sessions = $derived(sessionsOf(sets));
	const best = $derived(history?.records.bestE1rm && bestWords(history.records.bestE1rm));
	const fallback = $derived(shown?.fallback ?? null);
	const offline = $derived(offlineWords(shown));
</script>

<BottomSheet
	bind:open
	title={sheetTitle(shown, history)}
	description="Last performances"
	{onclose}
	data-testid="exercise-history-sheet"
>
	<div class="body" data-state={status}>
		{#if status === 'loading'}
			<p class="visually-hidden" role="status">Loading history…</p>
			<div class="skeleton" aria-hidden="true" data-testid="exercise-history-loading">
				<Skeleton height="4.5rem" radius="var(--radius-lg)" />
				<Skeleton height="7rem" radius="var(--radius-lg)" />
				<Skeleton height="7rem" radius="var(--radius-lg)" />
			</div>
		{:else if status === 'failed'}
			<EmptyState
				compact
				icon="alert"
				tone="combat"
				title="Couldn’t load this history"
				description="Your sets are safe. Check your connection, then try again."
				data-testid="exercise-history-error"
			>
				{#snippet actions()}
					<Button
						variant="secondary"
						icon="refresh"
						onclick={load}
						data-testid="exercise-history-retry">Try again</Button
					>
				{/snippet}
			</EmptyState>
		{:else if status === 'offline' && fallback}
			<Notice
				tone="neutral"
				icon="wifi-off"
				title="You’re offline"
				data-testid="exercise-history-offline"
			>
				Showing the last session saved on this device.
			</Notice>
			<Section title="Last performances">
				<article class="session" data-testid="history-session">
					<h3>{shortDate(fallback.date)}</h3>
					<ol class="sets">
						{#each fallback.sets as set, i (i)}
							{@render setRow(historySetWords(set, i + 1))}
						{/each}
					</ol>
				</article>
			</Section>
		{:else if status === 'offline'}
			<EmptyState
				compact
				icon="wifi-off"
				tone="neutral"
				title={offline.title}
				description={offline.description}
				data-testid="exercise-history-offline"
			>
				{#snippet actions()}
					<Button
						variant="secondary"
						icon="refresh"
						onclick={load}
						data-testid="exercise-history-retry">Try again</Button
					>
				{/snippet}
			</EmptyState>
		{:else if status === 'not-found' || !history}
			<EmptyState
				compact
				icon="clock"
				tone="neutral"
				title="No history for this exercise"
				description="It is no longer in your exercises."
				data-testid="exercise-history-missing"
			/>
		{:else}
			{#if best}
				<div class="best" data-testid="history-best">
					<p class="figure numeric">{best.value}</p>
					<p class="from">{best.from}</p>
				</div>
			{/if}
			{#if history.records.repMaxes.length}
				<Section title="Rep PRs" data-testid="history-rep-prs">
					<dl class="prs">
						{#each history.records.repMaxes.map((r) => repMaxWords(r)) as pr (pr.label)}
							<div class="pr">
								<dt>{pr.label}</dt>
								<dd><span class="numeric">{pr.value}</span> <span class="date">{pr.date}</span></dd>
							</div>
						{/each}
					</dl>
				</Section>
			{/if}
			<Section title="Last performances">
				{#if sessions.length === 0}
					<p class="none" data-testid="history-none">
						No sets logged yet. They show here after your first session.
					</p>
				{/if}
				{#each sessions as session (session.workoutId)}
					<article class="session" data-testid="history-session">
						<h3>{dayOf(session.at)}</h3>
						<ol class="sets">
							{#each session.sets as set, i (set.id)}
								{@render setRow(historySetWords(set, i + 1))}
							{/each}
						</ol>
					</article>
				{/each}
				<p class="visually-hidden" role="status">
					{older === 'loading' ? 'Loading older sessions…' : ''}
				</p>
				{#if history.next !== null}
					<Button
						variant="secondary"
						icon="clock"
						loading={older === 'loading'}
						onclick={showOlder}
						data-testid="history-older">Show older</Button
					>
				{/if}
				{#if older === 'failed'}
					<Notice
						tone="danger"
						title="Couldn’t load older sessions"
						data-testid="history-older-failed"
					>
						<Button variant="ghost" size="sm" onclick={showOlder}>Try again</Button>
					</Notice>
				{/if}
			</Section>
		{/if}
	</div>
</BottomSheet>

{#snippet setRow(words: ReturnType<typeof historySetWords>)}
	<li class="set" data-testid="history-set">
		<span class="label">{words.label}</span>
		<span class="value numeric">{words.value}</span>
		{#if words.mark}<span class="mark">{words.mark}</span>{/if}
	</li>
{/snippet}

<style>
	.body {
		display: grid;
		gap: var(--space-5);
		min-height: 16rem;
		align-content: start;
	}

	.skeleton {
		display: grid;
		gap: var(--space-3);
	}

	.best {
		display: grid;
		gap: var(--space-1);
		padding: var(--space-4);
		border-radius: var(--radius-lg);
		background: var(--color-surface-2);
	}

	.figure {
		font-family: var(--font-numeric);
		font-size: var(--text-xl);
		font-weight: var(--weight-bold);
		font-variant-numeric: lining-nums tabular-nums;
	}

	.from,
	.date,
	.none,
	.label {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.prs,
	.sets {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.pr {
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
		padding-top: var(--space-2);
		border-top: 1px solid var(--color-hairline);
	}

	.pr dd {
		margin: 0;
		text-align: end;
		font-weight: var(--weight-semibold);
	}

	.session {
		display: grid;
		gap: var(--space-2);
		padding: var(--space-3) var(--space-4) var(--space-4);
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border);
		background: var(--color-surface-1);
	}

	h3 {
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	.set {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		column-gap: var(--space-3);
		padding-top: var(--space-2);
		border-top: 1px solid var(--color-hairline);
	}

	.label {
		min-width: 4.5rem;
	}

	.value {
		font-weight: var(--weight-semibold);
		overflow-wrap: anywhere;
	}

	/* Skipped, extra or missed: in words, on a tinted pill; colour only reinforces them. */
	.mark {
		padding: 0 var(--space-2);
		border-radius: var(--radius-full);
		background: var(--color-surface-2);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
	}
</style>
