/**
 * Coach proposals (M5, PRD §14; the M5 plan's 'Proposals versus committed changes'): the one way
 * the propose tools, the cards, the inbox and get_coach_proposals create, read and decide them.
 *
 * - createProposal parses the proposal, checks it against the owner's data today
 *   (checkProposal, and checkMove's refusals and warnings for each move), and stores it with its
 *   card rows, impact, summary lines, base version, payload version and hash. summary is the
 *   first summary line (≤ 200 characters), and program_id is set whenever base_version_id is.
 *   An identical open proposal on the same base is returned instead of a second row (creates
 *   are serialised per owner, so two at once cannot both store it), and a
 *   revision supersedes the open proposal it revises ('revised'). A review's proposal superseded
 *   as SESSIONS_PASSED may also be revised, and stays as it is.
 * - acceptProposal takes only the id: it locks the row, re-parses the stored payload, supersedes
 *   it if its program has moved on ('program_changed'), checks it again against today and runs
 *   its kind's applier (./apply) in the same transaction. A proposal already decided returns as
 *   stored and nothing is written.
 * - rejectProposal stores the owner's optional reason; rejecting twice changes nothing.
 * - listProposals and getProposalView read one view model, from the stored rows only.
 * Every function is owner-scoped: someone else's proposal is not found, like a missing one.
 */
import type { IsoDate } from '../../../domain/calendar';
import {
	describeImpact,
	describeProposal,
	summaryLines,
	type DiffContext,
	type DiffRow,
	type WeekImpact
} from '../../../domain/coach/diff';
import {
	checkProposal,
	RULE_MESSAGES,
	type ProposalContext
} from '../../../domain/coach/proposal-rules';
import {
	PAYLOAD_VERSION,
	payloadHash,
	proposalSchema,
	type ProgramOp,
	type Proposal,
	type ProposalKind
} from '../../../domain/coach/proposals';
import type { SourceRef } from '../../../domain/coach/sources';
import type { SupersededReason } from '../../../domain/coach/vocabulary';
import { localDay } from '../../../domain/dates';
import { stillAhead } from '../../../domain/programming/review/next-week';
import { isEligible, libraryOf } from '../../../domain/programming/eligibility';
import { toExerciseKey, type ProgrammingInput } from '../../../domain/programming/input';
import { estimateMinutes } from '../../../domain/programming/timefit';
import {
	otherDetailsSchema,
	runSegmentSchema,
	setPrescriptionSchema
} from '../../../domain/training/schemas';
import { PROPOSAL_STATUSES, type ProposalStatus } from '../../../domain/training/vocabulary';
import { validate, type FieldErrors } from '../../../domain/validation';
import {
	createCoachProposalsRepository,
	type ProposalDecision,
	type ProposalViewRow
} from '../../db/repositories/coach-proposals';
import { createProgramsRepository } from '../../db/repositories/programs';
import { DECISION_NOTE_MAX, type AppliedRef } from '../../db/schema/coaching';
import { getExercisesByIds, resolveKeys, type ExerciseDef } from '../exercises/index';
import { isUuid } from '../ids';
import { getAthleteProfile, listGoals } from '../profile';
import { checkMove, getProgramVersion, type StoredSession } from '../programs';
import { programmingInputFor } from '../programs/alternatives';
import { runMinutes } from '../programs/edits';
import { listExercisePreferences } from '../training/preferences';
import { TrainingInputError } from '../training/shared';
import { listActiveWorkouts } from '../workouts/canonical';
import { APPLIERS, type Applier, type ApplyOutcome } from './apply';
import { SESSION_ENDED, substitutionEnded } from './apply/session';
import {
	CoachInputError,
	CoachNotFoundError,
	inTransaction,
	resolveDeps,
	type CoachDeps,
	type ResolvedCoachDeps
} from './shared';

/** Proposals per page of a list: the default and the most a caller may ask for. */
export const PROPOSAL_PAGE = Object.freeze({ default: 20, max: 50 });
/** The most proposals one list may name by id (get_coach_proposals). */
export const PROPOSAL_IDS_MAX = 10;
/**
 * Decision (M5 plan open question 'create_training_program works only when no program is
 * active'): a new_program is refused while a program is active, at create and at accept. Set it
 * to false for a 'replace my program' path, whose applier then retires the active program.
 */
