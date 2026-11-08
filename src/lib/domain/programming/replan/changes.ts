/**
 * What a new plan changes (M7 re-plans, PRD §5, §14): the difference between two plans' future
 * weeks, week by week, in the owner's units, and digests of the future's shape. Every re-plan
 * preview, proposal row and coach answer describes a re-plan through describeChanges, and the
 * re-plan tests prove which weeks kept their shape through weekShapes.
 *
 * - Only the future counts: a week that ends before `from` never appears, nor does a session
 *   dated before it.
 * - Plans carry no lineage, so sessions are matched within a week by kind, type and title: the
 *   same day first, then in date order. A match on another day or time of day is a move; one with
 *   other content is a change; the rest are added or removed.
 * - The impact is M3's metrics (plannedHardSets, sessionLoadOf) on each week, after minus before,
 *   as M5's proposal impact counts it; the words go through M3's describe helpers.
 * - shapeDigest and weekShapes hash the structure (block phases, week kinds and dates, and the
 *   sessions' days, types and titles) but never loads, so a refreshed load keeps the shape.
 *
 * Pure: no clock, no I/O. The same plans give the same words and digests, byte for byte.
 */
import { addDays, mondayOf, weekdayOf, type IsoDate } from '../../calendar.ts';
import { TIME_OF_DAY_LABEL, WEEKDAY_INFO } from '../../profile/catalog.ts';
import type { ProfileDistanceUnit } from '../../profile/types.ts';
import { describePrescription, describeSegment } from '../../training/describe.ts';
import {
	exerciseRefKey,
	plannedHardSets,
	sessionLoadOf,
	type ExerciseMuscles
} from '../../training/metrics.ts';
import type { BlockPlan, ProgramPlan, SessionPlan, WeekPlan } from '../../training/types.ts';
import {
	MUSCLE_GROUP_LABEL,
	MUSCLE_GROUPS,
	OTHER_SESSION_KIND_LABEL,
	PHASE_LABEL,
	WEEK_KIND_LABEL,
	type MuscleGroup
} from '../../training/vocabulary.ts';
import { cleanFloat, fromMetres, type WeightUnit } from '../../units.ts';
import { canonicalJson, compareText, fnv1a64 } from '../random.ts';

/** describeChanges' summary holds at most this many lines, each at most SUMMARY_LINE_MAX long. */
export const SUMMARY_LINES_MAX = 3;
/** M5's coach_proposals.summary limit, which the first line may fill. */
export const SUMMARY_LINE_MAX = 200;

export interface ChangeUnits {
	unit: WeightUnit;
	distanceUnit: ProfileDistanceUnit;
}

/** An exercise either plan names: its muscles for the hard-set count, and its name. */
export interface ChangeExercise extends ExerciseMuscles {
	name: string;
}

export interface ChangeOptions {
	units: ChangeUnits;
	/** The first day the new plan may differ on (a re-plan's Monday). */
	from: IsoDate;
	/** Every exercise in either plan, by exerciseRefKey; one missing throws a RangeError. */
	exercises: ReadonlyMap<string, ChangeExercise>;
}

/** What a row changes: a session, the block a week sits in, or the week's kind. */
export type ChangeKind = 'added' | 'removed' | 'moved' | 'changed' | 'block' | 'week';

export interface ChangeRow {
	kind: ChangeKind;
	/** The session's title, 'Lower A, Back squat', 'Block' or 'Week'. */
	label: string;
	/** Null for an added session. */
	before: string | null;
	/** Null for a removed session. */
	after: string | null;
	/** The session's day; null for a block or week row. */
	date: IsoDate | null;
	/** The row in words: 'Week of 16 Nov · Lower A Tue → Fri', 'Week of 16 Nov · Long run 22 → 18 km'. */
	line: string;
}

/** One week's change, after minus before; M5's WeekImpact has the same shape. */
export interface WeekImpact {
	weekStart: IsoDate;
	hardSets: Partial<Record<MuscleGroup, number>>;
	minutes: number;
	/** Session load in AU (M1's sessionLoad). */
	load: number;
	runMetres: number;
}

export interface WeekChange {
	/** The week's Monday. */
	weekStart: IsoDate;
	/** 'Week of 16 Nov'. */
	label: string;
	rows: ChangeRow[];
	/** Null when no measured number changes. */
	impact: WeekImpact | null;
}

