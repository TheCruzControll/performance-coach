/**
 * What the server knows about the owner's day when a coach turn starts (M5, the turn context):
 * their local date, time and zone, the active program version and its current week through M3's
 * program reads, and a matcher over their exercise library. The agent turns these into the turn's
 * context message (agent/prompt/context.ts); nothing here comes from the model.
 *
 * The week block (WeekBlock) and the periodisation road are read after those, in one read-only
 * transaction on the pool (readWeekBlock). Each statement is cancelled by Postgres at
 * BLOCK_TIMEOUT_MS, and a failure leaves the block and the road out and records an app_errors row:
 * the turn carries on without them. No JS timer races a query, and the reads never share the
 * turn's client.
 *
 * Queries run one at a time (docs/architecture.md), so the turn may hand this a transaction.
 */
import type { IsoDate } from '../../../domain/calendar';
import { localDay } from '../../../domain/dates';
import { CATALOGUE } from '../../../domain/exercises';
import { matchExercise, type MatchableExercise } from '../../../domain/exercises/match';
import type { Phase, WeekKind } from '../../../domain/training/vocabulary';
import { getDb } from '../../db';
import { createProgramsRepository } from '../../db/repositories/programs';
import type { Executor } from '../../db/types';
import { listCustomExercises } from '../exercises';
import { recordServerError } from '../errors';
import { getWeekFindings, type WeekAt } from '../periodisation/evaluate';
import {
	evaluationContext,
	inReadOnly,
	sqlState,
	timeoutSql,
	type ContextAt
} from '../periodisation/context';
import { getRoadView, type RoadView } from '../periodisation/road-view';
import { getAthleteProfile } from '../profile';
import { getCurrentProgram, getTrainingWeek } from '../programs';
import { resolveDeps, type CoachDeps } from './shared';

export interface PlannedTitle {
	date: IsoDate;
	title: string;
}

/**
 * The block the week falls in (m7 road): its phase and the week's kind, the headlines of its
 * findings (at most MAX_SHOWN), and the next deload and taper from this week on, when any.
 */
export interface WeekBlock {
	phase: Phase;
	kind: WeekKind;
	findings: string[];
	nextDeload?: IsoDate;
	nextTaper?: IsoDate;
}

/** The most a week block's statements may run before Postgres cancels them (SQLSTATE 57014). */
export const BLOCK_TIMEOUT_MS = 250;
/** The block's whole budget: once spent (a slow pool or road read), the findings are skipped. */
export const BLOCK_BUDGET_MS = 1_000;

/** The reads a week block makes, each on the executor it is handed. A test swaps one to fail or stall. */
export interface WeekBlockReads {
	road(db: Executor, ownerId: string, today: IsoDate): Promise<RoadView | null>;
	/** The headlines of the week's findings. `errors` is where the context's own failures go. */
	evaluation(db: Executor, ownerId: string, at: WeekAt, errors: Executor): Promise<string[]>;
}

/** A context read that evaluationContext already recorded: the block stops without recording again. */
class ContextUnavailable extends Error {}

const liveReads: WeekBlockReads = {
	road: (db, ownerId, today) => getRoadView(ownerId, today, { db }),
	evaluation: async (db, ownerId, at, errors) => {
		const deps = { db, errorsDb: errors, statementTimeoutMs: BLOCK_TIMEOUT_MS };
		// A context that failed is null here: the week would be judged by checkWeek alone, so the
		// block stops instead.
		const contexts = {
			get: async (ctx: ContextAt) => {
				const found = await evaluationContext(ownerId, ctx, deps);
				if (!found) throw new ContextUnavailable('the evaluation context is unavailable');
				return found;
			}
		};
		const { headlines } = await getWeekFindings(ownerId, at, { ...deps, contexts });
		return headlines;
	}
};

/** The block a road and a week's finding headlines make: the road's current week, or none. */
function blockOf(road: RoadView, headlines: string[]): WeekBlock | null {
	const current = road.current;
	const block = current ? road.blocks[current.block] : undefined;
	const week = block && current?.week != null ? block.weeks[current.week] : undefined;
	if (!block || !week) return null;
	const deload = road.markers.find((marker) => marker.kind === 'deload')?.week;
	const taper = road.markers.find((marker) => marker.kind === 'taper')?.week;
	return {
		phase: block.phase,
		kind: week.kind,
		findings: headlines,
		...(deload && { nextDeload: deload }),
		...(taper && { nextTaper: taper })
	};
}

