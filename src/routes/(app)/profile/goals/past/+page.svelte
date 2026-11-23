<!--
  Profile → Goals → Past goals (Paper, 9 · Profile, "Past goals"): the goals achieved or dropped,
  one row each saying how it ended. A goal opens the same sheet as on Goals, code-split and
  fetched on first intent, so one can be made active again (it goes back to Goals, last) or
  deleted; what the re-plan made of it shows under the list. From 1024 px Profile's list sits
  beside it, Goals open, and Back is hidden.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { applyAction } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { preferences } from '#lib/client/preferences.svelte.ts';
	import { post } from '#lib/client/profile-form.ts';
	import type { Goal } from '#lib/domain/profile/types.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import type { ProfileAnswers } from '#lib/ui/profile/answers.ts';
	import { themeLabel } from '#lib/ui/profile/appearance.ts';
	import { goalDraft, pastWhen, type GoalDraft } from '#lib/ui/profile/goals.ts';
	import type GoalSheet from '#lib/ui/profile/GoalSheet.svelte';
	import ProfileList from '#lib/ui/profile/ProfileList.svelte';
	import ReplanNotice from '#lib/ui/profile/ReplanNotice.svelte';
	import type { ReplanResult } from '#lib/ui/profile/replan-notice.ts';
	import { toast } from '#lib/ui/toast.svelte.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** The past goals as loaded, then as each change in the sheet left them. */
	let goals = $derived(data.goals);

	// Appearance's answer is this device's theme: known once the page has mounted, never on the
	// server, which would say "Dark" to a light device.
	let mounted = $state(false);
	onMount(() => {
		preferences.load();
		mounted = true;
	});

	// The rows' answers stream from the Profile layout's load, as on Profile: the list stays
	// mounted and its values fill in. A newer load (after a save) replaces an older one's.
	let answers = $state<ProfileAnswers | null>(null);
	$effect(() => {
		const sent = data.answers;
		void sent.then((a) => {
			if (data.answers === sent) answers = a;
		});
	});

	// ---- the goal sheet, loaded on first intent, as on Goals -------------------------------------
	let Sheet = $state<typeof GoalSheet | null>(null);
	let loading: Promise<unknown> | null = null;
	let unavailable = $state(false);
	let open = $state(false);
	let draft = $state.raw<GoalDraft | null>(null);

	function preload() {
		loading ??= import('#lib/ui/profile/GoalSheet.svelte').then(
			(module) => (Sheet = module.default),
			() => (unavailable = true)
		);
	}

	function edit(goal: Goal) {
		preload();
		draft = goalDraft(goal);
		open = true;
	}

	/** The priority trigger's answer for the last change (ReplanNotice); null before one. */
	let replan = $state<ReplanResult | null>(null);
	/** Try again runs the trigger again: the notice is busy until it answers. */
	let checking = $state(false);

	function changed(all: Goal[], message: string, next?: ReplanResult) {
		goals = all.filter((g) => g.priority === null);
		if (next) replan = next;
		open = false;
		toast.show(message, { tone: 'positive' });
		void invalidate('app:profile-answers');
	}

	/** Try again: the trigger runs again for the goals as they stand; a failure stays failed. */
	async function retry() {
		checking = true;
		const result = await post('?/replan').catch(() => null);
		checking = false;
		if (result?.type === 'success' && result.data?.replan) {
			replan = result.data.replan as ReplanResult;
		} else if (result?.type === 'redirect') {
			await applyAction(result); // the session ended: sign in again
		} else {
			replan = { state: 'failed' };
		}
	}
</script>

<svelte:head>
	<title>Past goals · Performance Coach</title>
</svelte:head>

<!-- Split from 1024 px, as a section is: Profile's whole list beside this screen, behind a
     hairline (layout.css). Below that the list is hidden, and Goals is one step back. -->
<div class="split" data-layout="split" data-measure="profile">
	<nav class="sections" aria-label="Profile">
		<ProfileList
			{answers}
			theme={mounted ? themeLabel(preferences.theme) : undefined}
			current="goals"
		/>
	</nav>

	<div class="column">
		<a
			class="back-link"
			href={resolve('/(app)/profile/[section]', { section: 'goals' })}
			data-testid="back-to-goals"
		>
			<Icon name="chevron-left" size={16} /> Goals
		</a>
		<PageHeader title="Past goals" />

		<div class="past">
			<div class="rows">
				{#each goals as goal (goal.id)}
					<ListRow
						title={goal.title}
						value={pastWhen(goal)}
						onpointerdown={preload}
						onclick={() => edit(goal)}
						data-testid="past-goal-row"
					/>
				{:else}
					<p class="none">No past goals.</p>
				{/each}
			</div>

			<ReplanNotice {replan} {checking} onretry={retry} />

			{#if unavailable}
				<div class="unavailable">
					<Notice tone="danger" title="Goals can’t be edited right now" data-testid="goals-error">
						Check your connection, then try again.
					</Notice>
					<!-- A reload: the browser keeps a failed module fetch for the life of the page. -->
					<Button variant="secondary" icon="refresh" onclick={() => location.reload()}
						>Try again</Button
					>
				</div>
			{/if}
		</div>

		{#if Sheet && draft}
			<!-- One sheet per draft: a keyed block of one mounts it afresh for each goal opened. -->
			{#each [draft] as current (current)}
				<Sheet
					bind:open
					draft={current}
					manage
					onsaved={(all, next) => changed(all, 'Goal saved', next)}
					ondeleted={(all, next) => changed(all, 'Goal deleted', next)}
				/>
			{/each}
		{/if}
	</div>
</div>

<style>
	.past,
	.unavailable {
		display: grid;
		gap: var(--space-4);
	}

	.rows {
		display: grid;
	}

	.none {
		font: var(--type-body);
		color: var(--color-text-secondary);
	}

	.unavailable {
		justify-items: start;
		gap: var(--space-3);
	}

	.sections {
		display: none;
	}

	@media (width >= 64rem) {
		.sections {
			display: block;
			/* Level with the open screen's top (Paper, 14: the detail column pads 48 px). */
			padding-top: var(--space-12);
		}

		/* The list says where you are, and the rail is the way out. */
		.back-link {
			display: none;
		}
	}
</style>
