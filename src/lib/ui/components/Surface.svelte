<!--
  @component
  The base container of the system. Legacy in v2: no new use; screen rows remove it. It keeps
  its padding and draws a hairline outline, with no fill, tint or shadow, and every radius is
  the card radius. `interactive` adds the list-row tint (no scale); `href` renders a link.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		level?: 1 | 2 | 3;
		padding?: 'none' | 'sm' | 'md' | 'lg';
		radius?: 'md' | 'lg' | 'xl';
		as?: 'div' | 'section' | 'article' | 'li' | 'aside';
		href?: string;
		interactive?: boolean;
		tone?:
			'default' | 'accent' | 'strength' | 'running' | 'combat' | 'hypertrophy' | 'conditioning';
		class?: string;
		'aria-labelledby'?: string;
		'aria-label'?: string;
		'data-testid'?: string;
		children: Snippet;
	}

	let {
		level = 1,
		padding = 'md',
		radius = 'lg',
		as = 'div',
		href,
		interactive = false,
		tone = 'default',
		class: className,
		children,
		...rest
	}: Props = $props();
</script>

{#if href}
	<a
		{href}
		class={['surface', 'interactive', className]}
		data-level={level}
		data-padding={padding}
		data-radius={radius}
		data-tone={tone}
		{...rest}
	>
		{@render children()}
	</a>
{:else}
	<svelte:element
		this={as}
		class={['surface', interactive && 'interactive', className]}
		data-level={level}
		data-padding={padding}
		data-radius={radius}
		data-tone={tone}
		{...rest}
	>
		{@render children()}
	</svelte:element>
{/if}

<style>
	/* Legacy in v2: the hairline outline stays until the screen rows drop the card. The tone is
	   accepted and no longer tints anything. */
	.surface {
		position: relative;
		display: block;
		background: transparent;
		border: 1px solid var(--color-hairline);
		border-radius: var(--radius-lg);
		box-shadow: none;
		color: var(--color-text);
	}

	.surface[data-padding='none'] {
		padding: 0;
	}
	.surface[data-padding='sm'] {
		padding: var(--space-3);
	}
	.surface[data-padding='md'] {
		padding: var(--space-4);
	}
	.surface[data-padding='lg'] {
		padding: var(--space-6);
	}

	.interactive {
		cursor: pointer;
	}

	.interactive:active {
		background: var(--color-surface-2);
	}
	@media (hover: hover) and (pointer: fine) {
		.interactive:hover {
			background: var(--color-surface-2);
		}
	}
</style>
