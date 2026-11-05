<!--
  @component
  The product mark: a performance gauge — a 270° track with a volt arc stopping short of
  full. Progress, not perfection. Also the basis of the app icons (static/icons).
-->
<script lang="ts">
	let { size = 32, title }: { size?: number; title?: string } = $props();
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 64 64"
	fill="none"
	role={title ? 'img' : undefined}
	aria-label={title}
	aria-hidden={title ? undefined : 'true'}
>
	<path
		d="M16.44 47.56A22 22 0 1 1 47.56 47.56"
		stroke="currentColor"
		stroke-opacity="0.18"
		stroke-width="6.5"
		stroke-linecap="round"
	/>
	<path
		d="M16.44 47.56A22 22 0 1 1 51.94 22.7"
		stroke="var(--color-accent)"
		stroke-width="6.5"
		stroke-linecap="round"
	/>
</svg>
