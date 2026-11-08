<!--
  @component
  Today once the training profile is ready and there is no program: one line on what Build my
  program does, and the button that opens it (BuildPreview, which takes Today's place). Its code
  starts loading once the browser is idle, or on the first touch. Code-split behind PanelLoader.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import Badge from '#lib/ui/components/Badge.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import Card from '#lib/ui/components/Card.svelte';
	import { PANELS, preloadPanel } from './index';

	interface Props {
		/** The button was tapped: open Build my program. */
		onbuild?: () => void;
	}

	let { onbuild }: Props = $props();

	let warmed = false;
	/** Fetch the preview's code ahead of the tap, so it is there when the tap lands. */
	function warm() {
		if (warmed) return;
		warmed = true;
		preloadPanel(PANELS.preview);
	}

	onMount(() => {
		if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 2000 });
		else setTimeout(warm, 800);
	});
</script>

<Card tone="accent" padding="lg" data-testid="today-build">
	<div class="build">
		<Badge tone="positive" icon="check">Profile ready</Badge>
		<h2 class="title">Build my program</h2>
		<p class="copy">
			Your coach plans week 1 around your goals, schedule and equipment, and shows you why before
			anything is saved.
		</p>
		<Button
			iconEnd="arrow-right"
			block
			onpointerdown={warm}
			onclick={() => onbuild?.()}
			data-testid="today-build-cta"
		>
			Build my program
		</Button>
	</div>
</Card>

<style>
	/* The card fills the room Today holds for it: the button sits at its foot. */
	.build {
		display: grid;
		grid-template-rows: auto auto 1fr auto;
		justify-items: start;
		gap: var(--space-3);
		height: 100%;
	}

	.build > :global(:last-child) {
		justify-self: stretch;
	}

	.title {
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-display);
		line-height: var(--leading-tight);
	}

	.copy {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}
</style>
