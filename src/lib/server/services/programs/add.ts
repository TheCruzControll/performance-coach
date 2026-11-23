/**
 * Adding a session to a planned week of the active program (PRD §5), from the owner's Add session
 * sheet on Train. The session is built by the generator's own builders from the owner's profile
 * (domain/programming/added.ts); the caller never writes its content. It is stored as the next
 * version (reviseProgram) with one session_added decision.
 *
 * - An add goes on a day from today on, inside a planned week of the current version, on or after
 *   its first planned day, where the day has fewer than SESSIONS_A_DAY sessions. An outline week
 *   and a bridge week take no add. Each refusal is a field error at `date`, or the builder's own at
 *   its field (AddRefusal).
 * - Its time of day places it in its day (placeInDay), and the day's sessions after it are
 *   numbered again.
 * - The week's new findings (judge, as a move's are) are returned and written into the decision's
 *   'why'. They never block the add. The week's context is read before the revision's transaction
 *   opens, as a move's is.
 * - addApplier writes nothing; addSession writes the version.
 */
import { AddRefusal, buildAddedSession } from '../../../domain/programming/added';
import { BRIDGE_PHASE, BRIDGE_WEEK_KIND } from '../../../domain/programming/next-block/dates';
import { DEFAULT_INTENT } from '../../../domain/programming/rules/added';
import { addSessionSchema } from '../../../domain/training/edits';
import type {
	ExerciseRef,
	SessionPlan,
	WeekPlan,
	WeekTargets
} from '../../../domain/training/types';
import { createProgramsRepository, type SessionChange } from '../../db/repositories/programs';
import {
	addDecision,
	checkToday,
	contextOf,
	findingKey,
	judge,
	placeInDay,
	revise,
	SESSIONS_A_DAY,
	toWarning,
	type EditAt,
	type MoveDeps,
	type MoveWarning,
	type PlannedEdit
} from './edits';
import { programmingInputFor } from './alternatives';
import { sessionTreeRows, toStoredSessions, type StoredSession } from './mapping';
import type { RevisedVersion } from './revise';
import { MAX_VERSION, resolveRefs } from './store';
import {
	ProgramConflictError,
	parseWith,
	resolveDeps,
	TrainingInputError
} from '../training/shared';

/** The version an add made, the session's lineage, its built title and the week's new warnings. */
export interface AddedSession extends RevisedVersion {
	lineage: string;
	title: string;
	warnings: MoveWarning[];
}

/**
 * A built session as the week's rules read it: under its lineage, with placeholder ids (judge reads
 * lineages and the plan's own fields, and no row is read back here).
 */
function storedOf(session: SessionPlan, lineage: string): StoredSession {
	const node = () => ({ id: crypto.randomUUID(), lineage: crypto.randomUUID() });
	const common = { id: crypto.randomUUID(), lineage, status: 'planned' as const, movedFrom: null };
	if (session.kind === 'strength') {
		return {
			...session,
			...common,
			exercises: session.exercises.map((e) => ({ ...e, ...node() }))
		};
	}
	return { ...session, ...common };
}

/**
 * The add as a planned edit, judged on the version it was made on: the session as built, its
 * place in its day, the day's renumbering, its decision and the warnings it brings. The session is
 * built from the owner's profile (deps.db), and no row is written. Throws a ProgramConflictError
 * when `at.version` is not the current version, and a TrainingInputError at the field a refusal
 * names.
 */
