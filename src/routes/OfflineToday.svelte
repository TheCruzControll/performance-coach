<!--
  @component
  Today's sessions on the offline screen at the start URL or /offline (a launch with no signal),
  from the kits Today and Train saved on this device (client/workout/coming-kits.ts), so a launch without a
  workout in progress can still start today's workout: each session's card with Start workout
  (/workout?start=, which starts from the saved kit offline), Resume for the workout in progress
  here, or Done once completed here. With none saved for today, a designed note says how to keep
  them ready and offers an ad-hoc workout, which needs no kit. It reads IndexedDB once mounted,
  never creating the database (probe.ts), and shows nothing until that read settles: a few
  milliseconds, so no skeleton flashes.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { savedToday, type OfflineSession } from '#lib/client/workout/today-kits.ts';
	import Badge from '#lib/ui/components/Badge.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';
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
				<Badge icon="check">Saved on this device</Badge>
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
				<Surface padding="none" radius="lg">
					<EmptyState
						compact
						icon="today"
						tone="neutral"
						title="No sessions saved for today"
						description="Open Today or Train with a connection, the day before or on the day, and its sessions are kept here, ready to start with no signal."
						data-testid="offline-today-empty"
					/>
				</Surface>
			{/each}
			<Button
				variant="ghost"
				icon="plus"
				href={resolve('/workout')}
				data-testid="offline-log-other"
			>
				Log something else
			</Button>
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
</style>
