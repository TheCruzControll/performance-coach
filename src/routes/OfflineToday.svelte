<!--
  @component
  Today's sessions on the offline screen at the start URL or /offline (a launch with no signal),
  from the kits Today and Train saved on this device (client/workout/coming-kits.ts), so a launch without a
  workout in progress can still start today's workout: each session's card with Start workout
  (/workout?start=, which starts from the saved kit offline), Resume for the workout in progress
  here, or Done once completed here. With none saved for today, it says so and how to keep them
  ready next time (Paper, 10 · States). Either way one row offers an ad-hoc workout, which needs
  no kit. It reads IndexedDB once mounted, never creating the database (probe.ts), and shows
  nothing until that read settles: a few milliseconds, so no skeleton flashes.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { savedToday, type OfflineSession } from '#lib/client/workout/today-kits.ts';
	import Badge from '#lib/ui/components/Badge.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import SessionCard from '#lib/ui/program/SessionCard.svelte';

	let sessions = $state<OfflineSession[]>();

	onMount(() => {
		let live = true;
		void savedToday()
			.catch(() => [])
			.then((found) => {
				if (live) sessions = found;
			});
		return () => (live = false);
	});

	const card = (session: OfflineSession) => ({
		title: session.title,
		line: session.line,
		tone: session.tone,
		status: session.action ? ('planned' as const) : ('completed' as const),
		statusWords: session.action ? null : 'Done'
	});
</script>

{#if sessions}
	<div class="offline-today" data-testid="offline-today" data-count={sessions.length}>
		<Section title="Today’s sessions" gap="md">
			{#snippet action()}
				{#if sessions?.length}
					<Badge icon="check">Saved on this device</Badge>
				{/if}
			{/snippet}
			{#each sessions as session (session.lineage)}
				<div class="session" data-testid="offline-session">
					<SessionCard session={card(session)} />
					{#if session.action}
						<Button
							icon="play"
							href={session.action.href}
							block
							data-testid={`offline-${session.action.id}`}>{session.action.label}</Button
						>
					{/if}
				</div>
			{:else}
				<!-- Paper, 10 · States, "Offline nothing saved": why, and how to have them next time. -->
				<div class="none" data-testid="offline-today-empty">
					<h2 class="statement">Today isn’t saved on this device</h2>
					<p class="body">
						Open Today with signal the day before and its sessions wait here, ready to start.
					</p>
				</div>
			{/each}
			<!-- The one other thing to do: a plain row, never a second button. -->
			<div class="other">
				<ListRow
					title="Log something else"
					href={resolve('/workout')}
					data-testid="offline-log-other"
				/>
			</div>
		</Section>
	</div>
{/if}

<style>
	.offline-today {
		width: 100%;
		padding-bottom: var(--space-6);
	}

	.session {
		display: grid;
		gap: var(--space-2);
	}

	.none {
		display: grid;
		gap: var(--space-4);
		padding-bottom: var(--space-6);
	}

	/* Paper's hairline above the one plain row; the list's last row has none below. */
	.other {
		border-top: 1px solid var(--color-hairline);
	}

	.statement {
		font: var(--type-statement);
		letter-spacing: var(--tracking-statement);
	}

	.body {
		font: var(--type-body);
		color: var(--color-text-secondary);
	}
</style>
