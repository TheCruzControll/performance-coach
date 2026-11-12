<!--
  @component
  Today's Status Display (Graphite 2004 only, through StatusSlot.svelte): the week, today's
  session, the connection and the changes waiting to sync, from the plan the panel shows (today-status.ts).
-->
<script lang="ts">
	import { connectivity } from '#lib/client/connectivity.svelte.ts';
	import { outboxStatus } from '#lib/client/workout/status.svelte.ts';
	import StatusDisplay from '#lib/ui/components/StatusDisplay.svelte';
	import { todayStatus, type StatusWeek } from './today-status';

	let { week }: { week: StatusWeek } = $props();

	const status = $derived(todayStatus(week, connectivity.online, outboxStatus.current));
</script>

{#if status}<StatusDisplay {...status} data-testid="today-status" />{/if}
