/**
 * What the coach's notices say (PRD §12, §15, §16): one entry for every reason the coach cannot
 * run (COACH_UNAVAILABLE_REASONS), every error a turn can end with (COACH_ERROR_KINDS), and the
 * screen's own failures and empty state. A title is the vocabulary's label, so the stream, the
 * pages and the notice never word a state twice; the body says what to do next, and `retry`
 * marks the states a Retry can fix. CoachNotice.svelte renders them.
 */
import {
	COACH_ERROR_KIND_LABEL,
	COACH_UNAVAILABLE_REASON_LABEL,
	type CoachErrorKind,
	type CoachUnavailableReason
} from '#lib/domain/coach/index.ts';
import type { IconName } from '../icons/icons';

/** Failures of the screen itself, rather than of a turn. */
export const SCREEN_FAILURE_LABEL = {
	/** A lazily loaded piece of the coach (the stream client, a card, a sheet) failed to load. */
	chunk_failed: 'Couldn’t load this part of the coach',
	/** A server load (the conversations, a conversation, a proposal) failed. */
	load_failed: 'Couldn’t load your conversations',
	/** A write (accept, reject, rename, archive) failed. */
	action_failed: 'That didn’t go through'
};
export type ScreenFailure = keyof typeof SCREEN_FAILURE_LABEL;

export type CoachNoticeKind = CoachUnavailableReason | CoachErrorKind | ScreenFailure | 'empty';

export interface NoticeCopy {
	title: string;
	body: string;
	/** danger is announced at once (role="alert"); the rest politely. */
	tone: 'danger' | 'warning' | 'neutral';
	icon: IconName;
	/** A Retry can fix it, so the notice offers one. */
	retry: boolean;
}

/** One notice: its body, tone, icon and whether Retry is offered. */
const notice = (
	body: string,
	tone: NoticeCopy['tone'],
	icon: IconName,
	retry: boolean
): Omit<NoticeCopy, 'title'> => ({ body, tone, icon, retry });

const BODY: Record<CoachNoticeKind, Omit<NoticeCopy, 'title'>> = {
	// Why the coach cannot run. Training, logging and history keep working in every case.
	no_key: notice(
		'Set its key and redeploy. Direct answers about your data still work.',
		'warning',
		'key',
		false
	),
	mock_in_production: notice(
		'Choose the real coach and redeploy. Direct answers about your data still work.',
		'warning',
		'alert',
		false
	),
	not_launched: notice(
		'Answers grounded in your own training data are on their way. Everything else works as usual.',
		'neutral',
		'sparkle',
		false
	),
	disabled: notice(
		'It’s off for now. Your training, logging and history work as usual.',
		'neutral',
		'info',
		false
	),
	// How a turn ended.
	unavailable: notice('Try again in a few minutes.', 'warning', 'alert', true),
	rate_limited: notice('Wait a few minutes, then ask again.', 'warning', 'clock', false),
	budget: notice(
		'The coach can answer again tomorrow. Your training works as usual.',
		'warning',
		'clock',
		false
	),
	refused: notice(
		'Try asking about your own training in a different way.',
		'neutral',
		'info',
		false
	),
	busy: notice('Wait for it to finish, or stop it, then ask again.', 'neutral', 'clock', true),
	timeout: notice('Try again, perhaps with a shorter question.', 'warning', 'clock', true),
	provider: notice(
		'Something went wrong on the coach’s side. Try again in a moment.',
		'danger',
		'alert',
		true
	),
	cancelled: notice('You stopped this answer before it finished.', 'neutral', 'info', true),
	interrupted: notice(
		'The connection dropped before the answer finished.',
		'warning',
		'alert',
		true
	),
	invalid_request: notice('Check the message, then send it again.', 'danger', 'alert', true),
	not_found: notice(
		'It may have been archived. Find it again from Coach.',
		'neutral',
		'info',
		false
	),
	offline: notice(
		'The coach needs a connection. Try again once you’re back online.',
		'warning',
		'wifi-off',
		true
	),
	// The screen’s own failures: Retry loads or sends the same thing again.
	chunk_failed: notice(
		'Check your connection, then try again. Nothing was lost.',
		'danger',
		'alert',
		true
	),
	load_failed: notice(
		'Check your connection, then try again. Nothing was lost.',
		'danger',
		'alert',
		true
	),
	action_failed: notice('Nothing has changed. Try again.', 'danger', 'alert', true),
	empty: notice(
		'Ask about your training below, and your conversations will be kept here.',
		'neutral',
		'coach',
		false
	)
};

const TITLE: Record<CoachNoticeKind, string> = {
	...COACH_UNAVAILABLE_REASON_LABEL,
	...COACH_ERROR_KIND_LABEL,
	...SCREEN_FAILURE_LABEL,
	empty: 'No conversations yet'
};

/** Every notice's words, keyed by its kind. */
export const COACH_NOTICES: Readonly<Record<CoachNoticeKind, NoticeCopy>> = Object.freeze(
	Object.fromEntries(
		(Object.keys(BODY) as CoachNoticeKind[]).map((kind) => [
			kind,
			{ title: TITLE[kind], ...BODY[kind] }
		])
	) as Record<CoachNoticeKind, NoticeCopy>
);

/** The words of the badge on every answer the practice (mock) provider wrote. */
export const MOCK_BADGE = {
	label: 'Practice coach',
	description: 'Scripted answers for testing, not from the real coach'
};
