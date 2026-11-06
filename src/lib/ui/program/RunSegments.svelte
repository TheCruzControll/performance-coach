<!--
  @component
  A structured run, step by step, in describe.ts's words (describeSegments): the warm-up, each
  repeat group as one bracketed block ('6×', then its interval and recovery), the cool-down, and
  each segment's pace and effort under it. The caller describes in the owner's distance unit, so
  nothing here converts, computes or invents a number.
-->
<script lang="ts">
	import type { RunStep, SegmentWords } from '#lib/domain/training/describe.ts';

	interface Props {
		/** The list's accessible name: the run. */
		label: string;
		steps: readonly RunStep[];
		'data-testid'?: string;
	}

	let { label, steps, 'data-testid': testId }: Props = $props();

	const effort = (segment: SegmentWords) =>
		[segment.pace, segment.target].filter((part) => part !== null).join(' · ');
</script>

<ol class="steps" aria-label={label} data-testid={testId}>
	{#each steps as step, i (i)}
		<li class="step" class:repeat={step.repeats > 1} data-testid="run-step">
			{#if step.repeats > 1}
				<p class="times">
					<span class="count numeric" aria-hidden="true">{step.repeats}×</span>
					Repeat {step.repeats} times
				</p>
			{/if}
			<ol class="segments">
				{#each step.segments as segment, j (j)}
					<li class="segment">
						<span class="headline">{segment.headline}</span>
						{#if effort(segment)}<span class="effort">{effort(segment)}</span>{/if}
					</li>
				{/each}
			</ol>
		</li>
	{/each}
</ol>

<style>
	/* A timeline: a dot per step in the running colour, on a rail that joins them. */
	.steps {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.step {
		position: relative;
		padding: 0 0 var(--space-4) var(--space-6);
	}

	.step:last-child {
		padding-bottom: 0;
	}

	.step::before {
		content: '';
		position: absolute;
		top: 0.4375rem;
		left: 0.1875rem;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background: var(--color-running);
	}

	.step:not(:last-child)::after {
		content: '';
		position: absolute;
		top: 1.25rem;
		bottom: 0.25rem;
		left: 0.40625rem;
		width: 1.5px;
		background: var(--color-border-strong);
	}

	.segment {
		display: grid;
		gap: var(--space-0-5);
	}

	.headline {
		font-weight: var(--weight-semibold);
		overflow-wrap: anywhere;
	}

	.effort {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	/* A repeat group: one bracketed block, its count over its segments. */
	.repeat > .times,
	.repeat > .segments {
		padding-inline: var(--space-4);
		border-inline: 1px solid var(--color-border);
		background: var(--color-surface-2);
	}

	.repeat > .times {
		padding-block: var(--space-3);
		border-top: 1px solid var(--color-border);
		border-radius: var(--radius-md) var(--radius-md) 0 0;
	}

	.repeat > .segments {
		padding-bottom: var(--space-4);
		border-bottom: 1px solid var(--color-border);
		border-radius: 0 0 var(--radius-md) var(--radius-md);
	}

	/* The repeat block's dot sits level with its count. */
	.repeat::before {
		top: 1.375rem;
	}

	.times {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}

	.count {
		font-size: var(--text-lg);
		font-weight: var(--weight-bold);
		color: var(--color-text);
	}

	.segments {
		display: grid;
		gap: var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}
</style>
