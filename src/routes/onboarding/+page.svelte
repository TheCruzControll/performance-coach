<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { preferences } from '#lib/client/preferences.svelte.ts';
	import { warmValidation } from '#lib/client/profile-form.ts';
	import { SectionForm } from '#lib/client/section-form.svelte.ts';
	import { STEP_INFO } from '#lib/domain/profile/onboarding.ts';
	import type { BasicsInput } from '#lib/domain/profile/schemas.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import SegmentedControl from '#lib/ui/components/SegmentedControl.svelte';
	import TextField from '#lib/ui/components/TextField.svelte';
	import Step from './Step.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const form = new SectionForm<BasicsInput>(
		untrack(() => ({
			name: data.profile.name,
			weightUnit: data.context.weightUnit,
			distanceUnit: data.context.distanceUnit
		})),
		'basics'
	);

	onMount(warmValidation);

	async function next() {
		const outcome = await form.submit();
		if (outcome.ok) {
			// The device's display units follow the profile.
			preferences.setUnits(form.value.weightUnit);
			preferences.setDistance(form.value.distanceUnit);
		}
	}

	const AHEAD = [
		{
			icon: 'target',
			title: 'Goals & priorities',
			text: 'An event, a general goal, or several at once'
		},
		{ icon: 'bolt', title: 'Experience & strength', text: '1RMs optional — week one finds them' },
		{ icon: 'today', title: 'Your week', text: 'Days, time, classes you already have' }
	] as const;
</script>

<svelte:head>
	<title>Set up · Performance Coach</title>
</svelte:head>

<Step
	step="welcome"
	title={data.onboarding.started ? 'Welcome back' : 'Let’s build your plan around you'}
	lede="About five minutes. Skip anything you don’t know yet — everything stays editable in Profile."
	busy={form.busy}
	error={form.failed}
	continueLabel={data.onboarding.started ? 'Continue' : 'Let’s start'}
	oncontinue={next}
>
	{#if data.onboarding.started && data.onboarding.resume !== 'welcome'}
		<div class="resume" data-testid="resume-card">
			<p>
				You stopped at <strong>{STEP_INFO[data.onboarding.resume].title}</strong>. Your answers so
				far are saved.
			</p>
			<Button
				variant="secondary"
				href={`${resolve('/onboarding')}/${data.onboarding.resume}`}
				iconEnd="arrow-right"
				data-testid="resume-link">Pick up there</Button
			>
		</div>
	{:else}
		<ol class="ahead" aria-label="What we’ll ask">
			{#each AHEAD as item (item.title)}
				<li>
					<span class="glyph" aria-hidden="true"><Icon name={item.icon} size={20} /></span>
					<span>
						<span class="ahead-title">{item.title}</span>
						<span class="ahead-text">{item.text}</span>
					</span>
				</li>
			{/each}
		</ol>
	{/if}

	<div class="fields">
		<TextField
			label="What should your coach call you?"
			bind:value={form.value.name}
			error={form.errors.name}
			autocomplete="given-name"
			autocapitalize="words"
			enterkeyhint="done"
			maxlength={64}
			data-testid="basics-name"
		/>
		<div class="units">
			<div class="unit">
				<span class="unit-label">Weights in</span>
				<SegmentedControl
					label="Weight unit"
					bind:value={form.value.weightUnit}
					options={[
						{ value: 'kg', label: 'kg' },
						{ value: 'lb', label: 'lb' }
					]}
				/>
			</div>
			<div class="unit">
				<span class="unit-label">Distances in</span>
				<SegmentedControl
					label="Distance unit"
					bind:value={form.value.distanceUnit}
					options={[
						{ value: 'km', label: 'km' },
						{ value: 'mi', label: 'mi' }
					]}
				/>
			</div>
		</div>
	</div>
</Step>

<style>
	.ahead {
		display: grid;
		gap: var(--space-1);
		margin: 0;
		padding: var(--space-2) 0;
		list-style: none;
	}

	.ahead li {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		min-height: 3.5rem;
	}

	.ahead li > span:last-child {
		display: grid;
	}

	.glyph {
		display: grid;
		flex: none;
		place-items: center;
		width: 2.75rem;
		height: 2.75rem;
		border-radius: var(--radius-md);
		background: var(--color-accent-subtle);
		color: var(--color-accent-text);
	}

	.ahead-title {
		font-weight: var(--weight-semibold);
	}

	.ahead-text {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.resume {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-4);
		border-radius: var(--radius-lg);
		border: 1px solid color-mix(in srgb, var(--color-accent) 35%, transparent);
		background: var(--color-accent-subtle);
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.resume strong {
		color: var(--color-text);
	}

	.fields {
		display: grid;
		gap: var(--space-5);
	}

	.units {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-3);
	}

	.unit {
		display: grid;
		gap: var(--space-2);
	}

	.unit-label {
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}
</style>
