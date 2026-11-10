<!--
  Progress → one exercise (M6): is this lift going up? The header names it with its tags and its
  e1RM verdict over the period picker; then the best estimated 1RM with its context, the e1RM
  chart (estimates as rings, the profile's maxes as their own marks, server-rendered with its
  table twin) beside the 1–10 rep-max table on a desktop window, top sets, every PR with its date,
  RPE against target and the recent sessions, each linking to its workout.

  - Before TREND_SESSIONS sessions of the lift, a designed empty state says when trends appear.
  - A period switch is a link: the frame holds, dimmed, until the numbers arrive (PeriodPicker).
    Offline it is cancelled and the numbers stay, with a notice; a client navigation here offline
    is the (app) error boundary's offline state.
  - A failed load is a notice with Retry inside the screen; an unknown id is the 404 page.
-->
<script lang="ts">
	import { beforeNavigate, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import MetricContext from '#lib/ui/analytics/MetricContext.svelte';
	import PeriodPicker from '#lib/ui/analytics/PeriodPicker.svelte';
	import TrendTile from '#lib/ui/analytics/TrendTile.svelte';
	import VerdictBadge from '#lib/ui/analytics/VerdictBadge.svelte';
	import { CHART_BODIES } from '#lib/ui/charts/bodies.ts';
	import ChartFrame from '#lib/ui/charts/ChartFrame.svelte';
	import Badge from '#lib/ui/components/Badge.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const detail = $derived(data.failed ? null : data.detail);
	let offline = $state(false);
	let retrying = $state(false);

	// A period switch made offline would fail to load: keep the frame and the numbers.
	beforeNavigate(({ to, cancel }) => {
		if (to?.url.pathname !== page.url.pathname || navigator.onLine) return;
		cancel();
		offline = true;
	});

	async function retry() {
		retrying = true;
		try {
			await invalidateAll();
		} finally {
			retrying = false;
		}
	}
</script>

{#snippet unplotted()}<p class="muted">No estimate in these weeks yet</p>{/snippet}

<svelte:head>
	<title>{detail?.name ?? 'Exercise'} · Progress · Performance Coach</title>
</svelte:head>

<svelte:window ononline={() => (offline = false)} />

<div data-layout="wide" class="screen" data-testid="exercise-detail">
	<a class="back" href={resolve('/(app)/progress')}
		><Icon name="chevron-left" size={18} strokeWidth={2} />Progress</a
	>
	<PageHeader title={detail?.name ?? 'Exercise'} eyebrow="Exercise" />
	{#if detail}
		<div class="meta">
			<ul class="tags" aria-label="About this lift" data-testid="exercise-tags">
				{#each detail.tags as tag (tag)}<li><Badge>{tag}</Badge></li>{/each}
			</ul>
			{#if !detail.waiting}<VerdictBadge verdict={detail.verdict} window={detail.window} />{/if}
		</div>
	{/if}

	{#if offline}
		<Notice tone="warning" icon="wifi-off" data-testid="exercise-offline">
			You’re offline — showing what was loaded
		</Notice>
	{/if}

	<PeriodPicker current={data.period} data-testid="exercise-period">
		{#if !detail}
			<div class="failed" data-testid="exercise-failed">
				<Notice tone="danger" title="Couldn’t load this exercise">
					Your training is safe. Try again in a moment.
				</Notice>
				<Button variant="secondary" icon="refresh" loading={retrying} onclick={retry}>Retry</Button>
			</div>
		{:else}
			<div class="pc-exercise-view" data-state={detail.waiting ? 'waiting' : 'ready'}>
				{#if detail.waiting}
					<EmptyState
						icon="progress"
						tone="strength"
						title="Trends appear after {detail.waiting.need} sessions with this lift"
						description="{detail.waiting.have} of {detail.waiting
							.need} so far. Log it again and its estimated 1RM, verdict and records fill in."
						data-testid="exercise-waiting"
					/>
				{:else}
					<Section title="Estimated 1RM" gap="md">
						<div class="lead">
							<TrendTile tile={detail.e1rm} data-testid="exercise-e1rm" />
							<div class="about">
								<MetricContext {...detail.context} data-testid="exercise-context" />
								{#if detail.markers.length}
									<ul class="markers" aria-label="Your profile’s 1RMs">
										{#each detail.markers as marker, i (i)}
											<li data-kind={marker.kind} data-value={marker.kg} data-testid="max-marker">
												<span class="shape" data-kind={marker.kind} aria-hidden="true"></span>
												<span class="numeric">{marker.text}</span>
												<span class="muted">{marker.label}{marker.on ? ` · ${marker.on}` : ''}</span
												>
											</li>
										{/each}
									</ul>
								{/if}
							</div>
						</div>
					</Section>
				{/if}

				<div class="pair">
					{#if !detail.waiting}
						<ChartFrame
							{...detail.chart}
							body={CHART_BODIES.line}
							props={{ data: detail.chart.data }}
							height="15rem"
							availability={detail.chart.plotted ? undefined : unplotted}
							data-testid="chart-e1rm"
						/>
					{/if}
					<Section title="Rep maxes" data-testid="rep-maxes">
						<table class="records">
							<caption class="visually-hidden">The heaviest load for each rep count</caption>
							<thead>
								<tr
									><th scope="col">Reps</th><th scope="col">Best</th><th scope="col">Set on</th></tr
								>
							</thead>
							<tbody>
								{#each detail.repMaxes as row (row.reps)}
									<tr data-reps={row.reps} data-value={row.kg ?? undefined} data-testid="rep-max">
										<th scope="row" class="numeric">{row.reps}</th>
										<td class="numeric">
											{row.text ?? '—'}
											{#if row.previous}<span class="muted">{row.previous}</span>{/if}
										</td>
										<td class="muted">{row.on ?? 'Not lifted yet'}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</Section>
				</div>

				<div class="pair">
					{#if !detail.waiting}
						<Section title="Personal records">
							{#if detail.prs.e1rm.length + detail.prs.volume.length === 0}
								<p class="muted">No record broken yet: each one shows here with its date.</p>
							{/if}
							{#each [{ kind: 'e1rm', title: 'Estimated 1RM', items: detail.prs.e1rm }, { kind: 'volume', title: 'Session volume', items: detail.prs.volume }] as group (group.kind)}
								{#if group.items.length}
									<h3 class="sub">{group.title}</h3>
									<ol class="list timeline">
										{#each group.items as pr (pr.key)}
											<li data-value={pr.value} data-testid="pr-{group.kind}">
												<span class="numeric">{pr.text}</span>
												<span class="muted">{pr.on} · {pr.previous}</span>
											</li>
										{/each}
									</ol>
								{/if}
							{/each}
						</Section>
					{/if}
					<div class="stack">
						{#if detail.topSets.length}
							<Section title="Top sets">
								<ul class="list">
									{#each detail.topSets as top (top.key)}
										<li data-testid="top-set">
											<span class="numeric">{top.text}</span>
											<span class="muted">{top.on}{top.inProgress ? ' · this week' : ''}</span>
										</li>
									{/each}
								</ul>
							</Section>
						{/if}

						{#if !detail.waiting}
							<Section title="RPE against target">
								<TrendTile tile={detail.rpe} data-testid="exercise-rpe" />
							</Section>
						{/if}
					</div>
				</div>

				{#if detail.recent.length}
					<Section title="Recent sessions" data-testid="recent-sessions">
						<ul class="rows">
							{#each detail.recent as session (session.id)}
								<li>
									<ListRow
										title={session.title}
										subtitle="{session.on} · {session.summary}"
										icon="train"
										tone="strength"
										href={resolve('/(app)/progress/workouts/[[id]]', { id: session.id })}
										data-testid="recent-session"
									/>
								</li>
							{/each}
						</ul>
					</Section>
				{/if}
			</div>
		{/if}
	</PeriodPicker>
</div>

<style>
	.screen {
		display: grid;
		gap: var(--space-4);
	}

	.back {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		justify-self: start;
		min-height: var(--touch-target);
		padding-inline: var(--space-2);
		margin: var(--space-2) 0 calc(var(--space-6) * -1) calc(var(--space-2) * -1);
		border-radius: var(--radius-sm);
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		text-decoration: none;
	}

	.back:active {
		background: var(--color-surface-2);
	}

	@media (hover: hover) and (pointer: fine) {
		.back:hover {
			background: var(--color-surface-2);
			color: var(--color-text);
		}
	}

	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
		margin-top: calc(var(--space-3) * -1);
	}

	.tags,
	.markers,
	.list,
	.rows {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.failed {
		display: grid;
		justify-items: start;
		gap: var(--space-3);
	}

	.pc-exercise-view {
		container-type: inline-size;
		display: grid;
		gap: var(--space-6);
		min-width: 0;
	}

	.pair {
		display: grid;
		gap: var(--space-6);
		min-width: 0;
	}

	.muted {
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
	}

	.markers li {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	/* As the chart's marks: a square diamond for a measured max, a hollow ring for an estimate. */
	.shape {
		inline-size: 8px;
		block-size: 8px;
		border: 2px solid var(--chart-muted);
		border-radius: 50%;
	}

	.shape[data-kind='measured'] {
		border-radius: 1px;
		background: var(--chart-muted);
		transform: rotate(45deg);
	}

	.records {
		inline-size: 100%;
		border-collapse: collapse;
		font-size: var(--text-sm);
	}

	.records th,
	.records td {
		padding: var(--space-2) var(--space-2) var(--space-2) 0;
		border-bottom: 1px solid var(--color-hairline);
		text-align: start;
		vertical-align: baseline;
	}

	.records thead th {
		color: var(--color-text-tertiary);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
	}

	.records td .muted {
		display: block;
		font-size: var(--text-xs);
	}

	.list {
		display: grid;
		gap: 0;
	}

	.list li {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: var(--space-1) var(--space-3);
		padding: var(--space-2) 0;
		border-bottom: 1px solid var(--color-hairline);
	}

	.sub {
		margin-top: var(--space-2);
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	.rows {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr));
	}

	.lead,
	.stack {
		display: grid;
		gap: var(--space-4);
		min-width: 0;
	}

	.stack {
		gap: var(--space-6);
	}

	.about {
		display: grid;
		align-content: start;
		gap: var(--space-3);
		min-width: 0;
	}

	/* A desktop column: the tile beside its context, the chart beside the rep-max table, the
	   records beside the top sets. */
	@container (width >= 44rem) {
		.pair {
			grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
			align-items: start;
		}

		.lead {
			grid-template-columns: minmax(0, 18rem) minmax(0, 1fr);
			column-gap: var(--space-6);
		}
	}

	/* A desktop window: the period picker keeps a control's width instead of the column's. */
	@media (width >= 64rem) {
		.screen :global(.period-view > .picker) {
			justify-self: start;
			inline-size: 24rem;
		}
	}
</style>
