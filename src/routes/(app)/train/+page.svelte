<script lang="ts">
	import { onMount, type Component, type ComponentProps } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { preferences } from '#lib/client/preferences.svelte.ts';
	import Badge from '#lib/ui/components/Badge.svelte';
	import Chip from '#lib/ui/components/Chip.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';
	import type PlateSheetType from './PlateSheet.svelte';

	const disciplines = [
		{ label: 'Strength', tone: 'strength' },
		{ label: 'Running', tone: 'running' },
		{ label: 'Muay Thai', tone: 'combat' },
		{ label: 'Hypertrophy', tone: 'hypertrophy' },
		{ label: 'Conditioning', tone: 'conditioning' }
	] as const;

	// The plate calculator and the sheet it opens in are code-split together (PlateSheet),
	// fetched on first intent (pointerdown/hover), on open, or for ?tool=plates, so Train ships
	// and hydrates without either. A tap made before they arrive is kept: the sheet opens when
	// they do. A failed fetch is forgotten, so the next tap imports again.
	type Sheet = Component<ComponentProps<typeof PlateSheetType>>;
	let fetching: Promise<{ default: Sheet }> | null = null;
	let PlateSheet = $state.raw<Sheet | null>(null);
	let sheetOpen = $state(false);
	let failed = $state(false);
	/** A tap after a reported failure, with the screen still here: failing again online reloads. */
	let retrying = false;

	function loadSheet() {
		if (fetching) return;
		fetching = import('./PlateSheet.svelte');
		// Kept apart from the import() expression: Vite moves `import(…).then(…)` whole into its
		// preloader, whose own failures would then skip these handlers.
		fetching.then(
			(module) => (PlateSheet = module.default),
			() => {
				fetching = null;
				// Resolved against Train's own URL: the same screen, asking for the sheet.
				if (retrying && sheetOpen && navigator.onLine) return location.replace('?tool=plates');
				// A failed tap is reported; a failed prefetch (hover) says nothing, and never takes
				// away a notice already shown.
				failed ||= sheetOpen;
				sheetOpen = false;
			}
		);
	}

	// After a failure, a tap on Retry (or on the row again) imports again in place, which WebKit
	// fetches anew because the sheet's code has no modulepreload tag (a failed one WebKit never
	// fetches again, reloads included: vite.config.ts). Chromium keeps a failed module fetch for
	// the document's lifetime, and after a deploy the old chunk is gone: if the import fails again
	// while online, Train reloads asking for the sheet (?tool=plates), which opens once its code
	// arrives. Offline, the notice stays.
	function openCalculator() {
		retrying ||= failed;
		failed = false;
		sheetOpen = true;
		loadSheet();
	}

	/** The notice can appear under the bottom navigation: bring it into view. */
	const reveal = (node: HTMLElement) => node.scrollIntoView({ block: 'nearest' });

	onMount(() => {
		preferences.load();
		if (page.url.searchParams.get('tool') === 'plates') openCalculator();
		// Left mid-retry: a late failure must not pull the owner back to Train.
		return () => (retrying = false);
	});

	function closeSheet() {
		if (page.url.searchParams.has('tool')) replaceState(resolve('/(app)/train'), {});
	}
</script>

<svelte:head>
	<title>Train · Performance Coach</title>
</svelte:head>

<PageHeader title="Train" eyebrow="Program" />

<div class="stack">
	<Surface padding="none" radius="xl">
		<EmptyState
			icon="train"
			title="No active program"
			description="Once your goals are in, your coach builds one plan across every discipline — and adapts it to each session you log."
			data-testid="train-empty"
		>
			{#snippet actions()}
				<p class="next" data-testid="train-next-step">
					Training profile <Badge>Coming next</Badge>
				</p>
			{/snippet}
		</EmptyState>
		<ul class="disciplines" aria-label="Supported disciplines">
			{#each disciplines as d (d.label)}
				<Chip as="li" tone={d.tone}>{d.label}</Chip>
			{/each}
		</ul>
	</Surface>

	<Section title="Tools">
		<div class="tool" aria-busy={sheetOpen && !PlateSheet}>
			<ListRow
				icon="plate"
				tone="strength"
				title="Plate calculator"
				subtitle="Exact loading in kg or lb"
				onpointerdown={loadSheet}
				onpointerenter={loadSheet}
				onclick={openCalculator}
				data-testid="open-plates"
			/>
			{#if failed}
				<Notice tone="danger" title="Couldn’t open the plate calculator">
					<button type="button" class="retry" onclick={openCalculator} use:reveal>Retry</button>
				</Notice>
			{/if}
		</div>
		<ListRow icon="timer" title="Rest timer" subtitle="Arrives with workout logging" disabled>
			{#snippet trailing()}<Badge>Soon</Badge>{/snippet}
		</ListRow>
	</Section>
</div>

<!-- Renders nothing until its code has arrived (a dynamic component that is null). -->
<PlateSheet bind:open={sheetOpen} unit={preferences.units} onclose={closeSheet} />

<style>
	.stack {
		display: grid;
		gap: var(--space-6);
	}

	.next {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}

	.disciplines {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: var(--space-2);
		margin: 0;
		padding: 0 var(--space-4) var(--space-6);
		list-style: none;
	}

	.tool {
		position: relative;
		display: grid;
		gap: var(--space-2);
	}

	/* Pending (tapped, the sheet's code on its way): a spinner takes the chevron's place after
	   a beat, so a fast fetch shows nothing. Drawn here from aria-busy, so the state adds no
	   component (no Spinner, no ListRow prop) to Train's initial JavaScript. */
	.tool[aria-busy='true']::after {
		content: '';
		position: absolute;
		top: 50%;
		right: calc(var(--space-4) + 1px);
		width: 20px;
		height: 20px;
		margin-top: -10px;
		border: 2.5px solid color-mix(in srgb, currentColor 25%, transparent);
		border-top-color: currentColor;
		border-radius: var(--radius-full);
		color: var(--color-text-tertiary);
		background: var(--color-surface-1);
		box-shadow: 0 0 0 4px var(--color-surface-1);
		opacity: 0;
		animation:
			spin 0.8s linear infinite,
			appear var(--duration-fast) var(--ease-out) 150ms forwards;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@keyframes appear {
		to {
			opacity: 1;
		}
	}

	/* The notice's inline action, styled as the notice styles its links (and the toast its
	   action): accent, underlined, with a full 44 × 44 px target that clears the bottom
	   navigation when scrolled into view. The negative margin keeps the word under the title
	   and the notice compact. */
	.retry {
		display: flex;
		align-items: center;
		min-width: var(--touch-target);
		min-height: var(--touch-target);
		padding: 0 var(--space-2);
		margin: calc(var(--space-2) * -1);
		scroll-margin-bottom: calc(var(--nav-inset-bottom) + var(--space-4));
		font-size: var(--text-sm);
		font-weight: var(--weight-bold);
		color: var(--color-accent-text);
		text-decoration: underline;
		text-underline-offset: 3px;
	}
</style>