export const NEW_PROGRAM_NEEDS_NO_PROGRAM = true;
export const PROGRAM_ACTIVE = 'You already have a program';

/** Why a review's proposal is superseded when some of its sessions passed before it was accepted. */
export const SESSIONS_PASSED = 'sessions_passed' satisfies SupersededReason;

/** The kinds proposed against the active program's current version (base_version_id). */
const ON_PROGRAM: ReadonlySet<ProposalKind> = new Set([
	'program_adjustment',
	'workout_update',
	'session_substitution',
	'next_cycle'
]);

/** The proposal fails its schema or today's rules: nothing was written. */
export class ProposalRefusedError extends CoachInputError {
	readonly errors: FieldErrors;

	constructor(errors: FieldErrors) {
		const [field, message] = Object.entries(errors)[0] ?? ['', 'Not a valid proposal'];
		super(field, message);
		this.name = 'ProposalRefusedError';
		this.errors = errors;
	}
}

/** It has already been decided another way (rejecting an accepted one): nothing was written. */
export class ProposalClosedError extends Error {
	readonly status: ProposalStatus;

	constructor(status: ProposalStatus) {
		super(`the proposal is already ${status}`);
		this.name = 'ProposalClosedError';
		this.status = status;
	}
}

/** One proposal as its card, the inbox and get_coach_proposals show it. */
export interface ProposalView {
	id: string;
	kind: ProposalKind;
	status: ProposalStatus;
	title: string;
	summary: string;
	rationale: string;
	summaryLines: string[];
	rows: DiffRow[];
	impact: WeekImpact[];
	impactLines: string[];
	/** The interference rules its moves newly break, when it was proposed. */
	warnings: string[];
	appliedVersion: { id: string; number: number } | null;
	appliedRef: AppliedRef | null;
	/** The owner's reason for a rejection; free text, never instructions. */
	decisionNote: string | null;
	supersededReason: SupersededReason | null;
	threadId: string | null;
	revisionOf: string | null;
	/** The review that proposed it by the rules (evidence.source); null for the coach's own. */
	origin: ProposalOrigin | null;
	createdAt: Date;
	closedAt: Date | null;
	/** What it touches, each once: its rows' records, the version it made, what it revises. */
	links: SourceRef[];
}

/**
 * A proposal the rules made for one of M6's reviews, not the coach: stored as evidence.source,
 * which M5's content guard then freezes. modifiedBy and trimmed mark an owner's revision of it.
 */
export interface RulesProvenance {
	kind: 'weekly_review' | 'cycle_review';
	reviewId: string;
	revision: number;
	/** A weekly review's Monday: its page is keyed by it. */
	weekStartsOn?: IsoDate;
	modifiedBy?: 'owner';
	/** How many of the review's changes were dropped because their sessions had passed. */
	trimmed?: number;
}

/** Where a review's proposal came from, and the review page that shows it. */
export interface ProposalOrigin {
	kind: RulesProvenance['kind'];
	reviewId: string;
	href: string;
}

/** The origin a stored evidence.source names; null for anything else. */
function originOf(source: unknown): ProposalOrigin | null {
	if (typeof source !== 'object' || source === null) return null;
	const { kind, reviewId, weekStartsOn } = source as Partial<RulesProvenance>;
	if (typeof reviewId !== 'string') return null;
	if (kind === 'weekly_review' && typeof weekStartsOn === 'string')
		return { kind, reviewId, href: `/progress/reviews/w-${weekStartsOn}` };
	if (kind === 'cycle_review') return { kind, reviewId, href: `/progress/reviews/c-${reviewId}` };
	return null;
}

/** coach_proposals.diff and .impact as createProposal stores them. */
interface StoredDiff {
	rows: DiffRow[];
	summaryLines: string[];
	warnings: string[];
}
interface StoredImpact {
	weeks: WeekImpact[];
	lines: string[];
}

