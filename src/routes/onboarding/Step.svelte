<!--
  @component
  The frame of one onboarding step: back, a segmented progress indicator, a large title, the
  step's form, and the actions pinned to the thumb zone (Continue, and Skip for optional
  steps). Back saves what changed when it can (save-as-you-go), then returns a step.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { STEP_INFO, type OnboardingStep } from '#lib/domain/profile/onboarding.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';

	interface Props {
		step: OnboardingStep;
		title: string;
		lede?: string;
		busy?: boolean;
		error?: string | null;
		continueLabel?: string;
		/** Shown for optional steps. */
		onskip?: () => void;
		oncontinue: () => void;
		/** Called instead of plain navigation (e.g. to save first), with the previous step's URL. */
		onback?: (href: string) => void;
		children: Snippet;
	}

	let {
		step,
		title,
		lede,
		busy = false,
		error = null,
		continueLabel = 'Continue',
		onskip,
		oncontinue,
		onback,
		children
	}: Props = $props();

	const onboarding = $derived(
		page.data.onboarding as {
			steps: OnboardingStep[];
			completed: OnboardingStep[];
			skipped: OnboardingStep[];
		}
	);
	const index = $derived(Math.max(0, onboarding.steps.indexOf(step)));
	const previous = $derived(index > 0 ? onboarding.steps[index - 1] : null);
	const pathOf = (s: OnboardingStep) =>
		s === 'welcome' ? resolve('/onboarding') : `${resolve('/onboarding')}/${s}`;
	const optional = $derived(STEP_INFO[step].optional && Boolean(onskip));

	function back(event: MouseEvent) {
		if (!onback || !previous) return;
		event.preventDefault();
		onback(pathOf(previous));
	}
</script>

<div class="step" data-step={step}>
	<header class="top">
		{#if previous}
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- pathOf() uses resolve() -->
			<a class="nav back" href={pathOf(previous)} onclick={back} data-testid="step-back">
				<Icon name="chevron-left" size={20} /> Back
			</a>
		{:else}
			<span></span>
		{/if}
		<span class="count numeric" aria-hidden="true">{index + 1} / {onboarding.steps.length}</span>
		<a class="nav later" href={resolve('/(app)/today')} data-testid="finish-later">Finish later</a>
	</header>

	<div
		class="progress"
		role="progressbar"
		aria-label="Setup progress"
		aria-valuemin={1}
		aria-valuemax={onboarding.steps.length}
		aria-valuenow={index + 1}
		aria-valuetext={`Step ${index + 1} of ${onboarding.steps.length}: ${STEP_INFO[step].title}`}
	>
		{#each onboarding.steps as s, i (s)}
			<span
				class="segment"
				class:done={i < index || onboarding.completed.includes(s) || onboarding.skipped.includes(s)}
				class:current={i === index}
			></span>
		{/each}
	</div>

	<div class="intro">
		<p class="eyebrow">
			{STEP_INFO[step].short}{#if STEP_INFO[step].optional}<span class="opt">· Optional</span>{/if}
		</p>
		<h1 class="title">{title}</h1>
		{#if lede}<p class="lede">{lede}</p>{/if}
	</div>

	<div class="body">
		{@render children()}
	</div>

	<div class="actions">
		{#if error}<Notice tone="danger" data-testid="step-error">{error}</Notice>{/if}
		<div class="buttons">
			{#if optional}
				<Button variant="ghost" size="lg" onclick={onskip} disabled={busy} data-testid="step-skip"
					>Skip</Button
				>
			{/if}
			<Button
				size="lg"
				block
				iconEnd="arrow-right"
				loading={busy}
				onclick={oncontinue}
				data-testid="step-continue">{continueLabel}</Button
			>
		</div>
	</div>
</div>

<style>
	.step {
		display: grid;
		min-height: calc(100dvh - var(--safe-top));
		grid-template-rows: auto auto auto 1fr auto;
	}

	.top {
		display: grid;
		grid-template-columns: 1fr auto 1fr;
		align-items: center;
		min-height: 3.25rem;
	}

	.nav {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		min-height: var(--touch-target);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}

	.back {
		margin-left: calc(-1 * var(--space-1));
		color: var(--color-text);
	}

	.later {
		justify-self: end;
	}

	.count {
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		color: var(--color-text-tertiary);
	}

	.progress {
		display: flex;
		gap: 3px;
		margin: var(--space-1) 0 var(--space-6);
	}

	.segment {
		flex: 1;
		height: 4px;
		border-radius: var(--radius-full);
		background: var(--color-surface-3);
		transition: background-color var(--duration-slow) var(--ease-standard);
	}

	.segment.done {
		background: color-mix(in srgb, var(--color-accent) 55%, var(--color-surface-3));
	}

	.segment.current {
		background: var(--color-accent);
		box-shadow: 0 0 10px color-mix(in srgb, var(--color-accent) 50%, transparent);
	}

	.intro {
		display: grid;
		gap: var(--space-2);
		margin-bottom: var(--space-6);
	}

	.eyebrow {
		font-size: var(--text-2xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
		color: var(--color-accent-text);
	}

	.opt {
		margin-left: var(--space-1);
		color: var(--color-text-tertiary);
	}

	.title {
		font-family: var(--font-display);
		font-size: var(--text-3xl);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-display);
		line-height: var(--leading-tight);
	}

	.lede {
		font-size: var(--text-base);
		color: var(--color-text-secondary);
	}

	.body {
		display: grid;
		align-content: start;
		gap: var(--space-6);
		padding-bottom: var(--space-8);
	}

	/* Pinned to the thumb zone; content scrolls under a short fade. */
	.actions {
		position: sticky;
		bottom: 0;
		z-index: var(--z-sticky);
		display: grid;
		gap: var(--space-3);
		margin: 0 calc(-1 * var(--gutter));
		padding: var(--space-6) var(--gutter) calc(var(--space-4) + var(--safe-bottom));
		background: linear-gradient(to bottom, transparent, var(--color-canvas) var(--space-6));
	}

	.buttons {
		display: flex;
		gap: var(--space-2);
	}
</style>
