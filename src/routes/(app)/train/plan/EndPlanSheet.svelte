<!--
  @component
  End this plan (Paper, 4 · Train row 8): it asks first. End the plan posts Train's ?/end
  (services/programs/archive.ts): the plan is archived and the owner lands on Today, where Build
  my program starts the next one. A workout in progress is refused and said so here; Keep my plan
  closes the sheet, the focus back on End this plan. A centred dialog from 1024 px.
-->
<script lang="ts">
	import { applyAction, type ActionResult } from '$app/forms';
	import { resolve } from '$app/paths';
	import { post } from '#lib/client/profile-form.ts';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';

	let { open = $bindable() }: { open: boolean } = $props();

	const END = `${resolve('/(app)/train')}?/end`;

	const UNREACHABLE = 'Can’t reach the server. Check your connection, then try again.';
	const IN_PROGRESS =
		'A workout from this plan is in progress. Finish or discard it, then end the plan.';
	const NOT_ENDED = 'That didn’t work. Try again.';

	let pending = $state(false);
	let failure = $state<string | null>(null);

	// Closed and opened again: the question, without the last failure.
	$effect(() => {
		if (!open) failure = null;
	});

	async function end() {
		pending = true;
		failure = null;
		let result: ActionResult;
		try {
			result = await post(END);
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

<BottomSheet bind:open title="End this plan" data-testid="end-plan-confirm">
	<p class="lead">
		Its sessions leave Train and Today. Your logged workouts stay. You can build a new plan right
		after.
	</p>
	<div class="choices">
		{#if failure}<Notice tone="danger" data-testid="end-plan-failure">{failure}</Notice>{/if}
		<Button
			variant="danger"
			size="lg"
			block
			loading={pending}
			onclick={end}
			data-testid="end-plan-confirm-button"
		>
			End the plan
		</Button>
		<Button
			variant="ghost"
			block
			disabled={pending}
			onclick={() => (open = false)}
			data-testid="end-plan-keep"
		>
			Keep my plan
		</Button>
	</div>
</BottomSheet>

<style>
	/* Paper: the sentence, 28 below it the button, 20 below that Keep my plan, centred. */
	.lead {
		font: var(--type-body);
		color: var(--color-text-secondary);
	}

	.choices {
		display: grid;
		gap: var(--space-5);
		margin-top: var(--space-7);
		padding-bottom: var(--space-2);
	}
</style>
