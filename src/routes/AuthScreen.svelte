<!--
  @component
  Frame for the screens outside the app shell (sign-in, first-run setup, recovery): the brand
  row, a large editorial headline and, pinned to the thumb zone at the bottom, the panel that
  holds the one thing to do next. The brand mark sits behind as a quiet watermark.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import BrandMark from '#lib/ui/components/BrandMark.svelte';

	interface Props {
		eyebrow: string;
		title: string;
		lede?: string;
		/** Extra content between the headline and the action panel. */
		body?: Snippet;
		/** The action panel (forms, buttons). */
		children: Snippet;
		footer?: Snippet;
		'data-testid'?: string;
	}

	let { eyebrow, title, lede, body, children, footer, 'data-testid': testId }: Props = $props();
</script>

<div class="screen" data-testid={testId}>
	<div class="backdrop" aria-hidden="true">
		<BrandMark size={520} />
	</div>

	<header class="brand">
		<BrandMark size={28} />
		<span class="wordmark">Performance Coach</span>
	</header>

	<main id="main" class="content" tabindex="-1">
		<div class="hero">
			<p class="eyebrow">{eyebrow}</p>
			<h1 class="headline">{title}</h1>
			{#if lede}<p class="lede">{lede}</p>{/if}
		</div>
		{#if body}<div class="body">{@render body()}</div>{/if}
		<div class="panel">{@render children()}</div>
	</main>

	{#if footer}<footer class="footer">{@render footer()}</footer>{/if}
</div>

<style>
	.screen {
		position: relative;
		display: flex;
		flex-direction: column;
		min-height: 100dvh;
		max-width: var(--content-max);
		margin: 0 auto;
		padding: calc(var(--safe-top) + var(--space-4)) max(var(--gutter), var(--safe-right))
			calc(var(--safe-bottom) + var(--space-4)) max(var(--gutter), var(--safe-left));
		overflow: hidden;
		isolation: isolate;
	}

	.backdrop {
		position: absolute;
		z-index: -1;
		top: -6rem;
		right: -15rem;
		color: var(--color-text);
		opacity: 0.09;
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

	.content {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: var(--space-6);
		padding-top: var(--space-6);
		outline: none;
	}

	.hero {
		flex: 1;
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: var(--space-4);
		min-height: 12rem;
	}

	.eyebrow {
		color: var(--color-accent-text);
	}

	.headline {
		font-family: var(--font-display);
		font-size: clamp(var(--text-4xl), 12.5vw, var(--text-6xl));
		font-weight: var(--weight-black);
		line-height: 0.95;
		letter-spacing: -0.045em;
		text-wrap: balance;
	}

	.lede {
		max-width: 32ch;
		font-size: var(--text-lg);
		line-height: var(--leading-snug);
		color: var(--color-text-secondary);
	}

	.body {
		display: grid;
		gap: var(--space-4);
	}

	.panel {
		display: grid;
		gap: var(--space-3);
	}

	.footer {
		display: grid;
		justify-items: center;
		gap: var(--space-1);
		margin-top: var(--space-4);
		text-align: center;
		font-size: var(--text-xs);
		color: var(--color-text-tertiary);
	}
</style>
