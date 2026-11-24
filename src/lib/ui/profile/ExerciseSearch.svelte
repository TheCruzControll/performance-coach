<!--
  @component
  Adding an exercise to a list (Paper, 9 · "Add an exercise": "Search the library, or keep your
  own words"): a search field, focused on arrival, whose label the screen's question already says,
  then up to eight exercises from the library (`/api/exercises`, through the workout's
  `searchLibrary`), those in either list already marked Added, and last "Add “…” as you wrote it"
  unless a result is named exactly that. When the library can't load, it searches the device's
  sixteen suggestions instead, and says nothing. A pick hands the name, as words, to `onpick`.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { isLibrary, LIBRARY_TIMEOUT_MS, LIBRARY_URL } from '#lib/client/workout/library.ts';
	import type { LibraryExercise } from '#lib/domain/workout/index.ts';
	import ListRow from '../components/ListRow.svelte';
	import TextField from '../components/TextField.svelte';
	import { searchExercises } from './exercise-preferences';

	interface Props {
		/** Both lists: a result either holds is Added, not a pick. */
		taken: string[];
		onpick: (name: string) => void;
	}

	let { taken, onpick }: Props = $props();

	let query = $state('');
	let input = $state<HTMLInputElement>();
	/** The library once it answers; null (the suggestions) when it can't. */
	let library = $state<readonly LibraryExercise[] | null>(null);
	let loading = $state(true);

	const typed = $derived(query.trim());
	const results = $derived(searchExercises(library, typed, taken));
	const own = $derived(
		typed !== '' && !results.some((r) => r.name.toLowerCase() === typed.toLowerCase())
	);

	onMount(() => {
		// After the screen has put the focus on its title: the field is where typing starts.
		const frame = requestAnimationFrame(() => input?.focus());
		void (async () => {
			try {
				const response = await fetch(LIBRARY_URL, {
					credentials: 'same-origin',
					headers: { accept: 'application/json' },
					signal: AbortSignal.timeout(LIBRARY_TIMEOUT_MS)
				});
				if (!response.ok) {
					// Any body unread would keep the request open.
					void response.body?.cancel().catch(() => {});
					return;
				}
				const body: unknown = await response.json();
				if (isLibrary(body)) library = body.exercises;
			} catch {
				// Offline, refused or too slow: the suggestions stand in, without a word.
			} finally {
				loading = false;
			}
		})();
		return () => cancelAnimationFrame(frame);
	});
</script>

<div class="search">
	<TextField
		label="Search exercises"
		hideLabel
		type="search"
		bind:value={query}
		bind:input
		placeholder="Search exercises"
		autocomplete="off"
		autocapitalize="sentences"
		enterkeyhint="done"
		maxlength={80}
		data-testid="exercise-search"
	/>
	<div class="rows" aria-busy={loading} data-testid="exercise-results">
		{#each results as result (result.name)}
			{#if result.added}
				<ListRow title={result.name} static muted value="Added" valueTone="muted" />
			{:else}
				<ListRow
					title={result.name}
					onclick={() => onpick(result.name)}
					data-testid="exercise-result"
				/>
			{/if}
		{/each}
		{#if own}
			<ListRow
				title={`Add “${typed}” as you wrote it`}
				onclick={() => onpick(typed)}
				data-testid="exercise-own"
			/>
		{/if}
	</div>
</div>

<style>
	/* The results start right under the field, so they sit above the phone's keyboard. */
	.search {
		display: grid;
		gap: var(--space-2);
	}

	.rows {
		display: grid;
	}
</style>
