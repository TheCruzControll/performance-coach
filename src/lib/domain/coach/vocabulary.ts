/**
 * The coach's closed vocabularies (PRD §4, §12, §14): the keys M5 stores, streams and shows.
 *
 * Closed lists marked "stored" are CHECKed by Postgres (coach-conversations-db and
 * coach-proposals-db): never rename or remove a key; a new key is a migration. "Wire" lists travel
 * only in stream events and pages, and grow with the client that renders them.
 *
 * Each list is the keys of its label table, so no key lacks a label, as in domain/training.
 */
type Labels = Readonly<Record<string, string>>;

/** The keys of a label table, in their written order. */
const keysOf = <L extends Labels>(labels: L) =>
	Object.keys(labels) as readonly (keyof L & string)[];

// ---- Answers --------------------------------------------------------------------------------

/**
 * Wire. The labelled blocks an answer is made of (PRD §12). The words are what the screen shows
 * beside each block, so a label never relies on colour alone. The tagged grammar that produces
 * them is server-only (domain/coach/answer.ts).
 */
export const ANSWER_BLOCK_KIND_LABEL = {
	fact: 'Fact',
	metric: 'Calculated',
	recommendation: 'Recommendation',
	safety: 'Safety',
	note: 'Note'
};
export type AnswerBlockKind = keyof typeof ANSWER_BLOCK_KIND_LABEL;
export const ANSWER_BLOCK_KINDS = keysOf(ANSWER_BLOCK_KIND_LABEL);

// ---- Transcript -----------------------------------------------------------------------------

/**
 * Stored. Where a conversation's title came from: its first message, until the owner renames it.
 * Owner decision (M5 plan, 'Thread titles'): the model writes no titles; a 'model' key would be
 * one entry here and a migration of coach_threads_title_source_ck.
 */
export const THREAD_TITLE_SOURCE_LABEL = {
	first_message: 'From your first message',
	owner: 'Named by you'
};
export type ThreadTitleSource = keyof typeof THREAD_TITLE_SOURCE_LABEL;
export const THREAD_TITLE_SOURCES = keysOf(THREAD_TITLE_SOURCE_LABEL);

/** Stored. The Messages API role a stored message is replayed with. */
export const MESSAGE_ROLE_LABEL = { user: 'You', assistant: 'Coach', system: 'Context' };
export type MessageRole = keyof typeof MESSAGE_ROLE_LABEL;
export const MESSAGE_ROLES = keysOf(MESSAGE_ROLE_LABEL);

/**
 * Stored. What a transcript row is. A display_only row (a partial answer) is shown but never
 * replayed to the model, so every replayed segment stays a valid request.
 */
export const MESSAGE_KIND_LABEL = {
	owner_message: 'Your message',
	segment_preamble: 'What the coach knows',
	context: 'Turn context',
	assistant: 'Coach answer',
	tool_results: 'Tool results',
	display_only: 'Partial answer'
};
export type MessageKind = keyof typeof MESSAGE_KIND_LABEL;
export const MESSAGE_KINDS = keysOf(MESSAGE_KIND_LABEL);

/** Stored. How a message ended; rows are insert-only, so this is set once. */
export const MESSAGE_STATUS_LABEL = {
	complete: 'Complete',
	stopped: 'Stopped',
	interrupted: 'Interrupted',
	failed: 'Failed'
};
export type MessageStatus = keyof typeof MESSAGE_STATUS_LABEL;
export const MESSAGE_STATUSES = keysOf(MESSAGE_STATUS_LABEL);

// ---- Runs -----------------------------------------------------------------------------------

/** Stored. An agent run's lifecycle: running until it finishes once, in one of the others. */
export const RUN_STATUS_LABEL = {
	running: 'Running',
	completed: 'Completed',
	refused: 'Declined',
	budget_exhausted: 'Stopped at the turn budget',
	cancelled: 'Stopped',
	interrupted: 'Interrupted',
	timed_out: 'Timed out',
	failed: 'Failed',
	expired: 'Abandoned'
};
export type RunStatus = keyof typeof RUN_STATUS_LABEL;
export const RUN_STATUSES = keysOf(RUN_STATUS_LABEL);

/** Stored. How one tool call ended; 'intervened' marks the output policy's `_policy` rows. */
export const TOOL_CALL_STATUS_LABEL = {
	succeeded: 'Done',
	failed: 'Failed',
	invalid_input: 'Invalid input',
	timed_out: 'Timed out',
	cancelled: 'Cancelled',
	intervened: 'Changed by the safety check'
};
export type ToolCallStatus = keyof typeof TOOL_CALL_STATUS_LABEL;
export const TOOL_CALL_STATUSES = keysOf(TOOL_CALL_STATUS_LABEL);

// ---- Proposals ------------------------------------------------------------------------------

/** Stored. Why a proposal was superseded (the status coach-proposals-db adds to M3's list). */
export const SUPERSEDED_REASON_LABEL = {
	program_changed: 'The program changed since it was proposed',
	revised: 'Replaced by a revised proposal'
};
export type SupersededReason = keyof typeof SUPERSEDED_REASON_LABEL;
export const SUPERSEDED_REASONS = keysOf(SUPERSEDED_REASON_LABEL);

// ---- Availability and errors ----------------------------------------------------------------

/**
 * Wire. Why the coach cannot run a turn. not_launched and disabled refuse every turn; no_key and
 * mock_in_production are misconfigurations that still serve direct answers (PRD §15).
 */
export const COACH_UNAVAILABLE_REASON_LABEL = {
	no_key: 'The coach has no API key',
	mock_in_production: 'The practice coach cannot run in production',
	not_launched: 'Your coach is getting ready',
	disabled: 'The coach is switched off'
};
export type CoachUnavailableReason = keyof typeof COACH_UNAVAILABLE_REASON_LABEL;
export const COACH_UNAVAILABLE_REASONS = keysOf(COACH_UNAVAILABLE_REASON_LABEL);

/** Wire. The error a turn's stream ends with; offline is the browser's own. */
export const COACH_ERROR_KIND_LABEL = {
	unavailable: 'The coach is unavailable',
	rate_limited: 'Too many questions in a short time',
	budget: 'Today’s coach budget is used up',
	refused: 'The coach can’t help with that',
	busy: 'Another answer is still running',
	timeout: 'The answer took too long',
	provider: 'The coach service had a problem',
	cancelled: 'Stopped',
	interrupted: 'The answer was interrupted',
	invalid_request: 'That message couldn’t be sent',
	not_found: 'Conversation not found',
	offline: 'You’re offline'
};
export type CoachErrorKind = keyof typeof COACH_ERROR_KIND_LABEL;
export const COACH_ERROR_KINDS = keysOf(COACH_ERROR_KIND_LABEL);
