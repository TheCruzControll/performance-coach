<!--
  @component
  Loading placeholder with a soft shimmer (static under reduced motion). Purely decorative:
  mark the loading region itself with aria-busy and a text alternative.
-->
<script lang="ts">
	interface Props {
		width?: string;
		height?: string;
		radius?: string;
		circle?: boolean;
	}

	let {
		width = '100%',
		height = '1rem',
		radius = 'var(--radius-xs)',
		circle = false
	}: Props = $props();
</script>

<span
	class="skeleton"
	aria-hidden="true"
	style:width={circle ? height : width}
	style:height
	style:border-radius={circle ? '50%' : radius}
></span>

<style>
	.skeleton {
		display: block;
		flex: none;
		background: linear-gradient(
				100deg,
				transparent 20%,
				color-mix(in srgb, var(--color-text) 6%, transparent) 50%,
				transparent 80%
			)
			var(--color-surface-2);
		background-size: 220% 100%;
		animation: shimmer 1.6s var(--ease-standard) infinite;
	}

	@keyframes shimmer {
		from {
			background-position: 120% 0;
		}
		to {
			background-position: -120% 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.skeleton {
			animation: none;
		}
	}
</style>
