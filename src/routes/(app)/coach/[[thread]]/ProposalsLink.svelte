<!--
  @component
  CoachHeader's link to the Proposals inbox (/coach/proposals): every change the coach proposed,
  waiting ones first. A plain link, so it costs the Coach screen no script of its own; a 44 px
  circle like the header's other actions, named for screen readers, with hover and focus states.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import Icon from '#lib/ui/components/Icon.svelte';
</script>

<a class="link" href={resolve('/(app)/coach/proposals/[[id]]', {})} aria-label="Proposals">
	<Icon name="sparkle" size={22} />
</a>

<style>
	.link {
		display: inline-grid;
		place-items: center;
		width: var(--touch-target);
		height: var(--touch-target);
		border-radius: var(--radius-full);
		color: var(--color-text);
	}

	.link:active {
		background: var(--color-surface-3);
	}

	.link:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	@media (hover: hover) and (pointer: fine) {
		.link:hover {
			background: var(--color-surface-2);
		}
	}
</style>
