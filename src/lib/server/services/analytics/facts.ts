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
 * - Services that compose (the overview) share one loader through sharedFacts: each service asks
 *   for its own days, and the database still sees each kind read once per window.
 */
import type { AdherenceFacts } from '../../../domain/analytics/adherence';
import type { PlannedLines } from '../../../domain/analytics/prescribed';
import type { PlannedRun, RunFact } from '../../../domain/analytics/running';
import { addDays, type IsoDate } from '../../../domain/calendar';
import { localDay } from '../../../domain/dates';
import type { RaceResult, StrengthBaseline } from '../../../domain/profile/types';
import {
	createAnalyticsRepository,
	type AnalyticsRepository,
	type RecoveryFact,
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

/** Runs each read after every read before it has settled, timed as 'analytics'. */
export function createQueue() {
	let last: Promise<unknown> = Promise.resolve();
	return function serial<T>(read: () => Promise<T>): Promise<T> {
		const next = last.then(() => measure('analytics', read));
		last = next.catch(() => undefined);
		return next;
	};
}
export type Queue = ReturnType<typeof createQueue>;

export interface FactsDeps {
	/** The reads, for a test to count; the analytics repository on `db` unless given. */
	repository?: AnalyticsRepository;
	/** Loaders given one queue never read at the same time; a queue of its own unless given. */
	queue?: Queue;
}

export function createFactsLoader(
	db: Executor,
	ownerId: string,
	{ from, to, timeZone }: FactsRange,
	{ repository = createAnalyticsRepository(db), queue: serial = createQueue() }: FactsDeps = {}
) {
	if (to < from) throw new RangeError(`${to} is before ${from}`);
	const windows = windowsOf(from, to);
	const dayOf = (instant: Date) => localDay(instant, timeZone);
	const inside = (w: Window, day: IsoDate) => w.from <= day && day <= w.to;

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

	const plannedParts = () =>
		windowed('planned', async (w) => [
			await serial(() => repository.planned(ownerId, w.from, w.to))
		]);

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
				const parts = await plannedParts();
				const workouts = await flat(sessionParts());
				return {
					planned: parts.flatMap(([part]) => part!.planned),
					completed: new Set(parts.flatMap(([part]) => [...part!.completed])),
					workouts
				};
			}),

		/** The runs every program in the range plans, with their segments (read with `planned`). */
		plannedRuns: async (): Promise<PlannedRun[]> =>
			(await plannedParts()).flatMap(([part]) => part!.runs),

		/** Recovery notes by date. */
		recovery: (): Promise<RecoveryFact[]> =>
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

/** The facts of the owner's days `from`–`to`, both included: how a dashboard service reads. */
export type FactsSource = (from: IsoDate, to: IsoDate) => FactsLoader;

/** What a dashboard service reads its facts through. */
export interface DashboardDeps {
	/** The reads, for a test to count; the analytics repository on `db` unless given. */
	repository?: AnalyticsRepository;
	/** Shared facts (sharedFacts), as the overview passes them; a new loader per range unless given. */
	facts?: FactsSource;
}

/** `deps.facts`, or a new loader for each range asked for. */
export function factsSource(
	db: Executor,
	ownerId: string,
	timeZone: string,
	{ repository, facts }: DashboardDeps = {}
): FactsSource {
	return (
		facts ?? ((from, to) => createFactsLoader(db, ownerId, { from, to, timeZone }, { repository }))
	);
}

export interface SharedFactsDeps extends FactsDeps {
	/** Answers firstActivity, baselines and races, which no range changes; one on `range` unless given. */
	everyDay?: FactsLoader;
}

/**
 * One loader over `range` that several services read, each asking for its own days: a range
 * inside it is a filtered view of its rows, so each kind is read once per window whoever asks.
 * Days before `range` are read once more, by a loader of their own (memoised by its first and last
 * day), and days after it are refused (RangeError): `range` must reach the latest day any service
 * reads.
 * Every loader shares one queue, so no two reads ever run at once.
 */
export function sharedFacts(
	db: Executor,
	ownerId: string,
	range: FactsRange,
	{ everyDay, ...deps }: SharedFactsDeps = {}
): FactsSource {
	const options = { ...deps, queue: deps.queue ?? createQueue() };
	const main = createFactsLoader(db, ownerId, range, options);
	const global = everyDay ?? main;
	const before = new Map<string, FactsLoader>();
	const earlier = (from: IsoDate, last: IsoDate) => {
		const to = last < range.from ? last : addDays(range.from, -1);
		const key = `${from}/${to}`;
		if (!before.has(key))
			before.set(key, createFactsLoader(db, ownerId, { ...range, from, to }, options));
		return before.get(key)!;
	};
	return (from, to) => {
		if (to < from) throw new RangeError(`${to} is before ${from}`);
		if (to > range.to)
			throw new RangeError(`${to} is after the shared facts' last day, ${range.to}`);
		const sources = [
			...(from < range.from ? [earlier(from, to)] : []),
			...(to >= range.from ? [main] : [])
		];
		return factsView(sources, global, { from, to, timeZone: range.timeZone });
	};
}

/** The rows of `sources` that fall on `range`'s days, as a loader of that range would give them. */
function factsView(
	sources: readonly FactsLoader[],
	global: FactsLoader,
	range: FactsRange
): FactsLoader {
	const on = (day: IsoDate) => range.from <= day && day <= range.to;
	const at = (instant: Date) => on(localDay(instant, range.timeZone));
	async function rows<T>(read: (loader: FactsLoader) => Promise<T[]>, keep: (row: T) => boolean) {
		const kept: T[] = [];
		for (const source of sources) kept.push(...(await read(source)).filter(keep));
		return kept;
	}
	return {
		range,
		sets: () =>
			rows(
				(l) => l.sets(),
				(set) => at(set.performedAt)
			),
		sessions: () =>
			rows(
				(l) => l.sessions(),
				(session) => on(session.date)
			),
		runs: () =>
			rows(
				(l) => l.runs(),
				(run) => at(run.startedAt)
			),
		// Looked up by planned session id, so another day's entries change nothing.
		prescriptions: async () => {
			const all = new Map<string, PlannedLines[]>();
			for (const source of sources)
				for (const [id, lines] of await source.prescriptions()) all.set(id, lines);
			return all;
		},
		planned: async () => {
			const parts: AdherenceFacts[] = [];
			for (const source of sources) parts.push(await source.planned());
			return {
				planned: parts.flatMap((part) => part.planned.filter((session) => on(session.date))),
				completed: new Set(parts.flatMap((part) => [...part.completed])),
				workouts: parts.flatMap((part) => part.workouts.filter((workout) => on(workout.date)))
			};
		},
		plannedRuns: () =>
			rows(
				(l) => l.plannedRuns(),
				(run) => on(run.date)
			),
		recovery: () =>
			rows(
				(l) => l.recovery(),
				(note) => on(note.notedOn)
			),
		firstActivity: () => global.firstActivity(),
		baselines: () => global.baselines(),
		races: () => global.races()
	};
}
