<!--
  @component
  An other session (PRD §7, §8): Muay Thai, mobility, S&C or the owner's own. What the plan
  asked for, then the session's fields (SessionFields): type, duration (the stopwatch's until
  changed), RPE, the plan's metrics or the owner's own, and notes.
  - Every change is a draft on this device (session.draft), so a reload restores it; nothing is
    sent until Save. Save sends one other.log with every value and clears the draft
    (session-log.ts); saving again after a change sends another, which edits the one record, after
    it synced too.
  - A value Save cannot send is marked at its field; a change this device could not save says so,
    with Retry.
  One column at every width: from 1024 px the Shell centres it at the readable width. Every control
  has hover and :focus-visible states (the primitives').
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import type { ActiveSnapshot, ActiveWorkout } from '#lib/client/workout/active.svelte.ts';
	import type { OtherFields } from '#lib/domain/workout/index.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import {
		KIND_WORDS,
		saveActions,
		shownValues,
		templateOf,
		unsaved,
		type SessionErrors
	} from './session-log.ts';
	import SessionFields from './SessionFields.svelte';

	interface Props {
		snapshot: ActiveSnapshot;
		active: ActiveWorkout;
	}

	let { snapshot, active }: Props = $props();
	const view = $derived(snapshot.view);
	const plan = $derived(view.kit?.kind === 'other' ? view.kit.other : null);
	const template = $derived(templateOf(view));

	// The stopwatch's minutes move on while the duration is untouched.
	let now = $state(Date.now());
	$effect(() => {
		const tick = setInterval(() => (now = Date.now()), 15_000);
		return () => clearInterval(tick);
	});

	/** What this page changed since its last Save, over the device's draft until the store has it. */
	let changed = $state.raw<Partial<OtherFields>>({});
	const values = $derived<OtherFields>({ ...shownValues(view, now), ...changed });
	const dirty = $derived(unsaved(view, values));
	let errors = $state.raw<SessionErrors>({});

	/** The draft, kept on this device; a page opened before the store connects keeps it on arrival. */
	function persist() {
		if (Object.keys(changed).length === 0) return;
		const draft = { ...view.device.session, ...changed };
		active.store?.dispatch({ type: 'session.draft', workoutId: view.workout.id, draft });
	}
	$effect(() => {
		if (active.store) untrack(persist);
	});

	function edit(change: Partial<OtherFields>) {
		changed = { ...changed, ...change };
		const cleared = { ...errors };
		for (const key of Object.keys(change)) delete cleared[key];
		if (change.metrics)
			for (const key of Object.keys(cleared)) {
				if (key.startsWith('metric:')) delete cleared[key];
			}
		errors = cleared;
		persist();
	}

	function save() {
		const result = saveActions(view, values, new Date().toISOString());
		if (!result.ok) return void (errors = result.errors);
		active.store?.dispatch(...result.actions);
		changed = {};
		errors = {};
	}

	const retry = async () => {
		for (const { id } of snapshot.notSaved) await active.store?.retry(id);
	};

	const status = $derived(
		!view.other
			? 'Not saved yet'
			: dirty
				? 'Changes not saved'
				: view.other.pending
					? 'Saved on this device'
					: 'Saved'
	);
</script>

<div class="main" data-testid="session-main">
	<section class="card" aria-labelledby="session-name" data-testid="session-entry">
		<header class="head">
			<p class="place">
				{plan && view.workout.plannedSessionId ? 'Planned session' : 'Your session'}
			</p>
			<h2 id="session-name">{view.workout.title}</h2>
			{#if plan}
				<p class="target" data-testid="session-plan">
					{[
						KIND_WORDS[plan.kind],
						`${plan.durationMinutes} min`,
						plan.targetRpe !== null && `RPE ${plan.targetRpe}`
					]
						.filter(Boolean)
						.join(' · ')}
				</p>
			{/if}
		</header>
		<SessionFields {values} {errors} {template} onchange={edit} />
	</section>

	<div class="save" data-testid="session-save">
		{#if snapshot.notSaved.length > 0}
			<Notice tone="danger" title="Not saved on this device" data-testid="not-saved">
				This browser couldn't save it.
				<Button size="sm" variant="secondary" icon="refresh" onclick={retry}>Try again</Button>
			</Notice>
		{/if}
		<p class="status" role="status" data-testid="session-status">{status}</p>
		<Button
			block
			icon="check"
			disabled={!active.store || !dirty}
			onclick={save}
			data-testid="save-session"
		>
			{view.other ? 'Save changes' : 'Save session'}
		</Button>
	</div>
</div>

<style>
	.main {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: var(--space-4);
		min-width: 0;
	}

	.card {
		display: grid;
		gap: var(--space-5);
		padding: var(--space-4);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-surface-1);
		box-shadow: var(--elevation-1);
	}

	.head {
		display: grid;
		gap: var(--space-1);
	}

	.place {
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
	}

	.target {
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
	}

	h2 {
		font-family: var(--font-display);
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-tight);
		overflow-wrap: anywhere;
	}

	/* Save stays in the thumb zone, stuck to the screen's foot above the home indicator. */
	.save {
		position: sticky;
		bottom: 0;
		z-index: var(--z-sticky);
		display: grid;
		gap: var(--space-2);
		margin: auto calc(-1 * max(var(--gutter), var(--safe-right)))
			calc(-1 * (var(--space-8) + var(--safe-bottom)))
			calc(-1 * max(var(--gutter), var(--safe-left)));
		padding: var(--space-3) max(var(--gutter), var(--safe-right))
			calc(var(--space-3) + var(--safe-bottom)) max(var(--gutter), var(--safe-left));
		border-top: 1px solid var(--color-border);
		background: var(--color-surface-1);
		box-shadow: var(--elevation-2);
	}

	.status {
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
		text-align: center;
	}

	@media (width >= 64rem) {
		.save {
			position: static;
			margin: 0;
			padding: 0;
			border: 0;
			background: none;
			box-shadow: none;
		}
	}
</style>