export interface PlanChanges {
	/** Only weeks that change, oldest first. */
	weeks: WeekChange[];
	/** The weeks whose numbers change, oldest first. */
	impact: WeekImpact[];
	/** At most SUMMARY_LINES_MAX lines: the counts, the first row, the impact in all. */
	summaryLines: string[];
}

// ---- Words ----------------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayMonth = (date: IsoDate) =>
	`${Number(date.slice(8))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
const weekday = (date: IsoDate) => WEEKDAY_INFO[weekdayOf(date)].short;
const weekLabel = (monday: IsoDate) => `Week of ${dayMonth(monday)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** '+3', '−2.5', with a real minus sign. */
const signed = (value: number) => `${value < 0 ? '−' : '+'}${cleanFloat(Math.abs(value), 1)}`;
const distance = (metres: number, unit: ProfileDistanceUnit) =>
	metres < 1000 ? `${metres} m` : `${cleanFloat(fromMetres(metres, unit), 2)} ${unit}`;

/** 'Tue', or 'Tue evening' when the time of day is what tells the two apart. */
function when(s: SessionPlan, withTime: boolean): string {
	const time = s.timeOfDay && s.timeOfDay !== 'varies' ? TIME_OF_DAY_LABEL[s.timeOfDay] : null;
	return withTime && time ? `${weekday(s.date)} ${time.toLowerCase()}` : weekday(s.date);
}

/** 'Long run 22 → 18 km': two bare amounts in the same unit say it once. */
function arrow(before: string, after: string): string {
	const amount = /^([\d.]+) (\S+)$/;
	const [a, b] = [amount.exec(before), amount.exec(after)];
	return `${a && b && a[2] === b[2] ? a[1] : before} → ${after}`;
}

function rowLine(week: string, row: Omit<ChangeRow, 'line'>): string {
	const text =
		row.kind === 'added'
			? `${row.label} added on ${row.after}`
			: row.kind === 'removed'
				? `${row.label} removed from ${row.before}`
				: `${row.label} ${arrow(row.before ?? '', row.after ?? '')}`;
	return `${week} · ${text}`;
}

// ---- Sessions -------------------------------------------------------------------------------

const runMetres = (s: SessionPlan) =>
	s.kind === 'run'
		? s.segments.reduce((t, g) => t + (g.distanceMetres ?? 0) * (g.repeats ?? 1), 0)
		: 0;

/** The rows a matched pair changes besides its day: exercises, sets, a run's size, details. */
function contentRows(a: SessionPlan, b: SessionPlan, options: ChangeOptions) {
	const { unit, distanceUnit } = options.units;
	const rows: { label: string; before: string; after: string }[] = [];
	const add = (label: string, before: string, after: string) => {
		if (before !== after) rows.push({ label, before, after });
	};
	if (a.kind === 'strength' && b.kind === 'strength') {
		const name = (ref: (typeof a.exercises)[number]['exercise']) => {
			const found = options.exercises.get(exerciseRefKey(ref));
			if (!found) throw new RangeError(`No exercise '${exerciseRefKey(ref)}' in the options`);
			return found.name;
		};
		const names = (s: typeof a) => s.exercises.map((e) => name(e.exercise)).join(' · ');
		if (names(a) !== names(b)) add(a.title, names(a), names(b));
		else {
			const sets = (e: (typeof a.exercises)[number]) =>
				e.sets
					.map((set) => {
						const w = describePrescription(set, { unit });
						const load = w.load ?? w.basis;
						return load ? `${w.headline}, ${load}` : w.headline;
					})
					.join('; ');
			a.exercises.forEach((e, i) =>
				add(`${a.title}, ${name(e.exercise)}`, sets(e), sets(b.exercises[i]!))
			);
		}
	} else if (a.kind === 'run' && b.kind === 'run') {
		const size = (s: typeof a) =>
			s.segments.some((g) => g.distanceMetres === null) || runMetres(s) === 0
				? `${s.estMinutes} min`
				: distance(runMetres(s), distanceUnit);
		const steps = (s: typeof a) =>
			s.segments
				.map((g) => {
					const w = describeSegment(g, { distanceUnit });
					const line = [w.headline, w.pace, w.target].filter(Boolean).join(' ');
					return g.repeats === null ? line : `${g.repeats} × ${line}`;
				})
				.join(' + ');
		if (size(a) !== size(b)) add(a.title, size(a), size(b));
		else add(a.title, steps(a), steps(b));
	} else if (a.kind === 'other' && b.kind === 'other') {
		const details = ({ details: d }: typeof a) =>
			[
				`${OTHER_SESSION_KIND_LABEL[d.kind]} ${d.durationMinutes} min`,
				d.targetRpe === null ? '' : ` @ RPE ${d.targetRpe}`,
				...d.metrics.map((m) => `, ${m.label} ${m.value}${m.unit ? ` ${m.unit}` : ''}`)
			].join('');
		add(a.title, details(a), details(b));
	}
	if (!rows.length) add(a.title, `${a.estMinutes} min`, `${b.estMinutes} min`);
	return rows;
}

const sessionKey = (s: SessionPlan) => `${s.kind}\n${s.type}\n${s.title}`;
const byDay = (a: SessionPlan, b: SessionPlan) =>
	compareText(a.date, b.date) || a.orderInDay - b.orderInDay || compareText(a.title, b.title);

/** A week's session rows: pairs on the same day first, then by date order within a key. */
function sessionRows(
	before: readonly SessionPlan[],
	after: readonly SessionPlan[],
	options: ChangeOptions
): Omit<ChangeRow, 'line'>[] {
	const left = [...before].sort(byDay);
	const right = [...after].sort(byDay);
	const pairs: [SessionPlan, SessionPlan][] = [];
	const take = (same: (a: SessionPlan, b: SessionPlan) => boolean) => {
		for (const a of [...left]) {
			const i = right.findIndex((b) => same(a, b));
			if (i < 0) continue;
			pairs.push([a, right[i]!]);
			left.splice(left.indexOf(a), 1);
			right.splice(i, 1);
		}
	};
	take((a, b) => sessionKey(a) === sessionKey(b) && a.date === b.date);
	take((a, b) => sessionKey(a) === sessionKey(b));
	const rows: Omit<ChangeRow, 'line'>[] = [];
	for (const [a, b] of pairs) {
		if (a.date !== b.date || a.timeOfDay !== b.timeOfDay) {
			const timed = a.date === b.date;
			rows.push({
				kind: 'moved',
				label: a.title,
				before: when(a, timed),
				after: when(b, timed),
				date: b.date
			});
		}
		if (
			canonicalJson({ ...a, date: '', timeOfDay: null, orderInDay: 0 }) ===
			canonicalJson({ ...b, date: '', timeOfDay: null, orderInDay: 0 })
		)
			continue;
		for (const r of contentRows(a, b, options)) rows.push({ kind: 'changed', ...r, date: b.date });
	}
	for (const a of left)
		rows.push({
			kind: 'removed',
			label: a.title,
			before: when(a, false),
			after: null,
			date: a.date
		});
	for (const b of right)
		rows.push({ kind: 'added', label: b.title, before: null, after: when(b, false), date: b.date });
	return rows.sort((x, y) => compareText(x.date ?? '', y.date ?? ''));
}

// ---- Weeks ----------------------------------------------------------------------------------

interface Slot {
	block: BlockPlan | null;
	week: WeekPlan | null;
	sessions: SessionPlan[];
}

/** The future Mondays either plan's blocks cover, oldest first. */
function mondays(plans: readonly ProgramPlan[], from: IsoDate): IsoDate[] {
	const all = new Set<IsoDate>();
	for (const block of plans.flatMap((p) => p.blocks)) {
		for (let m = mondayOf(block.startsOn); m <= block.endsOn; m = addDays(m, 7)) {
			if (addDays(m, 6) >= from) all.add(m);
		}
	}
	return [...all].sort(compareText);
}

function slotOf(plan: ProgramPlan, monday: IsoDate, from: IsoDate): Slot {
	const block = plan.blocks.find((b) => b.startsOn <= addDays(monday, 6) && b.endsOn >= monday);
	const week = block?.weeks.find((w) => w.startsOn === monday) ?? null;
	const sessions = week?.sessions.filter((s) => s.date >= from) ?? [];
	return { block: block ?? null, week, sessions };
}

/** 'Marathon build', or 'Spring block (Marathon build)' when the name does not say the phase. */
function blockWords(b: BlockPlan | null): string {
	if (b === null) return 'No block';
	const phase = PHASE_LABEL[b.phase];
	return b.name === phase ? phase : `${b.name} (${phase})`;
}

function metricsOf(slot: Slot, monday: IsoDate, options: ChangeOptions) {
	const muscles = options.exercises as ReadonlyMap<string, ExerciseMuscles>;
	const week = { startsOn: monday, sessions: slot.sessions } as WeekPlan;
	const sum = (value: (s: SessionPlan) => number) =>
		slot.sessions.reduce((t, s) => t + value(s), 0);
	return {
		groups: plannedHardSets(week, muscles).groups,
		minutes: sum((s) => s.estMinutes),
		load: sum((s) => sessionLoadOf(s)),
		runMetres: sum(runMetres)
	};
}

function impactOf(a: Slot, b: Slot, monday: IsoDate, options: ChangeOptions): WeekImpact | null {
	const before = metricsOf(a, monday, options);
	const after = metricsOf(b, monday, options);
	const hardSets: WeekImpact['hardSets'] = {};
	for (const group of MUSCLE_GROUPS) {
		const delta = cleanFloat((after.groups[group] ?? 0) - (before.groups[group] ?? 0));
		if (delta !== 0) hardSets[group] = delta;
	}
	const impact: WeekImpact = {
		weekStart: monday,
		hardSets,
		minutes: after.minutes - before.minutes,
		load: cleanFloat(after.load - before.load),
		runMetres: after.runMetres - before.runMetres
	};
	const changed = Object.keys(hardSets).length || impact.minutes || impact.load || impact.runMetres;
	return changed ? impact : null;
}

/** 'Quads −3 hard sets, −45 min, running −4 km'; '' when nothing measured changes. */
export function describeImpact(
	impact: Omit<WeekImpact, 'weekStart' | 'load'>,
	{ distanceUnit }: Pick<ChangeUnits, 'distanceUnit'>
): string {
	const sets = MUSCLE_GROUPS.filter((g) => impact.hardSets[g] !== undefined).map(
		(g) => `${MUSCLE_GROUP_LABEL[g]} ${signed(impact.hardSets[g]!)} hard sets`
	);
	const run = Math.abs(impact.runMetres);
	return [
		...sets,
		impact.minutes ? `${signed(impact.minutes)} min` : null,
		run ? `running ${impact.runMetres < 0 ? '−' : '+'}${distance(run, distanceUnit)}` : null
	]
		.filter(Boolean)
		.join(', ');
}

// ---- The change -----------------------------------------------------------------------------

function clip(line: string): string {
	if (line.length <= SUMMARY_LINE_MAX) return line;
	const cut = line.slice(0, SUMMARY_LINE_MAX - 1);
	const space = cut.lastIndexOf(' ');
	return `${(space > SUMMARY_LINE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function summaryOf(weeks: readonly WeekChange[], options: ChangeOptions): string[] {
	const fromWords = `${weekday(options.from)} ${dayMonth(options.from)}`;
	if (!weeks.length) return [`Nothing changes from ${fromWords}`];
	const rows = weeks.flatMap((w) => w.rows);
	const count = (kind: ChangeKind) => rows.filter((r) => r.kind === kind).length;
	const counts = [
		count('block') ? plural(count('block'), 'block change') : null,
		count('added') ? `${plural(count('added'), 'session')} added` : null,
		count('removed') ? `${count('removed')} removed` : null,
		count('moved') ? `${count('moved')} moved` : null,
		count('changed') ? `${count('changed')} changed` : null
	].filter(Boolean);
	const head = `From ${fromWords}, ${plural(weeks.length, 'week')} ${weeks.length === 1 ? 'changes' : 'change'}${counts.length ? `: ${counts.join(', ')}` : ''}`;
	const first = rows.find((r) => r.kind === 'block') ?? rows[0];
	const total = { hardSets: {} as WeekImpact['hardSets'], minutes: 0, runMetres: 0 };
	for (const { impact } of weeks) {
		if (!impact) continue;
		total.minutes += impact.minutes;
		total.runMetres += impact.runMetres;
		for (const [group, n] of Object.entries(impact.hardSets) as [MuscleGroup, number][]) {
			const sum = cleanFloat((total.hardSets[group] ?? 0) + n);
			if (sum === 0) delete total.hardSets[group];
			else total.hardSets[group] = sum;
		}
	}
	const overall = describeImpact(total, options.units);
	return [head, first?.line, overall ? `In all: ${overall}` : null]
		.filter((line): line is string => Boolean(line))
		.slice(0, SUMMARY_LINES_MAX)
		.map(clip);
}

/** What `after` changes from `before`, week by week from `from`, in the owner's units. */
export function describeChanges(
	before: ProgramPlan,
	after: ProgramPlan,
	options: ChangeOptions
): PlanChanges {
	const { from } = options;
	const weeks: WeekChange[] = [];
	let lastBlocks = '';
	for (const monday of mondays([before, after], from)) {
		const a = slotOf(before, monday, from);
		const b = slotOf(after, monday, from);
		const label = weekLabel(monday);
		const rows: Omit<ChangeRow, 'line'>[] = [];
		const blocks = `${blockWords(a.block)}\n${blockWords(b.block)}`;
		if (blockWords(a.block) !== blockWords(b.block) && blocks !== lastBlocks) {
			rows.push({
				kind: 'block',
				label: 'Block',
				before: blockWords(a.block),
				after: blockWords(b.block),
				date: null
			});
		}
		lastBlocks = blocks;
		if (a.week && b.week && a.week.kind !== b.week.kind) {
			const [was, now] = [WEEK_KIND_LABEL[a.week.kind], WEEK_KIND_LABEL[b.week.kind]];
			rows.push({ kind: 'week', label: 'Week', before: was, after: now, date: null });
		}
		rows.push(...sessionRows(a.sessions, b.sessions, options));
		const impact = impactOf(a, b, monday, options);
		if (!rows.length && !impact) continue;
		weeks.push({
			weekStart: monday,
			label,
			rows: rows.map((row) => ({ ...row, line: rowLine(label, row) })),
			impact
		});
	}
	return {
		weeks,
		impact: weeks.flatMap((w) => (w.impact ? [w.impact] : [])),
		summaryLines: summaryOf(weeks, options)
	};
}

// ---- Shape ----------------------------------------------------------------------------------

/** The blocks and weeks from `from`, sessions dated before it left out. */
function future(plan: ProgramPlan, from: IsoDate): BlockPlan[] {
	return plan.blocks
		.filter((b) => b.endsOn >= from)
		.map((b) => ({
			...b,
			weeks: b.weeks
				.filter((w) => w.endsOn >= from)
				.map((w) => ({ ...w, sessions: w.sessions.filter((s) => s.date >= from) }))
		}));
}

/** One digest per future planned week, by its Monday: phase, kind, dates and sessions, no loads. */
export function weekShapes(plan: ProgramPlan, from: IsoDate): Record<IsoDate, string> {
	const shapes: Record<IsoDate, string> = {};
	for (const block of future(plan, from)) {
		for (const week of block.weeks) {
			const sessions = week.sessions
				.map((s) => ({ date: s.date, type: s.type, title: s.title }))
				.sort((x, y) => compareText(canonicalJson(x), canonicalJson(y)));
			const { kind, startsOn, endsOn } = week;
			shapes[startsOn] = fnv1a64(
				canonicalJson({ phase: block.phase, kind, startsOn, endsOn, sessions })
			);
		}
	}
	return shapes;
}

/** The future's structure as one digest: the blocks' phases and dates, and every week's shape. */
export function shapeDigest(plan: ProgramPlan, from: IsoDate): string {
	const blocks = future(plan, from).map((b) => ({
		phase: b.phase,
		startsOn: b.startsOn < from ? from : b.startsOn,
		endsOn: b.endsOn
	}));
	return fnv1a64(canonicalJson({ blocks, weeks: weekShapes(plan, from) }));
}

/**
 * True when the two plans' futures are the same, loads and details included (decisions aside).
 * A difference no row names (a note, say) still counts as a change.
 */
export function noChange(before: ProgramPlan, after: ProgramPlan, from: IsoDate): boolean {
	return canonicalJson(future(before, from)) === canonicalJson(future(after, from));
}
