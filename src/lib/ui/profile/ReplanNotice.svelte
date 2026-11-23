<!--
  @component
  Profile → Goals: what the priority trigger did after a goal change (services/periodisation/
  priority.ts), in one calm line: a re-plan to review (a link to its proposal), a plan that already
  fits, a next block that will follow, a program to build (a link to Today), or a failed re-plan
  with Try again. The words come from replan-notice.ts; this component lays them out.

  The region is always in the markup, so a change is announced politely: it is empty, and takes
  no room, until `replan` is set. While Try again runs (`checking`) the region is busy and the
  button keeps its width. Never a warning tone: the notice says what the plan does, in words.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import Button from '../components/Button.svelte';
	import { replanCopy, type ReplanLinks, type ReplanResult } from './replan-notice.ts';

	interface Props {
		/** The trigger's answer for the last goal change or Try again; null before either. */
		replan: ReplanResult | null;
		/** Try again is running. */
		checking?: boolean;
		onretry?: () => void;
	}

	let { replan, checking = false, onretry }: Props = $props();

	const links: ReplanLinks = {
		proposal: (id) => resolve('/(app)/coach/proposals/[[id]]', { id }),
		today: resolve('/(app)/today')
	};

	const copy = $derived(replan ? replanCopy(replan, links) : null);
</script>

<div
	class="replan"
	aria-live="polite"
	aria-busy={checking || undefined}
	data-testid="replan-notice"
>
	{#if copy && replan}
		<p class="text" data-state={replan.state}>
			{copy.before}{#if copy.link}<a class="link" href={copy.link.href} data-testid="replan-link"
					>{copy.link.label}</a
				>{/if}{copy.after}
		</p>
		{#if copy.retry}
			<Button
				variant="secondary"
				size="sm"
				loading={checking}
				onclick={onretry}
				data-testid="replan-retry">Try again</Button
			>
		{/if}
	{/if}
</div>

<style>
	/* The neutral tint of Notice, with no icon: calm, and nothing to act on but its link. */
	.replan {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--color-text-secondary) 30%, transparent);
		background: color-mix(in srgb, var(--color-text-secondary) 9%, var(--color-surface-1));
	}

	/* An empty region takes no room, so the list above it and the goals below keep their gaps. */
	.replan:empty {
		display: none;
	}

	.text {
		min-width: 0;
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
		color: var(--color-text-secondary);
		text-wrap: pretty;
	}

	/* The link's hit area is 44 px tall; its words stay on the line. */
	.link {
		display: inline-flex;
		align-items: center;
		min-height: var(--touch-target);
		color: var(--color-accent-text);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
</style>
