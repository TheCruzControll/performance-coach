<!--
  @component
  An exercise's set prescriptions, or a run's steps, in describe.ts's words: one line each, in
  order. A set reads '3 × 5 @ RPE 7' with its load beside it ('125 kg') only when describe could
  compute one, then what the load is a fraction of, the rest and the tempo; a baseline set says
  what to record. A run step reads '6 × (Interval 400 m + Recovery 1:30)' with each segment's pace
  and effort under it. The caller describes (describePrescription, describeSegments) in the
  owner's units, so nothing here computes, rounds or invents a number.
-->
<script lang="ts">
	import type { PrescriptionWords, RunStep, SegmentWords } from '#lib/domain/training/describe.ts';
	import Icon from '../components/Icon.svelte';

	interface Props {
		/** The list's accessible name: the exercise, or the run. */
		label: string;
		/** describePrescription's words, one per set prescription. */
		sets?: readonly PrescriptionWords[];
		/** describeSegments' steps. */
		steps?: readonly RunStep[];
	}

	let { label, sets = [], steps = [] }: Props = $props();

	const joined = (parts: readonly (string | null)[]) =>
		parts.filter((part) => part !== null).join(' · ');
	const effort = (segment: SegmentWords) => joined([segment.pace, segment.target]);
</script>

<ol class="lines" aria-label={label}>
	{#each sets as set, i (i)}
		<li class="line">
			<p class="head">
				<span class="headline">{set.headline}</span>
				{#if set.load}<span class="load numeric">{set.load}</span>{/if}
			</p>
			{#if set.instruction}
				<p class="instruction"><Icon name="target" size={16} />{set.instruction}</p>
			{/if}
			{#if joined([set.basis, set.rest, set.tempo])}
				<p class="detail">{joined([set.basis, set.rest, set.tempo])}</p>
			{/if}
		</li>
	{/each}
	{#each steps as step, i (i)}
		<li class="line">
			<p class="head"><span class="headline">{step.headline}</span></p>
			{#if step.segments.length === 1}
				{#if effort(step.segments[0]!)}<p class="detail">{effort(step.segments[0]!)}</p>{/if}
			{:else}
				<ul class="segments">
					{#each step.segments as segment, j (j)}
						<li class="detail">{joined([segment.headline, effort(segment) || null])}</li>
					{/each}
				</ul>
			{/if}
		</li>
	{/each}
</ol>

<style>
	.lines {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.line {
		display: grid;
		gap: var(--space-1);
		padding: var(--space-3) 0;
	}

	.line + .line {
		border-top: 1px solid var(--color-hairline);
	}

	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.headline {
		min-width: 0;
		font-weight: var(--weight-semibold);
		overflow-wrap: anywhere;
	}

	.load {
		flex: none;
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
	}

	.instruction {
		display: flex;
		align-items: flex-start;
		gap: var(--space-1-5);
		font-size: var(--text-sm);
	}

	.instruction :global(.icon) {
		margin-top: 0.125rem;
		color: var(--color-accent-text);
	}

	.detail {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.segments {
		display: grid;
		gap: var(--space-0-5);
		margin: 0;
		padding: 0;
		list-style: none;
	}
</style>
