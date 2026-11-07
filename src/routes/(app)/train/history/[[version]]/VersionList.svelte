<!--
  @component
  History's versions, newest first, each a card: a link to the version's read-only week, named
  by its number, a 'Current' badge on the current one, what changed, and when and by whom
  ('Mon 2 Nov · 09:17 · You'); then every decision it made with its why (DecisionItem). The link
  is ≥ 44 px with hover, pressed and focus states, and aria-busy while it navigates (`navigating`),
  with a progress line along its edge, as a SessionCard does.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { navigating } from '$app/state';
	import Badge from '#lib/ui/components/Badge.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import DecisionItem from './DecisionItem.svelte';
	import type { VersionRowView } from './history.server';

	let { versions }: { versions: readonly VersionRowView[] } = $props();
</script>

<ol class="versions" aria-label="Versions">
	{#each versions as version (version.number)}
		{@const href = resolve('/(app)/train/history/[[version]]', { version: String(version.number) })}
		{@const pending = navigating.to?.url.pathname === href}
		<li class="version" data-testid="version">
			<a class="head" {href} aria-busy={pending ? 'true' : undefined} data-testid="version-link">
				<span class="text">
					<span class="title">
						<span class="number numeric">Version {version.number}</span>
						{#if version.current}<Badge tone="accent">Current</Badge>{/if}
					</span>
					<span class="summary">{version.summary}</span>
					<span class="meta">{version.when} · {version.by}</span>
				</span>
				<Icon name="chevron-right" size={20} class="chevron" />
				{#if pending}<span class="progress"></span>{/if}
			</a>
			{#if version.decisions.length}
				<ul class="decisions" aria-label={`Version ${version.number}: decisions`}>
					{#each version.decisions as decision (decision.id)}
						<DecisionItem {decision} />
					{/each}
				</ul>
			{/if}
		</li>
	{/each}
</ol>

<style>
	.versions {
		display: grid;
		gap: var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.version {
		overflow: hidden;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-surface-1);
		box-shadow: var(--elevation-1);
		transition: border-color var(--duration-fast) var(--ease-standard);
	}

	.head {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		column-gap: var(--space-3);
		min-height: var(--touch-target);
		padding: var(--space-4);
		color: var(--color-text);
		transition: background-color var(--duration-fast) var(--ease-standard);
	}

	.head:active {
		background: var(--color-surface-2);
		transition-duration: var(--duration-instant);
	}

	/* The card's border strengthens, as a SessionCard's does. */
	@media (hover: hover) and (pointer: fine) {
		.version:has(.head:hover) {
			border-color: var(--color-border-strong);
		}
	}

	.head:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: -2px;
		border-radius: var(--radius-lg);
	}

	.text {
		display: grid;
		gap: var(--space-1);
		min-width: 0;
	}

	.title {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.number {
		font-weight: var(--weight-semibold);
		line-height: var(--leading-snug);
	}

	.summary {
		line-height: var(--leading-snug);
		overflow-wrap: anywhere;
	}

	.meta {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.head :global(.chevron) {
		color: var(--color-text-tertiary);
		transition: opacity var(--duration-fast) var(--ease-standard);
	}

	.head[aria-busy='true'] {
		cursor: progress;
	}

	.head[aria-busy='true'] :global(.chevron) {
		opacity: 0.35;
	}

	/* Pending: a line sweeps along the link's bottom edge; still, under reduced motion. */
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

	.decisions {
		display: grid;
		gap: var(--space-3);
		margin: 0;
		padding: var(--space-3) var(--space-4) var(--space-4);
		border-top: 1px solid var(--color-hairline);
		list-style: none;
	}
</style>
