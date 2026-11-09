/**
 * Rolling fatigue by body system (M7's load model in the periodisation engine ADR): planned and
 * logged sessions become one daily load per system, a residual that decays with each system's
 * half-life, M1's acute:chronic ratio over the same series, and a level of fresh, elevated or
 * overloaded, so Train, the coach and the weekly review judge a week on what was actually done
 * and what is still ahead.
 *
 * - Logged sessions replace planned ones up to today. A planned session logged against (its
 *   lineage is a workout's plannedLineage) counts once, as logged; a skipped one never counts;
 *   one dated before today and never logged counts 0 and is named missed.
 * - Logged totals are M6's: a day's total is its dailyLoads load for the same workouts, and a
 *   session M6 calls 'load unknown' is counted and named, never 0.
 * - A planned session with no target RPE is estimated (load/systems.ts): its own series, never
 *   in a logged total. Like any planned load it enters the residual and the ratio, which project
 *   the plan ahead.
 * - rules/fatigue.ts holds every threshold and says why.
 *
 * Pure and date-only: the same output in any process time zone. Server-only, like all of
 * domain/programming.
 */
import { addDays, daysBetween, mondayOf } from '../../calendar.ts';
import type { IsoDate } from '../../calendar.ts';
import { acuteChronicRatio } from '../../load.ts';
import type { PlanStatus } from '../../training/vocabulary.ts';
import { SYSTEM_LABEL, SYSTEMS } from '../evaluate/types.ts';
import type { LoadSystem } from '../evaluate/types.ts';
import { catalogueTraits } from '../interference.ts';
import type { TraitsOf } from '../interference.ts';
import { FATIGUE_LEVELS, HALF_LIVES, HISTORY, RATIO, RESIDUAL } from '../rules/fatigue.ts';
import type { FatigueLevel } from '../rules/fatigue.ts';
import { fromPlanned, sumByDay, systemLoads } from './systems.ts';
import type { LoadSession, PlannedSession } from './systems.ts';

/** A planned session, with the lineage and status a stored one carries. */
export type ModelPlanned = PlannedSession & { lineage?: string; status?: PlanStatus };

/** A logged session (from-facts.ts's fromLogged), with the planned session it was logged against. */
export type ModelLogged = LoadSession & { source: 'logged'; plannedLineage?: string | null };

/** The thresholds a level is judged on: rules/fatigue.ts's by default. */
export interface LevelRules {
	ratio: Pick<typeof RATIO, 'elevated' | 'overloaded' | 'needsResidual'>;
	residual: Pick<typeof RESIDUAL, 'elevated' | 'overloaded'>;
}

export interface LoadModelInput {
	planned: readonly ModelPlanned[];
	logged: readonly ModelLogged[];
	/** The days modelled, both included: the residual starts at 0 on `from`. */
	from: IsoDate;
	to: IsoDate;
	/** Planned sessions before today count only when logged. */
	today: IsoDate;
	level?: LevelRules;
	traitsOf?: TraitsOf;
}

/** One system on one day. Loads in AU (minutes × RPE). */
export interface SystemDay {
	logged: number;
	/** Planned at a target RPE. */
	planned: number;
	/** Planned with no target RPE, at load/systems.ts's DEFAULT_RPE. */
	estimated: number;
	/** The fatigue left at the end of the day: the day's load plus what earlier days left. */
	residual: number;
	/** Its typical hard session (rules/fatigue.ts's HISTORY); null when there is none. */
	typical: number | null;
	/** M1's acuteChronicRatio over the system's series to this day; null under 28 days. */
	ratio: number | null;
	/**
	 * The level at the end of the day, its own sessions included: a steady week's hardest days end
	 * elevated (the legs at about 1.5 ×). Whether a system is fresh for a day is readinessOn's.
	 */
	level: FatigueLevel;
}

/** One day of the model. */
export interface FatigueDay {
	date: IsoDate;
	/** What counted: logged, planned, both, or only planned sessions missed; null for a rest day. */
	source: 'planned' | 'logged' | 'mixed' | 'missed' | null;
	/** The known logged load: M6's dailyLoads load (0 with none; null when all are unknown). */
	total: number | null;
	/** The estimated planned load, its own series. */
	estimated: number;
	/** Logged sessions whose load is unknown (M6's rule), named. */
	unknown: string[];
	/** Planned sessions dated before today and never logged: they count 0. */
	missed: string[];
	systems: Readonly<Record<LoadSystem, SystemDay>>;
}

export interface Readiness {
	date: IsoDate;
	system: LoadSystem;
	level: FatigueLevel;
	/** The fatigue carried into the day, before its own sessions. */
	residual: number;
	typical: number | null;
	/** The ratio at the end of the day before. */
	ratio: number | null;
	reasons: string[];
}

const DEFAULT_LEVELS: LevelRules = { ratio: RATIO, residual: RESIDUAL };

const worse = (a: FatigueLevel, b: FatigueLevel) =>
	FATIGUE_LEVELS.indexOf(a) >= FATIGUE_LEVELS.indexOf(b) ? a : b;