function toView(row: ProposalViewRow): ProposalView {
	const diff = (row.diff ?? { rows: [], summaryLines: [row.summary], warnings: [] }) as unknown;
	const impact = (row.impact ?? { weeks: [], lines: [] }) as unknown;
	const { rows, summaryLines: lines, warnings } = diff as StoredDiff;
	const { weeks, lines: impactLines } = impact as StoredImpact;
	const applied =
		row.appliedVersionId && row.appliedVersionNumber !== null
			? { id: row.appliedVersionId, number: row.appliedVersionNumber }
			: null;
	const links = new Map<string, SourceRef>();
	const refs: (SourceRef | null)[] = [
		...rows.map((r) => r.link),
		applied
			? { type: 'version', id: String(applied.number), label: `Version ${applied.number}` }
			: null,
		row.revisionOf ? { type: 'proposal', id: row.revisionOf } : null
	];
	for (const ref of refs) {
		if (ref && !links.has(`${ref.type}:${ref.id}`)) links.set(`${ref.type}:${ref.id}`, ref);
	}
	return {
		id: row.id,
		kind: row.kind as ProposalKind,
		status: row.status,
		title: row.title,
		summary: row.summary,
		rationale: row.rationale,
		summaryLines: lines,
		rows,
		impact: weeks,
		impactLines,
		warnings,
		appliedVersion: applied,
		appliedRef: row.appliedRef,
		decisionNote: row.decisionNote,
		supersededReason: row.supersededReason,
		threadId: row.threadId,
		revisionOf: row.revisionOf,
		origin: originOf(row.source),
		createdAt: row.createdAt,
		closedAt: row.closedAt,
		links: [...links.values()]
	};
}

type Repository = ReturnType<typeof createCoachProposalsRepository>;

async function view(repo: Repository, ownerId: string, id: string): Promise<ProposalView> {
	const row = await repo.proposal(ownerId, id);
	if (!row) throw new CoachNotFoundError('proposal');
	return toView(row);
}

/** One of the owner's proposals, locked for the transaction. */
async function lockOwn(repo: Repository, ownerId: string, id: string) {
	const row = isUuid(id) ? await repo.lockProposal(ownerId, id) : null;
	if (!row) throw new CoachNotFoundError('proposal');
	return row;
}

// ---- checking against today -------------------------------------------------------------

/** Every exercise id the proposal names, at its payload path. */
function namedExercises(proposal: Proposal): [string, string][] {
	switch (proposal.kind) {
		case 'program_adjustment':
		case 'workout_update':
			return proposal.payload.ops.flatMap((op, i): [string, string][] =>
				op.op === 'swap' ? [[`ops.${i}.toExerciseId`, op.toExerciseId]] : []
			);
		case 'session_substitution':
			return [
				['fromExerciseId', proposal.payload.fromExerciseId],
				['toExerciseId', proposal.payload.toExerciseId]
			];
		case 'next_cycle':
			return proposal.payload.rotation.flatMap((r, i): [string, string][] => [
				[`rotation.${i}.fromExerciseId`, r.fromExerciseId],
				[`rotation.${i}.toExerciseId`, r.toExerciseId]
			]);
		case 'preference_update':
			return [['exerciseId', proposal.payload.exerciseId]];
		default:
			return [];
	}
}

/** What an adjustment addresses its row by, rather than changes. */
const ADDRESS = new Set(['op', 'sessionLineage', 'plannedExerciseLineage', 'position', 'reason']);

/**
 * The adjustments' targets and the values they leave, checked as adjustPrescription and its
 * siblings check them: a set, segment or details that are not there, or a change that leaves an
 * invalid prescription (repsMin over repsMax), is refused at its op. Adjustments apply in
 * order, so each one is checked on top of the ones before it.
 */
