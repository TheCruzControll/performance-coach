<!--
  @component
  A coach answer's finished blocks (PRD §12): each labelled in words (Fact, Calculated,
  Recommendation, Safety, Note) with its own mark and edge, never colour alone. A metric reads in
  tabular figures, with how it was calculated behind a disclosure. A block the output policy could
  not check carries 'Not checked against your data'. Sources are dated rows: a link to the screen
  that holds the record, a button that asks the page to open an exercise's history
  (`onopenexercise`), or plain words when the record has no screen. Over ANSWER_BLOCKS_SHOWN
  blocks, the rest wait behind 'Show all'.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import {
		ANSWER_BLOCK_KIND_LABEL,
		sourceAction,
		type AnswerBlockKind,
		type CompletedBlock
	} from '#lib/domain/coach/index.ts';
	import Badge from '../components/Badge.svelte';
	import Button from '../components/Button.svelte';
	import Icon from '../components/Icon.svelte';
	import type { IconName } from '../icons/icons';
	import RichText from './RichText.svelte';
	import { ANSWER_BLOCKS_SHOWN, UNCHECKED_LABEL, sourceName, sourceWords } from './answer-words.ts';

	interface Props {
		blocks: readonly CompletedBlock[];
		/** An exercise source was chosen: the page opens that exercise's history. */
		onopenexercise?: (exerciseId: string) => void;
		'data-testid'?: string;
	}

	let { blocks, onopenexercise, ...rest }: Props = $props();

	const MARK: Record<AnswerBlockKind, IconName> = {
		fact: 'database',
		metric: 'pulse',
		recommendation: 'sparkle',
		safety: 'shield',
		note: 'info'
	};

	let expanded = $state(false);
	const shown = $derived(expanded ? blocks : blocks.slice(0, ANSWER_BLOCKS_SHOWN));
	const hidden = $derived(blocks.length - shown.length);
	let items: HTMLElement[] = $state([]);

	/** Reveal the rest, and take focus to the first block that was hidden. */
	async function showAll() {
		expanded = true;
		await tick();
		items[ANSWER_BLOCKS_SHOWN]?.focus();
	}
</script>

