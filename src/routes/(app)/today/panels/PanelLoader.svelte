<!--
  @component
  One of Today's code-split panels (panels/index.ts). On the page the server rendered, the panel
  is static markup (`served`), kept as sent while its code loads, and the live panel takes its
  place once it has. After a client navigation it fills the rest of Today's column (at least
  `height`, when given) while its code loads: 'Getting today' at the foot, no grey blocks; or, if
  the import failed, one statement with Try again, which imports it again in place (WebKit
  fetches anew). If that fails too while online, Today reloads: Chromium keeps a failed module
  fetch for the document's lifetime, and after a deploy the old chunk is gone. Offline, the
  statement stays. The rest of Today works throughout.
-->
<!-- eslint-disable-next-line @typescript-eslint/no-explicit-any -- any panel's props -->
<script lang="ts" generics="P extends Record<string, any>">
	import { onMount, type Component } from 'svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import { preloadPanel, settledPanel, type PanelImport } from './index';
	import ServedInPlace from './ServedInPlace.svelte';
	import ServedMarkup from './ServedMarkup.svelte';

	interface Props {
		load: PanelImport<P>;
		/**
		 * Room the panel holds while it loads or fails, at least: about its height on a phone, for a
		 * panel with something under it (setup, build, the preview). The plan has none: it fills
		 * the column to its foot.
		 */
		height?: string;
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
			<section
				class="statement-wrap"
				data-testid="today-panel-error"
				aria-labelledby="today-panel-failed"
			>
				<h2 id="today-panel-failed" class="statement">Couldn’t load today</h2>
				<p class="lead">Everything else here still works. Check your connection and try again.</p>
				<Button variant="secondary" size="lg" block onclick={retry} data-testid="today-retry">
					Try again
				</Button>
			</section>
		{:else}
			<p class="getting">Getting today</p>
		{/if}
	</div>
{/if}

<style>
	.reserve {
		display: flex;
		flex-direction: column;
		flex: 1;
	}

	/* Paper's 180 px foot under 'Getting today', as the plan's own loading line has it. */
	.getting {
		margin-top: auto;
		padding-bottom: calc(var(--space-20) * 2 + var(--space-5));
		font: var(--type-secondary);
		color: var(--color-text-quiet);
	}

	.statement-wrap {
		margin-top: auto;
		padding-bottom: var(--space-14);
	}

	.statement {
		font: var(--type-statement);
		letter-spacing: var(--tracking-statement);
		color: var(--color-text);
	}

	.lead {
		padding: var(--space-3) 0 var(--space-7);
		font: var(--type-body);
		color: var(--color-text-secondary);
	}
</style>
