<!--
  @component
  Swap one planned exercise for an alternative, inside EditSheetHost, which loads it when the
  sheet opens. The alternatives are the ones the session screen streamed (alternativesFor's
  ranking, best first), each with why it keeps the exercise's purpose, as one choice of cards.
  - Without the 'Never prescribe {name} again' switch, the swap is for this session only and
    saves no preference; with it, a dislike is saved (Profile → Exercises) and every session
    from today swaps it too. The switch says so before anything is saved.
  - Nothing fits the owner's equipment and injuries: it says why, links to Profile → Equipment,
    and the host hides Save, so nothing can be posted.
  - While the alternatives stream, a skeleton; if they could not be read, Retry reloads them.
  It gives no medical advice: pain belongs to the workout's own flow (M4, M5), not this sheet.
  Decision (m3 plan open question, 'add my own exercise' here): not in M3. Custom exercises are
  in the schema and services only, and M4's in-workout substitution brings the way to add one.
  Validation (zod) loads with the sheet, never the screen.
-->
<script lang="ts">
	import { applyAction, type ActionResult } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { focusFirstError, post } from '#lib/client/profile-form.ts';
	import type { FieldErrors } from '#lib/domain/validation.ts';
	import Button from '../components/Button.svelte';
	import ChoiceGroup from '../components/ChoiceGroup.svelte';
	import EmptyState from '../components/EmptyState.svelte';
	import ListRow from '../components/ListRow.svelte';
	import Notice from '../components/Notice.svelte';
	import Skeleton from '../components/Skeleton.svelte';
	import TextArea from '../components/TextArea.svelte';
	import Toggle from '../components/Toggle.svelte';
	import type { SwapTarget } from './session-words';

	interface Props {
		/** The session, by lineage, on the version the screen shows. */
		sessionLineage: string;
		version: number;
		/** The planned exercise, with what it can be swapped for once streamed. */
		exercise: SwapTarget;
	}

	let { sessionLineage, version, exercise }: Props = $props();

	const UNREACHABLE = 'Can’t reach the server. Check your connection, then try again.';
	const NOT_SAVED = 'That didn’t save. Try again.';

	// The browser checks with the services' own schema, loaded with the sheet; when it cannot
	// load, the swap is posted anyway and the server checks it.
	const checker = Promise.all([
		import('#lib/domain/training/edits.ts'),
		import('#lib/domain/validation.ts')
	]).then(
		([{ swapSchema }, { validate }]) =>
			(value: unknown) =>
				validate(swapSchema, value)
	);
	checker.catch(() => {});

	const choices = $derived(exercise.choices);
	const options = $derived(
		(choices?.alternatives ?? []).map((a) => ({ value: a.id, label: a.name, hint: a.reason }))
	);

	let toExerciseId = $state<string | null>(null);
	let never = $state(false);
	let reason = $state<string | null>('');
	let errors = $state<FieldErrors>({});
	let failure = $state<string | null>(null);
	/** The page's version is no longer the current one: nothing can be saved from it. */
	let conflict = $state(false);
	let reloading = $state(false);
	let fields = $state<HTMLElement>();

	const chosen = $derived(choices?.alternatives.find((a) => a.id === toExerciseId));

	/** A refused swap: its field errors, a conflict, or a message. */
	function refused(data: Record<string, unknown> | undefined) {
		const found = (data?.errors ?? {}) as FieldErrors;
		if (data?.reason === 'version') conflict = true;
		else if (Object.keys(found).length) {
			errors = found;
			failure = found.sessionLineage ?? found.plannedExerciseLineage ?? found[''] ?? null;
			focusFirstError(fields);
		} else failure = typeof data?.message === 'string' ? data.message : NOT_SAVED;
	}

	/** EditSheetHost's Save: validate, then post the swap with the version shown. */
	export async function submit(): Promise<string | null> {
		failure = null;
		const swap = {
			sessionLineage,
			plannedExerciseLineage: exercise.lineage,
			toExerciseId: toExerciseId ?? '',
			scope: never ? 'never_again' : 'once',
			reason: reason?.trim() || undefined
		};
		const checked = (await checker.catch(() => null))?.(swap);
		if (checked && !checked.ok) {
			errors = checked.errors;
			focusFirstError(fields);
			return null;
		}
		errors = {};
		let result: ActionResult;
		try {
			result = await post('?/swap', { ...swap, version });
		} catch {
			failure = UNREACHABLE;
			return null;
		}
		if (result.type === 'success') {
			const { version: next } = result.data as { version: number };
			const name = chosen?.name ?? 'its alternative';
			const scope = never ? 'from now on' : 'this session only';
			return `Swapped for ${name}, ${scope} · version ${next}`;
		}
		if (result.type === 'failure') refused(result.data);
		// A redirect (the session ended) or the server's own error: SvelteKit's to handle.
		else await applyAction(result);
		return null;
	}

	/** The alternatives again, or the screen's data after a conflict. */
	async function reload() {
		reloading = true;
		await invalidateAll();
		reloading = false;
		conflict = false;
		toExerciseId = null;
	}
