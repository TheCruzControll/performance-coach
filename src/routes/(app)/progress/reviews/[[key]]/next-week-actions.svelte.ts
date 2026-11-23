/**
 * What next week's card (NextWeekCard) does with its form once JavaScript runs, fetched on the
 * first tap so the review the page awaits stays small. A cycle review's next-block card
 * (NextCycleCard) posts ?/startCycle through send the same way:
 * - a post goes in place (the form action's JSON answer), aria-busy while it is on its way, and
 *   a second one meanwhile, or one made offline, posts nothing
 * - applied: the toast ('Next week updated · version 4 · …') and Train at next week
 * - kept, too late or changed meanwhile: the review reloads, and the card shows it; a refusal
 *   that says why (a next block's preview gone stale) says so on the reloaded card
 * - a refused post (nothing ticked) says why; a post that failed on its way says the plan has
 *   not changed, and the next tap (Retry) posts the same form again. Keep's say so in its sheet.
 * - Keep opens its sheet (KeepSheet, fetched and mounted here), whose optional reason goes with
 *   ?/keep
 * - Propose again (a stale or late deload) posts ?/proposeAgain (proposeAgain below): a fresh
 *   proposal opens its inbox page (/coach/proposals/<id>), any other answer is its note, and a
 *   failure is Try again
 */
import { mount } from 'svelte';
import { deserialize } from '$app/forms';
import { resolve } from '$app/paths';
import { goto, invalidateAll } from '$app/navigation';
import { proposeAgainRequest } from '#lib/client/coach/proposals.ts';
import { PROPOSE_AGAIN_FAILED, proposeNote } from '#lib/domain/coach/propose-again.ts';
import { toast } from '#lib/ui/toast.svelte.ts';

type Mode = 'decide' | 'keep' | 'startCycle' | 'proposeAgain';

/** The card's state, which these change. */
export interface NextWeekUi {
	pending: Mode | null;
	/** What went wrong; null when nothing did. */
	failure: string | null;
	/** The post `failure` is about, shown on the card (decide) or in Keep's sheet. */
	failed: Mode | null;
	/** Propose again's answer when it made no proposal: the engine's sentence, or the reason. */
	note?: string | null;
}

/** Keep's sheet, once mounted: whether it is open and the reason typed so far. */
export interface KeepSheetProps {
	open: boolean;
	note: string | null;
	ui: NextWeekUi;
	onsubmit: () => void;
}

const FAILED = 'Couldn’t save it. Your plan hasn’t changed. Try again.';

const idle: NextWeekUi = { pending: null, failure: null, failed: null };
const sheet: KeepSheetProps = $state({ open: false, note: null, ui: idle, onsubmit: () => {} });
let keeping: HTMLFormElement | undefined;

/** The card's form was submitted: Keep opens its sheet, Generate posts in place. */
export async function act(
	form: HTMLFormElement,
	ui: NextWeekUi,
	submitter: HTMLElement | null
): Promise<void> {
	if (submitter?.getAttribute('formaction') !== '?/keep') return send(form, ui, 'decide');
	const first = !keeping;
	// Another review's card: its own sheet, with no reason typed yet.
	if (keeping !== form)
		Object.assign(sheet, { note: null, ui, onsubmit: () => send(form, ui, 'keep', sheet) });
	keeping = form;
	sheet.open = true;
	if (!first) return;
	try {
		// The sheet's own chunk (BottomSheet, TextArea and their styles), fetched with the first Keep.
		const { default: KeepSheet } = await import('./KeepSheet.svelte');
		mount(KeepSheet, { target: document.body, props: sheet });
	} catch {
		// As the card does when this module fails to load: Keep posts as it would without JavaScript.
		keeping = undefined;
		form.action = (submitter as HTMLButtonElement).formAction;
		form.submit();
	}
}

/** Post `form` to ?/decide or ?/keep (with the sheet's reason) in place. */
export async function send(
	form: HTMLFormElement,
	ui: NextWeekUi,
	mode: Mode,
	keep?: KeepSheetProps
): Promise<void> {
	if (ui.pending || !navigator.onLine) return;
	ui.pending = mode;
	ui.failure = ui.failed = null;
	const body = new FormData(form);
	if (keep) body.set('note', keep.note ?? '');
	try {
		const response = await fetch(`?/${mode}`, {
			method: 'POST',
			body,
			headers: { accept: 'application/json', 'x-sveltekit-action': 'true' }
		});
		const result = deserialize(await response.text());
		if (result.type === 'success' && result.data?.href) {
			toast.show(String(result.data.words), { tone: 'positive' });
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- Train's path from forms/reviews.ts
			await goto(String(result.data.href));
		} else if (result.type === 'failure' && result.status === 400) {
			[ui.failure, ui.failed] = [String(result.data?.message ?? FAILED), mode];
		} else if (result.type === 'success' || result.type === 'failure') {
			if (keep) keep.open = false;
			await invalidateAll();
			const message = result.type === 'failure' && result.data?.message;
			if (message) [ui.failure, ui.failed] = [String(message), mode];
		} else [ui.failure, ui.failed] = [FAILED, mode];
	} catch {
		[ui.failure, ui.failed] = [FAILED, mode];
	} finally {
		ui.pending = null;
	}
}

/**
 * 'Propose again' on a stale or late deload: the request is proposeAgainRequest (the same one m7/50's
 * proposal card sends). A fresh proposal opens its inbox page (the review still points at the stale
 * one, so it is not reloaded); any other answer is its note on the card; a failure says so with
 * Try again, which sends the same request again. A second tap meanwhile sends nothing.
 */
export async function proposeAgain(ui: NextWeekUi): Promise<void> {
	if (ui.pending || !navigator.onLine) return;
	ui.pending = 'proposeAgain';
	ui.failure = ui.failed = ui.note = null;
	try {
		const outcome = await proposeAgainRequest();
		if (outcome.status === 'failed')
			[ui.failure, ui.failed] = [PROPOSE_AGAIN_FAILED, 'proposeAgain'];
		else if (outcome.status === 'proposed')
			// The fresh proposal's inbox page, as m7/50's Detail opens it. The finally below resets the
			// busy state even when the navigation fails.
			await goto(resolve('/(app)/coach/proposals/[[id]]', { id: outcome.id }));
		else ui.note = proposeNote(outcome);
	} catch {
		[ui.failure, ui.failed] = [PROPOSE_AGAIN_FAILED, 'proposeAgain'];
	} finally {
		ui.pending = null;
	}
}