function adjustmentErrors(ops: readonly ProgramOp[], sessions: readonly StoredSession[]) {
	const errors: FieldErrors = {};
	const after = new Map<string, object>();
	for (const [i, op] of ops.entries()) {
		const session = sessions.find((s) => s.lineage === op.sessionLineage);
		let target: [key: string, before: object | undefined, missing: [string, string]];
		let check: (value: unknown) => { ok: true; data: object } | { ok: false; errors: FieldErrors };
		if (op.op === 'adjust_set') {
			const planned =
				session?.kind === 'strength'
					? session.exercises.find((e) => e.lineage === op.plannedExerciseLineage)
					: undefined;
			const key = `${op.sessionLineage}/${op.plannedExerciseLineage}/${op.position}`;
			target = [key, planned?.sets[op.position - 1], ['position', 'Unknown set']];
			check = (v) => validate(setPrescriptionSchema, v);
		} else if (op.op === 'adjust_run_segment') {
			const segment = session?.kind === 'run' ? session.segments[op.position - 1] : undefined;
			target = [`${op.sessionLineage}/${op.position}`, segment, ['position', 'Unknown segment']];
			check = (v) => validate(runSegmentSchema, v);
		} else if (op.op === 'adjust_details') {
			const details = session?.kind === 'other' ? session.details : undefined;
			target = [op.sessionLineage, details, ['sessionLineage', RULE_MESSAGES.unknownSession]];
			check = (v) => validate(otherDetailsSchema, v);
		} else continue;
		const [key, before, [field, message]] = target;
		const prior = after.get(key) ?? before;
		if (!prior) {
			errors[`payload.ops.${i}.${field}`] ??= message;
			continue;
		}
		const values = Object.entries(op).filter(([k, v]) => v !== undefined && !ADDRESS.has(k));
		const result = check({ ...prior, ...Object.fromEntries(values) });
		if (result.ok) after.set(key, result.data);
		else {
			for (const [path, m] of Object.entries(result.errors))
				errors[path ? `payload.ops.${i}.${path}` : `payload.ops.${i}`] ??= m;
		}
	}
	return errors;
}

const eligibleFor = (def: ExerciseDef, input: ProgrammingInput | null) => {
	if (!input) return false;
	const key = toExerciseKey(def.key ? { key: def.key } : { customId: def.id });
	const entry = libraryOf(input).find((e) => e.key === key);
	return entry !== undefined && isEligible(entry, input).ok;
};

interface Checked {
	proposal: Proposal;
	today: IsoDate;
	/** The active program at its current version, if any. */
	program: { id: string; versionId: string } | null;
	diffContext: DiffContext;
	warnings: string[];
}

/**
 * Parse `input` as a proposal and check it against the owner's data today; ProposalRefusedError
 * with every field at fault otherwise. Queries run one at a time, so `db` may be a transaction.
 */
