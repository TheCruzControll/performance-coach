<!--
  @component
  A planned session as a card: its discipline's dot (a ring once skipped), its title, and what it
  is in words, 'Strength · 60 min · Hard · Evening'. Its status is a badge in words (Skipped,
  Moved from Mon, Done; a planned session shows none), and a week-1 baseline session says
  Baseline. With `href` the whole card is one link, named by everything it shows (label in name),
  ≥ 44 px, with hover, pressed and focus states; `pending` marks it aria-busy, with a progress
  line along its edge, while that link navigates. Words carry every state; colour only reinforces.
  It lays out the words cardView composed where the week was read (words.ts).
-->
<script lang="ts">
	import type { IconName } from '../icons/icons';
	import Badge from '../components/Badge.svelte';
	import Icon from '../components/Icon.svelte';
	import type { CardView } from './words.ts';

	interface Props {
		session: CardView;
		/** A resolved link to the session; without one the card is read-only. */
		href?: string;
		/** A week-1 session that establishes a baseline. */
		baseline?: boolean;
		/** Its link is navigating (`navigating.to` is this card's page). */
		pending?: boolean;
		'data-testid'?: string;
	}

	let { session, href, baseline = false, pending = false, 'data-testid': testId }: Props = $props();

	const STATUS_BADGE: Record<
		CardView['status'],
		{ tone: 'neutral' | 'positive'; icon: IconName } | null
	> = {
		planned: null,
		skipped: { tone: 'neutral', icon: 'close' },
		moved: { tone: 'neutral', icon: 'today' },
		completed: { tone: 'positive', icon: 'check' }
	};

	const status = $derived(STATUS_BADGE[session.status]);
	const tone = $derived(`var(--color-${session.tone})`);
</script>

{#snippet body()}
	<span class="dot" class:ring={session.status === 'skipped'} style:--tone={tone}></span>
	<span class="text">
		<span class="title">{session.title}</span>
		<span class="line">{session.line}</span>
		{#if baseline || status}
			<span class="badges">
				{#if baseline}<Badge icon="target">Baseline</Badge>{/if}
				{#if status}<Badge tone={status.tone} icon={status.icon}>{session.statusWords}</Badge>{/if}
			</span>
		{/if}
	</span>
	{#if href}<Icon name="chevron-right" size={20} class="chevron" />{/if}
	{#if pending}<span class="progress"></span>{/if}
{/snippet}

{#if href}
	<a
		{href}
		class="card"
		data-status={session.status}
		aria-busy={pending ? 'true' : undefined}
		data-testid={testId}
	>
		{@render body()}
	</a>
{:else}
	<div class="card" data-status={session.status} data-testid={testId}>{@render body()}</div>
{/if}

<style>
	.card {
		position: relative;
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: start;
		column-gap: var(--space-3);
		min-height: var(--touch-target);
		padding: var(--space-4);
		overflow: hidden;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-surface-1);
		box-shadow: var(--elevation-1);
		color: var(--color-text);
	}

	a.card {
		transition:
			transform var(--duration-fast) var(--ease-out),
			border-color var(--duration-fast) var(--ease-standard);
	}

	a.card:active {
		transform: scale(0.985);
		border-color: var(--color-border-strong);
		transition-duration: var(--duration-instant);
	}

	@media (hover: hover) and (pointer: fine) {
		a.card:hover {
			border-color: var(--color-border-strong);
		}
	}

	a.card:focus-visible {
		outline-offset: 2px;
		border-radius: var(--radius-lg);
	}

	.dot {
		width: 0.5rem;
		height: 0.5rem;
		/* Centred on the title's first line. */
		margin-top: 0.4375rem;
		border-radius: 50%;
		background: var(--tone);
	}

	.dot.ring {
		background: none;
		box-shadow: inset 0 0 0 1.5px var(--tone);
	}

	.text {
		display: grid;
		gap: var(--space-1);
		min-width: 0;
	}

	.title {
		font-weight: var(--weight-semibold);
		line-height: var(--leading-snug);
		overflow-wrap: anywhere;
	}

	.card[data-status='skipped'] .title {
		color: var(--color-text-secondary);
	}

	.line {
		font-size: var(--text-sm);
		line-height: var(--leading-snug);
		color: var(--color-text-secondary);
	}

	.badges {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1-5);
		margin-top: var(--space-1);
	}

	.card :global(.chevron) {
		align-self: center;
		color: var(--color-text-tertiary);
		transition: opacity var(--duration-fast) var(--ease-standard);
	}

	.card[aria-busy='true'] {
		cursor: progress;
	}

	.card[aria-busy='true'] :global(.chevron) {
		opacity: 0.35;
	}

	/* Pending: a line sweeps along the bottom edge; still, under reduced motion. */
	.progress {
		position: absolute;
		inset: auto 0 0;
		height: 2px;
		background: linear-gradient(90deg, transparent, var(--color-accent-text), transparent);
		animation: sweep 1.2s var(--ease-standard) infinite;
	}

	@keyframes sweep {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(100%);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.progress {
			animation: none;
			opacity: 0.6;
		}
	}
</style>
