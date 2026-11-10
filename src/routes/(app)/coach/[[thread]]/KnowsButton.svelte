<!--
  @component
  CoachHeader's 'What the coach knows' button: opens the memory sheet (KnowsSheet.svelte), whose
  code is fetched on the first press so the Coach screen ships without it; the sheet opens when it
  arrives. A failed fetch says so in a toast whose Retry (or the button) fetches again; failing
  again while online reloads the page, as UsageButton does and for the same reasons.
-->
<script lang="ts">
	import type { Component } from 'svelte';
	import IconButton from '#lib/ui/components/IconButton.svelte';
	import { SCREEN_FAILURE_LABEL } from '#lib/ui/coach/coach-notices.ts';
	import { toast } from '#lib/ui/toast.svelte.ts';

	type KnowsSheet = Component<{ open: boolean }>;

	let Sheet = $state.raw<KnowsSheet | null>(null);
	let open = $state(false);
	let failed = false;

	// Client only, and apart from .then(), as UsageButton explains.
	const load = (): Promise<{ default: KnowsSheet }> =>
		import.meta.env.SSR ? Promise.reject(new Error('client only')) : import('./KnowsSheet.svelte');

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

<IconButton
	icon="database"
	label="What the coach knows"
	onclick={show}
	data-testid="knows-button"
/>
{#if Sheet}<Sheet bind:open />{/if}
