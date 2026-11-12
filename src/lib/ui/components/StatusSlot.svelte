<!--
  @component
  Where a screen's Status Display goes: the one switch today's design carries. On today's design
  it is nothing (an empty hidden element until the page has mounted, then not even that), and the
  screen keeps its own presentation; on a page showing Graphite 2004 it loads the screen's display
  (`load`, a dynamic import, so the display's code ships only to a device that chose Graphite) and
  shows it with `props`. Graphite holds `room` for it from the first paint (graphite.css, the
  `status-room` hook) and the display fills at least that room, so nothing below it moves when it
  arrives. A chunk gone after a deploy only means no display.
-->
<script lang="ts" generics="P extends Record<string, unknown>">
	import { onMount, type Component } from 'svelte';
	import { chosenDisplay } from './status-slot';

	interface Props {
		/** The screen's display, e.g. () => import('./TodayStatus.svelte'). */
		load: () => Promise<{ default: Component<P> }>;
		props: P;
		/** About its height on a phone, held while it loads: '10rem'. */
		room: string;
	}

	let { load, props, room }: Props = $props();

	/** Undefined until decided; null on today's design (or with no chunk). */
	let Display = $state.raw<Component<P> | null | undefined>(undefined);
	onMount(() => {
		let live = true;
		void chosenDisplay(document.documentElement, load).then((found) => live && (Display = found));
		return () => (live = false);
	});
</script>

{#if Display !== null}
	<div data-ui="status-room" style:--status-room={room} hidden={Display === undefined}>
		{#if Display}<Display {...props} />{/if}
	</div>
{/if}
