<script lang="ts">
	import { resolve } from '$app/paths';
	import BrandMark from '#lib/ui/components/BrandMark.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import type { IconName } from '#lib/ui/icons/icons.ts';
	import { toast } from '#lib/ui/toast.svelte.ts';

	const pillars: { icon: IconName; title: string; text: string }[] = [
		{
			icon: 'target',
			title: 'Adaptive programming',
			text: 'Plans that change with every logged set.'
		},
		{
			icon: 'bolt',
			title: 'Instant logging',
			text: 'One-handed, offline-first, never loses a set.'
		},
		{
			icon: 'sparkle',
			title: 'A coach that shows its work',
			text: 'Facts, metrics and advice — labelled.'
		}
	];

	function signIn() {
		toast.show('Passkey sign-in arrives in the next milestone. Use the preview for now.');
	}
</script>

<svelte:head>
	<title>Performance Coach</title>
</svelte:head>

<div class="landing">
	<div class="backdrop" aria-hidden="true">
		<BrandMark size={520} />
	</div>

	<header class="brand">
		<BrandMark size={30} />
		<span class="wordmark">Performance Coach</span>
	</header>

	<main id="main" class="hero" tabindex="-1">
		<p class="eyebrow">Private performance coaching</p>
		<h1 class="headline">Train with<br />intent.</h1>
		<p class="lede">
			An AI coach that plans, adapts and explains — built on every set, run and round you log.
		</p>

		<ul class="pillars">
			{#each pillars as p (p.title)}
				<li class="pillar">
					<span class="pillar-icon"><Icon name={p.icon} size={20} /></span>
					<span>
						<span class="pillar-title">{p.title}</span>
						<span class="pillar-text">{p.text}</span>
					</span>
				</li>
			{/each}
		</ul>
	</main>

	<footer class="actions">
		<Button size="lg" block icon="key" onclick={signIn} data-testid="passkey-signin">
			Sign in with passkey
		</Button>
		<Button size="lg" block variant="ghost" href={resolve('/(app)/today')} iconEnd="arrow-right">
			Preview the app
		</Button>
		<p class="fine">Private · Single user · coach.nikocruz.com</p>
	</footer>
</div>

<style>
	.landing {
		position: relative;
		display: flex;
		flex-direction: column;
		min-height: 100dvh;
		max-width: var(--content-max);
		margin: 0 auto;
		padding: calc(var(--safe-top) + var(--space-6)) max(var(--gutter), var(--safe-right))
			calc(var(--safe-bottom) + var(--space-6)) max(var(--gutter), var(--safe-left));
		overflow: hidden;
		isolation: isolate;
	}

	.backdrop {
		position: absolute;
		z-index: -1;
		top: -6rem;
		right: -15rem;
		color: var(--color-text);
		opacity: 0.11;
		filter: blur(0.5px);
		pointer-events: none;
	}

	.backdrop::after {
		content: '';
		position: absolute;
		inset: 20%;
		border-radius: 50%;
		background: radial-gradient(
			circle,
			color-mix(in srgb, var(--color-accent) 50%, transparent),
			transparent 65%
		);
		filter: blur(60px);
	}

	.brand {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		color: var(--color-text);
	}

	.wordmark {
		font-family: var(--font-display);
		font-size: var(--text-base);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-tight);
	}

	.hero {
		flex: 1;
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: var(--space-5);
		padding: var(--space-12) 0 var(--space-8);
		outline: none;
	}

	.eyebrow {
		color: var(--color-accent-text);
	}

	.headline {
		font-family: var(--font-display);
		font-size: clamp(var(--text-5xl), 15vw, var(--text-6xl));
		font-weight: var(--weight-black);
		line-height: 0.95;
		letter-spacing: -0.045em;
	}

	.lede {
		max-width: 30ch;
		font-size: var(--text-lg);
		line-height: var(--leading-snug);
		color: var(--color-text-secondary);
	}

	.pillars {
		display: grid;
		gap: var(--space-4);
		margin: var(--space-4) 0 0;
		padding: 0;
		list-style: none;
	}

	.pillar {
		display: flex;
		align-items: flex-start;
		gap: var(--space-3);
	}

	.pillar-icon {
		display: grid;
		place-items: center;
		flex: none;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: var(--radius-sm);
		background: var(--color-surface-2);
		border: 1px solid var(--color-border);
		color: var(--color-accent-text);
	}

	.pillar-title {
		display: block;
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	.pillar-text {
		display: block;
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.actions {
		display: grid;
		gap: var(--space-2);
	}

	.fine {
		margin-top: var(--space-3);
		text-align: center;
		font-size: var(--text-xs);
		color: var(--color-text-tertiary);
	}
</style>
