<!--
  @component
  A proposal's rows: what each change touches, then what it was and what it becomes, the new
  value emphasised. A side that is nothing reads 'Added' or 'Removed', so a row never shows an
  empty arrow. Screen readers hear 'from … to …' rather than an arrow.
-->
<script lang="ts">
	import type { ProposalCardRow } from '#lib/domain/coach/cards.ts';
	import Icon from '../components/Icon.svelte';

	interface Props {
		rows: readonly ProposalCardRow[];
	}

	let { rows }: Props = $props();
</script>

<ul class="rows" data-testid="diff-rows">
	{#each rows as row, i (i)}
		<li class="row" data-testid="diff-row">
			<span class="label">{row.label}</span>
			<span class="change">
				{#if row.before === null}
					<span class="tag">Added</span>
					<span class="after">{row.after}</span>
				{:else if row.after === null}
					<span class="tag">Removed</span>
					<del class="before">{row.before}</del>
				{:else}
					<span class="visually-hidden">from</span>
					<span class="before">{row.before}</span>
					<span class="arrow" aria-hidden="true"><Icon name="arrow-right" size={14} /></span>
					<span class="visually-hidden">to</span>
					<span class="after">{row.after}</span>
				{/if}
			</span>
		</li>
	{/each}
</ul>

<style>
	.rows {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.row {
		display: grid;
		gap: var(--space-1);
		padding: var(--space-2) 0;
		border-top: 1px solid var(--color-border);
	}

	.row:first-child {
		border-top: none;
		padding-top: 0;
	}

	.label {
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-text);
		overflow-wrap: anywhere;
	}

	.change {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1-5);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}

	.before {
		color: var(--color-text-secondary);
	}

	del.before {
		text-decoration-thickness: 1px;
	}

	.arrow {
		display: inline-flex;
		color: var(--color-text-tertiary);
	}

	.after {
		color: var(--color-text);
		font-weight: var(--weight-semibold);
	}

	.tag {
		color: var(--color-text-secondary);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
	}
</style>
