<!--
  @component
  One of Today's code-split panels (panels/index.ts). On the page the server rendered, the panel
  is static markup (`served`), kept as sent while its code loads, and the live panel takes its
  place once it has. After a client navigation it holds `height` while its code loads: a skeleton,
  or, if the import failed, 'Couldn’t load this part of Today' with Retry, which imports it again
  in place (WebKit fetches anew). If that fails too while online, Today reloads: Chromium keeps a
  failed module fetch for the document's lifetime, and after a deploy the old chunk is gone.
  Offline, the notice stays. The rest of Today works throughout.
-->
<!-- eslint-disable-next-line @typescript-eslint/no-explicit-any -- any panel's props -->
<script lang="ts" generics="P extends Record<string, any>">
	import { onMount, type Component } from 'svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import Card from '#lib/ui/components/Card.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import Skeleton from '#lib/ui/components/Skeleton.svelte';
	import { preloadPanel, settledPanel, type PanelImport } from './index';
	import ServedInPlace from './ServedInPlace.svelte';
	import ServedMarkup from './ServedMarkup.svelte';

	interface Props {
		load: PanelImport<P>;
		/** Room the panel holds while it loads or fails: about its height on a phone. */
		height: string;
		props: P;
		/** The panel as the server rendered it (+page.ts), kept as sent until its code arrives. */
		served?: string;
	}

	let { load, height, props, served }: Props = $props();

	/** What the import came to, as of the last render or Retry. */
	let outcome = $state.raw<Component<P> | Error | undefined>();
	const current = $derived(outcome ?? (settledPanel(load) as Component<P> | Error | undefined));
	const Panel = $derived(current instanceof Error ? undefined : current);
	let loading = $state(false);
	const failed = $derived(current instanceof Error && !loading);
	/**
	 * The served markup stays through hydration, whatever the import came to by then, and until
	 * it comes to something: the panel, or Retry.
	 */
	let mounted = $state(false);
	onMount(() => (mounted = true));
	const held = $derived(mounted && current !== undefined ? undefined : served);
	/** The markup on the server; in the browser, the same element kept as sent (no props). */
	const Served: Component<{ markup: string }> = import.meta.env.SSR
		? ServedMarkup
		: (ServedInPlace as Component<{ markup: string }>);

	async function fetchPanel() {
		loading = true;
		await preloadPanel(load);
		const next = settledPanel(load) as Component<P> | Error;
		if (next instanceof Error && outcome instanceof Error && navigator.onLine) {
			return location.reload();
		}
		outcome = next;
		loading = false;
	}

	// Not imported yet (a client navigation, or a state +page.ts did not pick): import it now.
	$effect(() => {
		if (current === undefined && !loading) fetchPanel();
	});

	/** A tap on Retry after a failure: fails again online, and Today reloads. */
	function retry() {
		outcome = current;
		fetchPanel();
	}
</script>

{#if held}
	<Served markup={held} />
{:else if Panel}
	<Panel {...props} />
{:else}
	<div class="reserve" style:min-height={height} aria-busy={!failed} data-testid="today-panel">
		{#if failed}
			<Card padding="lg" data-testid="today-panel-error">
				<EmptyState
					compact
					icon="alert"
					tone="combat"
					title="Couldn’t load this part of Today"
					description="Everything else here still works. Check your connection, then try again."
				>
					{#snippet actions()}
						<Button variant="secondary" icon="refresh" onclick={retry}>Try again</Button>
					{/snippet}
				</EmptyState>
			</Card>
		{:else}
			<span class="visually-hidden">Loading…</span>
			<Skeleton {height} radius="var(--radius-lg)" />
		{/if}
	</div>
{/if}

<style>
	.reserve {
		display: grid;
	}
</style>
