<!--
  @component
  The changes, newest first (Instrument v2, Paper 4 · Train "What has changed"): one 60 px line
  each, a link to the change, with its summary, its day ('Today', '12 Nov') and a chevron; version
  1 reads 'Plan created'. A hairline between lines, as the week's lines have. Its name says the
  version ('Moved Long run, Today, version 3'). The link is busy (aria-busy) while it navigates;
  beside a change (a desktop window) the `selected` one is the current page (aria-current).
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { navigating } from '$app/state';
	import Icon from '#lib/ui/components/Icon.svelte';
	import type { VersionRowView } from './history.server';

	let {
		versions,
		selected = null
	}: { versions: readonly VersionRowView[]; selected?: number | null } = $props();
</script>

<ol class="changes" aria-label="Changes">
	{#each versions as version (version.number)}
		{@const href = resolve('/(app)/train/history/[[version]]', { version: String(version.number) })}
		{@const pending = navigating.to?.url.pathname === href}
		<li class="line" data-testid="version">
			<a
				class="row"
				{href}
				aria-label={`${version.summary}, ${version.day}, version ${version.number}`}
				aria-busy={pending ? 'true' : undefined}
				aria-current={version.number === selected ? 'page' : undefined}
				data-testid="version-link"
			>
				<span class="summary">{version.summary}</span>
				<span class="day">{version.day}</span>
				<span class="end"><Icon name="chevron-right" size={14} class="chevron" /></span>
			</a>
		</li>
	{/each}
</ol>

<style>
	.changes {
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
		gap: var(--space-3);
		min-height: 3.75rem; /* 60, Paper */
		color: var(--color-text);
		text-decoration: none;
	}

	.summary {
		flex: 1;
		min-width: 0;
		font: var(--type-row);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.day {
		flex: none;
		font: var(--type-secondary);
		line-height: 1.2; /* 15/18 */
		color: var(--color-text-secondary);
	}

	/* The 24 px end slot, the chevron at its end. */
	.end {
		display: flex;
		flex: none;
		justify-content: flex-end;
		width: 1.5rem;
	}

	.row :global(.chevron) {
		color: var(--color-text-tertiary);
	}

	/* The change open beside the list (a desktop window). */
	.row[aria-current='page'] .summary {
		font-weight: var(--weight-semibold);
	}

	.row:focus-visible {
		outline-offset: -2px;
		border-radius: var(--radius-sm);
	}

	.row[aria-busy='true'] {
		cursor: progress;
	}

	.row[aria-busy='true'] .summary {
		color: var(--color-text-secondary);
	}

	@media (hover: hover) and (pointer: fine) {
		.row:hover .summary {
			color: var(--color-text-secondary);
		}
	}
</style>
