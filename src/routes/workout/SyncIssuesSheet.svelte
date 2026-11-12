<!--
  @component
  The sync sheet (the brief's failed-sync recovery), opened from the header's sync pill and loaded
  only then: every change still on this device, in words (describe.ts).
  - Needs attention: a change the server refused, or one that kept failing past the cap
    (outbox-rules' STUCK_AFTER), each with why ('Weight: Up to 1000 kg', 'Couldn't sync for a day:
    the server answered 500') and its actions:
    - Fix, from the registry by type (fix/registry.ts): the set editor with the refused values, a
      family's own editor (loaded then), or a one-tap rewrite. The corrected change is checked
      with the schemas (loaded on demand), then re-queued under its id, in its place. 'Deleted on another device' offers Discard only.
    - Try again, for a change parked after the cap: queued again, its count cleared.
    - Discard, after a confirmation that says how many changes go: the change and every later one
      that depends on it. A start that kept failing may have reached the server, so its Discard
      keeps it and ends the workout as abandoned: only the changes logged in it go, and the start
      and its abandon wait to sync, however often it gets stuck. A toast says so when the store
      refuses it, because it would bring a workout back into progress beside the one in progress.
      The finish or abandon of a workout a sign-out stripped from this device (the store's
      heldEnds) offers no Discard: the server holds it in progress, so it waits for the server, and
      a line says so. Nothing re-sends a parked one by itself, so it offers Try again, refused too:
      the same change through Fix, at the time now when the server named its time (sentAgain).
      Discard of a change it depends on leaves it queued.
  - Waiting to sync: the rest, in order, in words.
  - A recovery session ('Finish adding your passkey') links to adding one; nothing is deleted.
  It re-reads the outbox whenever the store reports a change, so an answer shows at once.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount, tick } from 'svelte';
	import { STUCK_AFTER } from '#lib/client/workout/outbox-rules.ts';
	import type { OutboxEntry, OutboxStatus } from '#lib/client/workout/outbox-rules.ts';
	import { ActiveWorkoutError } from '#lib/client/workout/store.ts';
	import type { WorkoutStore } from '#lib/client/workout/store.ts';
	import { DEFAULT_LOAD_INCREMENT } from '#lib/domain/units.ts';
	import { describeMutation, problemText } from '#lib/domain/workout/describe.ts';
	import type { DescribeContext } from '#lib/domain/workout/describe.ts';
	import type { FieldErrors } from '#lib/domain/validation.ts';
	import { SYNC_CODE_LABEL } from '#lib/domain/workout/index.ts';
	import type { LoggedSet, Mutation, WorkoutView } from '#lib/domain/workout/index.ts';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import { toast } from '#lib/ui/toast.svelte.ts';
	import { syncWords } from '#lib/ui/workout/sync-words.ts';
	import { fixFor, type FixEntry } from './fix/registry.ts';
	import { discardOffer, sentAgain } from './fix/workout.ts';
	import SetEditSheet from './SetEditSheet.svelte';

	interface Props {
		open: boolean;
		store: WorkoutStore;
		/** The workout shown, for the names in the words; null when there is none. */
		view: WorkoutView | null;
		status: OutboxStatus | null;
	}

	let { open = $bindable(), store, view, status }: Props = $props();

	let entries = $state.raw<OutboxEntry[]>([]);
	/** The ends kept for the server (the store's heldEnds): no Discard for them. */
	let held = $state.raw<ReadonlySet<number>>(new Set());
	let now = $state(Date.now());
	let fixes = $state.raw<Partial<Record<string, FixEntry>>>({});
	/** The entry whose Discard is being confirmed. */
	let confirming = $state<number | null>(null);
	/** A fix the schemas refused here, by seq. */
	let notes = $state.raw<Partial<Record<number, string>>>({});
	let list: HTMLDivElement | undefined = $state();

	interface Editing {
		seq: number;
		m: Extract<Mutation, { type: 'set.log' | 'set.skip' | 'set.edit' }>;
		setIndex: number;
		exerciseId: string;
		position: number;
		values: LoggedSet;
		problem: string;
	}
	let editing = $state.raw<Editing | null>(null);
	let editorOpen = $state(false);
	/** A family's own editor, open on a refused change. */
	let custom = $state.raw<{
		seq: number;
		m: Mutation;
		problem: string;
		errors: FieldErrors;
		Editor: Awaited<ReturnType<Extract<FixEntry, { kind: 'editor' }>['editor']>>['default'];
	} | null>(null);

	async function read() {
		try {
			[entries, held] = await Promise.all([store.outbox(), store.heldEnds()]);
			now = Date.now();
			for (const { parked, envelope } of entries) {
				if (parked && !fixes[envelope.type]) {
					fixes = { ...fixes, [envelope.type]: await fixFor(envelope.type) };
				}
			}
		} catch {
			// Closed (sign-out), or a family module gone after a deploy: Discard still works.
		}
	}

	onMount(() => {
		void read();
		return store.onChange(() => void read());
	});

	const setById = (id: string) =>
		view?.slots.flatMap((slot) => slot.sets).find((set) => set.id === id);
	const context: DescribeContext = {
		exerciseName: (id) => view?.exercises[id]?.name,
		set: setById
	};

	const attention = $derived(entries.filter((e) => e.parked));
	const waiting = $derived(entries.filter((e) => !e.parked));
	const problemOf = (e: OutboxEntry) =>
		problemText(
			e.parked!,
			e.failingSince !== null && now - e.failingSince >= STUCK_AFTER.ms ? null : e.attempts
		);

	/** Runs an answer, then puts focus on what is left: the store shows the change. */
	async function act(run: () => Promise<void>) {
		confirming = null;
		try {
			await run();
		} catch (error) {
			// Discard refused: it would bring a workout back into progress beside the one in progress.
			// The sheet closes first: under its modal the toast is dimmed and never announced.
			if (error instanceof ActiveWorkoutError) {
				open = false;
				toast.show('Finish or end the workout in progress first.', { tone: 'danger' });
				return;
			}
			// Otherwise the store closed: the page shows why.
		}
		await tick();
		list?.querySelector<HTMLElement>('button')?.focus();
	}

	async function confirmDiscard(seq: number) {
		confirming = seq;
		await tick();
		list?.querySelector<HTMLElement>('[data-testid="keep-change"]')?.focus();
	}

	const EMPTY: LoggedSet = {
		reps: null,
		seconds: null,
		metres: null,
		weight: null,
		assistance: null,
		unit: 'kg',
		rpe: null,
		missedReps: 0,
		isWarmup: false,
		isExtra: false
	};

	function fix(entry: OutboxEntry, how: FixEntry) {
		const m = entry.envelope;
		if (how.kind === 'rewrite') return act(() => store.fix(entry.seq, how.rewrite(m)));
		if (how.kind === 'editor') {
			const { seq } = entry;
			const problem = problemOf(entry);
			const errors = entry.parked?.errors ?? {};
			// A chunk gone after a deploy leaves Discard, which always works.
			return how.editor().then(
				({ default: Editor }) => {
					editing = null;
					custom = { seq, m, problem, errors, Editor };
					editorOpen = true;
				},
				() => {}
			);
		}
		if (m.type !== 'set.log' && m.type !== 'set.skip' && m.type !== 'set.edit') return;
		const set = m.type === 'set.edit' ? setById(m.entityId) : m.payload;
		custom = null;
		editing = {
			seq: entry.seq,
			m,
			setIndex: set?.setIndex ?? 1,
			exerciseId: set?.exerciseId ?? '',
			position: set?.position ?? 0,
			values:
				m.type === 'set.skip' ? { ...EMPTY, unit: m.payload.unit } : { ...EMPTY, ...m.payload },
			problem: problemOf(entry)
		};
		editorOpen = true;
	}

	/** The corrected set, checked here first: the schemas load now, never before. */
	async function save(values: LoggedSet) {
		if (!editing) return;
		const { seq, m } = editing;
		const next = (
			m.type === 'set.log'
				? { ...m, payload: { ...m.payload, ...values } }
				: { ...m, payload: values }
		) as Mutation;
		await requeue(seq, next);
	}

	/**
	 * A corrected change, checked here first (the schemas load now, never before), re-queued; then
	 * `then`, a change it brings (a segment's new totals), queued after every older one.
	 */
	async function requeue(seq: number, next: Mutation, then?: Mutation) {
		try {
			const [{ validate }, { envelopeSchema }] = await Promise.all([
				import('#lib/domain/validation.ts'),
				import('#lib/domain/workout/schemas.ts')
			]);
			const checked = validate(envelopeSchema, next);
			if (!checked.ok) {
				const why = problemText({ reason: 'refused', errors: checked.errors, message: '' }, 0);
				notes = { ...notes, [seq]: why };
				return;
			}
		} catch {
			// The schemas' chunk is gone after a deploy: the server checks it anyway.
		}
		notes = { ...notes, [seq]: undefined };
		await act(async () => {
			await store.fix(seq, next);
			if (then) await store.dispatch(then).saved;
		});
	}

	const exerciseOf = (id: string) => view?.exercises[id];
</script>

<BottomSheet
	bind:open
	title="Changes on this device"
	description={status ? syncWords(status).text : undefined}
	data-testid="sync-sheet"
>
	<div class="sheet" bind:this={list}>
		{#if status?.state === 'passkey'}
			<Notice tone="warning" title="Finish adding your passkey">
				You signed in with a recovery code. Add a passkey to sync: until then everything stays on
				this device.
			</Notice>
			<Button variant="secondary" icon="passkey" href={resolve('/recover/passkey')}>
				Add a passkey
			</Button>
		{/if}

		{#if attention.length > 0}
			<section class="group" aria-labelledby="sync-attention">
				<h3 id="sync-attention">Needs attention</h3>
				<ul class="list">
					{#each attention as entry (entry.seq)}
						{@const how = fixes[entry.envelope.type]}
						{@const deleted = entry.parked!.message === SYNC_CODE_LABEL.deleted}
						{@const offer = discardOffer(entries, entry.seq, held)}
						{@const n = offer.kind === 'held' ? 0 : offer.n}
						<li class="item" data-testid="sync-issue">
							<p class="what">{describeMutation(entry.envelope, context)}</p>
							<p class="why">{problemOf(entry)}</p>
							{#if notes[entry.seq]}
								<p class="why" role="alert">Still not valid · {notes[entry.seq]}</p>
							{/if}
							{#if offer.kind === 'held'}
								<p class="why" data-testid="held-end">{offer.words}</p>
							{/if}
							{#if confirming === entry.seq && offer.kind !== 'held'}
								<p class="confirm" role="alert">
									{#if offer.kind === 'abandon'}
										{offer.words}
									{:else}
										{n === 1
											? 'Discard this change?'
											: `Discard ${n} changes? This one, and ${n - 1} made after it that depend on it.`}
										{how?.discard ?? ''}
									{/if}
									There's no undo.
								</p>
								<div class="actions">
									<Button
										variant="secondary"
										size="sm"
										onclick={() => (confirming = null)}
										data-testid="keep-change">Keep it</Button
									>
									<Button
										variant="danger"
										size="sm"
										icon="trash"
										onclick={() => act(() => store.discard(entry.seq))}
										data-testid="confirm-discard"
									>
										{n <= 1 ? 'Discard' : `Discard ${n}`}
									</Button>
								</div>
							{:else}
								<div class="actions">
									{#if how && how.kind !== 'discard-only' && !deleted && entry.parked!.reason === 'refused'}
										<Button
											size="sm"
											icon="pencil"
											onclick={() => fix(entry, how)}
											data-testid="fix-change"
										>
											{how.kind === 'rewrite' ? how.label : 'Fix'}
										</Button>
									{/if}
									{#if entry.parked!.reason === 'stuck'}
										<Button
											size="sm"
											icon="refresh"
											onclick={() => act(() => store.tryAgain(entry.seq))}
											data-testid="try-again">Try again</Button
										>
									{:else if offer.kind === 'held' && offer.resend}
										<Button
											size="sm"
											icon="refresh"
											onclick={() =>
												requeue(
													entry.seq,
													sentAgain(entry.envelope, entry.parked!.errors, new Date())
												)}
											data-testid="try-again">Try again</Button
										>
									{/if}
									{#if offer.kind !== 'held'}
										<Button
											variant="ghost"
											size="sm"
											icon="trash"
											onclick={() => confirmDiscard(entry.seq)}
											data-testid="discard-change">Discard</Button
										>
									{/if}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if waiting.length > 0}
			<section class="group" aria-labelledby="sync-waiting">
				<h3 id="sync-waiting">Waiting to sync</h3>
				<ul class="list">
					{#each waiting as entry (entry.seq)}
						<li class="item" data-testid="sync-pending">
							<p class="what">{describeMutation(entry.envelope, context)}</p>
						</li>
					{/each}
				</ul>
			</section>
		{:else if attention.length === 0}
			<p class="calm" data-testid="sync-empty">Everything on this device is saved.</p>
		{/if}
	</div>
</BottomSheet>

{#if custom}
	{@const { Editor, seq, m, problem, errors } = custom}
	{#key seq}
		<Editor
			bind:open={editorOpen}
			{m}
			{problem}
			{errors}
			{view}
			onsave={(next, then) => requeue(seq, next, then)}
		/>
	{/key}
{/if}

{#if editing}
	{@const exercise = exerciseOf(editing.exerciseId)}
	{@const slot = view?.slots.find((s) => s.position === editing!.position)}
	<SetEditSheet
		bind:open={editorOpen}
		editKey={String(editing.seq)}
		setIndex={editing.setIndex}
		exercise={{
			name: exercise?.name ?? 'Exercise',
			measure: exercise?.measure ?? 'reps',
			loadType: exercise?.loadType ?? 'external'
		}}
		values={editing.values}
		skipped={editing.m.type === 'set.skip'}
		increment={slot?.kit?.exercise.increment ?? DEFAULT_LOAD_INCREMENT[editing.values.unit]}
		fix={editing.problem}
		onsave={save}
		ondelete={() => act(() => store.discard(editing!.seq))}
	/>
{/if}

<style>
	.sheet {
		display: grid;
		gap: var(--space-5);
	}

	.group {
		display: grid;
		gap: var(--space-2);
	}

	h3 {
		color: var(--color-text-secondary);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
	}

	.list {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.item {
		display: grid;
		gap: var(--space-1);
		padding: var(--space-3);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
	}

	.what {
		font-weight: var(--weight-medium);
		overflow-wrap: anywhere;
	}

	.why,
	.calm {
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
	}

	.confirm {
		margin-top: var(--space-1);
		color: var(--color-danger);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: var(--space-2);
	}
</style>
