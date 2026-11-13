<!--
  @component
  Move a planned session to another day of its week, inside EditSheetHost, which loads it when
  the sheet opens. The days it can reach are one choice of cards, each with what is already
  planned that day; days that have passed and its own day are left out, because ChoiceGroup has
  no disabled option. The day the scheduler would pick says it clears the week's clash, and each
  day a move would bring a clash to is one calm line under the days, its reason in a native
  <details> (the choice cards are whole hit areas, so nothing inside them can open). Picking a day checks it against the rest of the week (?/checkMove) and
  shows the interference rules it would break before anything is saved: a warning never blocks
  the move, and is recorded in its decision with the owner's optional reason. With no day left,
  it says so and offers Skip instead. Validation (zod) loads with the sheet, never the screen.
-->
<script lang="ts">
	import { applyAction, type ActionResult } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { focusFirstError, post } from '#lib/client/profile-form.ts';
	import type { FieldErrors } from '#lib/domain/validation.ts';
	import Badge from '../components/Badge.svelte';
	import Button from '../components/Button.svelte';
	import ChoiceGroup from '../components/ChoiceGroup.svelte';
	import EmptyState from '../components/EmptyState.svelte';
	import ListRow from '../components/ListRow.svelte';
	import Notice from '../components/Notice.svelte';
	import Spinner from '../components/Spinner.svelte';
	import TextArea from '../components/TextArea.svelte';
	import type { MoveOption } from './session-words';

	interface Props {
		/** The session, by lineage, on the version the screen shows. */
		lineage: string;
		version: number;
		/** The days it can move to, earliest first; none when no day of its week is left. */
		targets: readonly MoveOption[];
		/** Skip it instead, when no day is left; offered as coming soon until Skip exists. */
		onskip?: () => void;
	}

	let { lineage, version, targets, onskip }: Props = $props();

	/** A rule the move would newly break, as ?/checkMove answers it. */
	interface Warning {
		severity: 'avoid' | 'prefer';
		message: string;
	}

	const UNREACHABLE = 'Can’t reach the server. Check your connection, then try again.';
	const NOT_SAVED = 'That didn’t save. Try again.';

	// The browser checks with the services' own schema, loaded with the sheet; when it cannot
	// load, the move is posted anyway and the server checks it.
	const checker = Promise.all([
		import('#lib/domain/training/edits.ts'),
		import('#lib/domain/validation.ts')
	]).then(
		([{ moveSessionSchema }, { validate }]) =>
			(value: unknown) =>
				validate(moveSessionSchema, value)
	);
	checker.catch(() => {});

	const options = $derived(
		targets.map((t) => ({
			value: t.date,
			label: t.label,
			hint: t.clears ? `${t.planned} · ${t.clears}` : t.planned
		}))
	);
	/** The days a move would bring a clash to, each with the rule's reason. */
	const headsUps = $derived(targets.filter((t) => t.warning));

	let toDate = $state<string | null>(null);
	let reason = $state<string | null>('');
	let errors = $state<FieldErrors>({});
	let failure = $state<string | null>(null);
	/** The page's version is no longer the current one: nothing can be saved from it. */
	let conflict = $state(false);
	let reloading = $state(false);
	let fields = $state<HTMLElement>();

	const chosen = $derived(targets.find((t) => t.date === toDate));

	/** What ?/checkMove said about the day picked: null while it answers. */
	let check = $state<{ date: string; warnings: Warning[] | null; failed: boolean } | null>(null);
	let asked = 0;

	async function checkDay() {
		const date = toDate;
		if (!date) return;
		const n = ++asked;
		errors = {};
		check = { date, warnings: null, failed: false };
		let result: ActionResult | null = null;
		try {
			result = await post('?/checkMove', { sessionLineage: lineage, toDate: date, version });
		} catch {
			// Offline: said below, and the move can still be tried.
		}
		if (n !== asked) return; // another day was picked meanwhile
		if (result?.type === 'success') {
			const { warnings } = result.data as { warnings: Warning[] };
			check = { date, warnings: [...warnings].sort(bySeverity), failed: false };
		} else if (result?.type === 'failure' && result.data?.reason === 'version') {
			conflict = true;
			check = null;
		} else check = { date, warnings: null, failed: true };
	}

	const bySeverity = (a: Warning, b: Warning) =>
		a.severity === b.severity ? 0 : a.severity === 'avoid' ? -1 : 1;

	/** A refused move: its field errors, a conflict, or a message. */
	function refused(data: Record<string, unknown> | undefined) {
		const found = (data?.errors ?? {}) as FieldErrors;
		if (data?.reason === 'version') conflict = true;
		else if (Object.keys(found).length) {
			errors = found;
			failure = found.sessionLineage ?? found[''] ?? null;
			focusFirstError(fields);
		} else failure = typeof data?.message === 'string' ? data.message : NOT_SAVED;
	}

	/** EditSheetHost's Save: validate, then post the move with the version shown. */
	export async function submit(): Promise<string | null> {
		failure = null;
		const move = {
			sessionLineage: lineage,
			toDate: toDate ?? '',
			reason: reason?.trim() || undefined
		};
		const checked = (await checker.catch(() => null))?.(move);
		if (checked && !checked.ok) {
			errors = checked.errors;
			focusFirstError(fields);
			return null;
		}
		errors = {};
		let result: ActionResult;
		try {
			result = await post('?/move', { ...move, version });
		} catch {
			failure = UNREACHABLE;
			return null;
		}
		if (result.type === 'success') {
			const moved = result.data as { version: number };
			return `Moved to ${chosen?.day ?? 'a new day'} · version ${moved.version}`;
		}
		if (result.type === 'failure') refused(result.data);
		// A redirect (the session ended) or the server's own error: SvelteKit's to handle.
		else await applyAction(result);
		return null;
	}

	/** What the check found appears below the days: bring it into view, under the thumb. */
	function reveal(node: HTMLElement) {
		const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
		node.scrollIntoView({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
	}

	/** After a conflict: the screen's data again, from which the move can be made anew. */
	async function reload() {
		reloading = true;
		await invalidateAll();
		reloading = false;
		conflict = false;
		toDate = null;
		check = null;
	}
</script>

{#if targets.length}
	<div class="move" bind:this={fields} data-testid="move-form">
		<ChoiceGroup
			legend="Move it to"
			hint="The days left in its week, with what is planned on each."
			variant="card"
			{options}
			bind:value={toDate}
			error={errors.toDate}
			onchange={checkDay}
			data-testid="move-days"
		/>

		{#if headsUps.length}
			<div class="heads-ups" data-testid="move-day-warnings">
				<p class="lead">Heads-up before you pick</p>
				{#each headsUps as t (t.date)}
					<details class="heads-up">
						<summary>{t.day.slice(0, 3)} · {t.warning?.headline}</summary>
						<p>{t.warning?.why}</p>
					</details>
				{/each}
			</div>
		{/if}

		{#if conflict}
			<div use:reveal>
				<Notice tone="warning" title="Your plan changed" data-testid="move-conflict">
					It changed after you opened this session, so nothing was moved. Reload to see the latest,
					then move it again.
					<div class="reload">
						<Button variant="secondary" size="sm" loading={reloading} onclick={reload}>
							Reload
						</Button>
					</div>
				</Notice>
			</div>
		{:else if check && chosen}
			{#if check.warnings === null && !check.failed}
				<p class="checking" role="status" data-testid="move-checking">
					<Spinner size={16} /> Checking {chosen.day} against the rest of your week…
				</p>
			{:else}
				<div use:reveal>
					{#if check.failed}
						<Notice data-testid="move-check">
							Couldn’t check {chosen.day} against the rest of your week. You can still move it.
						</Notice>
					{:else if check.warnings?.length}
						<Notice tone="warning" title="Before you move it" data-testid="move-warnings">
							<ul class="warnings">
								<!-- By place: two warnings can read the same, when sessions share a title. -->
								{#each check.warnings as warning, i (i)}<li>{warning.message}</li>{/each}
							</ul>
							<p>You can still move it: the warning is saved with the change.</p>
						</Notice>
					{:else}
						<Notice tone="positive" data-testid="move-check">
							{chosen.day} fits the rest of your week.
						</Notice>
					{/if}
				</div>
			{/if}
		{/if}

		<TextArea
			label="Reason"
			optional
			bind:value={reason}
			error={errors.reason}
			hint="Kept with the change, so you can see later why it moved."
			placeholder="A work trip, a late shift…"
			maxlength={200}
			rows={2}
			data-testid="move-reason"
		/>

		{#if failure}<Notice tone="danger" data-testid="move-error">{failure}</Notice>{/if}
	</div>
{:else}
	<div class="empty" data-testid="move-empty">
		<EmptyState
			compact
			icon="today"
			tone="neutral"
			title="No other day left this week"
			description="The other days of its week have passed or are full. If you can’t train that day, skip it instead."
		/>
		<ListRow
			icon="close"
			title="Skip this session"
			subtitle={onskip ? 'With a reason, if you like' : 'Arrives with the next update'}
			onclick={onskip}
			disabled={!onskip}
			trailing={onskip ? undefined : soon}
			data-testid="move-skip"
		/>
	</div>
{/if}

{#snippet soon()}<Badge>Soon</Badge>{/snippet}

<style>
	.move,
	.empty {
		display: grid;
		gap: var(--space-5);
		padding-bottom: var(--space-2);
	}

	.empty {
		gap: var(--space-3);
	}

	.checking {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-height: var(--touch-target);
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.warnings {
		display: grid;
		gap: var(--space-1-5);
		margin: 0 0 var(--space-2);
		padding-left: var(--space-5);
	}

	.reload {
		margin-top: var(--space-3);
	}

	.heads-ups {
		display: grid;
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.lead {
		margin: 0 0 var(--space-1);
		font-weight: var(--weight-medium);
	}

	.heads-up summary {
		display: flex;
		align-items: center;
		min-height: var(--touch-target);
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	@media (hover: hover) and (pointer: fine) {
		.heads-up summary:hover {
			color: var(--color-text);
		}
	}

	.heads-up summary:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	.heads-up p {
		margin: 0 0 var(--space-2);
	}
</style>
