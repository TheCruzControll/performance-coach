<!--
  @component
  CoachHeader's usage button: opens the usage sheet (UsageSheet.svelte), whose code is fetched on
  the first press so the Coach screen ships without it; the sheet opens when it arrives. A failed
  fetch says so in a toast whose Retry (or the button) fetches again; failing again while online
  reloads the page, as Chromium keeps a failed module fetch for the document's lifetime and a
  deploy removes old chunks. The toast, not a notice under the button: the toaster is already on
  every screen, which keeps this button within the Coach screen's byte allowance.
-->
<script lang="ts">
	import type { Component } from 'svelte';
	import IconButton from '#lib/ui/components/IconButton.svelte';
	import { SCREEN_FAILURE_LABEL } from '#lib/ui/coach/coach-notices.ts';
	import { toast } from '#lib/ui/toast.svelte.ts';

	type UsageSheet = Component<{ open: boolean }>;

	let Sheet = $state.raw<UsageSheet | null>(null);
	let open = $state(false);
	let failed = false;

	// Left out of the server build, which never renders it: SvelteKit links into a page the CSS of
	// every dynamic import its server build can reach. Kept apart from .then(): Vite moves
	// `import(…).then(…)` whole into its preloader, whose own failures would skip the handlers.
	const load = (): Promise<{ default: UsageSheet }> =>
		import.meta.env.SSR ? Promise.reject(new Error('client only')) : import('./UsageSheet.svelte');

	function show() {
		open = true;
		if (Sheet) return;
		load().then(
			(module) => (Sheet = module.default),
			() => {
				if (failed && navigator.onLine) return location.reload();
				failed = true;
				toast.show(SCREEN_FAILURE_LABEL.chunk_failed, {
					tone: 'danger',
					duration: 0,
					action: { label: 'Retry', onclick: show }
				});
			}
		);
	}
</script>

<IconButton icon="pulse" label="Coach usage" onclick={show} data-testid="usage-button" />
{#if Sheet}<Sheet bind:open />{/if}
