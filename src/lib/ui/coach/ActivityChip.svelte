<!--
  @component
  One step of a coach turn, as activityLabel words it (domain/coach/activity.ts): 'Looking at your
  last 6 bench sessions…' while it runs, then what it found, or that it could not. The words carry
  the state; a spinner, a check or an alert mark only repeat it, never colour alone.
-->
<script lang="ts">
	import type { ActivityState } from '#lib/domain/coach/index.ts';
	import Icon from '../components/Icon.svelte';
	import Spinner from '../components/Spinner.svelte';

	interface Props {
		state: ActivityState;
		label: string;
		'data-testid'?: string;
	}

	let { state, label, ...rest }: Props = $props();
</script>

<span class="activity" data-state={state} {...rest}>
	<span class="mark" aria-hidden="true"
		>{#if state === 'running'}<Spinner size={14} />{:else}<Icon
				name={state === 'done' ? 'check' : 'alert'}
				size={14}
				strokeWidth={2}
			/>{/if}</span
	><span class="label">{label}</span>
</span>

<style>
	.activity {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1-5);
		max-width: 100%;
		min-height: 1.75rem;
		padding: var(--space-1) var(--space-3) var(--space-1) var(--space-2);
		border-radius: var(--radius-full);
		border: 1px solid var(--color-border);
		background: var(--color-surface-1);
		color: var(--color-text-secondary);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
		line-height: var(--leading-snug);
	}

	.mark {
		display: grid;
		flex: none;
		color: var(--color-text-tertiary);
	}

	.activity[data-state='done'] .mark {
		color: var(--color-positive);
	}

	/* Couldn't: a dashed edge and the alert mark, besides the words. */
	.activity[data-state='failed'] {
		border-style: dashed;
		color: var(--color-text);
	}

	.activity[data-state='failed'] .mark {
		color: var(--color-warning);
	}

	.label {
		min-width: 0;
		overflow-wrap: anywhere;
	}
</style>
