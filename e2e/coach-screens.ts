/**
 * The coach's screenshot set for the owner's review before launch (M5 plan, coach-journeys): every
 * designed state of the coach (PRD §16) and every step of the M5 journeys, each at 393 × 659 (an
 * iPhone) and at 1440 × 900 (a desktop window). Data only:
 * - scripts/coach-screens-index.ts builds the contact sheet from it and from the PNGs CI uploads
 *   (test-results/screens/<project>/<name>.png); a state with no capture shows as missing there
 * - scripts/coach-screens-index.test.ts checks that every state names both viewports and that the
 *   spec each names really takes that capture
 *
 * Each viewport names its capture and the spec that takes it. The spec that owns a surface takes
 * its own; e2e/coach-journey.serial.e2e.ts takes the journeys' captures and the viewport an owning
 * spec leaves out, by id. The journeys also capture the light theme, as `<name>-light`; the other
 * captures are the dark theme (axe checks both themes in the owning specs).
 *
 * Left out, each captured at one viewport by its owning spec (the sheet shows it under 'Other coach
 * captures'): the inbox's failed load (coach-inbox-failed-desktop, desktop only), and three that
 * need a spec's own set-up and repeat a notice listed here at both viewports: the inbox detail's
 * and the reject sheet's chunk failures (the stream client's failed load), and the offline state
 * from a workout (Chromium-only offline emulation; the conversation's offline state).
 */

/** A capture: its file name under test-results/screens/<project>/ (no .png) and who takes it. */
export interface CoachCapture {
	name: string;
	/** The spec that takes it, relative to e2e/. */
	by: string;
}

export interface CoachScreen {
	id: string;
	group: string;
	label: string;
	phone: CoachCapture;
	desktop: CoachCapture;
}

/** The suffix of a light-theme capture. */
export const LIGHT = '-light';

export const JOURNEY_SPEC = 'coach-journey.serial.e2e.ts';

/** A state the journey spec captures at both viewports: `<name>` and `<name>-desktop`. */
const journey = <I extends string>(id: I, group: string, label: string, name = `coach-${id}`) => ({
	id,
	group,
	label,
	phone: { name, by: JOURNEY_SPEC },
	desktop: { name: `${name}-desktop`, by: JOURNEY_SPEC }
});

/** A state the owning spec captures at both viewports. */
const owned = <I extends string>(
	id: I,
	group: string,
	label: string,
	by: string,
	phone: string,
	desktop: string
) => ({
	id,
	group,
	label,
	phone: { name: phone, by },
	desktop: { name: desktop, by }
});

/** A state the owning spec captures on an iPhone; the journey spec adds the desktop window. */
const phoneOwned = <I extends string>(
	id: I,
	group: string,
	label: string,
	by: string,
	phone: string
) => ({
	id,
	group,
	label,
	phone: { name: phone, by },
	desktop: { name: `${phone}-desktop`, by: JOURNEY_SPEC }
});

const J = 'The M5 journeys';
const OUT = 'Outages';
const LOAD = 'Loading';
const FAIL = 'Failures';
const EMPTY = 'Empty';
const ANSWERS = 'Answers';