async function checkAgainstToday(
	ownerId: string,
	input: unknown,
	{ db, now }: ResolvedCoachDeps
): Promise<Checked> {
	const parsed = validate(proposalSchema, input);
	if (!parsed.ok) throw new ProposalRefusedError(parsed.errors);
	const { kind } = parsed.data;
	const profile = await getAthleteProfile(ownerId, { db });
	const today = localDay(now(), profile.timeZone);
	const found = await createProgramsRepository(db).currentProgram(ownerId);
	const version = found
		? await getProgramVersion(ownerId, found.program.id, found.version.number, { db })
		: null;
	const goals = kind === 'goal_update' ? await listGoals(ownerId, { db }) : [];
	const preferences = await listExercisePreferences(ownerId, { db });
	const programming =
		version && ON_PROGRAM.has(kind) ? await programmingInputFor(ownerId, { db }) : null;

	const sessions = (version?.blocks ?? [])
		.flatMap((b) => b.weeks)
		.flatMap((w) => w.sessions)
		.filter((s) => s.status !== 'skipped');
	const weeks = (version?.blocks ?? [])
		.flatMap((b) => b.weeks)
		.filter((w) => w.endsOn >= today)
		.map((w) => ({ ...w, sessions: w.sessions.filter((s) => s.status !== 'skipped') }));
	const planned = weeks
		.flatMap((w) => w.sessions)
		.flatMap((s) => (s.kind === 'strength' ? s.exercises.map((e) => e.exercise) : []));
	const named = namedExercises(parsed.data);
	const byKey = await resolveKeys(
		planned.flatMap((r) => ('key' in r ? [r.key] : [])),
		{ db }
	);
	const byId = await getExercisesByIds(
		ownerId,
		[
			...named.map(([, id]) => id),
			...planned.flatMap((r) => ('customId' in r ? [r.customId] : []))
		],
		{ db }
	);
	const defs = new Map([...byKey.values(), ...byId.values()].map((d) => [d.id, d]));

	const errors: FieldErrors = {};
	for (const [path, id] of named) {
		if (!defs.has(id)) errors[`payload.${path}`] ??= RULE_MESSAGES.unknownExercise;
	}
	const sentiment = new Map(preferences.flatMap((p) => (p.exerciseId ? [[p.exerciseId, p]] : [])));
	const context: ProposalContext = {
		today,
		sessions: sessions.map((s) => ({
			lineage: s.lineage,
			date: s.date,
			exerciseLineages: s.kind === 'strength' ? s.exercises.map((e) => e.lineage) : []
		})),
		blockLineages: version?.blocks.map((b) => b.lineage) ?? [],
		dislikedExerciseIds: preferences.flatMap((p) =>
			p.sentiment === 'dislike' && p.exerciseId ? [p.exerciseId] : []
		),
		eligibleExerciseIds: named.flatMap(([, id]) => {
			const def = defs.get(id);
			return def && eligibleFor(def, programming) ? [id] : [];
		}),
		goalIds: goals.map((g) => g.id)
	};
	const checked = checkProposal(input, context);
	if (!checked.ok) for (const [path, m] of Object.entries(checked.errors)) errors[path] ??= m;
	if (kind === 'new_program' && NEW_PROGRAM_NEEDS_NO_PROGRAM && found) {
		errors.kind ??= PROGRAM_ACTIVE;
	}

	// The interference rules a move newly breaks warn; the days it cannot reach refuse.
	const warnings: string[] = [];
	const proposal = parsed.data;
	if (
		!Object.keys(errors).length &&
		(proposal.kind === 'program_adjustment' || proposal.kind === 'workout_update')
	) {
		Object.assign(errors, adjustmentErrors(proposal.payload.ops, sessions));
	}
	if (found && !Object.keys(errors).length && 'ops' in proposal.payload) {
		for (const [i, op] of proposal.payload.ops.entries()) {
			if (op.op !== 'move') continue;
			const { op: _move, ...move } = op;
			const at = { version: found.version.number, today };
			try {
				for (const w of await checkMove(ownerId, move, at, { db })) warnings.push(w.message);
			} catch (error) {
				if (!(error instanceof TrainingInputError)) throw error;
				for (const [path, m] of Object.entries(error.errors))
					errors[`payload.ops.${i}.${path}`] ??= m;
			}
		}
	}
	if (Object.keys(errors).length || !checked.ok) throw new ProposalRefusedError(errors);

	const diffContext: DiffContext = {
		today,
		unit: profile.weightUnit,
		distanceUnit: profile.distanceUnit,
		weeks,
		exercises: [...defs.values()].map((d) => ({
			id: d.id,
			key: d.key,
			name: d.name,
			baselineLift: d.baselineLift,
			primaryMuscles: d.primaryMuscles,
			secondaryMuscles: d.secondaryMuscles,
			sentiment: sentiment.get(d.id)?.sentiment ?? null
		})),
		estimateMinutes: (s) => {
			if (s.kind === 'run') return runMinutes(s.segments);
			if (s.kind === 'other') return s.estMinutes;
			if (!programming) throw new Error('a strength estimate needs the programming input');
			return estimateMinutes(s, programming);
		},
		goals,
		blocks: version?.blocks.map((b) => ({ lineage: b.lineage, name: b.name })) ?? [],
		program: version && { title: version.title }
	};
	return {
		proposal: checked.data,
		today,
		program: found && { id: found.program.id, versionId: found.version.id },
		diffContext,
		warnings
	};
}

// ---- create -----------------------------------------------------------------------------

export interface NewProposal {
	/** {kind, title, rationale, payload}, as the drafter wrote it or a propose tool took it. */
	proposal: unknown;
	/** The open proposal this revises ('Ask for changes'): it is superseded as 'revised'. */
	revises?: string | null;
	/** The conversation, run and tool call that proposed it. */
	origin?: { threadId: string; runId: string; toolUseId: string } | null;
	/** What the coach read to propose it. */
	evidence?: Record<string, unknown> | null;
	/** A review's rules proposed it, with no conversation: stored as evidence.source. */
	provenance?: RulesProvenance | null;
}

export interface CreatedProposal {
	proposal: ProposalView;
	/** An identical open proposal on the same base was returned: nothing was written. */
	duplicate: boolean;
}

/**
 * Store a proposal checked against the owner's data today. An identical open proposal on the
 * same base is returned as it is, even for a revision (whose predecessor then stays open).
 */
