<!--
  @component
  A Surface with an optional header row (eyebrow, title, trailing action). Legacy in v2: no new
  use; screen rows remove it.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Surface from './Surface.svelte';

	interface Props {
		eyebrow?: string;
		title?: string;
		level?: 1 | 2 | 3;
		padding?: 'sm' | 'md' | 'lg';
		tone?:
			'default' | 'accent' | 'strength' | 'running' | 'combat' | 'hypertrophy' | 'conditioning';
		href?: string;
		as?: 'div' | 'section' | 'article' | 'li';
		action?: Snippet;
		'data-testid'?: string;
		children: Snippet;
	}

	let {
		eyebrow,
		title,
		level = 1,
		padding = 'md',
		tone = 'default',
		href,
		as = 'section',
		action,
		children,
		...rest
	}: Props = $props();

	const titleId = $props.id();
</script>

<Surface
	{level}
	{padding}
	{tone}
	{href}
	{as}
	aria-labelledby={title ? titleId : undefined}
	{...rest}
>
	{#if eyebrow || title || action}
		<header class="head">
			<div class="titles">
				{#if eyebrow}<span class="eyebrow">{eyebrow}</span>{/if}
				{#if title}<h2 id={titleId} class="title">{title}</h2>{/if}
			</div>
			{#if action}<div class="action">{@render action()}</div>{/if}
		</header>
	{/if}
	{@render children()}
</Surface>

<style>
	.head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-3);
		margin-bottom: var(--space-3);
	}

	.titles {
		display: grid;
		gap: var(--space-1);
		min-width: 0;
	}

	/* The eyebrow keeps the global .eyebrow type and takes the tertiary text. */
	.eyebrow {
		color: var(--color-text-tertiary);
	}

	/* The line box keeps its pre-v2 height (19 px × 1.1875), so the header does not move. */
	.title {
		font: var(--type-row);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-normal);
		line-height: calc(var(--text-lg) * var(--leading-snug));
	}

	.action {
		flex: none;
		margin: calc(var(--space-2) * -1) calc(var(--space-2) * -1) 0 0;
	}
</style>
