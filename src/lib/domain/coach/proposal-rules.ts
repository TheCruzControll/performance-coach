/**
 * The rules a proposal must pass beyond its schema (./proposals.ts): the ones that need the
 * owner's data. createProposal runs them before storing, and accept runs them again against the
 * owner's today, so a proposal that has gone stale is refused rather than applied.
 *
 * - No op lands in the past: its session is today or later, and so is a move's new day.
 * - A swap, a substitution or a rotation never targets an exercise the owner dislikes, or one
 *   that is not eligible for them (equipment, injuries); eligibility arrives as data.
 * - A workout_update touches one session. (At most MAX_PROPOSAL_OPS ops is the schema's.)
 * - Every id names something the owner has: a session, its planned exercise, a block, a goal.
 * - A replan starts on a Monday still ahead: a regenerating or splicing one from the next Monday
 *   (today when it is a Monday) on, a deload's week this week or later and its from that week.
 *
 * Errors are keyed by the dotted path of the field at fault, as validate() keys a schema's, so a
 * card or a tool result can point at it. Server-only and pure: imported by path, no clock, no I/O.
 */
import { addDays, mondayOf, type IsoDate } from '../calendar.ts';
import { validate, type FieldErrors, type Validated } from '../validation.ts';
import { proposalSchema, type ProgramOp, type Proposal } from './proposals.ts';

/** A session of the active program, by lineage, with its planned exercises' lineages. */
export interface ProposalSession {
	lineage: string;
	date: IsoDate;
	exerciseLineages: readonly string[];
}

export interface ProposalContext {
	/** The owner's local today. */
	today: IsoDate;
	sessions: readonly ProposalSession[];
	blockLineages: readonly string[];
	dislikedExerciseIds: readonly string[];
	eligibleExerciseIds: readonly string[];
	goalIds: readonly string[];
}

export const RULE_MESSAGES = {
	unknownSession: 'Unknown session',
	unknownExercise: 'Unknown exercise',
	unknownBlock: 'Unknown block',
	unknownGoal: 'Unknown goal',
	past: 'Already past',
	pastDay: 'Pick today or later',
	disliked: 'You dislike this exercise',
	ineligible: 'Not an option for you',
	oneSession: 'One session per workout update',
	startPassed: 'Start on a Monday still ahead',
	deloadWeek: 'Start on the deloaded week'
} as const;
const M = RULE_MESSAGES;

/** Parse `input` as a proposal, then check it against the owner's data. */
export function checkProposal(input: unknown, context: ProposalContext): Validated<Proposal> {
	const parsed = validate(proposalSchema, input);
	if (!parsed.ok) return parsed;
	const errors = proposalErrors(parsed.data, context);
	return Object.keys(errors).length ? { ok: false, errors } : parsed;
}

function proposalErrors(proposal: Proposal, context: ProposalContext): FieldErrors {
	const errors: FieldErrors = {};
	const fail = (path: string, message: string) => {
		errors[`payload.${path}`] ??= message;
	};
	const sessions = new Map(context.sessions.map((session) => [session.lineage, session]));
	const disliked = new Set(context.dislikedExerciseIds);
	const eligible = new Set(context.eligibleExerciseIds);
	const goals = new Set(context.goalIds);

	/** The session, if it is the owner's and not yet past; otherwise why not, at `path`. */
	const session = (lineage: string, path: string) => {
		const found = sessions.get(lineage);
		if (!found) fail(path, M.unknownSession);
		else if (found.date < context.today) fail(path, M.past);
		return found;
	};
	const plannedExercise = (found: ProposalSession | undefined, lineage: string, path: string) => {
		if (found && !found.exerciseLineages.includes(lineage)) fail(path, M.unknownExercise);
	};
	const target = (exerciseId: string, path: string) => {
		if (disliked.has(exerciseId)) fail(path, M.disliked);
		else if (!eligible.has(exerciseId)) fail(path, M.ineligible);
	};
	const goal = (id: string, path: string) => {
		if (!goals.has(id)) fail(path, M.unknownGoal);
	};

	const programOp = (op: ProgramOp, at: string) => {
		const found = session(op.sessionLineage, `${at}.sessionLineage`);
		if (op.op === 'move' && op.toDate < context.today) fail(`${at}.toDate`, M.pastDay);
		if (op.op === 'swap' || op.op === 'adjust_set') {
			plannedExercise(found, op.plannedExerciseLineage, `${at}.plannedExerciseLineage`);
		}
		if (op.op === 'swap') target(op.toExerciseId, `${at}.toExerciseId`);
	};

	switch (proposal.kind) {
		case 'program_adjustment':
			proposal.payload.ops.forEach((op, i) => programOp(op, `ops.${i}`));
			break;
		case 'workout_update': {
			const [first] = proposal.payload.ops;
			proposal.payload.ops.forEach((op, i) => {
				programOp(op, `ops.${i}`);
				if (op.sessionLineage !== first?.sessionLineage) {
					fail(`ops.${i}.sessionLineage`, M.oneSession);
				}
			});
			break;
		}
		case 'session_substitution': {
			const { payload } = proposal;
			const found = session(payload.sessionLineage, 'sessionLineage');
			plannedExercise(found, payload.plannedExerciseLineage, 'plannedExerciseLineage');
			target(payload.toExerciseId, 'toExerciseId');
			break;
		}
		case 'new_program':
			if (proposal.payload.firstPlannedDay < context.today) fail('firstPlannedDay', M.pastDay);
			break;
		case 'next_cycle':
			if (!context.blockLineages.includes(proposal.payload.fromBlockLineage)) {
				fail('fromBlockLineage', M.unknownBlock);
			}
			proposal.payload.rotation.forEach((swap, i) =>
				target(swap.toExerciseId, `rotation.${i}.toExerciseId`)
			);
			break;
		case 'goal_update':
			proposal.payload.ops.forEach((op, i) => {
				if (op.op === 'edit' || op.op === 'set_status') goal(op.goalId, `ops.${i}.goalId`);
				if (op.op === 'reorder') op.ids.forEach((id, j) => goal(id, `ops.${i}.ids.${j}`));
			});
			break;
		case 'preference_update':
			// The exercise is looked up when it is recorded (recordExercisePreference).
			break;
		case 'replan': {
			const { directive, from } = proposal.payload;
			const thisWeek = mondayOf(context.today);
			const nextMonday = thisWeek === context.today ? thisWeek : addDays(thisWeek, 7);
			if (directive.kind === 'deload') {
				if (directive.week < thisWeek) fail('directive.week', M.past);
				if (from !== directive.week) fail('from', M.deloadWeek);
			} else if (from < nextMonday) fail('from', M.startPassed);
			if (directive.kind === 'block' && directive.focusGoalRef)
				goal(directive.focusGoalRef, 'directive.focusGoalRef');
			if (directive.kind === 'taper') goal(directive.goalRef, 'directive.goalRef');
			break;
		}
	}
	return errors;
}