export async function createProposal(
	ownerId: string,
	input: NewProposal,
	deps: CoachDeps = {}
): Promise<CreatedProposal> {
	const { provenance } = input;
	if (provenance && input.origin) {
		throw new CoachInputError('provenance', 'A review proposal has no conversation');
	}
	const evidence = provenance
		? { ...input.evidence, source: provenance }
		: (input.evidence ?? null);
	return inTransaction(deps, async (resolved) => {
		const repo = createCoachProposalsRepository(resolved.db);
		const { proposal, program, diffContext, warnings } = await checkAgainstToday(
			ownerId,
			input.proposal,
			resolved
		);
		const base = ON_PROGRAM.has(proposal.kind) ? program : null;
		const hash = payloadHash(proposal.payload);
		const of = { kind: proposal.kind, payloadHash: hash, baseVersionId: base?.versionId ?? null };
		await repo.lockCreates(ownerId);
		const duplicate = await repo.openDuplicate(ownerId, of);
		if (duplicate) return { proposal: await view(repo, ownerId, duplicate), duplicate: true };

		let revises: string | null = null;
		let open = false;
		if (input.revises != null) {
			const predecessor = await lockOwn(repo, ownerId, input.revises);
			// A review's proposal superseded as sessions_passed is the base of the owner's revision
			// that finishes it in the review; it is already closed, so it stays as it is.
			const passed = predecessor.supersededReason === SESSIONS_PASSED;
			if (predecessor.status !== 'proposed' && !passed) {
				throw new ProposalClosedError(predecessor.status);
			}
			revises = predecessor.id;
			open = predecessor.status === 'proposed';
		}
		const { rows, impact } = describeProposal(proposal, diffContext);
		const lines = summaryLines(proposal, diffContext);
		const at = resolved.now();
		const id = await repo.insertProposal({
			ownerId,
			kind: proposal.kind,
			title: proposal.title,
			summary: lines[0]!,
			rationale: proposal.rationale,
			payload: proposal.payload as Record<string, unknown>,
			evidence,
			programId: base?.id ?? null,
			baseVersionId: base?.versionId ?? null,
			threadId: input.origin?.threadId ?? null,
			runId: input.origin?.runId ?? null,
			toolUseId: input.origin?.toolUseId ?? null,
			payloadVersion: PAYLOAD_VERSION,
			payloadHash: hash,
			diff: { rows, summaryLines: lines, warnings } satisfies StoredDiff,
			impact: { weeks: impact, lines: describeImpact(impact, diffContext) } satisfies StoredImpact,
			revisionOf: revises,
			createdAt: at,
			updatedAt: at
		});
		if (revises && open) {
			const superseded = { supersededReason: 'revised', closedAt: at, updatedAt: at } as const;
			await repo.decide(ownerId, revises, { status: 'superseded', ...superseded });
		}
		return { proposal: await view(repo, ownerId, id), duplicate: false };
	});
}

// ---- decide -----------------------------------------------------------------------------

export interface DecidedProposal {
	proposal: ProposalView;
	/** False when it had already been decided: it is returned as stored and nothing was written. */
	changed: boolean;
	/** A review's proposal some of whose sessions had passed: finish it in the review at `href`. */
	superseded?: { reason: typeof SESSIONS_PASSED; href: string };
}

/** A session the version does not hold: kept, so today's check refuses it as it would. */
const NOT_IN_VERSION: IsoDate = '9999-12-31';

/**
 * The items whose op's session is still ahead today (the domain's stillAhead): dated today or
 * later in the current version, not skipped, and with no workout begun or completed on it. The
 * review's decision and acceptProposal both split a review's ops with it, so they agree.
 */
export async function opsStillAhead<T extends { op: ProgramOp }>(
	ownerId: string,
	items: readonly T[],
	today: IsoDate,
	db: ResolvedCoachDeps['db']
): Promise<T[]> {
	const programs = createProgramsRepository(db);
	const found = await programs.currentProgram(ownerId);
	if (!found) return [...items];
	const version = await getProgramVersion(ownerId, found.program.id, found.version.number, { db });
	const sessions = new Map(
		version.blocks.flatMap((b) => b.weeks.flatMap((w) => w.sessions)).map((s) => [s.lineage, s])
	);
	const lineages = [...new Set(items.map((i) => i.op.sessionLineage))];
	const done = await programs.completedLineages(ownerId, lineages);
	const { workouts } = await listActiveWorkouts(ownerId, { db });
	const begun = [
		...done,
		...workouts.map((w) => w.plannedLineage),
		...lineages.filter((l) => sessions.get(l)?.status === 'skipped')
	].map((plannedLineage) => ({ plannedLineage }));
	const dated = items.map((item) => ({
		item,
		op: item.op,
		sessionDate: sessions.get(item.op.sessionLineage)?.date ?? NOT_IN_VERSION
	}));
	return stillAhead(dated, today, begun).map((d) => d.item);
}

