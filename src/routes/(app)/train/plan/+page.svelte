<!--
  The whole plan (Instrument v2, Paper 4 · Train "The whole plan"; plan.server.ts): the program's
  title and length, one line per phase with its weeks (the done ones ticked, the current one
  named, none a link), and at the foot End this plan, which asks first (EndPlanSheet). Reached
  from Train's More. A readable screen: on a desktop the 560 px column, the changes on their own
  page. A read that fails is Train's "Couldn't load your plan", with Try again.
-->
<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import Icon from '#lib/ui/components/Icon.svelte';
	import EndPlanSheet from './EndPlanSheet.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const TRAIN = resolve('/(app)/train');

	const plan = $derived(data.state === 'plan' ? data : null);
	let ending = $state(false);

	let reloading = $state(false);
	async function reload() {
		reloading = true;
		await invalidateAll();
		reloading = false;
	}
</script>

<svelte:head>
	<title>The plan · Train · Performance Coach</title>
</svelte:head>

<div class="screen">
	<a class="back-link" href={TRAIN} data-testid="back-to-train">
		<Icon name="chevron-left" size={16} /> Week
	</a>

	{#if plan}
		<h1 class="title">The plan</h1>
		<p class="lead" data-testid="plan-span">{plan.title} · {plan.span}</p>
		<ul class="phases" role="list" aria-label="Phases" data-testid="plan-phases">
			{#each plan.phases as phase (phase.key)}
				<li class="phase" data-state={phase.state}>
					<span class="name">{phase.state === 'now' ? `${phase.name}, now` : phase.name}</span>
					<span class="weeks numeric">{phase.weeks}</span>
					<span class="end">
						{#if phase.state === 'done'}
							<Icon name="check" size={16} class="tick" />
							<span class="visually-hidden">, done</span>
						{/if}
					</span>
				</li>
			{/each}
		</ul>
		<button
			type="button"
			class="end-plan"
			aria-haspopup="dialog"
			onclick={() => (ending = true)}
			data-testid="end-plan"
		>
			End this plan
		</button>
		<EndPlanSheet bind:open={ending} />
	{:else if data.state === 'error'}
		<!-- One statement in place of the plan, and Try again (Paper, 4 · Train "No week to show"). -->
		<section class="state" data-testid="plan-error" aria-labelledby="state-title">
			<h1 id="state-title" class="statement">{data.card.title}</h1>
			<p class="sentence">{data.card.description}</p>
			<button
				type="button"
				class="again"
				aria-busy={reloading}
				onclick={reload}
				data-testid="plan-retry"
			>
				{data.card.next.title}
			</button>
		</section>
	{/if}
</div>

<style>
	.screen {
		display: flex;
		flex-direction: column;
	}

	/* A state stands at the foot of a phone, above the tab bar, as Train's do; from 1024 px at the
	   top of the column. */
	.screen:has(.state) {
		min-height: calc(100svh - var(--nav-inset-bottom) - var(--safe-top) - var(--space-12));
	}

	.back-link {
		align-self: flex-start;
	}

	.title {
		margin-top: var(--space-10);
		font: var(--type-title);
		letter-spacing: var(--tracking-display);
		color: var(--color-text);
	}

	.lead {
		margin-top: var(--space-2);
		font: var(--type-body);
		color: var(--color-text-secondary);
	}

	/* One 60 px line per phase, a hairline between, as the week's lines are drawn (WeekLines). */
	.phases {
		display: grid;
		margin: var(--space-8) 0 0;
		padding: 0;
		list-style: none;
	}

	.phase {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-height: 3.75rem;
	}

	.phase + .phase {
		border-top: 1px solid var(--color-hairline);
	}

	.name {
		flex: 1;
		min-width: 0;
		font: var(--type-row);
		color: var(--color-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.weeks {
		flex: none;
		font: var(--type-secondary);
		line-height: 1.2; /* 15/18 */
		color: var(--color-text-secondary);
	}

	/* The 32 px end slot: the tick of a done phase, empty otherwise, so the weeks line up. */
	.end {
		display: flex;
		flex: none;
		justify-content: flex-end;
		width: 2rem;
	}

	.end :global(.tick) {
		color: var(--color-text-tertiary);
	}

	[data-state='done'] :is(.name, .weeks) {
		color: var(--color-text-tertiary);
	}

	[data-state='now'] .name {
		font-weight: var(--weight-semibold);
	}

	/* A quiet line under the phases: it asks first. */
	.end-plan {
		align-self: flex-start;
		min-height: var(--touch-target);
		margin-top: var(--space-10);
		font: var(--type-secondary);
		color: var(--color-text-tertiary);
	}

	.state {
		margin-top: auto;
		padding-top: var(--space-10);
	}

	.statement {
		font: var(--type-statement);
		letter-spacing: var(--tracking-statement);
		color: var(--color-text);
	}

	.sentence {
		padding: var(--space-3) 0 var(--space-7);
		font: var(--type-body);
		color: var(--color-text-secondary);
	}

	.again {
		min-height: var(--touch-target);
		font: var(--type-button);
		color: var(--color-text);
	}

	@media (hover: hover) and (pointer: fine) {
		.end-plan:hover {
			color: var(--color-text-secondary);
		}
	}

	@media (width >= 64rem) {
		.screen:has(.state) {
			min-height: 0;
		}

		.state {
			margin-top: 0;
		}
	}
</style>
