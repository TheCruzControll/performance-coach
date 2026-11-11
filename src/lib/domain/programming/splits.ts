/**
 * The week's strength split (PRD §5): what each strength day trains. The number of days is the
 * day rule's (allocateWeek's generated strength sessions, with strength classes already counted),
 * never a count of its own. rules/strength.ts holds the layouts:
 * - SBD for powerlifting, the two competition lifts for weightlifting, athletic days with a power
 *   slot, and otherwise full body for up to 3 days, upper/lower for 4, push/pull/legs beyond;
 * - maintenance when a goal of another kind ranks first, or every goal is paused, unless M7's
 *   prepare marks the strength goal secondary (it keeps its own layout and style); and whenever
 *   prepare holds the strength goal at maintenance, even ranked first.
 *
 * Pure: no clock, no randomness, no I/O.
 */
import type { Discipline } from '../profile/catalog.ts';
import { clip } from './demand.ts';
import type { ProgrammingInput } from './input.ts';
import { SESSIONS_WANTED } from './rules/days.ts';
import {
	DAYS,
	GENERAL_STYLE,
	LAYOUT_BY_DAYS,
	LAYOUTS,
	OWN_LAYOUT,
	STYLE_OF,
	STYLES
} from './rules/strength.ts';
import type { DayTemplate, DisciplineStyle, LayoutKey, Prescription } from './rules/strength.ts';

export interface SplitDay extends DayTemplate {
	/** The session's title: the day's name, lettered when the week repeats it. */
	title: string;
}

export interface Split extends Omit<DisciplineStyle, 'style'> {
	layout: LayoutKey;
	/** The top strength discipline: the one the sessions are for. */
	discipline: Discipline;
	maintenance: boolean;
	prescription: Prescription;
	days: SplitDay[];
}

/** The highest-ranked discipline a strength day serves, or null when no goal asks for one. */
export function strengthDiscipline(input: ProgrammingInput): Discipline | null {
	return input.disciplines.find((d) => SESSIONS_WANTED[d].stream === 'strength') ?? null;
}

/** Days that share a name are lettered in the order they come: Upper A, Lower A, Upper B. */
function lettered(templates: readonly DayTemplate[]): SplitDay[] {
	const seen = new Map<string, number>();
	return templates.map((day) => {
		const n = seen.get(day.name) ?? 0;
		seen.set(day.name, n + 1);
		const repeated = templates.filter((other) => other.name === day.name).length > 1;
		return { ...day, title: repeated ? `${day.name} ${String.fromCharCode(65 + n)}` : day.name };
	});
}

/** The split for `count` strength days a week; `count` comes from allocateWeek. */
export function chooseSplit(input: ProgrammingInput, count: number): Split {
	const discipline = strengthDiscipline(input);
	if (!discipline || count < 1) throw new RangeError('A split needs a strength goal and a day');
	// M7: a secondary goal (prepare's input.modes) keeps its own layout and style even where
	// another kind leads; a goal held at maintenance gets the maintenance layout even where it
	// ranks first; no modes at all gives M3's rule.
	const ref = input.refs.goals[input.goals.findIndex((g) => g.disciplines.includes(discipline))];
	const mode = input.maintenance || ref === undefined ? undefined : input.modes?.[ref];
	const maintenance =
		mode === 'maintenance' ||
		(mode !== 'secondary' &&
			(input.maintenance || SESSIONS_WANTED[input.disciplines[0]!].stream !== 'strength'));
	const layout: LayoutKey = maintenance
		? 'maintenance'
		: (OWN_LAYOUT[discipline] ?? LAYOUT_BY_DAYS.find(([most]) => count <= most)![1]);
	const { byCount } = LAYOUTS[layout];
	const row = byCount[Math.min(count, byCount.length) - 1]!;
	const { style, ...rest } = STYLE_OF[discipline] ?? GENERAL_STYLE;
	return {
		...rest,
		layout,
		discipline,
		maintenance,
		prescription: STYLES[maintenance ? 'maintenance' : style],
		days: lettered(Array.from({ length: count }, (_, i) => DAYS[row[i % row.length]!]))
	};
}

/** The split_chosen decision's facts; `classes` is the strength classes a week, if any. */
export function splitFacts(split: Split, input: ProgrammingInput, classes: number) {
	const goal = input.maintenance ? 'your paused goals' : clip(input.goals[0]?.title ?? '', 40);
	const { name, reason } = LAYOUTS[split.layout];
	return {
		split: name,
		article: /^[aeiou]/.test(name) ? 'an' : 'a',
		days: split.days.length,
		classes: classes ? ` besides your ${classes} strength class${classes > 1 ? 'es' : ''}` : '',
		reason: reason.replace('{goal}', goal)
	};
}
