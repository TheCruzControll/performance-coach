<!--
  @component
  Add exercise (PRD §7): a searchable picker over the exercise library this device caches
  (library.ts), in a BottomSheet (a centred dialog from 1024 px), code-split and loaded on the
  first intent of an Add exercise button. Each tap opens it afresh.
  - It lists the cached copy at once, and revalidates it when online: a new library replaces the
    list. With nothing cached, a skeleton (aria-busy) while the server is asked.
  - The search matches names and aliases ('RDL'), best first; focus starts in it. ArrowDown moves
    to the results, the arrows, Home and End move along them, ArrowUp from the first returns to
    the search; Enter in the search adds the first result, Enter or a tap on a result adds that.
  - Picking one adds it after the session's last exercise and makes it current, on this device
    only until its first set is logged.
  - No library on this device and offline: 'Your exercise list isn't on this device yet', with
    Try again. Online with no answer: the list couldn't load, with Try again.
  Every control is 44 px or more, with hover and :focus-visible states.
-->
<script lang="ts">
	import {
		addExercise,
		refreshLibrary,
		searchLibrary,
		type Library
	} from '#lib/client/workout/library.ts';
	import type { WorkoutStore } from '#lib/client/workout/store.ts';
	import { needsLine } from '#lib/domain/workout/copy.ts';
	import type { WorkoutView } from '#lib/domain/workout/index.ts';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import Skeleton from '#lib/ui/components/Skeleton.svelte';
	import TextField from '#lib/ui/components/TextField.svelte';
	import { tick, untrack } from 'svelte';

	interface Props {
		view: WorkoutView;
		/** A new object per tap: each opens the picker afresh. */
		request: object;
		store: WorkoutStore;
	}

	let { view, request, store }: Props = $props();

	type Shown =
		| { status: 'loading' }
		| { status: 'ready'; library: Library }
		/** Nothing cached here: offline ('missing'), or the server did not answer ('failed'). */
		| { status: 'missing' | 'failed' };

	let open = $state(false);
	let shown = $state.raw<Shown>({ status: 'loading' });
	let query = $state('');
	let search = $state<HTMLInputElement>();
	let list = $state<HTMLUListElement>();
	/** Each load's number: an earlier one that answers late changes nothing. Declared before the
	   effect below, which runs load() as the component starts. */
	let loads = 0;

	$effect.pre(() => {
		void request;
		query = '';
		open = true;
		untrack(() => void load());
	});

	/** The cached list at once, then the server's when it answers. */
	async function load() {
		const mine = ++loads;
		const cached = await store.getLibrary().catch(() => null);
		if (mine !== loads) return;
		shown = cached ? { status: 'ready', library: cached } : { status: 'loading' };
		if (cached) void focusSearch();
		const library = await refreshLibrary(store).catch(() => cached);
		if (mine !== loads) return;
		if (library) {
			const first = shown.status !== 'ready';
			shown = { status: 'ready', library };
			if (first) void focusSearch();
		} else {
			shown = { status: navigator.onLine ? 'failed' : 'missing' };
		}
	}

	async function focusSearch() {
		await tick();
		search?.focus();
	}

	const found = $derived(
		shown.status === 'ready' ? searchLibrary(shown.library.exercises, query) : null
	);

	function pick(index: number) {
		const exercise = found?.results[index];
		if (!exercise || shown.status !== 'ready') return;
		addExercise(store, view, exercise, shown.library.units);
		open = false;
	}

	const options = () => [...(list?.querySelectorAll<HTMLElement>('.option') ?? [])];

	/** The search's keys: ArrowDown to the results, Enter adds the first. */
	function searchKey(event: KeyboardEvent) {
		if (event.target !== search) return;
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			options()[0]?.focus();
		} else if (event.key === 'Enter') {
			event.preventDefault();
			pick(0);
		}
	}

	/** The results' keys: the arrows, Home and End; ArrowUp from the first returns to the search. */
	function listKey(event: KeyboardEvent) {
		const all = options();
		const at = all.indexOf(document.activeElement as HTMLElement);
		const last = all.length - 1;
		const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: last }[event.key];
		if (at < 0 || to === undefined) return;
		event.preventDefault();
		if (to < 0) search?.focus();
		else all[Math.min(last, to)]?.focus();
	}
