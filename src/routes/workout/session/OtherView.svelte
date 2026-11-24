<!--
  @component
  An other session (PRD §7, §8; Instrument v2, Paper 4 · Train "How long, how hard"): what the
  plan asked for, or "Today · your own session"; the duration's stepper (the stopwatch's minutes
  until changed) at the foot of the room; then What kind, Effort, Notes, More to keep and Session
  options as rows, each opening its sheet over the page (PickRow, SheetRow): the type as a pick,
  1 to 10 with its word (EffortScale), the notes, and the plan's metrics or the owner's own
  (KeepRows); Save at the foot. The title is the workout header's.
  - Every change is a draft on this device (session.draft), so a reload restores it; nothing is
    sent until Save. Save sends one other.log with every value and clears the draft
    (session-log.ts); saving again after a change sends another, which edits the one record, after
    it synced too.
  - A value Save cannot send is marked at its row (and in its sheet), and the first such row takes
    the focus; a change this device could not save says so, with Retry.
  - Session options opens the session's quick actions (SessionActionsSheet.svelte, loaded on its
    first intent): This hurts, which ends the session, and Swap to a lighter session, where Muay
    Thai has a lighter format: the type it picks sets What kind here (a draft, as any change), and
    Save sends it.
  One column at every width: from 1024 px the Shell centres it at the readable width. Every control
  has hover and :focus-visible states (the primitives').
-->
<script lang="ts">
	import { tick, untrack } from 'svelte';
	import type {
		ActiveSnapshot,
		ActiveWorkout,
		ChunkLoad
	} from '#lib/client/workout/active.svelte.ts';
	import type { OtherFields } from '#lib/domain/workout/index.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import NumberStepper from '#lib/ui/components/NumberStepper.svelte';
	import PickRow from '#lib/ui/components/PickRow.svelte';
	import SheetRow from '#lib/ui/components/SheetRow.svelte';
	import TextArea from '#lib/ui/components/TextArea.svelte';
	import EffortScale from './EffortScale.svelte';
	import KeepRows from './KeepRows.svelte';
	import {
		KIND_WORDS,
		metricField,
		saveActions,
		SESSION_MINUTES,
		shownValues,
		templateOf,
		unsaved,
		type SessionErrors
	} from './session-log.ts';
	import {
		effortWord,
		keptSummary,
		KIND_CHOICES,
		notesValue,
		ownSessionLine
	} from './session-words.ts';
	import type SessionActionsSheet from '../SessionActionsSheet.svelte';

	interface Props {
		snapshot: ActiveSnapshot;
		/** The page's chunk loader, for the quick actions. */
		load: ChunkLoad;
		active: ActiveWorkout;
	}

	let { snapshot, load, active }: Props = $props();
	const view = $derived(snapshot.view);
	const plan = $derived(view.kit?.kind === 'other' ? view.kit.other : null);
	const template = $derived(templateOf(view));

	// The stopwatch's minutes move on while the duration is untouched.
	let now = $state(Date.now());
	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 15_000);
		return () => clearInterval(timer);
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

	/** A refused metric marks More to keep: which one, and why. */
	const keepError = $derived.by(() => {
		const marked = values.metrics.find((m) => errors[metricField(m.key)]);
		if (marked) return `${marked.label}: ${errors[metricField(marked.key)]}`;
		return errors.metrics ?? null;
	});

	/** A value not given yet is its row's placeholder ('Add', in tertiary). */
	const shown = (value: string) => (value === 'Add' ? undefined : value);

	let main: HTMLElement | undefined = $state();

	async function save() {
		const result = saveActions(view, values, new Date().toISOString());
		if (!result.ok) {
			errors = result.errors;
			// The first value Save refused: its field, or the row that opens it.
			await tick();
			main?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
			return;
		}
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

	// The quick actions: fetched on the row's first intent, opened on each tap.
	let Actions = $state.raw<typeof SessionActionsSheet | null>(null);
	let acting = $state.raw<object | null>(null);
	function prefetchActions() {
		void load(() => import('../SessionActionsSheet.svelte')).then((module) => {
			if (module) Actions = module.default;
		});
	}
	function openActions(event: MouseEvent) {
		(event.currentTarget as HTMLElement).focus();
		prefetchActions();
		acting = {};
	}
</script>

<section class="main" aria-label={view.workout.title} bind:this={main} data-testid="session-main">
	<div class="entry" data-testid="session-entry">
		{#if plan && view.workout.plannedSessionId}
			<p class="line" data-testid="session-plan">
				{[
					KIND_WORDS[plan.kind],
					`${plan.durationMinutes} min`,
					plan.targetRpe !== null && `RPE ${plan.targetRpe}`
				]
					.filter(Boolean)
					.join(' · ')}
			</p>
		{:else}
			<p class="line" data-testid="session-line">
				{ownSessionLine(view.workout.startedAt, now)}
			</p>
		{/if}
		<div class="room"></div>
		<NumberStepper
			label="Duration"
			size="md"
			hideLabel
			value={values.durationMinutes}
			min={SESSION_MINUTES[0]}
			max={SESSION_MINUTES[1]}
			step={1}
			bigStep={5}
			unit="min"
			error={errors.durationMinutes}
			onchange={(durationMinutes) => edit({ durationMinutes })}
			ondraft={(durationMinutes) => durationMinutes !== null && edit({ durationMinutes })}
			data-testid="session-duration"
		/>
		<div class="rows">
			<PickRow
				label="What kind"
				options={KIND_CHOICES}
				bind:value={() => values.kind, (kind) => kind !== null && edit({ kind })}
				error={errors.kind}
				data-testid="session-kind"
			/>
			<SheetRow
				label="Effort"
				title="How hard was it"
				value={values.rpe === null ? undefined : effortWord(values.rpe)}
				error={errors.rpe}
				data-testid="session-effort"
			>
				<EffortScale value={values.rpe} onpick={(rpe) => edit({ rpe })} />
			</SheetRow>
			<SheetRow
				label="Notes"
				value={shown(notesValue(values.notes))}
				error={errors.notes}
				data-testid="session-notes-row"
			>
				<TextArea
					label="Notes"
					maxlength={500}
					error={errors.notes}
					bind:value={() => values.notes ?? '', (notes) => edit({ notes })}
					data-testid="session-notes"
				/>
			</SheetRow>
			{#if template === null || values.metrics.length > 0}
				<SheetRow
					label="More to keep"
					value={shown(keptSummary(values.metrics))}
					error={keepError}
					data-testid="session-keep"
				>
					<KeepRows
						metrics={values.metrics}
						{template}
						{errors}
						onchange={(metrics) => edit({ metrics })}
					/>
				</SheetRow>
			{/if}
			<ListRow
				title="Session options"
				aria-haspopup="dialog"
				onpointerdown={prefetchActions}
				onclick={openActions}
				data-testid="session-actions"
			/>
		</div>
	</div>

	<div class="save" data-testid="session-save">
		{#if snapshot.notSaved.length > 0}
			<Notice tone="danger" title="Not saved on this device" data-testid="not-saved">
				This browser couldn't save it.
				<Button size="sm" variant="secondary" icon="refresh" onclick={retry}>Try again</Button>
			</Notice>
		{/if}
		<p class="status" role="status" data-testid="session-status">{status}</p>
		<Button
			size="lg"
			block
			disabled={!active.store || !dirty}
			onclick={save}
			data-testid="save-session"
		>
			{view.other ? 'Save changes' : 'Save session'}
		</Button>
	</div>
</section>

{#if Actions && acting && active.store}
	<Actions
		{view}
		request={acting}
		store={active.store}
		{load}
		skipTo={null}
		minutesLeft={null}
		sessionKind={values.kind}
		onlighter={(kind) => edit({ kind })}
		onfinish={() => (active.finishing = true)}
	/>
{/if}

<style>
	.main {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
	}

	/* Paper: the line at the top, the room, then the duration and the rows at the foot. */
	.entry {
		display: flex;
		flex: 1;
		flex-direction: column;
	}

	.line {
		font: var(--type-body);
		color: var(--color-text-secondary);
	}

	.room {
		flex: 1;
		min-height: var(--space-8);
	}

	.rows {
		display: grid;
		margin-top: var(--space-7);
		border-top: 1px solid var(--color-hairline);
	}

	/* Save stays in the thumb zone, stuck to the screen's foot above the home indicator; the rows
	   scroll under it. */
	.save {
		position: sticky;
		bottom: 0;
		z-index: var(--z-sticky);
		display: grid;
		gap: var(--space-2);
		margin: auto calc(-1 * max(var(--gutter), var(--safe-right)))
			calc(-1 * (var(--space-8) + var(--safe-bottom)))
			calc(-1 * max(var(--gutter), var(--safe-left)));
		padding: var(--space-5) max(var(--gutter), var(--safe-right))
			calc(var(--space-5) + var(--safe-bottom)) max(var(--gutter), var(--safe-left));
		background: var(--color-canvas);
	}

	.status {
		font: var(--type-secondary);
		color: var(--color-text-tertiary);
		text-align: center;
	}

	@media (width >= 64rem) {
		.save {
			position: static;
			margin: 0;
			padding: var(--space-5) 0 0;
			background: none;
		}
	}
</style>
