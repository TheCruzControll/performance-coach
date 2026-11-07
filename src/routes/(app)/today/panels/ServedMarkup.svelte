<!--
  @component
  A panel as the server rendered it (+page.ts), sent as static markup. Server only: the browser
  renders ServedInPlace instead, which keeps this markup as sent while Today hydrates. Its box
  takes no part in the layout (`display: contents`), so the markup lays out as the panel does.
-->
<script lang="ts">
	let { markup }: { markup: string } = $props();
</script>

<!-- eslint-disable-next-line svelte/no-at-html-tags -- the server's own render of the panel -->
<div data-served style="display: contents">{@html markup}</div>
