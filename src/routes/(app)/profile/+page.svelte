<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { preferences, type ThemePreference } from '#lib/client/preferences.svelte.ts';
	import type { WeightUnit } from '#lib/domain/units.ts';
	import Card from '#lib/ui/components/Card.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import SegmentedControl from '#lib/ui/components/SegmentedControl.svelte';
	import Skeleton from '#lib/ui/components/Skeleton.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	onMount(() => preferences.load());

	// Core Web Vitals thresholds (good / poor), https://web.dev/articles/vitals
	const VITALS: Record<string, { good: number; poor: number; unit: 'ms' | '' }> = {
		LCP: { good: 2500, poor: 4000, unit: 'ms' },
		INP: { good: 200, poor: 500, unit: 'ms' },
		CLS: { good: 0.1, poor: 0.25, unit: '' },
		FCP: { good: 1800, poor: 3000, unit: 'ms' },
		TTFB: { good: 800, poor: 1800, unit: 'ms' }
	};

	function rating(name: string, value: number) {
		const t = VITALS[name];
		if (!t) return 'neutral';
		return value <= t.good ? 'good' : value <= t.poor ? 'fair' : 'poor';
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

<div class="stack">
	<Surface padding="md" radius="xl">
		<div class="identity">
			<!-- Identity comes from the signed-in account once passkey auth exists (M2). -->
			<span class="avatar" aria-hidden="true"><Icon name="profile" size={26} /></span>
			<div>
				<p class="name">Preview mode</p>
				<p class="meta"><Icon name="lock" size={14} /> Passkey sign-in coming soon</p>
			</div>
		</div>
	</Surface>

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

	<Card title="Training profile" eyebrow="Goals & baseline">
		{#snippet action()}<span class="soon">Soon</span>{/snippet}
		<p class="note">
			Goals, schedule, experience and optional 1RMs. You'll be able to change any of it, any time.
		</p>
	</Card>

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
						<li class="vital" data-rating={rating(v.name, v.p75)}>
							<span class="vital-name">{v.name}</span>
							<span class="vital-value numeric"
								>{formatVital(v.name, v.p75)}<small>{VITALS[v.name]?.unit}</small></span
							>
							<span class="vital-n">{v.samples} {v.samples === 1 ? 'sample' : 'samples'}</span>
						</li>
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

<style>
	.stack {
		display: grid;
		gap: var(--space-4);
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
		color: var(--color-text-secondary);
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

	.vital {
		--rating: var(--color-text-tertiary);
		display: grid;
		gap: 2px;
		padding: var(--space-3);
		border-radius: var(--radius-md);
		background: var(--color-surface-2);
		border: 1px solid var(--color-border);
	}

	.vital[data-rating='good'] {
		--rating: var(--color-positive);
	}
	.vital[data-rating='fair'] {
		--rating: var(--color-warning);
	}
	.vital[data-rating='poor'] {
		--rating: var(--color-danger);
	}

	.vital-name {
		font-size: var(--text-2xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		color: var(--rating);
	}

	.vital-value {
		font-size: var(--text-xl);
		font-weight: var(--weight-bold);
	}

	.vital-value small {
		margin-left: 2px;
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
		color: var(--color-text-tertiary);
	}

	.vital-n {
		font-size: var(--text-2xs);
		color: var(--color-text-tertiary);
	}

	.note {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.soon {
		display: inline-block;
		margin-top: var(--space-2);
		padding: var(--space-1) var(--space-2);
		border-radius: var(--radius-full);
		background: var(--color-accent-subtle);
		color: var(--color-accent-text);
		font-size: var(--text-2xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
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
