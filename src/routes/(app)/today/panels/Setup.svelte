<!--
  @component
  Today until onboarding is complete: how many of the steps that apply are done, and Continue to
  the step to resume at. Code-split behind PanelLoader.
-->
<script lang="ts">
	import { STEP_INFO } from '#lib/domain/profile/onboarding.ts';
	import Badge from '#lib/ui/components/Badge.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import Card from '#lib/ui/components/Card.svelte';
	import { stepHref } from '../../../onboarding/paths';
	import type { PageData } from '../$types';

	interface Props {
		setup: Extract<NonNullable<PageData['setup']>, { complete: false }>;
	}

	let { setup }: Props = $props();

	const started = $derived(setup.done > 0);
</script>

<Card tone="accent" padding="lg" data-testid="today-setup">
	<div class="session">
		<Badge tone="accent" icon="target">{started ? 'Setup in progress' : 'First step'}</Badge>
		<h2 class="session-title">
			{started ? 'Finish setting up your profile' : 'Set up your training profile'}
		</h2>
		<p class="session-copy">
			Your coach plans each week around your goals, schedule and recent training. About five
			minutes: skip what you don’t know yet, and change anything later in Profile.
		</p>
		<div class="progress">
			<p class="count numeric" data-testid="today-setup-count">
				{setup.done} of {setup.total} steps done
			</p>
			<!-- The count above says it in words; the bar only shows it. -->
			<span class="bar" aria-hidden="true">
				<span class="fill" style:width="{(setup.done / setup.total) * 100}%"></span>
			</span>
		</div>
		<Button
			href={stepHref(setup.next)}
			iconEnd="arrow-right"
			block
			data-testid="today-setup-continue"
		>
			{started ? `Continue: ${STEP_INFO[setup.next].title}` : 'Start setup'}
		</Button>
	</div>
</Card>

<style>
	/* The card fills the room Today holds for it: the progress and Continue sit at its foot. */
	.session {
		display: grid;
		grid-template-rows: auto auto auto 1fr auto;
		gap: var(--space-3);
		height: 100%;
	}

	.session-title {
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-display);
		line-height: var(--leading-tight);
	}

	.session-copy {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.progress {
		align-self: end;
		display: grid;
		gap: var(--space-2);
	}

	.count {
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}

	.bar {
		display: block;
		height: 0.375rem;
		border-radius: var(--radius-full);
		background: var(--color-surface-3);
		overflow: hidden;
	}

	.fill {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--color-accent);
	}
</style>
