<!--
  @component
  Train's plan overview: the BottomSheet with the BlockTimeline it holds, both code-split out of
  Train's initial JavaScript (Train imports this on first intent). A tap on a planned week closes
  the sheet and hands the week's number to `onweek`, which opens it on Train; a tap that opens a
  new tab or window (a modifier key, a middle click) stays the browser's.

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
	import type { TimelineBlock } from './timeline.ts';

	interface Props {
		open: boolean;
		/** The program's title. */
		title: string;
		blocks: readonly TimelineBlock[];
		weekHref: (week: number) => string;
		onweek: (week: number) => void;
		onclose: () => void;
	}

	let { open = $bindable(), title, blocks, weekHref, onweek, onclose }: Props = $props();

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
		<BlockTimeline {blocks} {weekHref} onweek={go} data-testid="block-timeline" />
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
