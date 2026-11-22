<!--
  @component
  'What the coach knows' (PRD §4, §12): the coaching memory, read through GET /api/coach/memory
  each time the sheet opens, section by section in knows.ts's words: goals, the program, trends,
  exercise preferences, equipment, injuries, recent pain reports (each opening its workout in
  History), decisions and rejected proposals. Only structured records, never a conversation. What
  Profile holds says 'Edit in Profile'. Loading rows while it loads; a failed read offers Retry;
  knowing nothing yet points to Profile → Goals and Equipment. KnowsButton fetches this on intent.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import LoadingRows from '#lib/ui/coach/LoadingRows.svelte';
	import { knowsDate } from './knows-dates';
	import type { KnowsView } from './knows';

	let { open = $bindable() }: { open: boolean } = $props();

	let phase = $state<'loading' | 'failed' | 'ready'>('loading');
	let view = $state.raw<KnowsView | null>(null);

	async function load() {
		phase = 'loading';
		try {
			const response = await fetch('/api/coach/memory');
			if (!response.ok) throw new Error(`memory ${response.status}`);
			view = await response.json();
			phase = 'ready';
		} catch {
			phase = 'failed';
		}
	}

	// Read afresh on every open: a turn or a Profile save since the last one may have added to it.
	$effect(() => {
		if (open) untrack(load);
	});
</script>

<BottomSheet
	bind:open
	title="What the coach knows"
	description="From your profile and training records, never from old conversations."
	data-testid="knows-sheet"
>
	<div class="knows">
		{#if phase === 'loading'}
			<LoadingRows label="Loading what the coach knows…" data-testid="knows-loading" />
		{:else if phase === 'failed'}
			<Notice
				tone="danger"
				icon="alert"
				title="Couldn’t load what the coach knows"
				data-testid="knows-failed"
			>
				<p>Check your connection, then try again.</p>
				<div class="action">
					<Button variant="secondary" size="sm" icon="refresh" onclick={load}>Try again</Button>
				</div>
			</Notice>
		{:else if !view || view.sections.length === 0}
			<EmptyState
				compact
				icon="database"
				tone="neutral"
				title="The coach doesn’t know much yet"
				description="Add your goals and equipment in Profile, and every conversation starts from them."
				data-testid="knows-empty"
			>
				{#snippet actions()}
					<Button variant="secondary" size="sm" href="/profile/goals">Goals</Button>
					<Button variant="secondary" size="sm" href="/profile/equipment">Equipment</Button>
				{/snippet}
			</EmptyState>
		{:else}
			{#each view.sections as section (section.key)}
				<Section title={section.title} data-testid={`knows-${section.key}`}>
					{#snippet action()}
						{#if section.edit}
							<a class="edit" href={resolve('/(app)/profile/[section]', { section: section.edit })}
								>Edit in Profile</a
							>
						{/if}
					{/snippet}
					<ul class="items">
						{#each section.items as item, i (i)}
							<li>
								<svelte:element this={item.href ? 'a' : 'div'} class="item" href={item.href}>
									<span class="text">
										<span class="title">{item.title}</span>
										{#if item.detail || item.date}
											<span class="detail">
												{[item.date && knowsDate(item.date, view.asOf), item.detail]
													.filter(Boolean)
													.join(' · ')}
											</span>
										{/if}
									</span>
									{#if item.href}<Icon name="chevron-right" size={18} />{/if}
								</svelte:element>
							</li>
						{/each}
					</ul>
				</Section>
			{/each}
			<p class="caption">As of {knowsDate(view.asOf, view.asOf)}.</p>
		{/if}
	</div>
</BottomSheet>

<style>
	.knows {
		display: grid;
		gap: var(--space-5);
	}

	.action {
		margin-top: var(--space-2);
	}

	.items {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--color-hairline);
		border-radius: var(--radius-lg);
	}

	.items li + li {
		border-top: 1px solid var(--color-hairline);
	}

	.item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		min-height: var(--touch-target);
		padding: var(--space-2) var(--space-3);
		color: inherit;
		text-decoration: none;
		border-radius: var(--radius-lg);
	}

	a.item {
		color: var(--color-text);
	}

	a.item :global(svg) {
		flex: none;
		color: var(--color-text-tertiary);
	}

	.text {
		display: grid;
		gap: var(--space-1);
		min-width: 0;
	}

	.title {
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		overflow-wrap: anywhere;
	}

	.detail,
	.caption {
		font-size: var(--text-xs);
		color: var(--color-text-secondary);
		overflow-wrap: anywhere;
		font-variant-numeric: tabular-nums;
	}

	.caption {
		margin: 0;
	}

	.edit {
		display: inline-flex;
		align-items: center;
		min-height: var(--touch-target);
		padding: 0 var(--space-1);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-accent-text);
		text-decoration: none;
		border-radius: var(--radius-sm);
	}

	a:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	@media (hover: hover) and (pointer: fine) {
		a.item:hover {
			background: var(--color-hairline);
		}

		.edit:hover {
			text-decoration: underline;
		}
	}
</style>
