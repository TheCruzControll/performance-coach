<!--
  @component
  Progress → Strength: what is improving, and whether volume and effort are where they should be
  (M6, PRD §10). Server-rendered from strength-data.ts.

  - A new owner, or one in the first week, is told what appears and when, never a ghost chart.
  - Under that the trends (StrengthTrends): the key lifts' e1RM small multiples with their
    verdicts, the weekly volume, the muscle groups, effort and the PRs, in a chunk of their own
    that loads after hydration, served as static markup until it has (trends.ts,
    StrengthTrendsLoader), so only this intro's code counts towards initial JS.
-->
<script lang="ts">
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import type { StrengthData } from './strength-data';
	import StrengthTrendsLoader from './StrengthTrendsLoader.svelte';

	interface Props {
		strength: StrengthData;
		/** The trends as the server rendered them (+page.ts, trends.ts). */
		served?: string;
	}

	let { strength: s, served }: Props = $props();
</script>

<div class="pc-strength-view" data-stage={s.stage} data-testid="strength">
	{#if s.stage !== 'history'}
		<EmptyState
			icon={s.stage === 'first_week' ? 'sparkle' : 'progress'}
			tone="strength"
			title={s.stage === 'first_week'
				? 'Your first week of lifting is under way'
				: 'Your strength trends start with your first lift'}
			description={s.stage === 'first_week'
				? 'Totals, ranges and trends count complete weeks, so they start after Sunday. This week so far is below.'
				: 'Log a strength session and your estimated 1RMs, weekly volume, muscle groups, RPE and records appear here.'}
			data-testid="strength-intro"
		/>
	{/if}
	{#if s.stage !== 'new'}
		<StrengthTrendsLoader strength={s} {served} />
	{/if}
</div>

<style>
	.pc-strength-view {
		display: grid;
		gap: var(--space-6);
		min-width: 0;
	}
</style>
