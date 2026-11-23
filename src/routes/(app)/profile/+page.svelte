<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { preferences } from '#lib/client/preferences.svelte.ts';
	import Card from '#lib/ui/components/Card.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import Skeleton from '#lib/ui/components/Skeleton.svelte';
	import Stat from '#lib/ui/components/Stat.svelte';
	import type { ProfileAnswers } from '#lib/ui/profile/answers.ts';
	import { themeLabel } from '#lib/ui/profile/appearance.ts';
	import ProfileList from '#lib/ui/profile/ProfileList.svelte';
	import { stepHref } from '../../onboarding/paths';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// Appearance's answer is this device's theme: known once the page has mounted, never on the
	// server, which would say "Dark" to a light device.
	let mounted = $state(false);
	onMount(() => {
		preferences.load();
		mounted = true;
	});

	// The rows' answers stream from the Profile layout's load: the rows stay mounted, showing their
	// titles, and their values fill in. A newer load (after a save) replaces an older one's.
	let answers = $state<ProfileAnswers | null>(null);
	$effect(() => {
		const sent = data.answers;
		void sent.then((a) => {
			if (data.answers === sent) answers = a;
		});
	});

	// Core Web Vitals thresholds (good / poor), https://web.dev/articles/vitals
	const VITALS: Record<string, { good: number; poor: number; unit: 'ms' | '' }> = {
		LCP: { good: 2500, poor: 4000, unit: 'ms' },
		INP: { good: 200, poor: 500, unit: 'ms' },
		CLS: { good: 0.1, poor: 0.25, unit: '' },
		FCP: { good: 1800, poor: 3000, unit: 'ms' },
		TTFB: { good: 800, poor: 1800, unit: 'ms' }
	};

	// Rated in words (the dot only reinforces them): never state by colour alone.
	const RATINGS = {
		good: { tone: 'positive', label: 'Good' },
		fair: { tone: 'warning', label: 'Needs work' },
		poor: { tone: 'danger', label: 'Poor' }
	} as const;

	function rating(name: string, value: number) {
		const t = VITALS[name];
		if (!t) return undefined;
		return RATINGS[value <= t.good ? 'good' : value <= t.poor ? 'fair' : 'poor'];
	}

	const samples = (n: number) => `${n} ${n === 1 ? 'sample' : 'samples'}`;

	function formatVital(name: string, value: number) {
		// No Intl here: formatter construction is measurable hydration cost on phones.
		return name === 'CLS' ? value.toFixed(3) : String(Math.round(value));
	}
</script>

<svelte:head>
	<title>Profile · Performance Coach</title>
</svelte:head>

<a class="back-link" href={resolve('/(app)/today')} data-testid="back-to-today">
	<Icon name="chevron-left" size={16} /> Today
</a>
<div class="head">
	<PageHeader title="Profile" />
	<p class="lede" data-testid="owner-name">{data.owner.name}</p>
</div>

<!-- Split from 1024 px, at Profile's measure (layout.css): the list, then About this app behind a
     hairline, where a section's screen has its own content. Each column keeps the phone's order. -->