<div class="answer" {...rest}>
	<ol class="blocks">
		{#each shown as block, i (block.block)}
			<li
				bind:this={items[i]}
				class="block"
				data-kind={block.kind}
				data-testid="answer-block"
				tabindex="-1"
			>
				<div class="head">
					<span class="kind"
						><Icon name={MARK[block.kind]} size={16} strokeWidth={2} />{ANSWER_BLOCK_KIND_LABEL[
							block.kind
						]}</span
					>
					{#if !block.grounded}
						<Badge tone="warning" icon="alert" data-testid="unchecked">{UNCHECKED_LABEL}</Badge>
					{/if}
				</div>
				<div class={['body', block.kind === 'metric' && 'tabular']}>
					<RichText nodes={block.ast} />
				</div>
				{#if block.method}
					<details class="method">
						<summary
							><Icon name="chevron-right" size={16} strokeWidth={2} />How it’s calculated</summary
						>
						<p class="tabular">{block.method}</p>
					</details>
				{/if}
				{#if block.sources.length}
					<ul class="sources" aria-label="Sources">
						{#each block.sources as ref, s (s)}
							{@const words = sourceWords(ref)}
							{@const action = sourceAction(ref)}
							{#snippet row()}
								<span class="source-text">
									<span class="source-title">{words.title}</span>
									{#if words.kind || words.date}
										<span class="visually-hidden">, </span>
										<span class="source-meta">
											{#if words.kind}<span>{words.kind}</span>{/if}
											{#if words.kind && words.date}<span aria-hidden="true">·</span>{/if}
											{#if words.date}<time datetime={words.day}>{words.date}</time>{/if}
										</span>
									{/if}
								</span>
							{/snippet}
							<li>
								{#if action?.kind === 'link'}
									<a class="source interactive" href={action.href} aria-label={sourceName(ref)}
										>{@render row()}<Icon name="chevron-right" size={18} /></a
									>
								{:else if action?.kind === 'exercise_history'}
									<button
										type="button"
										class="source interactive"
										aria-label={sourceName(ref)}
										onclick={() => onopenexercise?.(action.exerciseId)}
										>{@render row()}<Icon name="clock" size={18} /></button
									>
								{:else}
									<span class="source">{@render row()}</span>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</li>
		{/each}
	</ol>
	{#if hidden > 0}
		<Button variant="secondary" size="sm" onclick={showAll} data-testid="show-all-blocks"
			>Show all {blocks.length} parts</Button
		>
	{/if}
</div>

<style>
	.answer {
		display: grid;
		gap: var(--space-3);
		justify-items: start;
		min-width: 0;
	}

	.blocks,
	.sources {
		padding: 0;
		list-style: none;
	}

	.blocks {
		display: grid;
		gap: var(--space-3);
		width: 100%;
	}

	/*
	 * Each kind: a mark, a word and an edge. The edge's colour only repeats what the word says;
	 * safety also sits on a tint, the one block that must never be skimmed past.
	 */
	.block {
		--edge: var(--color-border-strong);
		display: grid;
		gap: var(--space-2);
		min-width: 0;
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		border-left: 3px solid var(--edge);
		background: var(--color-surface-1);
	}

	.block[data-kind='metric'] {
		--edge: var(--color-info);
	}

	.block[data-kind='recommendation'] {
		--edge: var(--color-accent);
	}

	.block[data-kind='safety'] {
		--edge: var(--color-warning);
		background: color-mix(in srgb, var(--color-warning) 8%, var(--color-surface-1));
	}

	.block[data-kind='note'] {
		--edge: var(--color-border);
		background: transparent;
	}

	.block:focus-visible {
		outline-offset: 2px;
	}

	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.kind {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1-5);
		color: var(--color-text-secondary);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
	}

	.body {
		color: var(--color-text);
		font-size: var(--text-base);
	}

	.method summary {
		display: flex;
		align-items: center;
		gap: var(--space-1-5);
		min-height: var(--touch-target);
		width: fit-content;
		padding: 0 var(--space-2);
		margin-inline: calc(var(--space-2) * -1);
		border-radius: var(--radius-sm);
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		cursor: pointer;
		list-style: none;
	}

	.method summary::-webkit-details-marker {
		display: none;
	}

	.method summary :global(.icon) {
		transition: transform var(--duration-fast) var(--ease-standard);
	}

	.method[open] summary :global(.icon) {
		transform: rotate(90deg);
	}

	.method p {
		padding-bottom: var(--space-1);
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
	}

	.sources {
		display: grid;
		gap: var(--space-1);
		border-top: 1px solid var(--color-hairline);
		padding-top: var(--space-2);
		margin-top: var(--space-1);
	}

	.source {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		width: 100%;
		min-height: var(--touch-target);
		padding: var(--space-1) var(--space-2);
		margin-inline: calc(var(--space-2) * -1);
		box-sizing: content-box;
		border-radius: var(--radius-sm);
		color: var(--color-text);
		text-align: left;
	}

	.source :global(.icon) {
		color: var(--color-text-tertiary);
	}

	.interactive {
		cursor: pointer;
		transition: background-color var(--duration-fast) var(--ease-standard);
	}

	.interactive:active,
	.method summary:active {
		background: var(--color-surface-2);
	}

	@media (hover: hover) and (pointer: fine) {
		.interactive:hover,
		.method summary:hover {
			background: var(--color-surface-2);
			color: var(--color-text);
		}
	}

	.source-text {
		flex: 1;
		display: grid;
		min-width: 0;
	}

	.source-title {
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		overflow-wrap: anywhere;
	}

	.source-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0 var(--space-1);
		color: var(--color-text-secondary);
		font-size: var(--text-xs);
		font-variant-numeric: tabular-nums;
	}
</style>
