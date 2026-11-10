/**
 * The coaching memory (PRD §4): one snapshot built from structured records, never from replayed
 * chat. It opens every conversation segment as data and fills 'What the coach knows'.
 *
 * Profile sections are what the owner set up and trained (coach-memory-profile builds them);
 * record sections are what happened since (coach-memory-records). Every item carries the
 * SourceRef it came from, so the coach can cite it and the screen can open it. Strings here are
 * plain; the server wraps every stored string as untrusted text when it serialises the snapshot
 * for the model (domain/coach/memory-format.ts).
 */
import type { BaselineKind, Severity } from '../profile/catalog.ts';
import type { Decider, PreferenceSource, ProposalStatus } from '../training/vocabulary.ts';
import type { SourceRef } from './sources.ts';

/**
 * Free text someone stored (a note, a reason, a title), as the model receives it: a labelled
 * value, never an instruction. The system prompt says so, and nothing else reaches the model
 * outside this wrapper.
 */
export interface UntrustedText {
	readonly untrusted_text: string;
	readonly truncated?: true;
}

// Control characters other than tab and newline, and the bidirectional overrides that can make
// text read differently from what it says. Matching control characters is the point here.
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/** `text` as untrusted data: newlines normalised, hidden controls removed, at most `max` characters. */
export function untrusted(text: string, max: number): UntrustedText {
	const clean = text.replace(/\r\n?/g, '\n').replace(HIDDEN, '').trim();
	const chars = Array.from(clean);
	if (chars.length <= max) return { untrusted_text: clean };
	return { untrusted_text: chars.slice(0, Math.max(0, max)).join(''), truncated: true };
}

/** Every item says which record it came from. */
type Sourced<T> = T & { source: SourceRef };

// ---- Profile sections -----------------------------------------------------------------------

export type MemoryGoal = Sourced<{ rank: number; title: string; targetDate: string | null }>;
export type MemoryProgram = Sourced<{
	name: string;
	versionNumber: number;
	week: number | null;
	weeks: number | null;
	phase: string | null;
}>;
export type MemoryPlanned = Sourced<{ title: string }>;
/** One of the last 14 days, planned against done. */
export type MemoryDay = Sourced<{ date: string; planned: MemoryPlanned[]; done: MemoryPlanned[] }>;
export type MemoryBaseline = Sourced<{
	exercise: string;
	value: number;
	unit: string;
	kind: BaselineKind;
	date: string | null;
}>;
export type MemoryTrend = Sourced<{
	subject: string;
	direction: 'up' | 'down' | 'flat';
	summary: string;
}>;
export type MemoryPreference = Sourced<{
	exercise: string;
	stance: 'like' | 'dislike';
	origin: PreferenceSource;
	reason: string | null;
}>;
export type MemoryEquipment = Sourced<{ name: string }>;
/** `area` is M2's body-area key, open like M2's injuries. */
export type MemoryInjury = Sourced<{
	area: string;
	severity: Severity | null;
	note: string | null;
}>;
export type MemoryAvoid = Sourced<{ movement: string; reason: string | null }>;

// ---- Record sections ------------------------------------------------------------------------

export type MemoryPainReport = Sourced<{
	date: string;
	exercise: string | null;
	area: string | null;
	severity: Severity | null;
	action: string;
	note: string | null;
}>;
export type MemoryNote = Sourced<{ date: string; text: string }>;
/** What was decided, in a few words, and why. */
export type MemoryDecision = Sourced<{
	date: string;
	kind: string;
	decider: Decider;
	what: string;
	why: string;
}>;
/** Who proposed a change: the coach, or the rules of one of the owner's reviews. */
export const PROPOSAL_ORIGINS = ['coach', 'weekly_review', 'cycle_review'] as const;
export type ProposalOriginKind = (typeof PROPOSAL_ORIGINS)[number];

export type MemoryProposal = Sourced<{
	kind: string;
	title: string;
	status: ProposalStatus | 'superseded';
	decidedOn: string | null;
	decisionNote: string | null;
	/** A review's rules made it, not the coach: the coach never presents it as its own. */
	origin: ProposalOriginKind;
	/** The review that made it, whose source opens it; null for the coach's own. */
	review: SourceRef | null;
}>;

/** What the owner decided on a review's proposal, read from its revision chain's head. */
export const REVIEW_DECISION_STATES = [
	'none',
	'undecided',
	'accepted_waiting',
	'applied',
	'rejected',
	'partly_past',
	'superseded'
] as const;
export type ReviewDecisionState = (typeof REVIEW_DECISION_STATES)[number];

export type MemoryReview = Sourced<{
	scope: 'week' | 'cycle';
	date: string;
	summary: string;
	/** Each verdict finding as 'label: verdict'; none for a review written before M6. */
	verdicts: string[];
	decisionState: ReviewDecisionState;
}>;

export interface MemorySnapshot {
	/** The owner's local day the snapshot was built on. */
	asOf: string;
	profile: {
		goals: MemoryGoal[];
		program: MemoryProgram | null;
		recentDays: MemoryDay[];
		baselines: MemoryBaseline[];
		trends: MemoryTrend[];
		preferences: MemoryPreference[];
		equipment: MemoryEquipment[];
		injuries: MemoryInjury[];
		avoid: MemoryAvoid[];
	};
	records: {
		painReports: MemoryPainReport[];
		recoveryNotes: MemoryNote[];
		decisions: MemoryDecision[];
		proposals: MemoryProposal[];
		reviews: MemoryReview[];
		threadSummaries: MemoryNote[];
		analyses: MemoryNote[];
	};
}