export async function addApplier(
	ownerId: string,
	input: unknown,
	at: EditAt,
	deps: MoveDeps = {}
): Promise<PlannedEdit & { warnings: MoveWarning[]; lineage: string; session: SessionPlan }> {
	const req = parseWith(addSessionSchema, input);
	const today = checkToday(at.today);
	const { db, source } = resolveDeps(deps);
	const repo = createProgramsRepository(db);
	const numbered = Number.isInteger(at.version) && at.version >= 1 && at.version <= MAX_VERSION;
	const found = numbered ? await repo.currentProgram(ownerId, at.version) : null;
	if (!found || found.version.id !== found.program.currentVersionId) {
		throw new ProgramConflictError();
	}
	const { version } = found;

	if (req.date < today) throw new TrainingInputError({ date: 'That day has passed' });
	const outline = await repo.versionOutline(version.id);
	const blockOf = new Map(outline.blocks.map((block) => [block.id, block]));
	const week = outline.weeks.find((w) => w.startsOn <= req.date && req.date <= w.endsOn);
	const block = week && blockOf.get(week.blockId);
	const planned =
		week &&
		block &&
		!block.outline &&
		!(week.kind === BRIDGE_WEEK_KIND && block.phase === BRIDGE_PHASE) &&
		req.date >= version.firstPlannedDay;
	if (!week || !planned) throw new TrainingInputError({ date: 'Pick a day in your program' });

	const sessions = [...toStoredSessions(await repo.weekSessions([week.id])).values()];
	const day = sessions.filter((s) => s.date === req.date);
	if (day.length >= SESSIONS_A_DAY) {
		throw new TrainingInputError({ date: 'That day already has four sessions' });
	}

	const target = { versionId: version.id, week };
	const context = await contextOf(ownerId, target, today, deps);
	const plan: WeekPlan = {
		kind: week.kind,
		startsOn: week.startsOn,
		endsOn: week.endsOn,
		targets: week.targets as unknown as WeekTargets,
		sessions
	};
	const programming = await programmingInputFor(ownerId, { db });
	let built: SessionPlan;
	try {
		built = buildAddedSession(req, plan, programming);
	} catch (err) {
		if (err instanceof AddRefusal) throw new TrainingInputError({ [err.field]: err.message });
		throw err;
	}

	const lineage = crypto.randomUUID();
	const place = placeInDay(day, req.timeOfDay ?? null);
	const session: SessionPlan = { ...built, orderInDay: place + 1 };
	// The day's sessions before the new one keep their order, those after it move on by one.
	const orderOf = new Map(day.map((s, n) => [s.lineage, n < place ? n + 1 : n + 2]));
	const changes: Record<string, SessionChange> = {};
	for (const s of day) {
		const orderInDay = orderOf.get(s.lineage)!;
		if (s.orderInDay !== orderInDay) changes[s.lineage] = { orderInDay };
	}
	const after = [
		...sessions.map((s) => ({ ...s, orderInDay: orderOf.get(s.lineage) ?? s.orderInDay })),
		storedOf(session, lineage)
	];
	const had = new Set(judge(target, sessions, today, context).map(findingKey));
	const warnings = judge(target, after, today, context)
		.filter((f) => !had.has(findingKey(f)))
		.map(toWarning);

	const refs = (session.kind === 'strength' ? session.exercises : []).map(
		(e, x): [string, ExerciseRef] => [`exercises.${x}.exercise`, e.exercise]
	);
	const exerciseId = await resolveRefs(ownerId, refs, { db });
	const intent = req.intent ?? DEFAULT_INTENT[req.kind];
	return {
		weekLineages: [week.lineageId],
		changes: { sessions: changes },
		added: [
			{
				weekLineage: week.lineageId,
				rows: (weekId) => sessionTreeRows(session, { weekId, lineageId: lineage, exerciseId })
			}
		],
		decision: addDecision(session, intent, req.reason, warnings, source, lineage),
		warnings,
		lineage,
		session
	};
}

/**
 * Add a session to a planned week as the next version, with its decision and the week's new
 * warnings (returned too, and never blocking). A stale version is a ProgramConflictError.
 */
export async function addSession(
	ownerId: string,
	input: unknown,
	at: EditAt,
	deps: MoveDeps = {}
): Promise<AddedSession> {
	const { warnings, lineage, session, ...edit } = await addApplier(ownerId, input, at, deps);
	return {
		...(await revise(ownerId, edit, at, deps)),
		lineage,
		title: session.title,
		warnings
	};
}
