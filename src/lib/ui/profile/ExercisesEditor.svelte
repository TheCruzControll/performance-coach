<!--
  @component
  Profile → Exercises (Paper, 9 · "Exercises", "Add an exercise"): two plain lists, the ones the
  owner enjoys, which the coach picks when there is a choice, and the ones they’d rather swap
  out, which it replaces with one that does the same job; each exercise a row with a remove ×.
  "Add one…" under each list opens a search of the exercise library (ExerciseSearch, a
  sub-screen), which keeps the owner's own words too; what is stored is the name, as words. A
  dislike is a preference, not an injury: pain goes under Injuries. Saved with the section's Save.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import Button from '../components/Button.svelte';
	import IconButton from '../components/IconButton.svelte';
	import ListRow from '../components/ListRow.svelte';
	import type { EditorProps } from './editors';
	import ExerciseSearch from './ExerciseSearch.svelte';
	import { listErrors, type ExercisesDraft } from './exercise-preferences';
	import { useSubScreens } from './subscreens.svelte.ts';

	let { value = $bindable(), errors = {} }: EditorProps<ExercisesDraft> = $props();

	const id = $props.id();
	// The schema takes up to 60 exercises in all: 30 a list keeps any mix within that.
	const MAX = 30;
	const SCREEN = 'add:';

	const LISTS = [
		{
			key: 'likes',
			label: 'You like',
			add: 'Add one you like',
			question: 'What do you like doing?'
		},
		{
			key: 'dislikes',
			label: 'You’d rather swap out',
			add: 'Add one to swap out',
			question: 'What would you rather swap out?'
		}
	] as const;
	type List = (typeof LISTS)[number];

	/** The host's sub-screens: none where an editor is rendered alone (a test). */
	const subs = useSubScreens();
	/** The list whose search is open, if one is. */
	const adding = $derived(LISTS.find((l) => subs?.top?.id === SCREEN + l.key));
	const shown = $derived(listErrors(errors, value.likes.length));

	let root = $state<HTMLElement>();
	let announcement = $state('');
	let timer: ReturnType<typeof setTimeout> | undefined;

	/** Clear, then set: a live region speaks only when its text changes, even to the same words. */
	function announce(text: string) {
		announcement = '';
		clearTimeout(timer);
		timer = setTimeout(() => (announcement = text), 100);
	}

	const addLink = (list: List) => () =>
		document.querySelector<HTMLElement>(`[data-testid="add-${list.key}"]`);

	function search(list: List) {
		subs?.open({ id: SCREEN + list.key, title: list.question, back: 'Exercises', statement: true });
	}

	/** The picked name joins the list, once in any case; the search closes on its Add link. */
	function pick(list: List, name: string) {
		const names = value[list.key];
		const held = names.some((n) => n.toLowerCase() === name.toLowerCase());
		if (held) announce(`${name} is already there`);
		else if (names.length < MAX) {
			names.push(name);
			announce(`Added ${name}`);
		}
		subs?.close(addLink(list));
	}

	/** The row goes: the focus to the next one's remove, the one before, or the list's Add. */
	async function remove(list: List, name: string) {
		const names = value[list.key];
		const i = names.indexOf(name);
		names.splice(i, 1);
		announce(`Removed ${name}`);
		await tick();
		const removes =
			root?.querySelectorAll<HTMLElement>(`[data-testid="${list.key}"] .remove button`) ?? [];
		(removes[i] ?? removes[i - 1] ?? addLink(list)())?.focus();
	}

	// A refused save says why under the list, which this low on the screen can sit behind the Save
	// bar: bring the list holding the message to the top.
	$effect(() => {
		if (!Object.keys(errors).length) return;
		root?.querySelector('[role="alert"]')?.closest('.group')?.scrollIntoView();
	});
</script>

<div class="exercises" bind:this={root}>
	{#if adding}
		{#key adding.key}
			<ExerciseSearch
				taken={[...value.likes, ...value.dislikes]}
				onpick={(name) => pick(adding, name)}
			/>
		{/key}
	{:else}
		{#each LISTS as list (list.key)}
			{@const names = value[list.key]}
			<section class="group" aria-labelledby="{id}-{list.key}" data-testid={list.key}>
				<h2 class="label" id="{id}-{list.key}">{list.label}</h2>
				{#if names.length}
					<ul class="rows" aria-labelledby="{id}-{list.key}">
						{#each names as name (name)}
							<li>
								<ListRow title={name} static>
									{#snippet trailing()}
										<span class="remove">
											<IconButton
												icon="close"
												size="sm"
												variant="ghost"
												label="Remove {name}"
												onclick={() => remove(list, name)}
											/>
										</span>
									{/snippet}
								</ListRow>
							</li>
						{/each}
					</ul>
				{/if}
				<div class="more">
					<Button
						variant="link"
						disabled={names.length >= MAX}
						onclick={() => search(list)}
						data-opens={SCREEN + list.key}
						data-testid="add-{list.key}">{list.add}</Button
					>
					{#if names.length >= MAX}<p class="note">That’s the most a list holds.</p>{/if}
				</div>
				{#if list.key === 'dislikes'}
					<p class="note">
						Swapped for one that does the same job. Pain or an injury goes under Injuries.
					</p>
				{/if}
				{#if shown[list.key]}<p class="error" role="alert">{shown[list.key]}</p>{/if}
			</section>
		{/each}
	{/if}

	<p class="visually-hidden" role="status">{announcement}</p>
</div>

<style>
	.exercises,
	.group {
		display: grid;
	}

	/* 36 px between the two lists (Paper). */
	.group + .group {
		margin-top: var(--space-9);
	}

	.group {
		scroll-margin-top: calc(var(--safe-top) + var(--space-4));
	}

	.label {
		font: var(--type-secondary);
		color: var(--color-text-tertiary);
	}

	.rows {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.remove {
		display: grid;
		flex: none;
	}

	/* A text link as wide as its words, 8 px under the last row (Paper). */
	.more {
		display: grid;
		justify-items: start;
		padding-top: var(--space-2);
	}

	.note {
		font: var(--type-caption);
		color: var(--color-text-tertiary);
	}

	/* An error about the whole list: one red line under it. */
	.error {
		padding-top: var(--space-2);
		font: var(--type-caption);
		color: var(--color-danger);
	}
</style>
