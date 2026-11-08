/**
 * What the workout pages load on idle, after the engine: the sync status for the header, the
 * signed-out state, and the status they follow. One chunk, so the first render carries none of it.
 */
export { outboxStatus } from '#lib/client/workout/status.svelte.ts';
export { default as SignedOutState } from './SignedOutState.svelte';
export { default as SyncStatus } from './SyncStatus.svelte';
