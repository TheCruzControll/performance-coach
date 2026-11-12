/**
 * Moving the program's start (owner decision 2026-11-12; domain/programming/start-move.ts has
 * the rules): Train's Start date screen reads what a move may do (getStartMove), and the move is
 * stored as the program's next version (moveProgramStart), so History lists it and moving back
 * plans it again for the earlier dates. One transaction under the program head's lock:
 * - a base that is no longer current is a ProgramConflictError, before anything is written
 * - a start that can no longer move (its first planned day has passed, or a workout is logged
 *   against the program) is a StartMoveError; a start the move does not offer, or the current
 *   one, a TrainingInputError at `start`
 * - the program is generated again from the owner's profile for the new dates, as a build
 *   generates it (generateFor), so an unfinished onboarding is refused there, blocks and weeks
 *   stay on Mondays and every dated goal keeps its date: its taper is placed from the new start,
 *   never shifted past the event
 * - the new version shares none of its parent's blocks: every block, week and session comes back
 *   as new rows, the version's startsOn and firstPlannedDay move with them, and it keeps the
 *   generator, fingerprint, catalogue digest and input that built it, as version 1 does; the
 *   program keeps the title its build gave it
 * - its decisions: the move first (start_moved, by deps.source), then the generator's.
 * Version N, its weeks and anything logged against them are never touched.
 */
import * as z from 'zod/mini';
import type { IsoDate } from '../../../domain/calendar';
import { DecisionLog } from '../../../domain/programming/decisions';
import { GENERATOR_ID } from '../../../domain/programming/index';
import {
	choiceOf,
	currentChoice,
	moveRefusal,
	sameStart,
	startChoices,
	startWords,
	type StartChoice,
	type StartDates,
	type StartMoveRefusal
} from '../../../domain/programming/start-move';
import { programPlanSchema } from '../../../domain/training/schemas';
import type { Decider } from '../../../domain/training/vocabulary';
import { createReplanRepository } from '../../db/repositories/program-replan';
import { createProgramsRepository } from '../../db/repositories/programs';
import { measure } from '../../observability/timing';
import { planRows } from '../programs/mapping';
import type { RevisedVersion } from '../programs/revise';
import { MAX_VERSION, resolveExercises } from '../programs/store';
import {
	ConflictError,
	parseWith,
	ProgramConflictError,
	resolveDeps,
	TrainingInputError,
	TrainingNotFoundError
} from '../training/shared';
import { generateFor, type ProgrammingDeps } from './preview';

const REFUSAL_MESSAGE: Readonly<Record<StartMoveRefusal, string>> = {
	started: "the program's first planned day has passed",
	logged: 'a workout is logged against the program'
};

/** The start can no longer move: nothing was written. */
export class StartMoveError extends ConflictError<StartMoveRefusal> {
	constructor(reason: StartMoveRefusal) {
		super(reason, REFUSAL_MESSAGE[reason]);
		this.name = 'StartMoveError';
	}
}

/** What the screen says at `start` for a start the move does not offer, or the current one. */
export const NOT_OFFERED = 'Pick one of the dates shown';
export const ALREADY_THEN = 'Your program already starts then';

/** Who the move's 'why' says moved it. */
const WHO: Readonly<Record<Decider, string>> = {
	owner: 'You',
	coach: 'The coach',
	rules: 'The programming rules'
};

/** What a move may do today: the current start, why it can't move, and the starts offered. */
export interface StartMove {
	/** The current version, which a move is made on. */
	version: number;
	current: StartDates;
	/** Why it can no longer move; null while it can. */
	refusal: StartMoveRefusal | null;
	/** Earliest first; none once it can't move. */
	choices: StartChoice[];
	/** The choice that keeps the current start, if one does. */
	currentValue: StartChoice['value'] | null;
}

export interface MovedStart extends RevisedVersion, StartDates {
	/** The start before the move. */
	from: StartDates;
}

const RELOAD = 'Reload and try again';

const moveRequestSchema = z.object({
	today: z.iso.date('Use a real date'),
	baseVersionNumber: z.int(RELOAD).check(z.minimum(1, RELOAD), z.maximum(MAX_VERSION, RELOAD)),
	start: z.string(NOT_OFFERED)
});
export type MoveRequest = z.output<typeof moveRequestSchema>;