const decay = (system: LoadSystem, days: number) => 2 ** (-days / HALF_LIVES[system].days);

const round = (n: number) => Math.round(n);

/** A level, and why, from a residual, its typical hard session and the ratio. */
function judge(
	system: LoadSystem,
	residual: number,
	typical: number | null,
	ratio: number | null,
	rules: LevelRules
): { level: FatigueLevel; reasons: string[] } {
	const name = SYSTEM_LABEL[system];
	if (typical === null) {
		return {
			level: 'fresh',
			reasons: [`${name} has no typical hard session to judge its fatigue against yet.`]
		};
	}
	const reasons: string[] = [];
	const times = residual / typical;
	let level: FatigueLevel = 'fresh';
	if (times > rules.residual.overloaded) level = 'overloaded';
	else if (times > rules.residual.elevated) level = 'elevated';
	reasons.push(
		`${name} carries ${times.toFixed(1)} × its typical hard session (${round(residual)} of ${round(typical)} AU).`
	);
	if (ratio !== null && times >= rules.ratio.needsResidual && ratio >= rules.ratio.elevated) {
		const sharp = ratio >= rules.ratio.overloaded;
		const raised = sharp
			? FATIGUE_LEVELS[Math.min(FATIGUE_LEVELS.indexOf(level) + 1, FATIGUE_LEVELS.length - 1)]!
			: worse(level, 'elevated');
		reasons.push(
			`Its load is rising ${sharp ? 'sharply' : 'fast'}: an acute:chronic ratio of ${ratio.toFixed(2)}, against ${sharp ? rules.ratio.overloaded : rules.ratio.elevated}.`
		);
		level = raised;
	}
	return { level, reasons };
}

