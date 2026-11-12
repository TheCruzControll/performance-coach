<!--
  @component
  The next block in a cycle review (next-cycle-data.ts nextCycleView): what it will be and why it
  changes, when it can start and what a late start costs, then 'Start next block'.

  - When it starts: 'This week' or 'Next Monday' as a ChoiceGroup, each with its own preview (the
    phase, weeks and dates; a bridge's unplanned weeks and the weeks lost before a race; week 1
    as a WeekStrip with the chosen day's sessions; what changes and why, the exercises, the
    starting loads labelled estimated, the targets and deload). The chosen start's preview shows,
    and its fingerprint is the one the action reads.
  - Adjust: keep an exercise the rules rotate, move the deload to the other end or skip it.
  - 'Start next block' posts the chosen start with its preview's fingerprint (?/startCycle), then
    the plan overview opens with the toast 'Next block planned · version 3'. 'Not now' leaves it
    waiting here, as the reviews list.
  - Pending: aria-busy, and a second tap posts nothing (generating takes about a second). A stale
    preview (the profile or training changed) reloads with the fresh one and says so. Offline:
    Start is disabled and says why. A failure says so, and Retry posts again.
  - Otherwise: planned (with the plan's link), decided elsewhere, or superseded.

  CycleReview loads it after hydration. Posting in place is next-week-actions.svelte.ts's send,
  fetched on the first tap; should that fetch fail, the form posts natively.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import type { IsoDate } from '#lib/domain/calendar.ts';
	import Badge from '#lib/ui/components/Badge.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import ChoiceGroup from '#lib/ui/components/ChoiceGroup.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	// With SessionCard, as Train and History import them, so the two stay one chunk and one
	// stylesheet; WeekStrip alone here would split them, adding about 0.4 KB gzip of
	// render-blocking CSS to Train, Today and History.
	import SessionCard from '#lib/ui/program/SessionCard.svelte';
	import WeekStrip from '#lib/ui/program/WeekStrip.svelte';
	import type { NextWeekUi } from './next-week-actions.svelte.ts';
	import type { NextCycleView } from './next-cycle-data';

	interface Props {
		next: NextCycleView;
		reviewId: string;
	}

	let { next, reviewId }: Props = $props();

	const ui: NextWeekUi = $state({ pending: null, failure: null, failed: null });
	let online = $state(true);
	onMount(() => (online = navigator.onLine));
	// The chosen start, and the day each start's week 1 is open on.
	// svelte-ignore state_referenced_locally
	let start = $state(next.previews[0]?.start ?? null);
	// svelte-ignore state_referenced_locally
	let days: Record<string, IsoDate> = $state(
		Object.fromEntries(next.previews.map((p) => [p.start, p.week.first]))
	);
	let plain = false;

	function act(event: SubmitEvent) {
		if (plain) return;
		event.preventDefault();
		const form = event.currentTarget as HTMLFormElement;
		import('./next-week-actions.svelte.ts').then(
			(m) => m.send(form, ui, 'startCycle'),
			() => ((plain = true), form.submit())
		);
	}
</script>

<svelte:window ononline={() => (online = true)} onoffline={() => (online = false)} />

<section
	class="next"
	aria-labelledby="next-cycle-title"
	data-testid="next-cycle"
	data-state={next.state}
>
	<h3 id="next-cycle-title">{next.title}</h3>
	{#if next.folded}<Badge tone="accent" data-testid="next-cycle-folded"
			>Includes your coach’s suggestion</Badge
		>{/if}
	{#if next.words}<p class="muted" data-testid="next-cycle-words">{next.words}</p>{/if}

	{#if next.previews.length}
		<form
			method="POST"
			action="?/startCycle"
			onsubmit={act}
			aria-busy={ui.pending ? 'true' : undefined}
		>
			<input type="hidden" name="reviewId" value={reviewId} />
			{#if next.previews.length > 1}
				<ChoiceGroup
					legend="When it starts"
					name="start"
					variant="card"
					options={next.previews.map((p) => ({ value: p.start, label: p.label, hint: p.hint }))}
					bind:value={start}
					data-testid="next-cycle-start"
				/>
			{:else}
				<input type="hidden" name="start" value={start} />
			{/if}

			{#each next.previews as p (p.start)}
				<input type="hidden" name="fingerprint:{p.start}" value={p.fingerprint} />
				{#if p.start === start}<div class="preview" data-testid="next-cycle-preview">
						<h4>{p.title}</h4>
						<p class="muted">{next.previews.length > 1 ? p.dates : `${p.hint} · ${p.dates}`}</p>
						{#each p.notes as note (note.id)}
							<p class="note" data-testid="next-cycle-{note.id}">{note.words}</p>
						{/each}
						<WeekStrip
							days={p.week.days}
							today={p.week.today}
							label="Week 1"
							bind:selected={days[p.start]}
						/>
						<div class="sessions">
							{#each p.week.sessions.filter((s) => s.date === days[p.start]) as s, i (i)}
								<SessionCard session={s} />
							{:else}
								<p class="muted">No sessions this day</p>
							{/each}
						</div>
						{#each p.groups as group (group.id)}
							<h4>{group.title}</h4>
							<ul class="items" data-testid="next-cycle-{group.id}">
								{#each group.items as item, i (i)}
									<li>
										<span class="label">{item.label}</span>
										{#if item.badge}<Badge>{item.badge}</Badge>{/if}
										<span class="muted">{item.words}</span>
									</li>
								{/each}
							</ul>
						{/each}
					</div>{/if}
			{/each}

			{#if next.rotated.length}
				<ChoiceGroup
					legend="Keep instead of rotating"
					name="keep"
					variant="card"
					multiple
					options={next.rotated}
					data-testid="next-cycle-keep"
				/>
			{/if}
			{#if next.deload}
				<ChoiceGroup
					legend="Deload"
					name="deload"
					options={next.deload}
					value={next.deload[0]!.value}
					data-testid="next-cycle-deload"
				/>
			{/if}

			{#if ui.failed}
				<Notice tone="warning" data-testid="next-cycle-failure">{ui.failure}</Notice>
			{:else if !online}
				<p class="muted" data-testid="next-cycle-offline">
					You’re offline. Start it once you’re back online.
				</p>
			{/if}
			<div class="actions">
				<Button
					type="submit"
					loading={!!ui.pending}
					disabled={!online}
					data-testid="next-cycle-start-block">{ui.failed ? 'Retry' : 'Start next block'}</Button
				>
				<Button
					variant="secondary"
					href={resolve('/(app)/progress/reviews/[[key]]', {})}
					data-testid="next-cycle-not-now">Not now</Button
				>
			</div>
		</form>
	{/if}

	{#if next.link}
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the plan's path, from next-cycle-data.ts -->
		<a class="link" href={next.link.href} data-testid="next-cycle-link"
			>{next.link.label} <span aria-hidden="true">→</span></a
		>
	{/if}
</section>

<style>
	.next,
	form,
	.preview,
	.sessions {
		display: grid;
		gap: var(--space-3);
		min-width: 0;
	}

	h3 {
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
	}

	h4,
	.label {
		font-weight: var(--weight-medium);
	}

	.items {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.items li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1) var(--space-2);
		padding: var(--space-2) 0;
	}

	.items li + li {
		border-top: 1px solid var(--color-border);
	}

	.muted {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.note {
		font-weight: var(--weight-medium);
		color: var(--color-warning);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.link {
		display: inline-flex;
		align-items: center;
		min-height: var(--touch-target);
		font-weight: var(--weight-medium);
		color: var(--color-accent-text);
	}

	.link:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	@media (hover: hover) and (pointer: fine) {
		.link:hover {
			color: var(--color-text);
		}
	}
</style>
