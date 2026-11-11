<!--
  @component
  A launch that lands on the offline screen opens the workout in progress instead (launch.ts): the
  inline script, in the head of the prerendered /offline page, replaces the page with the flagged
  kind's workout page as the parser reaches it, before the app boots or the offline screen paints.
  - Server-rendered only, as Prepaint.svelte's: the client's build neither runs nor carries it.
    Both sides render the marker before it, so hydration keeps the block as it is (an {@html}
    block is never checked against the client's). The CSP allows it by its hash (vite.config.ts).
-->
<script lang="ts">
	import { LAUNCH_SCRIPT } from '#lib/client/workout/launch.ts';

	const marker = '<meta name="pc-launch" />';
	// Its closing tag is split, or it would end this block.
	const markup = import.meta.env.SSR ? `${marker}<script>${LAUNCH_SCRIPT}</${'script'}>` : marker;
</script>

<svelte:head>
	<!-- svelte-ignore hydration_html_changed -->
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- constant markup: no data reaches it -->
	{@html markup}
</svelte:head>