/** What the owner's active program's start may do on `today`; null without an active program. */
export async function getStartMove(
	ownerId: string,
	today: IsoDate,
	deps: Pick<ProgrammingDeps, 'db'> = {}
): Promise<StartMove | null> {
	const { db } = resolveDeps(deps);
	return measure('db', async () => {
		const found = await createProgramsRepository(db).currentProgram(ownerId);
		if (!found) return null;
		const { startsOn, firstPlannedDay, number } = found.version;
		const logged = await createReplanRepository(db).loggedAgainst(ownerId, found.program.id);
		const refusal = moveRefusal({ today, firstPlannedDay, logged });
		const current = { startsOn, firstPlannedDay };
		return {
			version: number,
			current,
			refusal,
			choices: refusal ? [] : startChoices(today),
			currentValue: currentChoice(current, today)?.value ?? null
		};
	});
}

/**
 * Move the owner's active program's start to `request.start` ('this_week' or a Monday the move
 * offers on `request.today`), as its next version made on `request.baseVersionNumber`.
 * `deps.source` moves it: the owner on Train, or the coach.
 */
export async function moveProgramStart(
	ownerId: string,
	request: unknown,
	deps: ProgrammingDeps = {}
): Promise<MovedStart> {
	const { today, baseVersionNumber, start } = parseWith(moveRequestSchema, request);
	const choice = choiceOf(start, today);
	if (!choice) throw new TrainingInputError({ start: NOT_OFFERED });
	const { db, now, source } = resolveDeps(deps);
	if (source === 'rules') throw new TrainingInputError({ source: 'You or the coach move it' });
	const dates: StartDates = { startsOn: choice.startsOn, firstPlannedDay: choice.firstPlannedDay };

	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createProgramsRepository(tx);
			const replan = createReplanRepository(tx);
			const head = await repo.lockProgram(ownerId);
			if (!head) throw new TrainingNotFoundError('program');
			const base = await repo.findVersion(ownerId, head.id, baseVersionNumber);
			if (!base || base.version.id !== head.currentVersionId) throw new ProgramConflictError();
			const from = {
				startsOn: base.version.startsOn,
				firstPlannedDay: base.version.firstPlannedDay
			};
			const logged = await replan.loggedAgainst(ownerId, head.id);
			const refusal = moveRefusal({ today, firstPlannedDay: from.firstPlannedDay, logged });
			if (refusal) throw new StartMoveError(refusal);
			if (sameStart(from, dates)) throw new TrainingInputError({ start: ALREADY_THEN });

			const generated = await generateFor(ownerId, dates, { ...deps, db: tx });
			const facts = {
				who: WHO[source],
				from: startWords(from.firstPlannedDay),
				to: startWords(dates.firstPlannedDay)
			};
			const moved = new DecisionLog(source).add('start_moved', 'program.start_moved', [], {
				...facts,
				fromStartsOn: from.startsOn,
				toStartsOn: dates.startsOn,
				firstPlannedDay: dates.firstPlannedDay
			});
			const plan = parseWith(programPlanSchema, {
				...generated.plan,
				decisions: [moved, ...generated.plan.decisions]
			});
			const exerciseId = await resolveExercises(ownerId, plan, { db: tx });
			const createdAt = now();
			const rows = planRows(plan, {
				ownerId,
				at: createdAt,
				version: {
					createdBy: source,
					summary: moved.summary,
					generator: GENERATOR_ID,
					inputFingerprint: generated.fingerprint,
					catalogueDigest: generated.digest,
					// Plain data (no Date, Map or undefined), so jsonb stores it exactly.
					inputSnapshot: generated.input as unknown as Record<string, unknown>
				},
				exerciseId
			});
			const { program: _p, version, ...tables } = rows.tree;
			const versionId = crypto.randomUUID();
			const number = base.version.number + 1;
			await replan.insertVersionSharing(
				{ ...version, id: versionId, programId: head.id, number, parentVersionId: base.version.id },
				[]
			);
			await replan.insertPlannedBlocks({
				...tables,
				blocks: tables.blocks.map((row) => ({ ...row, programId: head.id })),
				versionBlocks: tables.versionBlocks.map((row) => ({ ...row, versionId })),
				versionWeeks: tables.versionWeeks.map((row) => ({ ...row, versionId }))
			});
			await repo.insertDecisions(
				rows.decisions.map((d) => ({ ...d, programId: head.id, versionId }))
			);
			if (!(await repo.setCurrentVersion(head.id, base.version.id, versionId))) {
				throw new ProgramConflictError();
			}
			return { programId: head.id, versionId, number, ...dates, from };
		})
	);
}