<div class="profile" data-layout="split" data-measure="profile">
	<div class="list-column">
		<!-- Streamed: nothing until it settles, and nothing if setup is done or the read failed. -->
		{#await data.setup then setup}
			{#if setup}
				<ListRow
					title="Continue setting up"
					subtitle={setup.stoppedAt
						? `You stopped at ${setup.stoppedAt}`
						: 'About five minutes: your goals, experience and week'}
					href={stepHref(setup.resume)}
					data-testid="continue-setup"
				/>
			{/if}
		{/await}
		<ProfileList {answers} theme={mounted ? themeLabel(preferences.theme) : undefined} />
	</div>

	<div class="about">
		<section class="group" aria-labelledby="about-app" data-testid="system-card">
			<h2 class="label" id="about-app">About this app</h2>
			<!-- Streamed: each row keeps its 60 px while its status loads, so nothing below moves. -->
			{#await data.backups}
				<ListRow title="Backups" static aria-busy data-testid="backup-status">
					{#snippet trailing()}<Skeleton width="7rem" height="0.875rem" /><span
							class="visually-hidden">Checking…</span
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
			{#await data.health}
				<ListRow title="Database" static aria-busy>
					{#snippet trailing()}<Skeleton width="6rem" height="0.875rem" /><span
							class="visually-hidden">Checking…</span
						>{/snippet}
				</ListRow>
			{:then health}
				<ListRow
					title="Database"
					static
					value={health.db === 'up'
						? `Connected · ${health.dbLatencyMs?.toFixed(0)} ms`
						: 'Unavailable'}
					valueTone={health.db === 'up' ? undefined : 'warning'}
					data-testid="db-status"
				/>
			{/await}
			<ListRow title="Version" static value={data.version} />
			<ListRow title="Environment" static value={data.appEnv} />
		</section>

		<Card title="Real-user performance" eyebrow="p75 · last 7 days">
			{#await data.vitals}
				<div class="vitals" aria-busy="true">
					{#each [0, 1, 2] as i (i)}<Skeleton height="3.5rem" radius="var(--radius-md)" />{/each}
				</div>
			{:then vitals}
				{#if vitals && vitals.length}
					<ul class="vitals">
						{#each vitals as v (v.name)}
							<Stat
								as="li"
								level={2}
								label={v.name}
								value={formatVital(v.name, v.p75)}
								unit={VITALS[v.name]?.unit || undefined}
								rating={rating(v.name, v.p75)}
								caption={samples(v.samples)}
								data-testid={`vital-${v.name}`}
							/>
						{/each}
					</ul>
					<!-- The app opens on Today (the manifest's start_url): what a launch costs. -->
					<section class="start" aria-labelledby="start-vitals" data-testid="start-vitals">
						<h3 id="start-vitals" class="subhead">Opening the app · Today</h3>
						{#if vitals.some((v) => v.start)}
							<ul class="vitals">
								{#each vitals as v (v.name)}
									{#if v.start}
										<Stat
											as="li"
											level={2}
											label={v.name}
											value={formatVital(v.name, v.start.p75)}
											unit={VITALS[v.name]?.unit || undefined}
											rating={rating(v.name, v.start.p75)}
											caption={samples(v.start.samples)}
											data-testid={`start-vital-${v.name}`}
										/>
									{/if}
								{/each}
							</ul>
						{:else}
							<p class="note">No launches measured yet — they appear after you open the app.</p>
						{/if}
					</section>
				{:else}
					<p class="note">No samples yet — metrics are collected as you use the app.</p>
				{/if}
			{/await}
		</Card>

		<a class="design-link" href={resolve('/design')}>Design system</a>
	</div>
</div>

<style>
	/* Rows only: from 1024 px the columns are Profile's measure's (layout.css). */
	.profile {
		display: grid;
		row-gap: var(--space-9);
	}

	.list-column,
	.about {
		display: grid;
		gap: var(--space-9);
	}

	/* The owner's name, 8 px under the title (the header pads 20 px below it). */
	.lede {
		margin-top: calc(var(--space-2) - var(--space-5));
		font: var(--type-body);
		color: var(--color-text-secondary);
	}

	.group {
		display: grid;
	}

	.label {
		font: var(--type-secondary);
		color: var(--color-text-tertiary);
	}

	/* From 1024 px the rail is the way back to Today, so the link goes, and the owner's name sits
	   above the title in 15 px (Paper, 14 · "Profile, goals"). */
	@media (width >= 64rem) {
		.back-link {
			display: none;
		}

		.head {
			display: flex;
			flex-direction: column;
		}

		.lede {
			order: -1;
			margin-top: 0;
			font: var(--type-secondary);
		}
	}

	.vitals {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(5.5rem, 1fr));
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.start {
		display: grid;
		gap: var(--space-2);
		margin-top: var(--space-4);
		padding-top: var(--space-4);
		border-top: 1px solid var(--color-border);
	}

	.subhead {
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		color: var(--color-text-secondary);
	}

	.note {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	/* A plain text link, its hit area still 44 px tall. */
	.design-link {
		display: inline-flex;
		align-items: center;
		justify-self: start;
		min-height: var(--touch-target);
		font: var(--type-secondary);
		color: var(--color-text-secondary);
	}
</style>
