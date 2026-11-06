<!--
  @component
  Week 1's baseline instructions on a strength session: why this session sets the loads ahead,
  how to work up to the target effort and what to record. The copy is session-words.ts's
  BASELINE_CALLOUT, composed on the server, so it ships in no screen's JavaScript.
-->
<script lang="ts">
	import Icon from '../components/Icon.svelte';
	import Surface from '../components/Surface.svelte';

	interface Props {
		eyebrow: string;
		title: string;
		lead: string;
		points: readonly string[];
		'data-testid'?: string;
	}

	let { eyebrow, title, lead, points, 'data-testid': testId }: Props = $props();
	const id = $props.id();
</script>

<Surface as="section" tone="accent" aria-labelledby={id} data-testid={testId}>
	<div class="callout">
		<span class="eyebrow"><Icon name="target" size={14} />{eyebrow}</span>
		<h2 {id} class="title">{title}</h2>
		<p>{lead}</p>
		<ol class="points">
			{#each points as point (point)}<li>{point}</li>{/each}
		</ol>
	</div>
</Surface>

<style>
	.callout {
		display: grid;
		gap: var(--space-3);
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
		color: var(--color-text-secondary);
	}

	.eyebrow {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1-5);
		color: var(--color-accent-text);
	}

	.title {
		margin-top: calc(var(--space-2) * -1);
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-tight);
		line-height: var(--leading-snug);
		color: var(--color-text);
	}

	.points {
		display: grid;
		gap: var(--space-1-5);
		margin: 0;
		padding-left: var(--space-5);
	}
</style>
