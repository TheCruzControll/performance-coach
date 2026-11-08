<!--
  @component
  The badge on an answer the practice (mock) provider wrote, so a scripted answer is never taken
  for the real coach's. Words, not colour, carry it.
-->
<script lang="ts">
	import Badge from '../components/Badge.svelte';
	import { MOCK_BADGE } from './coach-notices.ts';

	let { 'data-testid': testId }: { 'data-testid'?: string } = $props();
</script>

<Badge tone="warning" icon="bolt" data-testid={testId}
	>{MOCK_BADGE.label}<span class="visually-hidden">: {MOCK_BADGE.description}</span></Badge
>
