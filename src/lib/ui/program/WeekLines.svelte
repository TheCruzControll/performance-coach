<!--
  @component
  A week as Instrument v2 lays it out (v2/07): one 60 px line per session, the day in a fixed
  column, the title, and at the end a tick once done, 'Skipped' or the length; a rest day is a
  line that says Rest and links nowhere. Before today the line is quiet, today's is in text
  colour and 600, and the rest of the week reads in text colour. Words from week-lines.ts.
  `href` makes a session line a link (Train, a version's week); without it no line is.
-->
<script lang="ts">
	import Icon from '../components/Icon.svelte';
	import type { WeekLine } from './week-lines.ts';

	interface Props {
		lines: readonly WeekLine[];
		/** The list's name: 'Week 3'. */
		label: string;
		href?: (lineage: string) => string;
		/** The line whose page is loading. */
		pending?: string | null;
		/** A test id for the lines that link nowhere in place of 'session-card' / 'rest-day':
		 * a bridge week's off-plan workouts ('off-plan-workout'). */
		testId?: string;
	}

	let { lines, label, href, pending = null, testId }: Props = $props();
</script>

<ul class="week-lines" aria-label={label} data-testid="week-lines">
	{#each lines as line, i (`${line.date}:${line.session?.lineage ?? 'rest'}:${i}`)}
		<li class="line" data-when={line.when}>
			{#if line.session && href}
				{@const to = href(line.session.lineage)}
				<a
					class="row"
					href={to}
					aria-label={line.name}
					aria-busy={pending === to ? 'true' : undefined}
					data-status={line.session.status}
					data-date={line.date}
					data-testid="session-card"
				>
					{@render body(line)}
				</a>
			{:else}
				<div
					class="row"
					aria-label={line.name}
					role="group"
					data-date={line.date}
					data-status={line.session?.status}
					data-testid={testId ?? (line.session ? 'session-card' : 'rest-day')}
				>
					{@render body(line)}
				</div>
			{/if}
		</li>
	{/each}
</ul>

{#snippet body(line: WeekLine)}
	<span class="day" aria-hidden="true">{line.day}</span>
	<span class="title" aria-hidden="true">{line.title}</span>
	{#if line.end && 'done' in line.end}
		<Icon name="check" size={16} class="tick" />
	{:else if line.end}
		<span class="end numeric" aria-hidden="true">{line.end.text}</span>
	{/if}
{/snippet}

<style>
	.week-lines {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.line + .line {
		border-top: 1px solid var(--color-hairline);
	}

	.row {
		display: flex;
		align-items: center;
		min-height: 3.75rem; /* 60, Paper */
		color: var(--color-text);
		text-decoration: none;
	}

	.day {
		flex: none;
		width: 4.25rem; /* 68, Paper's phone; 72 from 1024 px */
		font: var(--type-secondary);
		line-height: 1.2; /* 15/18 */
		color: var(--color-text-secondary);
	}

	.title {
		flex: 1;
		min-width: 0;
		font: var(--type-row);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.end {
		flex: none;
		font: var(--type-secondary);
		line-height: 1.2;
		color: var(--color-text-secondary);
	}

	.row :global(.tick) {
		flex: none;
		color: var(--color-text-tertiary);
	}

	[data-when='past'] :is(.day, .title, .end) {
		color: var(--color-text-tertiary);
	}

	[data-when='today'] :is(.day, .title) {
		font-weight: var(--weight-semibold);
		color: var(--color-text);
	}

	.line:not([data-when='today']) [data-testid='rest-day'] :is(.day, .title) {
		color: var(--color-text-tertiary);
	}

	a.row:focus-visible {
		outline-offset: -2px;
		border-radius: var(--radius-sm);
	}

	a.row[aria-busy='true'] .title {
		color: var(--color-text-secondary);
	}

	@media (hover: hover) and (pointer: fine) {
		a.row:hover .title {
			color: var(--color-text-secondary);
		}
	}

	@media (width >= 64rem) {
		.day {
			width: 4.5rem; /* 72, Paper's desktop */
		}
	}
</style>
