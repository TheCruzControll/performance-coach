<!--
  @component
  What shows while another screen loads ((app)/+layout.svelte): the last time that screen showed
  in this page (a copy of its DOM, screen-memory.ts), or, for a tab not shown yet, its skeleton.
  It draws in the frame after the navigation starts, over the content column and under the
  navigation, and goes as the new screen renders. The screen being left stays in place under it,
  so Back still finds it scrolled where it was. Inert and hidden from assistive technology; the
  region is aria-busy and names what is loading.
-->
<script lang="ts" module>
	import { screens } from '#lib/client/screen-memory.ts';
	import { heldFor, type Held, type Where } from './held';
	import { isStale } from './today/freshness';

	/**
	 * What to hold while a navigation from `from` to `to` loads (held.ts): a copy kept on another
	 * day or longer ago than Today's TTL (today/freshness.ts) is not shown. Here, not in the
	 * layout, so it loads with this component and is in no screen's initial JavaScript.
	 */
	export function holding(from: Where, to: Where | null | undefined): Held<readonly Node[]> | null {
		return heldFor(from, to, (url) => screens.recall(url, (keptAt) => isStale(keptAt, new Date())));
	}
</script>

<script lang="ts">
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import Skeleton from '#lib/ui/components/Skeleton.svelte';

	interface Props {
		label: string;
		last: readonly Node[] | null;
	}

	let { label, last }: Props = $props();

	/** Holds the eyebrow's line, so the title sits where the screen's own will. */
	const EYEBROW_LINE = '\u00a0';
</script>

<div class="held" data-testid="held-screen" data-held={last ? 'last' : 'skeleton'} aria-busy="true">
	<p class="visually-hidden" role="status">Loading {label}</p>
	{#if last}
		<div
			class="column"
			inert
			aria-hidden="true"
			{@attach (node) => node.replaceChildren(...(last ?? []))}
		></div>
	{:else}
		<div class="column" inert aria-hidden="true">
			<PageHeader title={label} eyebrow={EYEBROW_LINE} />
			<div class="cards">
				<Skeleton height="11rem" radius="var(--radius-lg)" />
				<Skeleton height="6.5rem" radius="var(--radius-lg)" />
				<Skeleton height="6.5rem" radius="var(--radius-lg)" />
			</div>
		</div>
	{/if}
</div>

<style>
	/* Over the content and under the nav and the resume bar (the same layer, but later in the
	   shell), on the shell's canvas and accent glow (AppShell.svelte). */
	.held {
		position: fixed;
		z-index: var(--z-sticky);
		inset: 0;
		overflow: hidden;
		padding-top: var(--safe-top);
		padding-left: var(--nav-inset-left);
		background: var(--color-canvas);
		isolation: isolate;
	}

	.held::before {
		content: '';
		position: absolute;
		z-index: -1;
		inset: 0 0 auto;
		height: 22rem;
		pointer-events: none;
		background: radial-gradient(
			120% 70% at 50% -20%,
			color-mix(in srgb, var(--color-accent) 7%, transparent),
			transparent 70%
		);
	}

	/* The content column's own width and gutters (AppShell.svelte, layout.css). */
	.column {
		width: 100%;
		max-width: var(--content-column);
		margin: 0 auto;
		padding: 0 max(var(--gutter), var(--safe-right)) 0 max(var(--gutter), var(--safe-left));
	}

	.cards {
		display: grid;
		gap: var(--space-4);
	}

	@media (width >= 64rem) {
		.column:has(:global([data-layout='wide'], [data-layout='split'])) {
			max-width: var(--content-wide);
		}
	}
</style>