function decisionOf(outcome: ApplyOutcome, at: Date): ProposalDecision {
	const closed = { closedAt: at, updatedAt: at };
	switch (outcome.status) {
		case 'applied':
			return {
				status: 'applied',
				appliedVersionId: outcome.appliedVersionId,
				appliedRef: outcome.appliedRef,
				programId: outcome.programId,
				...closed
			};
		case 'accepted':
			return { status: 'accepted', ...closed };
		case 'superseded':
			return { status: 'superseded', supersededReason: outcome.reason, ...closed };
	}
}

/**
 * Accept one of the owner's proposals by id: the stored payload, re-parsed and checked again
 * against today, is applied by its kind's applier in this transaction. A proposal whose program
 * has a newer version is superseded ('program_changed') instead, and a review's proposal with a
 * session now past or started as SESSIONS_PASSED, with the review's href to finish it there; one
 * that no longer passes today's rules is refused (ProposalRefusedError) and stays proposed.
 */
export async function acceptProposal(
	ownerId: string,
	id: string,
	deps: CoachDeps = {}
): Promise<DecidedProposal> {
	return inTransaction(deps, async (resolved) => {
		const repo = createCoachProposalsRepository(resolved.db);
		const row = await lockOwn(repo, ownerId, id);
		if (row.status !== 'proposed') {
			return { proposal: await view(repo, ownerId, row.id), changed: false };
		}
		const at = resolved.now();
		if (row.baseVersionId) {
			const current = await createProgramsRepository(resolved.db).currentProgram(ownerId);
			if (current?.version.id !== row.baseVersionId) {
				const superseded = { supersededReason: 'program_changed' as const, closedAt: at };
				await repo.decide(ownerId, row.id, { status: 'superseded', ...superseded, updatedAt: at });
				return { proposal: await view(repo, ownerId, row.id), changed: true };
			}
		}
		// A review's proposal with a session now past or started is finished in the review instead.
		const origin = originOf((row.evidence as { source?: unknown } | null)?.source);
		const ops = (row.payload as { ops?: ProgramOp[] }).ops;
		if (origin && Array.isArray(ops)) {
			const { timeZone } = await getAthleteProfile(ownerId, { db: resolved.db });
			const items = ops.map((op) => ({ op }));
			const ahead = await opsStillAhead(ownerId, items, localDay(at, timeZone), resolved.db);
			if (ahead.length < items.length) {
				const superseded = {
					supersededReason: SESSIONS_PASSED,
					closedAt: at,
					updatedAt: at
				} as const;
				await repo.decide(ownerId, row.id, { status: 'superseded', ...superseded });
				const proposal = await view(repo, ownerId, row.id);
				return {
					proposal,
					changed: true,
					superseded: { reason: SESSIONS_PASSED, href: origin.href }
				};
			}
		}
		const stored = {
			kind: row.kind,
			title: row.title,
			rationale: row.rationale,
			payload: row.payload
		};
		const checked = await checkAgainstToday(ownerId, stored, resolved).catch(async (error) => {
			// A refused substitution whose workout or session is over is superseded instead.
			const parsed = validate(proposalSchema, stored);
			if (!(error instanceof ProposalRefusedError) || !parsed.ok) throw error;
			if (!(await substitutionEnded(ownerId, parsed.data, resolved.db))) throw error;
			return null;
		});
		if (!checked) {
			const superseded = { supersededReason: SESSION_ENDED, closedAt: at };
			await repo.decide(ownerId, row.id, { status: 'superseded', ...superseded, updatedAt: at });
			return { proposal: await view(repo, ownerId, row.id), changed: true };
		}
		const { proposal, today } = checked;
		const apply = APPLIERS[proposal.kind] as Applier<ProposalKind>;
		const outcome = await apply({
			ownerId,
			proposalId: row.id,
			proposal,
			programId: row.programId,
			baseVersionId: row.baseVersionId,
			today,
			deps: resolved
		});
		await repo.decide(ownerId, row.id, decisionOf(outcome, at));
		return { proposal: await view(repo, ownerId, row.id), changed: true };
	});
}

