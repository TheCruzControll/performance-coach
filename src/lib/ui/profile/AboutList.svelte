<!--
  @component
  About this app's rows (Paper, 9 · Profile, "About this app"): Backups first (m9/52), then Your
  data (the database: Connected or Unavailable), Speed on your devices (the worst of Speed's three
  ratings, opening Speed), the version, and the design system. The statuses stream from the
  page's load (src/routes/(app)/profile/about.server.ts): a status row keeps its 60 px while it
  loads, a Skeleton in its value's place ("Checking…" for screen readers), so nothing below moves.
  On `/profile/about`, and beside Profile's list from 1024 px.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import type { BackupStatusView } from '#lib/domain/backup/status.ts';
	import type { VitalSummary } from '#lib/domain/vitals.ts';
	import ListRow from '../components/ListRow.svelte';
	import Skeleton from '../components/Skeleton.svelte';
	import { speedAnswer } from './speed';

	interface Props {
		/** The backups' status in the server's words. */
		backups: Promise<Pick<BackupStatusView, 'value' | 'tone'>>;
		/** The database's health check (it answers 'down' rather than failing). */
		health: Promise<{ db: 'up' | 'down' }>;
		/** The p75 web vitals of the last 7 days, or null when they could not be read. */
		vitals: Promise<VitalSummary[] | null>;
		version: string;
	}

	let { backups, health, vitals, version }: Props = $props();

	// The Speed row is a link at once, and its answer fills in when the vitals arrive, as the
	// list's rows' answers do: one row throughout, so focus on it is never lost. A newer load's
	// answer replaces an older one's.
	let speed = $state<string | undefined>();
	$effect(() => {
		const sent = vitals;
		void sent.then((v) => {
			if (vitals === sent) speed = speedAnswer(v);
		});
	});
</script>

<div class="about-list" data-testid="system-card">
	{#await backups}
		<ListRow title="Backups" static aria-busy data-testid="backup-status">
			{#snippet trailing()}<Skeleton width="7rem" height="0.875rem" /><span class="visually-hidden"
					>Checking…</span
				>{/snippet}
		</ListRow>
	{:then backups}
		<ListRow
			title="Backups"
			static
			value={backups.value}
			valueTone={backups.tone === 'warning' ? 'warning' : undefined}
			data-testid="backup-status"
		/>
	{/await}
	{#await health}
		<ListRow title="Your data" static aria-busy>
			{#snippet trailing()}<Skeleton width="6rem" height="0.875rem" /><span class="visually-hidden"
					>Checking…</span
				>{/snippet}
		</ListRow>
	{:then health}
		<ListRow
			title="Your data"
			static
			value={health.db === 'up' ? 'Connected' : 'Unavailable'}
			valueTone={health.db === 'up' ? undefined : 'warning'}
			data-testid="db-status"
		/>
	{/await}
	<ListRow
		title="Speed on your devices"
		value={speed}
		href={resolve('/(app)/profile/about/speed')}
		data-testid="speed-row"
	/>
	<ListRow title="Version" static value={version} data-testid="version" />
	<ListRow title="Design system" href={resolve('/design')} data-testid="design-link" />
</div>

<style>
	.about-list {
		display: grid;
	}
</style>
