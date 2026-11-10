<script lang="ts">
	import { onMount } from 'svelte';
	import { STEP_INFO, type OnboardingStep } from '#lib/domain/profile/onboarding.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import { stepHref } from '../paths';
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

	/** What a first visit is told is ahead. */
	const AHEAD = [
		{ icon: 'target', title: 'Goals & priorities', text: 'An event, a general goal, or several' },
		{ icon: 'bolt', title: 'Experience & strength', text: 'Maxes optional: week one finds them' },
		{ icon: 'today', title: 'Your week', text: 'Days, time and the classes you already have' }
	] as const;

	// Signed in (owner only), so real-user monitoring runs here as in the app shell, once idle.
	onMount(() => {
		const start = () =>
			void import('#lib/client/vitals.ts')
				.then((rum) => rum.startVitalsReporting())
				.catch(() => {}); // best effort, as in the app shell
		if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 3000 });
		else setTimeout(start, 1500);
	});
</script>

<svelte:head>
	<title>{STEP_INFO[data.step].title} · Set up · Performance Coach</title>
</svelte:head>

<!-- Outside the app shell: no navigation, one readable column centred in the window (from
     1024 px a card, and wide on the review: Step.svelte). -->
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
			profile={data.profile}
			fromReview={data.fromReview}
			title={data.resume ? 'Welcome back' : COPY[step].title}
			lede={COPY[step].lede}
			continueLabel={data.resume ? 'Continue' : (COPY[step].next ?? 'Continue')}
		>
			<!-- Opened from the review's Edit, the welcome is only its name and units: neither the
			     first visit's outline nor the return visit's card. -->
			{#if step === 'welcome' && !data.fromReview}
				{#if data.resume}
					<!-- A return visit: the furthest step advanced, with everything before it saved. -->
					<div class="resume" data-testid="resume-card">
						<p>
							You stopped at <strong>{STEP_INFO[data.resume].title}</strong>. Your answers so far
							are saved.
						</p>
						<Button
							variant="secondary"
							href={stepHref(data.resume)}
							iconEnd="arrow-right"
							data-testid="resume-link">Pick up there</Button
						>
					</div>
				{:else}
					<ul class="ahead" aria-label="What we’ll ask">
						{#each AHEAD as item (item.title)}
							<li>
								<span class="glyph" aria-hidden="true"><Icon name={item.icon} size={20} /></span>
								<span class="ahead-text">
									<span class="ahead-title">{item.title}</span>
									<span>{item.text}</span>
								</span>
							</li>
						{/each}
					</ul>
				{/if}
			{/if}
		</Step>
	{/each}
</main>

<style>
	.ahead {
		display: grid;
		gap: var(--space-1);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.ahead li {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		min-height: 3.5rem;
	}

	.glyph {
		display: grid;
		flex: none;
		place-items: center;
		width: 2.75rem;
		height: 2.75rem;
		border-radius: var(--radius-md);
		background: var(--color-accent-subtle);
		color: var(--color-accent-text);
	}

	.ahead-text {
		display: grid;
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.ahead-title {
		font-size: var(--text-base);
		font-weight: var(--weight-semibold);
		color: var(--color-text);
	}

	.resume {
		display: grid;
		justify-items: start;
		gap: var(--space-3);
		padding: var(--space-4);
		border-radius: var(--radius-lg);
		border: 1px solid color-mix(in srgb, var(--color-accent) 35%, transparent);
		background: var(--color-accent-subtle);
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.resume strong {
		color: var(--color-text);
	}

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

	/* A desktop window: the step's card centred in it, both ways (the review widens it to wide). */
	@media (width >= 64rem) {
		.onboarding {
			display: grid;
			align-content: center;
			min-height: 100dvh;
			padding: var(--space-10) 0;
		}
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