const median = (values: readonly number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

type Counted = { date: IsoDate; loads: Readonly<Record<LoadSystem, number>> };

/** The median, over the weeks, of the session that loads `system` most each week; null with none. */
function typicalOf(sessions: readonly Counted[], system: LoadSystem): number | null {
	const hardest = new Map<IsoDate, number>();
	for (const { date, loads } of sessions) {
		const week = mondayOf(date);
		if (loads[system] > (hardest.get(week) ?? 0)) hardest.set(week, loads[system]);
	}
	return hardest.size ? median([...hardest.values()]) : null;
}

const zeros = () => Object.fromEntries(SYSTEMS.map((s) => [s, 0])) as Record<LoadSystem, number>;

/** Each day from `from` to `to`, oldest first. */
export function loadModel(input: LoadModelInput): FatigueDay[] {
	const { from, to, today, traitsOf = catalogueTraits } = input;
	if (to < from) throw new RangeError(`${to} is before ${from}`);
	const rules = input.level ?? DEFAULT_LEVELS;
	const inRange = (date: IsoDate) => date >= from && date <= to;

	const logged = input.logged.filter((s) => inRange(s.date));
	const done = new Set(logged.flatMap((s) => (s.plannedLineage ? [s.plannedLineage] : [])));
	const plan = input.planned.filter((s) => s.status !== 'skipped');
	const ahead = plan.filter((s) => !(s.lineage !== undefined && done.has(s.lineage)));
	const counted = ahead.filter((s) => s.date >= today && inRange(s.date));
	const missed = ahead.filter((s) => s.date < today && inRange(s.date));

	const plannedLoads = counted.map((s) => ({
		date: s.date,
		...systemLoads(fromPlanned(s, traitsOf))
	}));
	const planReference = plan.flatMap((s) => {
		const { loads } = systemLoads(fromPlanned(s, traitsOf));
		return loads ? [{ date: s.date, loads }] : [];
	});
	const loggedLoads = logged.map((s) => ({ session: s, ...systemLoads(s) }));
	// Logged history only: projected days are not training done.
	const firstLogged = loggedLoads.flatMap((l) => (l.loads ? [l.session.date] : [])).sort()[0];
	const totals = new Map(sumByDay(logged).map((day) => [day.date, day]));

	const days: FatigueDay[] = [];
	const series = Object.fromEntries(SYSTEMS.map((s) => [s, [] as number[]])) as Record<
		LoadSystem,
		number[]
	>;
	let start: IsoDate | null = null;
	let previous: FatigueDay | null = null;
	for (let date = from; date <= to; date = addDays(date, 1)) {
		const own = { logged: zeros(), planned: zeros(), estimated: zeros() };
		const theirs = loggedLoads.filter((l) => l.session.date === date);
		for (const { loads } of theirs) {
			if (loads) for (const s of SYSTEMS) own.logged[s] += loads[s];
		}
		let estimated = 0;
		const planned = plannedLoads.filter((p) => p.date === date);
		for (const { loads, status, basis } of planned) {
			if (!loads) continue;
			const into = status === 'estimated' ? own.estimated : own.planned;
			for (const s of SYSTEMS) into[s] += loads[s];
			if (status === 'estimated') estimated += basis ?? 0;
		}
		const load = (s: LoadSystem) => own.logged[s] + own.planned[s] + own.estimated[s];
		if (start === null && SYSTEMS.some((s) => load(s) > 0)) start = date;
		// A day ahead is judged against the logs up to today.
		const asOf = date < today ? date : today;
		const history = firstLogged === undefined ? 0 : daysBetween(firstLogged, asOf) + 1;
		const reference =
			history >= HISTORY.days
				? loggedLoads.flatMap(({ session, loads }) =>
						loads && session.date < asOf && session.date >= addDays(asOf, -HISTORY.days)
							? [{ date: session.date, loads }]
							: []
					)
				: planReference;

		const systems = {} as Record<LoadSystem, SystemDay>;
		for (const s of SYSTEMS) {
			if (start !== null) series[s].push(load(s));
			const residual = (previous?.systems[s].residual ?? 0) * decay(s, 1) + load(s);
			const typical = typicalOf(reference, s);
			const ratio = acuteChronicRatio(series[s], RATIO.acuteDays, RATIO.chronicDays)?.ratio ?? null;
			const { level } = judge(s, residual, typical, ratio, rules);
			systems[s] = {
				logged: own.logged[s],
				planned: own.planned[s],
				estimated: own.estimated[s],
				residual,
				typical,
				ratio,
				level
			};
		}
		const missedHere = missed.filter((m) => m.date === date).map((m) => m.title);
		const source =
			theirs.length && planned.length
				? 'mixed'
				: theirs.length
					? 'logged'
					: planned.length
						? 'planned'
						: missedHere.length
							? 'missed'
							: null;
		const known = totals.get(date);
		const day: FatigueDay = {
			date,
			source,
			total: known ? known.total : 0,
			estimated,
			unknown: theirs.filter((l) => l.status === 'unknown').map((l) => l.session.title),
			missed: missedHere,
			systems
		};
		days.push(day);
		previous = day;
	}
	return days;
}

/**
 * How ready `system` is on `date`, before the day's own sessions: the residual it carries in from
 * the day before, judged against the day's typical hard session and the day before's ratio.
 */
export function readinessOn(
	days: readonly FatigueDay[],
	date: IsoDate,
	system: LoadSystem,
	rules: LevelRules = DEFAULT_LEVELS
): Readiness {
	const i = days.findIndex((d) => d.date === date);
	if (i < 0) throw new RangeError(`${date} is not a day of the model`);
	const before = i > 0 ? days[i - 1]!.systems[system] : null;
	const residual = (before?.residual ?? 0) * decay(system, 1);
	const { typical } = days[i]!.systems[system];
	const ratio = before?.ratio ?? null;
	return {
		date,
		system,
		residual,
		typical,
		ratio,
		...judge(system, residual, typical, ratio, rules)
	};
}

/** The days in `window` (both included) on which `system` is overloaded, oldest first. */
export function overloadedDays(
	days: readonly FatigueDay[],
	system: LoadSystem,
	window: { from: IsoDate; to: IsoDate }
): IsoDate[] {
	return days
		.filter((d) => d.date >= window.from && d.date <= window.to)
		.filter((d) => d.systems[system].level === 'overloaded')
		.map((d) => d.date);
}

export interface WeekSummary {
	from: IsoDate;
	to: IsoDate;
	/** Each system's worst level, its load by series, and the days it was elevated or overloaded. */
	systems: Record<
		LoadSystem,
		{
			worst: FatigueLevel;
			logged: number;
			planned: number;
			estimated: number;
			elevated: IsoDate[];
			overloaded: IsoDate[];
		}
	>;
	/** The known logged load; null when there were logged sessions and none had a known load. */
	total: number | null;
	estimated: number;
	unknown: string[];
	missed: string[];
}

/** The days given (a week, as a rule) in one summary. */
export function weekSummary(days: readonly FatigueDay[]): WeekSummary {
	if (days.length === 0) throw new RangeError('A summary needs at least one day');
	const systems = {} as WeekSummary['systems'];
	for (const s of SYSTEMS) {
		const of = days.map((d) => d.systems[s]);
		const sum = (key: 'logged' | 'planned' | 'estimated') => of.reduce((t, x) => t + x[key], 0);
		const on = (level: FatigueLevel) =>
			days.filter((d) => d.systems[s].level === level).map((d) => d.date);
		systems[s] = {
			worst: of.reduce<FatigueLevel>((w, x) => worse(w, x.level), 'fresh'),
			logged: sum('logged'),
			planned: sum('planned'),
			estimated: sum('estimated'),
			elevated: on('elevated'),
			overloaded: on('overloaded')
		};
	}
	// M6's rule: null when logged sessions had no known load; a rest day's 0 is not a known load.
	const known = days.some(
		(d) => d.total !== null && (d.source === 'logged' || d.source === 'mixed')
	);
	const allUnknown = !known && days.some((d) => d.total === null);
	return {
		from: days[0]!.date,
		to: days.at(-1)!.date,
		systems,
		total: allUnknown ? null : days.reduce((t, d) => t + (d.total ?? 0), 0),
		estimated: days.reduce((t, d) => t + d.estimated, 0),
		unknown: days.flatMap((d) => d.unknown),
		missed: days.flatMap((d) => d.missed)
	};
}
