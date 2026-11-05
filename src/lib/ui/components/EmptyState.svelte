<!--
  @component
  Designed empty state: a quiet glyph medallion, a clear title, one or two sentences of
  guidance and (optionally) a single next action.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { IconName } from '../icons/icons';
	import Icon from './Icon.svelte';

	interface Props {
		icon: IconName;
		title: string;
		description?: string;
		tone?:
			'accent' | 'neutral' | 'strength' | 'running' | 'combat' | 'hypertrophy' | 'conditioning';
		compact?: boolean;
		actions?: Snippet;
		'data-testid'?: string;
	}

	let {
		icon,
		title,
		description,
		tone = 'accent',
		compact = false,
		actions,
		'data-testid': testId
	}: Props = $props();
</script>

<div class="empty" class:compact data-tone={tone} data-testid={testId}>
	<div class="medallion" aria-hidden="true">
		<span class="ring"></span>
		<Icon name={icon} size={compact ? 22 : 28} />
	</div>
	<div class="copy">
		<h2 class="title">{title}</h2>
		{#if description}<p class="description">{description}</p>{/if}
	</div>
	{#if actions}<div class="actions">{@render actions()}</div>{/if}
</div>

<style>
	.empty {
		--tone: var(--color-accent-text);
		display: grid;
		justify-items: center;
		gap: var(--space-4);
		padding: var(--space-8) var(--space-4);
		text-align: center;
	}

	.compact {
		gap: var(--space-3);
		padding: var(--space-6) var(--space-2);
	}

	.empty[data-tone='neutral'] {
		--tone: var(--color-text-secondary);
	}
	.empty[data-tone='strength'] {
		--tone: var(--color-strength);
	}
	.empty[data-tone='running'] {
		--tone: var(--color-running);
	}
	.empty[data-tone='combat'] {
		--tone: var(--color-combat);
	}
	.empty[data-tone='hypertrophy'] {
		--tone: var(--color-hypertrophy);
	}
	.empty[data-tone='conditioning'] {
		--tone: var(--color-conditioning);
	}

	.medallion {
		position: relative;
		display: grid;
		place-items: center;
		width: 4.5rem;
		height: 4.5rem;
		border-radius: 50%;
		color: var(--tone);
		background: radial-gradient(
			circle at 50% 35%,
			color-mix(in srgb, var(--tone) 18%, transparent),
			color-mix(in srgb, var(--tone) 4%, transparent) 70%
		);
	}

	.compact .medallion {
		width: 3.5rem;
		height: 3.5rem;
	}

	.ring {
		position: absolute;
		inset: 0;
		border-radius: 50%;
		border: 1px solid color-mix(in srgb, var(--tone) 30%, transparent);
	}

	.ring::after {
		content: '';
		position: absolute;
		inset: -9px;
		border-radius: 50%;
		border: 1px dashed color-mix(in srgb, var(--tone) 16%, transparent);
	}

	.copy {
		display: grid;
		gap: var(--space-2);
		max-width: 30ch;
	}

	.title {
		font-size: var(--text-xl);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-tight);
		line-height: var(--leading-snug);
	}

	.compact .title {
		font-size: var(--text-lg);
	}

	.description {
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
		color: var(--color-text-secondary);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: var(--space-2);
		margin-top: var(--space-1);
	}
</style>
