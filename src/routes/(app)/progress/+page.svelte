<!--
  Progress (M6): the view nav and the period picker over the view the server rendered (+page.ts,
  load.ts). Switching a view or a period is a link, so it works without JavaScript and Back
  restores it; with JavaScript the frame holds, dimmed and aria-busy, until the new numbers
  arrive (PeriodPicker). Offline, a switch is cancelled and the numbers stay, with a notice. A
  failed load is a notice with Retry inside the screen, never the error page.
-->
<script lang="ts">
	import { beforeNavigate, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import type { Period } from '#lib/domain/analytics/periods.ts';
	import PeriodPicker from '#lib/ui/analytics/PeriodPicker.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import type { PageProps } from './$types';
	import { DEFAULT_VIEW, progressQuery, PROGRESS_VIEWS, VIEW_LABEL } from './params';

	let { data }: PageProps = $props();

	/** What the offline notice says is still shown. */
	const SHOWING: Readonly<Record<Period, string>> = {
		'4w': '4 weeks',
		'12w': '12 weeks',
		'26w': '26 weeks',
		'52w': '52 weeks',
		all: 'all time'
	};

	let offline = $state(false);
	let retrying = $state(false);

	// A view or period switch made offline would fail to load: keep the frame and the numbers.
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

<svelte:head>
	<title>Progress · Performance Coach</title>
</svelte:head>

<svelte:window ononline={() => (offline = false)} />

<!-- A dashboard: wide from 1024 px (docs/design-system.md, Responsive layout → Content width). -->
<div data-layout="wide">
	<PageHeader title="Progress" eyebrow="Trends" />

	<div class="history">
		<ListRow
			title="Workout history"
			subtitle="Every finished workout, with its sets and notes"
			icon="clock"
			href={resolve('/(app)/progress/workouts/[[id]]', {})}
			data-testid="workout-history-row"
		/>
	</div>

	{#if offline}
		<div class="notice">
			<Notice tone="warning" icon="wifi-off" data-testid="progress-offline">
				You’re offline — showing {SHOWING[data.period]}
			</Notice>
		</div>
	{/if}

	<div class="frame">
		<nav class="views" aria-label="Progress views" data-sveltekit-reset="false">
			{#each PROGRESS_VIEWS as view (view)}
				<a
					class="view"
					href="{resolve('/(app)/progress')}{progressQuery({ view, period: data.period })}"
					aria-current={view === data.view ? 'page' : undefined}>{VIEW_LABEL[view]}</a
				>
			{/each}
		</nav>
		<PeriodPicker
			current={data.period}
			keep={data.view === DEFAULT_VIEW ? '' : `view=${data.view}&`}
			data-testid="progress-period"
		>
			{#if data.failed}
				<div class="failed" data-testid="progress-failed">
					<Notice tone="danger" title="Couldn’t load your progress">
						Your training is safe. Try again in a moment.
					</Notice>
					<Button variant="secondary" icon="refresh" loading={retrying} onclick={retry}>
						Retry
					</Button>
				</div>
			{:else if data.view === 'strength'}
				<data.View strength={data.strength} served={data.served} />
			{:else if data.view === 'running'}
				<data.View running={data.running} served={data.served} />
			{:else if data.View}
				<data.View overview={data.overview} served={data.served} />
			{/if}
		</PeriodPicker>
	</div>
</div>

<style>
	.history,
	.notice {
		margin-bottom: var(--space-5);
	}

	.frame {
		display: grid;
		gap: var(--space-3);
	}

	.views {
		display: flex;
		gap: var(--space-1);
	}

	.view {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: var(--touch-target);
		min-width: var(--touch-target);
		padding: 0 var(--space-3);
		border-radius: var(--radius-full);
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		text-decoration: none;
	}

	.view[aria-current='page'] {
		background: var(--color-surface-2);
		color: var(--color-text);
	}

	.view:not([aria-current='page']):active {
		background: var(--color-surface-3);
	}

	@media (hover: hover) and (pointer: fine) {
		.view:not([aria-current='page']):hover {
			background: var(--color-surface-2);
			color: var(--color-text);
		}
	}

	.failed {
		display: grid;
		justify-items: start;
		gap: var(--space-3);
	}

	/* A desktop window: the view nav and the period picker share one row over the view. */
	@media (width >= 64rem) {
		.frame {
			grid-template-columns: minmax(0, 1fr) 24rem;
			align-items: center;
			row-gap: var(--space-4);
		}

		.frame :global(.period-view) {
			display: contents;
		}

		.frame :global(.period-view > .content) {
			grid-column: 1 / -1;
		}
	}
</style>
