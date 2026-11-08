/**
 * The facts every M6 dashboard and review reads (PRD §10), loaded once per request: one loader
 * per request and owner, over the owner's dates `from`–`to` in their time zone.
 * - Each kind is read at most once, when first asked for, and kept: a service may ask for sets
 *   twice and the database sees one read.
 * - One query at a time: every read waits for the one before it, even when callers ask for
 *   several kinds at once, so the loader may run on a transaction.
 * - A range longer than MAX_RANGE_DAYS ('all') is read in consecutive windows of at most that
 *   many days, so no query reads a wider range than its plan was gated for.
 * - Rows are kept by the owner's calendar day they fell on, so a Sunday-night set stays in its
 *   week whatever its UTC date. Only completed, undeleted workouts count (queries/analytics.ts).
 * - Each read is timed as 'analytics' in Server-Timing.
 * - Baselines and race results come through M2's profile services.
 */
import type { AdherenceFacts } from '../../../domain/analytics/adherence';
import type { PlannedLines } from '../../../domain/analytics/prescribed';
import type { RunFact } from '../../../domain/analytics/running';
import type { RecoveryEntry } from '../../../domain/analytics/workload';
import { addDays, type IsoDate } from '../../../domain/calendar';
import { localDay } from '../../../domain/dates';
import type { RaceResult, StrengthBaseline } from '../../../domain/profile/types';
import {
	createAnalyticsRepository,
	type AnalyticsRepository,
	type SessionFact,
	type SetFact
} from '../../db/repositories/analytics';
import type { InstantRange } from '../../db/queries/history';
import type { Executor } from '../../db/types';
import { measure } from '../../observability/timing';
import { baselineHistory, getSpecifics } from '../profile/index';
import { MAX_RANGE_DAYS } from '../training/history';

export interface FactsRange {
	/** The owner's first and last day, both included. */
	from: IsoDate;
	to: IsoDate;
	timeZone: string;
}

/** A counted workout, on the owner's calendar day it started. */
export type DatedSession = SessionFact & { date: IsoDate };

interface Window {
	from: IsoDate;
	to: IsoDate;
}

/** `from`–`to` as consecutive windows of at most MAX_RANGE_DAYS days, oldest first. */
export function windowsOf(from: IsoDate, to: IsoDate): Window[] {
	const windows: Window[] = [];
	for (let start = from; start <= to; start = addDays(start, MAX_RANGE_DAYS)) {
		const end = addDays(start, MAX_RANGE_DAYS - 1);
		windows.push({ from: start, to: end < to ? end : to });
	}
	return windows;
}

/** UTC offsets run from −12:00 to +14:00 (as training/history.ts reads a range). */
const ZONE_SLACK_MS = 14 * 3_600_000;
const instantsOf = ({ from, to }: Window): InstantRange => ({
	start: new Date(Date.parse(`${from}T00:00:00Z`) - ZONE_SLACK_MS),
	end: new Date(Date.parse(`${addDays(to, 1)}T00:00:00Z`) + ZONE_SLACK_MS)
});

export interface FactsDeps {
	/** The reads, for a test to count; the analytics repository on `db` unless given. */
	repository?: AnalyticsRepository;
}

