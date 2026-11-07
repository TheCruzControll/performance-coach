<!--
  @component
  Skip a planned session, inside EditSheetHost, which loads it when the sheet opens. It says what
  skipping does before anything is saved (the session stays in the plan, marked Skipped, and the
  rest of the week is unchanged) and takes an optional reason, which its decision keeps. Once
  skipped it stays skipped: there is no undo in M3. Validation (zod) loads with the sheet.
-->
<script lang="ts">
	import { applyAction, type ActionResult } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { focusFirstError, post } from '#lib/client/profile-form.ts';
	import type { FieldErrors } from '#lib/domain/validation.ts';
	import Button from '../components/Button.svelte';
	import Notice from '../components/Notice.svelte';
	import TextArea from '../components/TextArea.svelte';

	interface Props {
		/** The session, by lineage, on the version the screen shows. */
		lineage: string;
		title: string;
		version: number;
	}

	let { lineage, title, version }: Props = $props();

	const UNREACHABLE = 'Can’t reach the server. Check your connection, then try again.';
	const NOT_SAVED = 'That didn’t save. Try again.';

	// The services' own schema, loaded with the sheet; without it the server checks alone.
	const checker = Promise.all([
		import('#lib/domain/training/edits.ts'),
		import('#lib/domain/validation.ts')
	]).then(
		([{ skipSessionSchema }, { validate }]) =>
			(value: unknown) =>
				validate(skipSessionSchema, value)
	);
	checker.catch(() => {});

	let reason = $state<string | null>('');
	let errors = $state<FieldErrors>({});
	let failure = $state<string | null>(null);
	/** The page's version is no longer the current one: nothing can be saved from it. */
	let conflict = $state(false);
	let reloading = $state(false);
	let fields = $state<HTMLElement>();

	/** EditSheetHost's Save: validate, then post the skip with the version shown. */
	export async function submit(): Promise<string | null> {
		failure = null;
		const skip = { sessionLineage: lineage, reason: reason?.trim() || undefined };
		const checked = (await checker.catch(() => null))?.(skip);
		if (checked && !checked.ok) {
			errors = checked.errors;
			focusFirstError(fields);
			return null;
		}
		errors = {};
		let result: ActionResult;
		try {
			result = await post('?/skip', { ...skip, version });
		} catch {
			failure = UNREACHABLE;
			return null;
		}
		if (result.type === 'success') {
			const skipped = result.data as { version: number };
			return `Skipped ${title} · version ${skipped.version}`;
		}
		if (result.type === 'failure') {
			const data = result.data;
			const found = (data?.errors ?? {}) as FieldErrors;
			if (data?.reason === 'version') conflict = true;
			else if (Object.keys(found).length) {
				errors = found;
				failure = found.sessionLineage ?? found[''] ?? null;
				focusFirstError(fields);
			} else failure = typeof data?.message === 'string' ? data.message : NOT_SAVED;
		} else await applyAction(result);
		return null;
	}

	async function reload() {
		reloading = true;
		await invalidateAll();
		reloading = false;
		conflict = false;
	}
</script>

<div class="skip" bind:this={fields} data-testid="skip-form">
	<p class="lead">
		It stays in your plan, marked Skipped, and the rest of your week stays as it is. A skipped
		session can’t be moved or changed afterwards.
	</p>

	<TextArea
		label="Reason"
		optional
		bind:value={reason}
		error={errors.reason}
		hint="Kept with the change, so you can see later why you skipped it."
		placeholder="Sick, travelling, too sore…"
		maxlength={200}
		rows={2}
		data-testid="skip-reason"
	/>

	{#if conflict}
		<Notice tone="warning" title="Your plan changed" data-testid="skip-conflict">
			It changed after you opened this session, so nothing was skipped. Reload to see the latest,
			then skip it again.
			<div class="reload">
				<Button variant="secondary" size="sm" loading={reloading} onclick={reload}>Reload</Button>
			</div>
		</Notice>
	{/if}
	{#if failure}<Notice tone="danger" data-testid="skip-failure">{failure}</Notice>{/if}
</div>

<style>
	.skip {
		display: grid;
		gap: var(--space-5);
		padding-bottom: var(--space-2);
	}

	.lead {
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
		color: var(--color-text-secondary);
	}

	.reload {
		margin-top: var(--space-3);
	}
</style>
