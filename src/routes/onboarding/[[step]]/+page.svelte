<script lang="ts">
	import { onMount } from 'svelte';
	import { startVitalsReporting } from '#lib/client/vitals.ts';
	import { STEP_INFO, type OnboardingStep } from '#lib/domain/profile/onboarding.ts';
	import Step from './Step.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** Each step's words: a title, one line on why it is asked, and its Continue. */
	const COPY: Record<OnboardingStep, { title: string; lede: string; next?: string }> = {
		welcome: {
			title: 'Let’s build your plan around you',
			lede: 'About five minutes. Skip what you don’t know yet: everything stays editable in Profile.',
			next: 'Let’s start'
		},
		goals: {
			title: 'What are you training for?',
			lede: 'One goal or several. Rank them: when they compete, your coach plans around the top one.'
		},
		experience: {
			title: 'Where are you starting from?',
			lede: 'Your level in each discipline sets how hard week one starts.'
		},
		strength: {
			title: 'Strength baselines',
			lede: 'Known maxes help from day one. Don’t know them? That’s what week one is for.'
		},
		specifics: {
			title: 'Running & Muay Thai',
			lede: 'Where your engine and your skill work are now. Leave out what you don’t know.'
		},
		equipment: {
			title: 'Where do you train?',
			lede: 'So every exercise in your plan is one you can do where you are.'
		},
		injuries: {
			title: 'Anything to work around?',
			lede: 'Injuries, limits and movements to avoid: your coach plans around them.'
		},
		exercises: {
			title: 'Exercises you like, and ones you don’t',
			lede: 'Favourites come up more; the ones you’d rather skip get swapped out.'
		},
		schedule: {
			title: 'Your week',
			lede: 'How often and how long you can train, and the classes already in it.'
		},
		body: {
			title: 'Body & nutrition',
			lede: 'Only used to plan fuel and weight targets. Skip it if it isn’t relevant.'
		},
		review: {
			title: 'Ready when you are',
			lede: 'Your coach plans week one from this. Everything stays editable in Profile.',
			next: 'Start coaching'
		}
	};

	// Signed in (owner only), so real-user monitoring runs here as in the app shell, once idle.
	onMount(() => {
		const start = () => void startVitalsReporting();
		if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 3000 });
		else setTimeout(start, 1500);
	});
</script>

<svelte:head>
	<title>{STEP_INFO[data.step].title} · Set up · Performance Coach</title>
</svelte:head>

<!-- Outside the app shell: no navigation, one readable column centred in the window. -->
<main id="main" class="onboarding" tabindex="-1" data-layout="readable">
	<!-- Another step is another screen, with its own editor and form state: a keyed block of one
	     mounts it afresh. -->
	{#each [data.step] as step (step)}
		<Step
			{step}
			steps={data.steps}
			completed={data.completed}
			skipped={data.skipped}
			key={data.key}
			saved={data.saved}
			context={data.context}
			title={COPY[step].title}
			lede={COPY[step].lede}
			continueLabel={COPY[step].next ?? 'Continue'}
		/>
	{/each}
</main>

<style>
	.onboarding {
		position: relative;
		width: 100%;
		max-width: var(--content-column);
		margin: 0 auto;
		padding: var(--safe-top) max(var(--gutter), var(--safe-right)) 0
			max(var(--gutter), var(--safe-left));
		outline: none;
		isolation: isolate;
	}

	/* The app shell's quiet volt glow: one product, not a separate wizard. */
	.onboarding::before {
		content: '';
		position: fixed;
		z-index: -1;
		inset: 0 0 auto;
		height: 20rem;
		pointer-events: none;
		background: radial-gradient(
			120% 70% at 50% -20%,
			color-mix(in srgb, var(--color-accent) 8%, transparent),
			transparent 70%
		);
	}
</style>
