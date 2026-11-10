<!--
  @component
  A view's trends (trends.ts), Running's or General's, as StrengthTrendsLoader holds Strength's.
  On the page the server rendered, they are static markup (`served`), kept as sent while their
  code loads after hydration, and the live section takes its place once it has. Any other load
  waited for their code (+page.ts), so the section is there at once, or, if the import failed,
  'Couldn’t load your … trends' with Retry, which imports it again in place. If that fails too
  while online, Progress reloads (a failed module fetch is kept, and after a deploy the old chunk
  is gone). Offline, the notice stays. No stylesheet: /progress's CSS budget has no room.
-->
<script lang="ts" generics="P extends Record<string, unknown>">
	import { onMount, type Component } from 'svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import ServedInPlace from '../today/panels/ServedInPlace.svelte';
	import ServedMarkup from '../today/panels/ServedMarkup.svelte';

	interface Props {
		/** The section's import and what it came to (trends.ts). */
		section: { preload: () => Promise<void>; settled: () => Component<P> | Error | undefined };
		/** What the section is given. */
		props: P;
		/** The section as the server rendered it (+page.ts), kept as sent until its code arrives. */
		served?: string;
		/** The view's name in the failure's title: 'Couldn’t load your {name} trends'. */
		name: string;
		'data-testid': string;
	}

	let { section, props, served, name, 'data-testid': testid }: Props = $props();

	/** What the import came to, as of the last render or Retry. */
	let outcome = $state.raw<Component<P> | Error | undefined>();
	const current = $derived(outcome ?? section.settled());
	const Trends = $derived(current instanceof Error ? undefined : current);
	let loading = $state(false);
	/**
	 * The served markup stays through hydration, whatever the import came to by then, and until
	 * it comes to something: the section, or Retry.
	 */
	let mounted = $state(false);
	onMount(() => (mounted = true));
	const held = $derived(mounted && current !== undefined ? undefined : served);
	/** The markup on the server; in the browser, the same element kept as sent (no props). */
	const Served: Component<{ markup: string }> = import.meta.env.SSR
		? ServedMarkup
		: (ServedInPlace as Component<{ markup: string }>);

	async function fetchTrends() {
		loading = true;
		await section.preload();
		const next = section.settled() as Component<P> | Error;
		if (next instanceof Error && outcome instanceof Error && navigator.onLine) {
			return location.reload();
		}
		outcome = next;
		loading = false;
	}

	// Not imported yet (+page.ts has not finished it while Progress hydrates): import it now.
	$effect(() => {
		if (current === undefined && !loading) fetchTrends();
	});

	/** A tap on Retry after a failure: fails again online, and Progress reloads. */
	function retry() {
		outcome = current;
		fetchTrends();
	}
</script>

{#if held}
	<Served markup={held} />
{:else if Trends}
	<Trends {...props} />
{:else if current instanceof Error}
	<div style="display:grid;justify-items:start;gap:var(--space-3)" data-testid={testid}>
		<Notice tone="danger" title="Couldn’t load your {name} trends">
			Your training is safe. Check your connection, then try again.
		</Notice>
		<Button variant="secondary" icon="refresh" {loading} onclick={retry}>Retry</Button>
	</div>
{/if}