/**
 * The road and the week's block, read on the pool in one read-only transaction: the road, then the
 * week's findings, each statement cancelled by Postgres at BLOCK_TIMEOUT_MS. A failure gives
 * neither, and records it (part 'week-block') unless the context already recorded it.
 */
async function readWeekBlock(
	ownerId: string,
	at: { today: IsoDate; version: number; startsOn: IsoDate | null },
	errors: Executor,
	reads: WeekBlockReads
): Promise<{ road: RoadView | null; block: WeekBlock | null }> {
	try {
		const started = Date.now();
		return await inReadOnly(getDb(), timeoutSql(BLOCK_TIMEOUT_MS), async (tx) => {
			const road = await reads.road(tx, ownerId, at.today);
			// A slow pool or road read never stretches the turn: past BLOCK_BUDGET_MS the week's
			// findings are skipped and the turn goes on without the block.
			const headlines =
				at.startsOn === null || Date.now() - started > BLOCK_BUDGET_MS
					? null
					: await reads.evaluation(
							tx,
							ownerId,
							{ version: at.version, weekStartsOn: at.startsOn, today: at.today },
							errors
						);
			return { road, block: road && headlines ? blockOf(road, headlines) : null };
		});
	} catch (error) {
		if (!(error instanceof ContextUnavailable)) {
			const code = sqlState(error);
			await recordServerError(
				{
					error,
					kind: 'load',
					status: 500,
					context: { part: 'week-block', ...(code && { code }) }
				},
				{ db: errors }
			);
		}
		return { road: null, block: null };
	}
}

export interface ProgramFacts {
	/** The active version: what a segment starts on and its week summary compares with. */
	versionId: string;
	versionNumber: number;
	/** The planned week today falls in, skipped sessions left out; null once the weeks are over. */
	week: { number: number; of: number; startsOn: IsoDate; sessions: PlannedTitle[] } | null;
	todaysSessions: { title: string }[];
	/** The week's block; null when the week is over or its block could not be read. */
	block: WeekBlock | null;
}

export interface TurnDayFacts {
	today: IsoDate;
	/** HH:MM in the owner's zone. */
	localTime: string;
	timeZone: string;
	/** Null when no program is active. */
	program: ProgramFacts | null;
	/** The periodisation road, for the coaching memory's goal modes; null when it could not be read. */
	road: RoadView | null;
	/** M3's matchExercise over the owner's library (catalogue and custom exercises). */
	matchExercise: (text: string) => string | null;
}

function localTime(instant: Date, timeZone: string): string {
	return new Intl.DateTimeFormat('en-GB', {
		timeZone,
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23'
	}).format(instant);
}

export async function loadTurnFacts(
	ownerId: string,
	deps: CoachDeps = {},
	reads: WeekBlockReads = liveReads
): Promise<TurnDayFacts> {
	const { db, now } = resolveDeps(deps);
	const at = now();
	const { timeZone } = await getAthleteProfile(ownerId, { db });
	const today = localDay(at, timeZone);

	let program: ProgramFacts | null = null;
	let road: RoadView | null = null;
	const active = await createProgramsRepository(db).currentProgram(ownerId);
	const current = active && (await getCurrentProgram(ownerId, today, { db }));
	if (active && current) {
		const week = current.blockComplete
			? null
			: await getTrainingWeek(ownerId, { date: today }, {}, { db });
		// A skipped session is no longer planned for the owner.
		const sessions = week?.planned
			? week.days
					.flatMap((day) => day.sessions)
					.filter((session) => session.status !== 'skipped')
					.map(({ date, title }) => ({ date, title }))
			: [];
		const planned =
			week?.planned === true
				? { number: week.number, of: current.plannedWeeks, startsOn: week.startsOn, sessions }
				: null;
		// Last, once the program's own reads are in: the block never delays or breaks them.
		const bounded = await readWeekBlock(
			ownerId,
			{ today, version: current.version.number, startsOn: planned?.startsOn ?? null },
			db,
			reads
		);
		road = bounded.road;
		program = {
			versionId: active.version.id,
			versionNumber: current.version.number,
			week: planned,
			todaysSessions: sessions.filter((s) => s.date === today).map(({ title }) => ({ title })),
			block: bounded.block
		};
	}

	const custom = await listCustomExercises(ownerId, { db });
	const library: MatchableExercise[] = [
		...CATALOGUE,
		...custom.map(({ id, name, aliases }) => ({ key: `custom:${id}`, name, aliases }))
	];
	return {
		today,
		localTime: localTime(at, timeZone),
		timeZone,
		program,
		road,
		matchExercise: (text) => matchExercise(text, library)
	};
}
