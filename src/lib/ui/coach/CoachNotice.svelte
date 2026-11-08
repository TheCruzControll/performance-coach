<!--
  @component
  One of the coach's notices, worded in coach-notices.ts: why the coach cannot run (not launched,
  switched off, misconfigured), how a turn ended (rate limited, budget, refused, busy, offline, a
  failure), a piece of the screen that failed to load or a write that failed, each a Notice with
  an icon and words, and Retry where trying again can work; or the empty state, when there is no
  conversation yet. Retry is offered only with `onretry`, and is busy while `retrying`.
-->
<script lang="ts">
	import Button from '../components/Button.svelte';
	import EmptyState from '../components/EmptyState.svelte';
	import Notice from '../components/Notice.svelte';
	import { COACH_NOTICES, type CoachNoticeKind } from './coach-notices.ts';

	interface Props {
		kind: CoachNoticeKind;
		onretry?: () => void;
		retrying?: boolean;
		'data-testid'?: string;
	}

	let { kind, onretry, retrying = false, 'data-testid': testId }: Props = $props();

	const copy = $derived(COACH_NOTICES[kind]);
</script>

{#if kind === 'empty'}
	<EmptyState
		compact
		icon={copy.icon}
		title={copy.title}
		description={copy.body}
		data-testid={testId}
	/>
{:else}
	<Notice tone={copy.tone} icon={copy.icon} title={copy.title} data-testid={testId}>
		<p>{copy.body}</p>
		{#if copy.retry && onretry}
			<div class="action">
				<Button variant="secondary" size="sm" icon="refresh" loading={retrying} onclick={onretry}
					>Retry</Button
				>
			</div>
		{/if}
	</Notice>
{/if}

<style>
	.action {
		margin-top: var(--space-2);
	}
</style>
