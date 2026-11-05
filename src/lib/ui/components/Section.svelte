<!--
  @component
  A titled group of content on a screen ("This week", "Tools"): a quiet section heading over
  its children, labelled for assistive tech. Screens use it instead of styling their own
  headings so spacing and type stay identical everywhere.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		/** Gap between the children (the heading always sits 12 px above the first). */
		gap?: 'sm' | 'md';
		action?: Snippet;
		'data-testid'?: string;
		children: Snippet;
	}

	let { title, gap = 'sm', action, children, ...rest }: Props = $props();
	const id = $props.id();
</script>

<section class="section" data-gap={gap} aria-labelledby={id} {...rest}>
	<header class="head">
		<h2 {id} class="title">{title}</h2>
		{#if action}{@render action()}{/if}
	</header>
	{@render children()}
</section>

<style>
	.section {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-2);
	}

	.section[data-gap='md'] {
		gap: var(--space-3);
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		margin-bottom: var(--space-1);
	}

	.title {
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-normal);
		color: var(--color-text-secondary);
	}
</style>