export function createFactsLoader(
	db: Executor,
	ownerId: string,
	{ from, to, timeZone }: FactsRange,
	{ repository = createAnalyticsRepository(db) }: FactsDeps = {}
) {
	if (to < from) throw new RangeError(`${to} is before ${from}`);
	const windows = windowsOf(from, to);
	const dayOf = (instant: Date) => localDay(instant, timeZone);
	const inside = (w: Window, day: IsoDate) => w.from <= day && day <= w.to;

	let last: Promise<unknown> = Promise.resolve();
	/** Run `read` after every read before it has settled, timed as 'analytics'. */
	function serial<T>(read: () => Promise<T>): Promise<T> {
		const next = last.then(() => measure('analytics', read));
		last = next.catch(() => undefined);
		return next;
	}
	const memo = new Map<string, Promise<unknown>>();
	function once<T>(kind: string, load: () => Promise<T>): Promise<T> {
		if (!memo.has(kind)) memo.set(kind, load());
		return memo.get(kind) as Promise<T>;
	}
	/** A kind read window by window, each window's rows kept apart. */
	function windowed<T>(kind: string, read: (w: Window, i: number) => Promise<T[]>) {
		return once(kind, async () => {
			const parts: T[][] = [];
			for (const [i, w] of windows.entries()) parts.push(await read(w, i));
			return parts;
		});
	}
	const flat = async <T>(parts: Promise<T[][]>) => (await parts).flat();

	const setParts = () =>
		windowed('sets', async (w) =>
			(await serial(() => repository.sets(ownerId, instantsOf(w)))).filter((set) =>
				inside(w, dayOf(set.performedAt))
			)
		);
	const sessionParts = () =>
		windowed('sessions', async (w): Promise<DatedSession[]> =>
			(await serial(() => repository.sessions(ownerId, instantsOf(w))))
				.map((session) => ({ ...session, date: dayOf(session.startedAt) }))
				.filter((session) => inside(w, session.date))
		);

	return {
		range: { from, to, timeZone },

		/** Counted sets, by the time they were performed. */
		sets: (): Promise<SetFact[]> => flat(setParts()),

		/** Counted workouts of every kind, by start. */
		sessions: (): Promise<DatedSession[]> => flat(sessionParts()),

		/** Counted runs with their totals and their segments in order. */
		runs: (): Promise<RunFact[]> =>
			flat(
				windowed('runs', async (_w, i) => {
					const runs = (await sessionParts())[i]!.filter((s) => s.run !== null);
					const ids = runs.map((s) => s.id);
					const segments = await serial(() => repository.segments(ownerId, ids));
					return runs.map((s) => ({
						workout: s.id,
						startedAt: s.startedAt,
						sessionType: s.sessionType,
						metres: s.run!.distanceMetres,
						seconds: s.run!.durationSeconds,
						avgHr: s.run!.avgHr,
						rpe: s.run!.rpe,
						segments: segments.get(s.id) ?? []
					}));
				})
			),

		/** The planned lines of each strength workout's planned session, by planned session id. */
		prescriptions: (): Promise<Map<string, PlannedLines[]>> =>
			once('prescriptionsAll', async () => {
				const parts = await windowed('prescriptions', async (_w, i) => {
					const ids = (await sessionParts())[i]!.flatMap((s) =>
						s.kind === 'strength' && s.plannedSessionId ? [s.plannedSessionId] : []
					);
					return [...(await serial(() => repository.prescriptions([...new Set(ids)])))];
				});
				return new Map(parts.flat());
			}),

		/** Planned sessions of every program in the range, completion by lineage, and the workouts. */
		planned: (): Promise<AdherenceFacts> =>
			once('plannedAll', async () => {
				const parts = await windowed('planned', async (w) => [
					await serial(() => repository.planned(ownerId, w.from, w.to))
				]);
				const workouts = await flat(sessionParts());
				return {
					planned: parts.flatMap(([part]) => part!.planned),
					completed: new Set(parts.flatMap(([part]) => [...part!.completed])),
					workouts
				};
			}),

		/** Recovery notes by date. */
		recovery: (): Promise<RecoveryEntry[]> =>
			flat(windowed('recovery', (w) => serial(() => repository.recovery(ownerId, w.from, w.to)))),

		/** The day of the owner's first counted workout, ever; null before any. */
		firstActivity: (): Promise<IsoDate | null> =>
			once('firstActivity', async () => {
				const at = await serial(() => repository.firstActivity(ownerId));
				return at && dayOf(at);
			}),

		/** Every strength baseline the profile has held, superseded ones included (M2). */
		baselines: (): Promise<StrengthBaseline[]> =>
			once('baselines', () => serial(() => baselineHistory(ownerId, { db }))),

		/** The race results on the running profile (M2). */
		races: (): Promise<RaceResult[]> =>
			once('races', async () => {
				const { running } = await serial(() => getSpecifics(ownerId, { db }));
				return running?.races ?? [];
			})
	};
}

export type FactsLoader = ReturnType<typeof createFactsLoader>;
