<!--
  @component
  The header's sync status, loaded on idle with the engine (sync-ui.ts), so none of it weighs on
  the first render: the pill (SyncPill) follows the engine through outboxStatus, and opens the
  sync sheet (SyncIssuesSheet.svelte, fetched on the pill's first intent) whenever there is
  something to show. A chunk that is gone shows 'App updated — reload to continue'. A 401 closes
  the sheet and its editor at once: they show the changes' details.
-->
<script lang="ts">
	import type { ChunkLoad } from '#lib/client/workout/active.svelte.ts';
	import { outboxStatus } from '#lib/client/workout/status.svelte.ts';
	import type { WorkoutStore } from '#lib/client/workout/store.ts';
	import type { WorkoutView } from '#lib/domain/workout/index.ts';
	import SyncPill from '#lib/ui/workout/SyncPill.svelte';
	import type SyncIssuesSheet from './SyncIssuesSheet.svelte';

	interface Props {
		store: WorkoutStore;
		/** The workout shown, for the sheet's words; null when none may be shown. */
		view: WorkoutView | null;
		load: ChunkLoad;
	}

	let { store, view, load }: Props = $props();
	const status = $derived(outboxStatus.current);
	const signedOut = $derived(status?.state === 'signed-out');
	const quiet = $derived(!status || status.state === 'synced' || signedOut);

	let Issues = $state.raw<typeof SyncIssuesSheet | null>(null);
	let open = $state(false);
	const prefetch = () =>
		void load(() => import('./SyncIssuesSheet.svelte')).then((module) => {
			if (module) Issues = module.default;
		});
	function show(event: MouseEvent) {
		// Safari never focuses a tapped button: the sheet returns focus to what has it.
		(event.currentTarget as HTMLElement).focus();
		prefetch();
		open = true;
	}
</script>

<SyncPill {status} onopen={quiet ? undefined : show} onintent={prefetch} />
{#if Issues && !signedOut}
	<Issues bind:open {store} {view} {status} />
{/if}
