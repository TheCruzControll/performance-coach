<!--
  @component
  Train's More (Instrument v2, Paper 4 · Train "More"): the plan, what has changed and the tools,
  as rows in a sheet, and from 1024 px the right-hand panel (board 12 "Train tools"). Train loads
  it on intent, as it loads each tool. A tool's row opens the tool over this sheet, which stays
  open beneath it (a dialog from 1024 px), so closing the tool gives the focus back to its row; a
  tool whose code fails to load says so under its row, with Retry. A link row leaves Train, and
  this sheet with it. "Add a session to this week" and "Change when the plan starts" are Train's
  own, which Paper does not place: leaving them out would take the capability away. A session added
  closes this sheet with Add session (Train's `onadded`), so the new line is in view on Train.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { navigating } from '$app/state';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import type { LazySheet } from './lazy-sheet.svelte.ts';

	/** One of Train's lazy tools: its row is busy while its code is on its way, or says it failed. */
	type Tool = Pick<LazySheet<Record<string, unknown>>, 'busy' | 'failed' | 'show' | 'prefetch'>;

	interface Props {
		open: boolean;
		onclose?: () => void;
		/** The whole plan, with a program: its row and History's. */
		plan: Tool | null;
		plates: Tool;
		rest: Tool;
		/** Adding a session to the week shown, when a day of it can take one. */
		add: Tool | null;
		/** The plan's start may still move (Start date). */
		movable: boolean;
	}

	let { open = $bindable(), onclose, plan, plates, rest, add, movable }: Props = $props();

	const HISTORY_HREF = resolve('/(app)/train/history/[[version]]', {});
	const START_HREF = resolve('/(app)/train/start');
	const LOG_HREF = resolve('/workout');

	/** The notice can appear under the sheet's fold: bring it into view. */
	const reveal = (node: HTMLElement) => node.scrollIntoView({ block: 'nearest' });
</script>

{#snippet retry(tool: Tool, title: string)}
	{#if tool.failed}
		<Notice tone="danger" {title}>
			<button type="button" class="retry" onclick={tool.show} use:reveal>Try again</button>
		</Notice>
	{/if}
{/snippet}

<BottomSheet bind:open title="Plan and tools" {onclose} desktop="panel" data-testid="more-sheet">
	<!-- Each row in its own item, so each keeps its hairline, a failed tool's notice under it. -->
	<ul class="rows" role="list">
		{#if plan}
			<li class="tool" aria-busy={plan.busy}>
				<ListRow
					title="See the whole plan"
					onpointerdown={plan.prefetch}
					onpointerenter={plan.prefetch}
					onclick={plan.show}
					data-testid="open-plan"
				/>
				{@render retry(plan, 'Couldn’t open your plan')}
			</li>
			<li class="tool">
				<ListRow
					title="See what has changed"
					href={HISTORY_HREF}
					aria-busy={navigating.to?.url.pathname === HISTORY_HREF}
					data-testid="open-history"
				/>
			</li>
		{/if}
		<li class="tool" aria-busy={plates.busy}>
			<ListRow
				title="Work out the plates for a bar"
				onpointerdown={plates.prefetch}
				onpointerenter={plates.prefetch}
				onclick={plates.show}
				data-testid="open-plates"
			/>
			{@render retry(plates, 'Couldn’t open the plate calculator')}
		</li>
		<li class="tool" aria-busy={rest.busy}>
			<ListRow
				title="Start a rest timer"
				onpointerdown={rest.prefetch}
				onpointerenter={rest.prefetch}
				onclick={rest.show}
				data-testid="open-rest-timer"
			/>
			{@render retry(rest, 'Couldn’t open the rest timer')}
		</li>
		<li class="tool">
			<ListRow
				title="Log a session that isn’t on the plan"
				href={LOG_HREF}
				data-testid="log-a-session"
			/>
		</li>
		{#if add}
			<li class="tool" aria-busy={add.busy}>
				<ListRow
					title="Add a session to this week"
					onpointerdown={add.prefetch}
					onpointerenter={add.prefetch}
					onclick={add.show}
					data-testid="open-add-session"
				/>
				{@render retry(add, 'Couldn’t open adding a session')}
			</li>
		{/if}
		{#if movable}
			<li class="tool">
				<ListRow
					title="Change when the plan starts"
					href={START_HREF}
					aria-busy={navigating.to?.url.pathname === START_HREF}
					data-testid="open-start"
				/>
			</li>
		{/if}
	</ul>
</BottomSheet>

<style>
	/* What the busy spinner sits on: the sheet's surface on a phone, the canvas in the panel. */
	.rows {
		--under: var(--color-surface-1);
		display: grid;
		list-style: none;
	}

	.tool {
		position: relative;
		display: grid;
		gap: var(--space-2);
	}

	/* Pending (tapped, the tool's code on its way): a spinner takes the chevron's place after a
	   beat, so a fast fetch shows nothing. Drawn from aria-busy, as Train draws its own rows'. */
	.tool[aria-busy='true']::after {
		content: '';
		position: absolute;
		top: 50%;
		right: 0;
		width: 20px;
		height: 20px;
		margin-top: -10px;
		border: 2.5px solid color-mix(in srgb, currentColor 25%, transparent);
		border-top-color: currentColor;
		border-radius: var(--radius-full);
		color: var(--color-text-tertiary);
		background: var(--under);
		box-shadow: 0 0 0 4px var(--under);
		opacity: 0;
		animation:
			spin 0.8s linear infinite,
			appear var(--duration-fast) var(--ease-out) 150ms forwards;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@keyframes appear {
		to {
			opacity: 1;
		}
	}

	/* The notice's inline action, as Train styles its own: accent, underlined, a full 44 × 44 px
	   target, the negative margin keeping the word under the title. */
	.retry {
		display: flex;
		align-items: center;
		min-width: var(--touch-target);
		min-height: var(--touch-target);
		padding: 0 var(--space-2);
		margin: calc(var(--space-2) * -1);
		font-size: var(--text-sm);
		font-weight: var(--weight-bold);
		color: var(--color-accent-text);
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	@media (width >= 64rem) {
		.rows {
			--under: var(--color-canvas);
		}
	}
</style>
