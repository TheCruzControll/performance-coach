<!--
  @component
  The week's note (Instrument v2, Paper 4 · Train "The baseline week" and "A heads-up"): what the
  one line under Train's week opens, as a sheet, and from 1024 px the right-hand panel. Each part
  only when the week has it, in this order: the week's kind, its heads-ups (each once, with its
  why), what a weekly review changed, week 1's brief, a re-plan, and why each day holds its
  session; then, always, the way to ask the coach. With more than one part, each says what it is.
  Train loads it on intent; unlike v2/07a1's disclosure, it needs JavaScript.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import type { AsidePanel } from './cards.server';
	import type { NoteParts } from './week.server';

	interface Props {
		open: boolean;
		onclose?: () => void;
		/** The line that opened it: '1 heads-up this week', 'What week 1 is for'. */
		title: string;
		parts: NoteParts;
	}

	let { open = $bindable(), onclose, title, parts }: Props = $props();

	const COACH_HREF = resolve('/(app)/coach/[[thread]]', {});

	/** More than one part: each says what it is. */
	const headed = $derived(
		[
			parts.kind,
			parts.findings.length,
			parts.review,
			parts.baseline,
			parts.replan,
			parts.why.length
		].filter(Boolean).length > 1
	);
</script>

<!-- What a review changed (each change, then its links), or week 1's brief (its facts as rows). -->
{#snippet panel(part: AsidePanel)}
	<section data-testid={part.id}>
		{#if headed}<h3>{part.title}</h3>{/if}
		<p class="lead">{part.lead}</p>
		{#if part.id === 'review-notice'}
			<ul class="changes" role="list">
				{#each part.points as point, i (i)}
					<li>
						{#if point.lead}<strong>{point.lead}</strong>{/if}
						{point.text}
					</li>
				{/each}
			</ul>
		{:else}
			{#each part.points as point, i (i)}
				<ListRow static title={point.text} />
			{/each}
		{/if}
		<!-- eslint-disable svelte/no-navigation-without-resolve -- paths from cards.server.ts -->
		{#each part.links as link (link.id)}
			<ListRow title={link.label} href={link.href} data-testid={link.id} />
		{/each}
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
	</section>
{/snippet}

<BottomSheet bind:open {title} {onclose} desktop="panel" data-testid="week-note">
	<div class="note">
		{#if parts.kind}
			<section data-testid="week-kind">
				{#if headed}<h3>{parts.kind.label}</h3>{/if}
				<p class="lead">{parts.kind.why}</p>
			</section>
		{/if}
		{#if parts.findings.length}
			<section data-testid="week-findings">
				{#if headed}<h3>{parts.summary ?? 'Heads-ups'}</h3>{/if}
				{#each parts.findings as finding (finding.text)}
					<p class="finding" data-tone={finding.tone}>{finding.text}</p>
					<p class="why-line">Why: {finding.why}</p>
				{/each}
			</section>
		{/if}
		{#if parts.review}{@render panel(parts.review)}{/if}
		{#if parts.baseline}{@render panel(parts.baseline)}{/if}
		<!-- eslint-disable svelte/no-navigation-without-resolve -- a path from week.server.ts -->
		{#if parts.replan}
			<section>
				{#if headed}<h3>Your coach suggests a new plan</h3>{/if}
				<ListRow
					title="See the plan your coach suggests"
					href={parts.replan.href}
					data-testid="replan-review"
				/>
			</section>
		{/if}
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
		{#if parts.why.length}
			<section data-testid="week-why">
				{#if headed}<h3>Why each day holds its session</h3>{/if}
				{#each parts.why as why, i (i)}
					<details class="why">
						<summary>{why.title}</summary>
						<ul role="list">
							{#each why.lines as line, j (j)}<li>{line}</li>{/each}
						</ul>
					</details>
				{/each}
			</section>
		{/if}
		<div class="ask"><ListRow title="Ask the coach about it" href={COACH_HREF} /></div>
	</div>
</BottomSheet>

<style>
	.note {
		display: grid;
		gap: var(--space-6);
	}

	/* Paper, "A heads-up": "Ask the coach about it", a 60 px row with a hairline above. */
	.ask {
		border-top: 1px solid var(--color-hairline);
	}

	h3 {
		font: var(--type-row);
		font-weight: var(--weight-semibold);
		color: var(--color-text);
	}

	/* Paper, "The baseline week": the lead in 17/26 secondary, 12 px under the title. */
	.lead {
		font: var(--type-body);
		color: var(--color-text-secondary);
	}

	h3 + .lead {
		padding-top: var(--space-3);
	}

	/* A heads-up (Paper, "A heads-up"): its words in text colour, label first; a caution keeps
	   its warning dot. */
	.finding {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		font: var(--type-body);
		color: var(--color-text);
	}

	h3 ~ .finding,
	.why-line + .finding {
		padding-top: var(--space-3);
	}

	.finding::before {
		content: '';
		flex: none;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		box-shadow: inset 0 0 0 1.5px;
		transform: translateY(-0.1em);
	}

	.finding[data-tone='caution']::before {
		background: var(--color-warning);
	}

	/* 'Why: you moved Lower body to Monday.' 15/22 tertiary, 12 above and 20 below. */
	.why-line {
		padding: var(--space-3) 0 var(--space-5);
		font: var(--type-secondary);
		color: var(--color-text-tertiary);
	}

	.changes {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-3) 0;
		list-style: none;
		font: var(--type-secondary);
		color: var(--color-text-secondary);
	}

	.changes strong {
		font-weight: var(--weight-semibold);
		color: var(--color-text);
	}

	/* Why a day holds its session (m7/14): closed by default, its decisions under it. */
	.why {
		font: var(--type-secondary);
		color: var(--color-text-secondary);
	}

	.why summary {
		display: flex;
		align-items: center;
		min-height: var(--touch-target);
		list-style: none;
		cursor: pointer;
	}

	.why summary::-webkit-details-marker {
		display: none;
	}

	.why ul {
		display: grid;
		gap: var(--space-2);
		padding-bottom: var(--space-3);
		list-style: none;
	}

	@media (hover: hover) and (pointer: fine) {
		.why summary:hover {
			color: var(--color-text);
		}
	}
</style>