</script>

{#if choices === undefined}
	<div class="loading" role="status" aria-busy="true" data-testid="swap-loading">
		<span class="visually-hidden">Finding alternatives…</span>
		<Skeleton height="1rem" width="55%" />
		<Skeleton height="4rem" radius="var(--radius-md)" />
		<Skeleton height="4rem" radius="var(--radius-md)" />
	</div>
{:else if choices === null}
	<EmptyState
		compact
		icon="alert"
		tone="combat"
		title="Couldn’t load the alternatives"
		description="Check your connection, then try again. Nothing has changed."
		data-testid="swap-error"
	>
		{#snippet actions()}
			<Button variant="secondary" icon="refresh" loading={reloading} onclick={reload}
				>Try again</Button
			>
		{/snippet}
	</EmptyState>
{:else if !choices.alternatives.length}
	<div class="empty" data-testid="swap-empty">
		<EmptyState
			compact
			icon="refresh"
			tone="neutral"
			title="Nothing fits your equipment and injuries"
			description={`No other exercise does the job of ${exercise.name.toLowerCase()} with what you have.`}
		/>
		{#if choices.blocked}
			<Notice title="Why" data-testid="swap-blocked">{choices.blocked}.</Notice>
		{/if}
		<ListRow
			icon="profile"
			title="Update your equipment"
			subtitle="Profile → Equipment: what you add opens up alternatives"
			href={resolve('/(app)/profile/[section]', { section: 'equipment' })}
			data-testid="swap-equipment"
		/>
	</div>
{:else}
	<div class="swap" bind:this={fields} data-testid="swap-form">
		<ChoiceGroup
			legend={`Swap ${exercise.name.toLowerCase()} for`}
			hint="Each keeps what it is there for. The best fit is first."
			variant="card"
			{options}
			bind:value={toExerciseId}
			error={errors.toExerciseId}
			data-testid="swap-alternatives"
		/>

		<div class="never">
			<Toggle
				label={`Never prescribe ${exercise.name.toLowerCase()} again`}
				description={never
					? 'Saved as a dislike in Profile → Exercises, and swapped in every session from today.'
					: 'Off: this session only. Nothing else changes, and no preference is saved.'}
				bind:checked={never}
				data-testid="swap-never"
			/>
		</div>

		<TextArea
			label="Reason"
			optional
			bind:value={reason}
			error={errors.reason}
			hint="Kept with the change, so you can see later why it was swapped."
			placeholder="The rack was taken, it never feels right…"
			maxlength={200}
			rows={2}
			data-testid="swap-reason"
		/>

		{#if conflict}
			<Notice tone="warning" title="Your plan changed" data-testid="swap-conflict">
				It changed after you opened this session, so nothing was swapped. Reload to see the latest,
				then swap it again.
				<div class="reload">
					<Button variant="secondary" size="sm" loading={reloading} onclick={reload}>Reload</Button>
				</div>
			</Notice>
		{/if}
		{#if failure}<Notice tone="danger" data-testid="swap-failure">{failure}</Notice>{/if}
	</div>
{/if}

<style>
	.swap,
	.empty,
	.loading {
		display: grid;
		gap: var(--space-5);
		padding-bottom: var(--space-2);
	}

	.empty,
	.loading {
		gap: var(--space-3);
	}

	/* The switch on a quiet panel of its own, so its explanation reads with it. */
	.never {
		padding: var(--space-3) var(--space-4);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-surface-2);
	}

	.reload {
		margin-top: var(--space-3);
	}
</style>
