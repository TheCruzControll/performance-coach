<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import {
		preferences,
		type DistancePreference,
		type ThemePreference
	} from '#lib/client/preferences.svelte.ts';
	import type { WeightUnit } from '#lib/domain/units.ts';
	import Card from '#lib/ui/components/Card.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import SegmentedControl from '#lib/ui/components/SegmentedControl.svelte';
	import Skeleton from '#lib/ui/components/Skeleton.svelte';
	import Stat from '#lib/ui/components/Stat.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';
	import SectionList from '#lib/ui/profile/SectionList.svelte';
	import { stepHref } from '../../onboarding/paths';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	onMount(() => preferences.load());

	const initials = $derived(
		data.owner.name
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0]!.toUpperCase())
			.join('') || '·'
	);

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

	function formatVital(name: string, value: number) {
		// No Intl here: formatter construction is measurable hydration cost on phones.
		return name === 'CLS' ? value.toFixed(3) : String(Math.round(value));
	}
</script>

<svelte:head>
	<title>Profile · Performance Coach</title>
</svelte:head>

<PageHeader title="Profile" eyebrow="Account" />

<!-- Wide: from 1024 px the training profile sits beside who is signed in and this device's
     preferences, with the system's status below them. Each group keeps the phone's order. -->
<div class="stack profile" data-layout="wide">
	<div class="stack account">
		<Surface padding="md" radius="xl">
			<div class="identity">
				<span class="avatar" aria-hidden="true">{initials}</span>
				<div>
					<p class="name" data-testid="owner-name">{data.owner.name}</p>
					<p class="meta"><Icon name="lock" size={14} /> Signed in with a passkey</p>
				</div>
			</div>
		</Surface>

		<ListRow
			title="Security"
			subtitle="Passkeys, signed-in devices, recovery codes"
			icon="shield"
			href={resolve('/(app)/profile/security')}
			data-testid="security-link"
		/>

		<Card title="Preferences" eyebrow="This device">
			<div class="prefs">
				<div class="pref">
					<span class="pref-label">Units</span>
					<SegmentedControl
						label="Units"
						size="sm"
						value={preferences.units}
						options={[
							{ value: 'kg', label: 'kg' },
							{ value: 'lb', label: 'lb' }
						]}
						onchange={(u: WeightUnit) => preferences.setUnits(u)}
					/>
				</div>
				<div class="pref">
					<span class="pref-label">Distance</span>
					<SegmentedControl
						label="Distance"
						size="sm"
						value={preferences.distance}
						options={[
							{ value: 'km', label: 'km' },
							{ value: 'mi', label: 'mi' }
						]}
						onchange={(d: DistancePreference) => preferences.setDistance(d)}
					/>
				</div>
				<div class="pref">
					<span class="pref-label">Appearance</span>
					<SegmentedControl
						label="Appearance"
						size="sm"
						value={preferences.theme}
						options={[
							{ value: 'dark', label: 'Dark', icon: 'moon' },
							{ value: 'light', label: 'Light', icon: 'sun' },
							{ value: 'system', label: 'Auto', icon: 'device' }
						]}
						onchange={(t: ThemePreference) => preferences.setTheme(t)}
						data-testid="theme-control"
					/>
				</div>
			</div>
		</Card>
	</div>

	<Section title="Training profile" data-testid="training-profile">
		<!-- Streamed: nothing until it settles, and nothing if setup is done or the read failed. -->
		{#await data.setup then setup}
			{#if setup}
				<ListRow
					title="Continue setting up"
					subtitle={setup.stoppedAt
						? `You stopped at ${setup.stoppedAt}`
						: 'About five minutes: your goals, experience and week'}
					icon="target"
					href={stepHref(setup.resume)}
					data-testid="continue-setup"
				/>
			{/if}
		{/await}
		<SectionList />
	</Section>

	<div class="stack system">
		<Card title="System" eyebrow="Status" data-testid="system-card">
			<dl class="rows">
				<div class="row">
					<dt><Icon name="database" size={18} /> Database</dt>
					<dd>
						{#await data.health}
							<span class="loading" aria-busy="true"
								><Skeleton width="6rem" height="0.875rem" /><span class="visually-hidden"
									>Checking…</span
								></span
							>
						{:then health}
							{#if health.db === 'up'}
								<span class="status" data-status="up" data-testid="db-status">
									<span class="led"></span>Connected · {health.dbLatencyMs?.toFixed(0)} ms
								</span>
							{:else}
								<span class="status" data-status="down" data-testid="db-status">
									<span class="led"></span>Unavailable
								</span>
							{/if}
						{/await}
					</dd>
				</div>
				<div class="row">
					<dt><Icon name="bolt" size={18} /> Version</dt>
					<dd class="mono">{data.version}</dd>
				</div>
				<div class="row">
					<dt><Icon name="device" size={18} /> Environment</dt>
					<dd>{data.appEnv}</dd>
				</div>
			</dl>
		</Card>

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
								caption={`${v.samples} ${v.samples === 1 ? 'sample' : 'samples'}`}
								data-testid={`vital-${v.name}`}
							/>
						{/each}
					</ul>
				{:else}
					<p class="note">No samples yet — metrics are collected as you use the app.</p>
				{/if}
			{/await}
		</Card>

		<a class="design-link" href={resolve('/design')}>
			<Icon name="sparkle" size={18} /> Design system <Icon name="chevron-right" size={18} />
		</a>
	</div>
</div>

<style>
	.stack {
		display: grid;
		gap: var(--space-4);
	}

	/* Two columns, read row by row as on a phone: the account beside the training profile, then
	   the system's status under the account. */
	@media (width >= 64rem) {
		.profile {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			grid-template-areas:
				'account training'
				'system training';
			/* The taller list grows the second row, never the gap under the account. */
			grid-template-rows: auto 1fr;
			column-gap: var(--space-8);
			align-items: start;
		}

		.account {
			grid-area: account;
		}

		.profile > :global([data-testid='training-profile']) {
			grid-area: training;
		}

		.system {
			grid-area: system;
		}
	}

	.identity {
		display: flex;
		align-items: center;
		gap: var(--space-4);
	}

	.avatar {
		display: grid;
		place-items: center;
		width: 3.5rem;
		height: 3.5rem;
		border-radius: 50%;
		background:
			radial-gradient(
				circle at 30% 25%,
				color-mix(in srgb, var(--color-accent) 30%, transparent),
				transparent 60%
			),
			var(--color-surface-3);
		border: 1px solid var(--color-border-strong);
		color: var(--color-text);
		font-family: var(--font-display);
		font-size: var(--text-lg);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-tight);
	}

	.name {
		font-family: var(--font-display);
		font-size: var(--text-xl);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-tight);
	}

	.meta {
		display: flex;
		align-items: center;
		gap: var(--space-1-5);
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.prefs {
		display: grid;
		gap: var(--space-4);
	}

	.pref {
		display: grid;
		gap: var(--space-2);
	}

	.pref-label {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.rows {
		display: grid;
		margin: 0;
	}

	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		min-height: 3rem;
		border-top: 1px solid var(--color-hairline);
	}

	.row:first-child {
		border-top: 0;
	}

	dt {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	dd {
		margin: 0;
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		text-align: right;
	}

	.mono {
		font-variant-numeric: tabular-nums;
		color: var(--color-text-secondary);
	}

	.loading {
		display: inline-flex;
	}

	.status {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
	}

	.led {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--color-positive);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-positive) 22%, transparent);
	}

	.status[data-status='down'] .led {
		background: var(--color-danger);
		box-shadow: 0 0 0 3px var(--color-danger-subtle);
	}

	.vitals {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(5.5rem, 1fr));
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.note {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.design-link {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		min-height: var(--touch-target);
		font-size: var(--text-sm);
		color: var(--color-text-tertiary);
	}
</style>
