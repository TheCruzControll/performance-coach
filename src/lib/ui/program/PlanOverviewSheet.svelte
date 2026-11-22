<!--
  @component
  Train's plan overview: the BottomSheet with the BlockTimeline it holds, both code-split out of
  Train's initial JavaScript (Train imports this on first intent). A tap on a planned week closes
  the sheet and hands the week's number to `onweek`, which opens it on Train; a tap that opens a
  new tab or window (a modifier key, a middle click) stays the browser's.

  The timeline is the season's region, 'Your season' (m7/39: `road`, streamed with Train's data):
  M3's timeline, aria-busy with a polite 'Loading your season' and the room of `openGoals` lanes
  held, until the season arrives; a road that answers null or fails leaves M3's timeline exactly
  (no season passed: no track, lanes or counted rows), with no error shown.

  Under the timeline, End this plan asks first, in the same sheet, then posts Train's ?/end
  (services/programs/archive.ts): the plan is archived and the owner lands on Today, where Build
  my program starts the next one. A workout in progress is refused and said so here.
-->
<script lang="ts">
	import { applyAction, type ActionResult } from '$app/forms';
	import { post } from '#lib/client/profile-form.ts';
	import BottomSheet from '../components/BottomSheet.svelte';
	import Button from '../components/Button.svelte';
	import Notice from '../components/Notice.svelte';
	import BlockTimeline from './BlockTimeline.svelte';
	import type { SeasonView } from './season.ts';
	import type { TimelineBlock } from './timeline.ts';

	interface Props {
		open: boolean;
		/** The program's title. */
		title: string;
		blocks: readonly TimelineBlock[];
		weekHref: (week: number) => string;
		onweek: (week: number) => void;
		onclose: () => void;
		/** The season, on its way: null when there is none or its read failed. */
		road: Promise<SeasonView | null>;
		/** The goals each block's lanes list, held while the season streams. */
		openGoals: number;
	}

	let {
		open = $bindable(),
		title,
		blocks,
		weekHref,
		onweek,
		onclose,
		road,
		openGoals
	}: Props = $props();

	/** The road's answer, beside the promise it answers (a new week's data brings a new one). */
	let arrived = $state<[Promise<SeasonView | null>, SeasonView | null]>();
	$effect(() => {
		const from = road;
		const answer = (season: SeasonView | null) => road === from && (arrived = [from, season]);
		from.then(answer, () => answer(null));
	});
	/** The season; null when there is none; undefined while it streams. */
	const season = $derived(arrived?.[0] === road ? arrived[1] : undefined);

	const UNREACHABLE = 'Can’t reach the server. Check your connection, then try again.';
	const IN_PROGRESS =
		'A workout from this plan is in progress. Finish or discard it, then end the plan.';
	const NOT_ENDED = 'That didn’t work. Try again.';

	/** The plan, or the question before ending it. */
	let ending = $state(false);
	let pending = $state(false);
	let failure = $state<string | null>(null);

	// Closed and opened again: the plan, not the question.
	$effect(() => {
		if (!open) {
			ending = false;
			failure = null;
		}
	});

	function go(event: MouseEvent, week: number) {
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
			return;
		event.preventDefault();
		open = false;
		onweek(week);
	}

	async function end() {
		pending = true;
		failure = null;
		let result: ActionResult;
		try {
			result = await post('?/end');
		} catch {
			failure = UNREACHABLE;
			pending = false;
			return;
		}
		if (result.type === 'failure') {
			failure = result.data?.reason === 'workout_in_progress' ? IN_PROGRESS : NOT_ENDED;
		} else if (result.type === 'redirect') {
			open = false;
			await applyAction(result);
		} else if (result.type === 'error') {
			failure = NOT_ENDED;
		}
		pending = false;
	}
</script>

<BottomSheet
	bind:open
	title={ending ? 'End this plan?' : 'Your plan'}
	description={title}
	{onclose}
	data-testid="plan-sheet"
>
	{#if ending}
		<div class="end" data-testid="end-plan-confirm">
			<p class="lead">
				Its sessions leave Train and Today. Your logged workouts stay in History. You can build a
				new plan right after, from your profile as it is now.
			</p>
			{#if failure}<Notice tone="danger" data-testid="end-plan-failure">{failure}</Notice>{/if}
			<div class="choices">
				<Button
					variant="danger"
					block
					loading={pending}
					onclick={end}
					data-testid="end-plan-confirm-button"
				>
					End plan
				</Button>
				<Button
					variant="ghost"
					block
					disabled={pending}
					onclick={() => (ending = false)}
					data-testid="end-plan-keep"
				>
					Keep my plan
				</Button>
			</div>
		</div>
	{:else}
		<!-- Outside the region: a busy region's changes may go unannounced. -->
		<p class="visually-hidden" role="status">{season === undefined ? 'Loading your season' : ''}</p>
		<section aria-label="Your season" aria-busy={season === undefined}>
			<BlockTimeline
				{blocks}
				{weekHref}
				onweek={go}
				season={season === null ? undefined : (season ?? null)}
				lanes={openGoals}
				data-testid="block-timeline"
			/>
		</section>
		<div class="footer">
			<Button
				variant="ghost"
				block
				icon="refresh"
				onclick={() => (ending = true)}
				data-testid="end-plan"
			>
				End this plan
			</Button>
		</div>
	{/if}
</BottomSheet>

<style>
	.end,
	.choices {
		display: grid;
		gap: var(--space-4);
	}

	.end {
		padding-bottom: var(--space-2);
	}

	.lead {
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
		color: var(--color-text-secondary);
	}

	.footer {
		margin-top: var(--space-5);
		padding-bottom: var(--space-2);
	}
</style>
