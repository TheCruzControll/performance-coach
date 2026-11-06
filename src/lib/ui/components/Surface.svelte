<!--
  @component
  The base container of the system. Depth comes from tone + a top highlight rather than heavy
  shadows (dark-first). `interactive` adds a pressed state; `href` renders a link.
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
	.surface {
		--surface-bg: var(--color-surface-1);
		--tone: transparent;
		position: relative;
		display: block;
		background:
			linear-gradient(
				180deg,
				color-mix(in srgb, var(--tone) 9%, transparent),
				color-mix(in srgb, var(--tone) 2%, transparent) 70%
			),
			var(--surface-bg);
		border: 1px solid var(--color-border);
		box-shadow: var(--elevation-1);
		color: var(--color-text);
	}

	.surface[data-level='2'] {
		--surface-bg: var(--color-surface-2);
		box-shadow: var(--elevation-2);
	}
	.surface[data-level='3'] {
		--surface-bg: var(--color-surface-3);
		box-shadow: var(--elevation-3);
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

	.surface[data-radius='md'] {
		border-radius: var(--radius-md);
	}
	.surface[data-radius='lg'] {
		border-radius: var(--radius-lg);
	}
	.surface[data-radius='xl'] {
		border-radius: var(--radius-xl);
	}

	.surface[data-tone='accent'] {
		--tone: var(--color-accent);
	}
	.surface[data-tone='strength'] {
		--tone: var(--color-strength);
	}
	.surface[data-tone='running'] {
		--tone: var(--color-running);
	}
	.surface[data-tone='combat'] {
		--tone: var(--color-combat);
	}
	.surface[data-tone='hypertrophy'] {
		--tone: var(--color-hypertrophy);
	}
	.surface[data-tone='conditioning'] {
		--tone: var(--color-conditioning);
	}

	.interactive {
		cursor: pointer;
		transition:
			transform var(--duration-fast) var(--ease-out),
			border-color var(--duration-fast) var(--ease-standard),
			background-color var(--duration-fast) var(--ease-standard);
	}
	.interactive:active {
		transform: scale(0.985);
		border-color: var(--color-border-strong);
		transition-duration: var(--duration-instant);
	}
	@media (hover: hover) and (pointer: fine) {
		.interactive:hover {
			border-color: var(--color-border-strong);
		}
	}
</style>