</script>

<BottomSheet
	bind:open
	title="Add exercise"
	description="It goes after the last exercise, for this session."
	data-testid="exercise-picker"
>
	{#if shown.status === 'ready' && found}
		<div class="body">
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="search" onkeydown={searchKey}>
				<TextField
					label="Search exercises"
					type="search"
					placeholder="Name or alias, like RDL"
					autocomplete="off"
					autocapitalize="none"
					spellcheck={false}
					enterkeyhint="go"
					bind:value={query}
					bind:input={search}
					data-testid="picker-search"
				/>
			</div>
			{#if found.results.length > 0}
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<ul
					class="list"
					aria-label="Exercises"
					bind:this={list}
					onkeydown={listKey}
					data-testid="picker-results"
				>
					{#each found.results as exercise, i (exercise.id)}
						<li>
							<button
								type="button"
								class="option"
								onclick={() => pick(i)}
								data-testid="picker-option"
							>
								<span class="name">{exercise.name}</span>
								<span class="detail">{needsLine(exercise.equipment)}</span>
							</button>
						</li>
					{/each}
				</ul>
				{#if found.more > 0}
					<p class="more" data-testid="picker-more">Keep typing to narrow {found.more} more</p>
				{/if}
			{:else}
				<p class="none" role="status" data-testid="picker-none">
					No exercise matches “{query.trim()}”. Try another name, or fewer letters.
				</p>
			{/if}
		</div>
	{:else if shown.status === 'loading'}
		<div class="loading" role="status" aria-busy="true" data-testid="picker-loading">
			<p class="detail">Getting your exercises</p>
			<Skeleton height="3.5rem" radius="var(--radius-md)" />
			<Skeleton height="3.5rem" radius="var(--radius-md)" />
			<Skeleton height="3.5rem" radius="var(--radius-md)" />
		</div>
	{:else}
		<EmptyState
			compact
			icon="wifi-off"
			tone="neutral"
			title={shown.status === 'missing'
				? "Your exercise list isn't on this device yet"
				: "Your exercise list couldn't load"}
			description={shown.status === 'missing'
				? 'Connect once to download it. After that, adding an exercise works offline too.'
				: "The server didn't answer. Try again in a moment."}
			data-testid={shown.status === 'missing' ? 'picker-no-library' : 'picker-failed'}
		>
			{#snippet actions()}
				<Button icon="refresh" onclick={() => void load()}>Try again</Button>
			{/snippet}
		</EmptyState>
	{/if}
</BottomSheet>

<style>
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.body,
	.list,
	.loading {
		display: grid;
		gap: var(--space-2);
	}

	.body {
		gap: var(--space-4);
	}

	.option {
		display: grid;
		gap: var(--space-0-5);
		width: 100%;
		min-height: 56px;
		padding: var(--space-3);
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		background: var(--color-surface-2);
		color: var(--color-text);
		font: inherit;
		text-align: start;
		cursor: pointer;
		transition:
			border-color var(--duration-fast) var(--ease-standard),
			background-color var(--duration-fast) var(--ease-standard);
	}

	.option:active {
		background: var(--color-surface-3);
	}

	.option:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	@media (hover: hover) and (pointer: fine) {
		.option:hover {
			border-color: var(--color-border-strong);
			background: var(--color-surface-3);
		}
	}

	.name {
		font-weight: var(--weight-semibold);
		overflow-wrap: anywhere;
	}

	.detail,
	.more,
	.none {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.more {
		text-align: center;
	}

	.none {
		line-height: var(--leading-normal);
	}
</style>