export const COACH_SCREENS = [
	journey('journey-bench', J, '1. Bench progress, every source the set Postgres holds'),
	journey('journey-change-proposed', J, '2. Change today’s workout: the proposal'),
	journey('journey-change-applied', J, '2. Accepted: applied as version 2'),
	journey('journey-train-version', J, '2. Train’s new version, with the coach’s why'),
	journey('journey-rejected', J, '3. Rejected, with a reason'),
	journey('journey-after-rejection', J, '3. The next turn reads the reason'),
	journey('journey-knows-rejected', J, '3. What the coach knows: the rejection'),
	journey('journey-dislike-profile', J, '4. The dislike in Profile → Exercises'),
	journey('journey-dislike-applied', J, '4. The replacement accepted: out of next week'),
	journey('journey-taken-proposed', J, '5. The leg press is taken: a swap for this session'),
	journey('journey-taken-applied', J, '5. The swap applied, the version unchanged'),
	journey('journey-taken-workout', J, '5. The workout with the swap'),
	journey('journey-knows-pain', J, '6. What the coach knows: the knee pain report'),
	journey('journey-pain-safety', J, '6. My knee hurts: the safety block, no banned phrase'),
	journey('journey-unavailable', J, '7. The coach unavailable'),
	journey('journey-unavailable-logged', J, '7. A set logged while the coach is unavailable'),
	journey('journey-reloaded-thread', J, '8. Reloaded: the conversation and its proposal'),
	journey('journey-reloaded-inbox', J, '8. Reloaded: the proposal in the inbox'),

	owned(
		'not-launched',
		OUT,
		'Not launched: your coach is getting ready',
		'coach-screen.serial.e2e.ts',
		'coach-not-launched',
		'coach-not-launched-desktop'
	),
	journey('disabled', OUT, 'Switched off'),
	owned(
		'unavailable',
		OUT,
		'Unavailable, in a conversation',
		'coach-states.serial.e2e.ts',
		'coach-state-unavailable',
		'coach-state-unavailable-desktop'
	),
	owned(
		'provider-error',
		OUT,
		'The coach service had a problem',
		'coach-states.serial.e2e.ts',
		'coach-state-provider-error',
		'coach-state-error-desktop'
	),
	owned(
		'overloaded',
		OUT,
		'The coach service is overloaded',
		'coach-states.serial.e2e.ts',
		'coach-state-provider-overloaded',
		'coach-state-overloaded-desktop'
	),
	owned(
		'rate-limited',
		OUT,
		'Rate-limited, counting down',
		'coach-states.serial.e2e.ts',
		'coach-state-rate-limited',
		'coach-state-rate_limited-desktop'
	),
	owned(
		'budget',
		OUT,
		'Today’s budget is used up',
		'coach-states.serial.e2e.ts',
		'coach-state-budget',
		'coach-state-budget-desktop'
	),
	owned(
		'refused',
		OUT,
		'Refused',
		'coach-states.serial.e2e.ts',
		'coach-state-refused',
		'coach-state-refusal-desktop'
	),
	owned(
		'busy',
		OUT,
		'Another answer is still running',
		'coach-states.serial.e2e.ts',
		'coach-state-busy',
		'coach-state-busy-desktop'
	),
	owned(
		'timeout',
		OUT,
		'The answer took too long',
		'coach-states.serial.e2e.ts',
		'coach-state-timeout',
		'coach-state-timeout-desktop'
	),
	owned(
		'offline',
		OUT,
		'Offline',
		'coach-states.serial.e2e.ts',
		'coach-state-offline',
		'coach-state-offline-desktop'
	),
	phoneOwned(
		'proposal-offline',
		OUT,
		'Offline: a proposal’s Accept and Reject wait for a connection',
		'coach-proposal-decisions.serial.e2e.ts',
		'coach-proposal-offline'
	),

	phoneOwned(
		'long-answer',
		ANSWERS,
		'A long answer, behind Show all',
		'coach-stream.serial.e2e.ts',
		'coach-long-answer'
	),
	phoneOwned('stopped', ANSWERS, 'Stopped', 'coach-stream.serial.e2e.ts', 'coach-stopped'),
	phoneOwned(
		'interrupted',
		ANSWERS,
		'Interrupted, with Retry',
		'coach-stream.serial.e2e.ts',
		'coach-interrupted'
	),

	phoneOwned('thinking', LOAD, 'Thinking…', 'coach-stream.serial.e2e.ts', 'coach-thinking'),
	journey('thread-loading', LOAD, 'Opening a conversation: busy'),
	phoneOwned(
		'memory-loading',
		LOAD,
		'What the coach knows: loading',
		'coach-memory-panel.serial.e2e.ts',
		'coach-memory-panel-loading'
	),
	phoneOwned(
		'usage-loading',
		LOAD,
		'Usage: loading',
		'coach-usage.serial.e2e.ts',
		'coach-usage-loading'
	),
	phoneOwned(
		'archived-loading',
		LOAD,
		'Archived conversations: loading',
		'coach-threads.serial.e2e.ts',
		'coach-archived-loading'
	),
	phoneOwned(
		'rename-pending',
		LOAD,
		'Rename: saving',
		'coach-threads.serial.e2e.ts',
		'coach-rename-pending'
	),

	owned(
		'stream-failed',
		FAIL,
		'The stream client failed to load, with Retry',
		'coach-states.serial.e2e.ts',
		'coach-state-stream-failed',
		'coach-state-stream-failed-desktop'
	),
	phoneOwned(
		'load-failed',
		FAIL,
		'A conversation’s load failed, with Retry',
		'coach-screen.serial.e2e.ts',
		'coach-load-failed'
	),
	phoneOwned(
		'decision-failed',
		FAIL,
		'An Accept that failed: Couldn’t save, with Retry',
		'coach-proposal-decisions.serial.e2e.ts',
		'coach-proposal-save-failed'
	),
	phoneOwned(
		'rename-failed',
		FAIL,
		'A rename that failed, with Retry',
		'coach-threads.serial.e2e.ts',
		'coach-rename-failed'
	),
	phoneOwned(
		'unarchive-failed',
		FAIL,
		'An unarchive that failed, with Retry',
		'coach-threads.serial.e2e.ts',
		'coach-unarchive-failed'
	),
	phoneOwned(
		'memory-failed',
		FAIL,
		'What the coach knows: failed, with Retry',
		'coach-memory-panel.serial.e2e.ts',
		'coach-memory-panel-failed'
	),
	phoneOwned(
		'usage-failed',
		FAIL,
		'Usage: failed, with Retry',
		'coach-usage.serial.e2e.ts',
		'coach-usage-failed'
	),
	phoneOwned(
		'archived-failed',
		FAIL,
		'Archived conversations: failed, with Retry',
		'coach-threads.serial.e2e.ts',
		'coach-archived-failed'
	),
	phoneOwned(
		'exercise-sheet-error',
		FAIL,
		'Exercise history: failed, with Retry',
		'coach-exercise-sheet.serial.e2e.ts',
		'coach-exercise-sheet-error'
	),
	phoneOwned(
		'exercise-sheet-offline',
		FAIL,
		'Exercise history needs a connection',
		'coach-exercise-sheet.serial.e2e.ts',
		'coach-exercise-sheet-offline'
	),

	phoneOwned(
		'coach-empty',
		EMPTY,
		'No conversations yet',
		'coach-screen.serial.e2e.ts',
		'coach-empty'
	),
	phoneOwned(
		'memory-empty',
		EMPTY,
		'The coach doesn’t know much yet',
		'coach-memory-panel.serial.e2e.ts',
		'coach-memory-panel-empty'
	),
	phoneOwned(
		'usage-empty',
		EMPTY,
		'No coach runs yet',
		'coach-usage.serial.e2e.ts',
		'coach-usage-empty'
	),
	phoneOwned(
		'archived-empty',
		EMPTY,
		'No archived conversations',
		'coach-threads.serial.e2e.ts',
		'coach-archived-empty'
	),
	phoneOwned(
		'inbox-empty',
		EMPTY,
		'No proposals yet',
		'coach-inbox.serial.e2e.ts',
		'coach-inbox-empty'
	),
	phoneOwned(
		'inbox-filter-empty',
		EMPTY,
		'Proposals: nothing decided yet',
		'coach-inbox.serial.e2e.ts',
		'coach-inbox-filter-empty'
	)
] as const satisfies readonly CoachScreen[];

export type CoachScreenId = (typeof COACH_SCREENS)[number]['id'];

/** A screen by id. */
export function coachScreen(id: CoachScreenId): CoachScreen {
	return COACH_SCREENS.find((screen) => screen.id === id)!;
}