/**
 * Reject one of the owner's open proposals, with their optional reason. Rejecting it again
 * returns it as stored; rejecting one accepted, applied or superseded is a ProposalClosedError.
 */
export async function rejectProposal(
	ownerId: string,
	id: string,
	input: { reason?: string | null } = {},
	deps: CoachDeps = {}
): Promise<DecidedProposal> {
	const reason = input.reason?.trim() || null;
	if (reason !== null && Array.from(reason).length > DECISION_NOTE_MAX) {
		throw new CoachInputError('reason', `Keep it under ${DECISION_NOTE_MAX} characters`);
	}
	return inTransaction(deps, async (resolved) => {
		const repo = createCoachProposalsRepository(resolved.db);
		const row = await lockOwn(repo, ownerId, id);
		if (row.status === 'rejected') {
			return { proposal: await view(repo, ownerId, row.id), changed: false };
		}
		if (row.status !== 'proposed') throw new ProposalClosedError(row.status);
		const at = resolved.now();
		await repo.decide(ownerId, row.id, {
			status: 'rejected',
			decisionNote: reason,
			closedAt: at,
			updatedAt: at
		});
		return { proposal: await view(repo, ownerId, row.id), changed: true };
	});
}

// ---- read -------------------------------------------------------------------------------

export interface ProposalQuery {
	status?: ProposalStatus;
	/** Only these, up to PROPOSAL_IDS_MAX; an id that is not the owner's is left out. */
	ids?: readonly string[];
	/** The `next` of the previous page. */
	before?: string;
	limit?: number;
}

export interface ProposalList {
	/** Newest first. */
	proposals: ProposalView[];
	/** The cursor for the next page; null on the last. */
	next: string | null;
}

/** The owner's proposals, newest first, a page at a time. */
export async function listProposals(
	ownerId: string,
	query: ProposalQuery = {},
	deps: CoachDeps = {}
): Promise<ProposalList> {
	const { status, ids, before, limit = PROPOSAL_PAGE.default } = query;
	if (!Number.isInteger(limit) || limit < 1 || limit > PROPOSAL_PAGE.max) {
		throw new CoachInputError('limit', `1 to ${PROPOSAL_PAGE.max} at a time`);
	}
	if (ids && ids.length > PROPOSAL_IDS_MAX) {
		throw new CoachInputError('ids', `Up to ${PROPOSAL_IDS_MAX} proposals at a time`);
	}
	if (status !== undefined && !PROPOSAL_STATUSES.includes(status)) {
		throw new CoachInputError('status', 'Unknown status');
	}
	const wanted = ids?.filter(isUuid);
	if (wanted?.length === 0 || (before !== undefined && !isUuid(before))) {
		return { proposals: [], next: null };
	}
	const { db } = resolveDeps(deps);
	const rows = await createCoachProposalsRepository(db).proposalPage(ownerId, {
		status,
		ids: wanted,
		before,
		limit: limit + 1
	});
	const page = rows.slice(0, limit);
	return { proposals: page.map(toView), next: rows.length > limit ? page.at(-1)!.id : null };
}

/**
 * The owner's proposals decided after `since`, most recently decided first and at most
 * PROPOSAL_IDS_MAX of them (one get_coach_proposals call): ids, kinds and statuses only, as the
 * turn context carries them (never the owner's note, which get_coach_proposals returns).
 */
export async function listDecidedSince(
	ownerId: string,
	since: Date,
	deps: CoachDeps = {}
): Promise<{ id: string; kind: ProposalKind; status: ProposalStatus }[]> {
	const { db } = resolveDeps(deps);
	const rows = await createCoachProposalsRepository(db).decidedSince(
		ownerId,
		since,
		PROPOSAL_IDS_MAX
	);
	return rows.map(({ id, kind, status }) => ({ id, kind: kind as ProposalKind, status }));
}

/** One of the owner's proposals as its card and the inbox's detail show it. */
export async function getProposalView(
	ownerId: string,
	id: string,
	deps: CoachDeps = {}
): Promise<ProposalView> {
	if (!isUuid(id)) throw new CoachNotFoundError('proposal');
	return view(createCoachProposalsRepository(resolveDeps(deps).db), ownerId, id);
}
