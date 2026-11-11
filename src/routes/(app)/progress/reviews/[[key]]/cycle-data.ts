/**
 * The cycle review as the screen shows it (CycleReview.svelte), arranged on the server from the
 * stored snapshot and findings (domain/programming/review/cycle.ts) and the block's progression as
 * logged now (getCycleReviewView), so the screen computes nothing. Sections, in screen order:
 *
 * - goal progress: a card per goal and area
 * - strength progression: an estimated 1RM line per judged exercise (small multiples, at most
 *   PROGRESSION_MAX), each with its first and last session and the change in data-value (kg);
 *   with no progression (the block left the current version), the stored findings alone
 * - endurance progression: weekly distance over the block
 * - accumulated fatigue: load, ACWR with its caveat (SHOW_ACWR), RPE creep, soreness and sleep
 * - volume and intensity: planned against achieved hard sets per group, against the range
 * - exercise effectiveness: a table in words, each row leading to Keep or Rotate (the next
 *   block's directives, directivesFrom over the same snapshot)
 * - adherence by week and weekday, and the deload need
 */
import type { IsoDate } from '#lib/domain/calendar.ts';
import { METRICS } from '#lib/domain/analytics/metrics.ts';
import type { Finding, FindingLevel } from '#lib/domain/programming/review/brief.ts';
import { directivesFrom } from '#lib/domain/programming/review/directives.ts';
import { plural } from '#lib/domain/programming/review/weekly.ts';
import { MUSCLE_GROUP_LABEL } from '#lib/domain/training/vocabulary.ts';
import { cleanFloat, convertWeight, fromMetres } from '#lib/domain/units.ts';
import type {
	CycleProgression,
	CycleReviewView,
	ReviewListItem
} from '#lib/server/services/reviews/index.ts';
import { rangeTable, rowsHeight } from '#lib/ui/charts/bar-model.ts';
import { lineTable, type LineChartData } from '#lib/ui/charts/line-model.ts';
import { SERIES_TOKEN } from '#lib/ui/charts/palette.ts';
import { shortDate } from '#lib/ui/program/words.ts';
import { slotOf } from '../../load.ts';
import type { ReviewRow } from './load.ts';
import type { NextCycleView } from './next-cycle-data.ts';
import { item, type ItemView, type LineChartView, type SectionView } from './sections.ts';

/**
 * Decision (m6-plan open question 'ACWR'): shown, with its caveat in view, as planned. False
 * leaves it out of the cycle review.
 */
export const SHOW_ACWR = true;

/** The most lifts drawn as small multiples: the most sessions first. */
export const PROGRESSION_MAX = 6;

export const CYCLE_SECTION_TITLE = {
	goals: 'Goal progress',
	strength: 'Strength progression',
	endurance: 'Endurance progression',
	fatigue: 'Accumulated fatigue',
	volume: 'Volume and intensity',
	effectiveness: 'Exercise effectiveness',
	adherence: 'Adherence and deload'
} as const;
export type CycleSectionId = keyof typeof CYCLE_SECTION_TITLE;

export const cycleKey = (id: string) => `c-${id}`;

const tick = (on: IsoDate) => slotOf({ at: on, value: null, inProgress: false }, 'week').tick;
/** 'Block · 26 Oct – 22 Nov'. */
export const cycleTitle = (from: IsoDate, to: IsoDate) => `Block · ${tick(from)} – ${tick(to)}`;

export interface CycleReviewData {
	kind: 'cycle';
	id: string;
	key: string;
	/** The block's name. */
	title: string;
	/** 'Mon 26 Oct – Sun 22 Nov'. */
	dates: string;
	summary: string;
	legacy: boolean;
	adherence: {
		pct: number | null;
		text: string | null;
		level: FindingLevel;
		words: string;
		counts: { label: string; value: number; words: string }[];
	} | null;
	sections: SectionView[];
	/** Training logged in the block since it was computed; null when up to date. */
	stale: { words: string; detail: string } | null;
	/** Earlier cycles' reviews, newest first, as the list's rows. */
	earlier: ReviewRow[];
	/** The version its decision planned, in History; null until one is. */
	history: { version: number; label: string } | null;
	writeUp: string | null;
	/** The next block's card (next-cycle-data.ts); null with none to decide or show. */
	next: NextCycleView | null;
}

const WATCH: readonly FindingLevel[] = ['low', 'watch'];

function section(
	id: CycleSectionId,
	found: Finding[],
	items: ItemView[],
	more: Partial<SectionView> = {}
): SectionView {
	const f = found.find((x) => WATCH.includes(x.verdict.level)) ?? found[0];
	return {
		id,
		title: CYCLE_SECTION_TITLE[id],
		verdict: f
			? { level: f.verdict.level, words: `${f.label}: ${f.verdict.words}` }
			: { level: 'neutral', words: 'Nothing to judge this block' },
		items,
		chart: null,
		...more
	};
}

const number = (n: number) => cleanFloat(n, 1).toLocaleString('en-US');

/** One lift's estimated 1RM per session, in the profile's unit. */
function liftChart(
	name: string,
	points: CycleProgression['lifts'][number]['points'],
	units: CycleProgression['units']
): LineChartView {
	const unit = units.weight;
	const shown = (kg: number) => cleanFloat(convertWeight(kg, 'kg', unit), 1);
	const data: LineChartData = {
		title: `${name} estimated 1RM`,
		unit,
		slots: points.map((p) => ({ tick: tick(p.on), label: `Session on ${shortDate(p.on)}` })),
		series: [
			{
				key: 'e1rm',
				label: name,
				token: SERIES_TOKEN.strength,
				points: points.map((p) => ({
					value: shown(p.kg),
					text: number(shown(p.kg)),
					kind: 'estimated'
				}))
			}
		]
	};
	const [a, b] = [shown(points[0]!.kg), shown(points.at(-1)!.kg)];
	const way = b > a ? 'Up' : b < a ? 'Down' : 'Unchanged,';
	const by = b === a ? '' : ` ${number(Math.abs(b - a))} ${unit}`;
	return {
		body: 'line',
		data,
		title: data.title,
		context: ['The block', 'Estimated', 'Per session'],
		summary: `${way}${by} from the first session to the last: ${number(a)} to ${number(b)} ${unit}.`,
		table: lineTable(data, 'Session'),
		height: '9rem'
	};
}

/** Weekly distance over the block, in the profile's unit. */
function distanceChart(
	weeks: NonNullable<CycleProgression['distance']>,
	units: CycleProgression['units']
): LineChartView {
	const unit = units.distance;
	const shown = (m: number) => cleanFloat(fromMetres(m, unit), 1);
	const data: LineChartData = {
		title: 'Weekly distance',
		unit,
		slots: weeks.map((w) => slotOf({ at: w.weekStartsOn, value: null, inProgress: false }, 'week')),
		series: [
			{
				key: 'distance',
				label: 'Distance',
				token: SERIES_TOKEN.running,
				points: weeks.map((w) => ({ value: shown(w.metres), text: number(shown(w.metres)) }))
			}
		]
	};
	const total = shown(weeks.reduce((sum, w) => sum + w.metres, 0));
	const [first, last] = [shown(weeks[0]!.metres), shown(weeks.at(-1)!.metres)];
	return {
		body: 'line',
		data,
		title: data.title,
		context: ['The block', 'Calculated', 'Per week'],
		summary: `${number(total)} ${unit} over the block: ${number(first)} ${unit} in its first week, ${number(last)} ${unit} in its last.`,
		table: lineTable(data),
		height: '9rem'
	};
}

/** The cycle review's sections, in screen order; one with nothing to show is left out. */
export function cycleSections(view: CycleReviewView): SectionView[] {
	const snapshot = view.snapshot;
	if (!snapshot) return [];
	const findings = snapshot.brief.findings;
	const byId = new Map(findings.map((f) => [f.id, f]));
	const starts = (...prefixes: string[]) =>
		findings.filter((f) => prefixes.some((p) => f.id === p || f.id.startsWith(`${p}:`)));
	const nameOf = (exercise: string) =>
		byId.get(`effectiveness:${exercise}`)?.label.replace(/ \(main lift\)$/, '') ?? 'Exercise';
	const sections: SectionView[] = [];

	const goals = starts('goals');
	sections.push(
		section(
			'goals',
			goals,
			goals.map((f) => item(f)),
			goals.length
				? {}
				: {
						verdict: {
							level: 'neutral',
							words: 'No active goals: set one in your profile to see its progress here'
						}
					}
		)
	);

	const progression = view.progression;
	const lifts = (progression?.lifts ?? [])
		.toSorted((a, b) => b.points.length - a.points.length)
		.slice(0, PROGRESSION_MAX);
	const strength = starts('verdicts:strength', 'verdicts:e1rm');
	// A block that left the current version has no progression to draw: its findings stay.
	if (!progression || !lifts.length) {
		if (strength.length)
			sections.push(
				section(
					'strength',
					strength,
					strength.map((f) => item(f))
				)
			);
	} else {
		const unit = progression.units.weight;
		const words = (kg: number) => `${number(convertWeight(kg, 'kg', unit))} ${unit}`;
		const liftItems = lifts.map(({ exercise, points }): ItemView => {
			const [first, last] = [points[0]!.kg, points.at(-1)!.kg];
			return {
				id: `progression:${exercise}`,
				label: `${nameOf(exercise)} estimated 1RM`,
				words: byId.get(`effectiveness:${exercise}`)?.verdict.words ?? '',
				figures: [
					{ label: 'First session', words: words(first), value: first },
					{ label: 'Last session', words: words(last), value: last },
					{
						label: 'Change',
						words: `${last < first ? '−' : '+'}${words(Math.abs(last - first))}`,
						value: cleanFloat(last - first, 2)
					}
				],
				reasons: []
			};
		});
		sections.push(
			section(
				'strength',
				strength,
				[...strength.filter((f) => f.id === 'verdicts:strength').map((f) => item(f)), ...liftItems],
				{
					charts: lifts.map((l) => liftChart(nameOf(l.exercise), l.points, progression.units))
				}
			)
		);
	}

	const mileage = starts('verdicts:mileage');
	if (mileage.length || progression?.distance)
		sections.push(
			section(
				'endurance',
				mileage,
				mileage.map((f) => item(f)),
				{
					charts: progression?.distance
						? [distanceChart(progression.distance, progression.units)]
						: []
				}
			)
		);

	const fatigue = starts('fatigue', 'recovery').filter(
		(f) => f.id !== 'fatigue:deload' && (SHOW_ACWR || f.id !== 'fatigue:acwr')
	);
	sections.push(
		section(
			'fatigue',
			fatigue,
			fatigue.map((f) => {
				const shown = item(f, f.id === 'fatigue' ? snapshot.fatigue.reasons : []);
				return f.id === 'fatigue:acwr' && METRICS.acwr.caveat
					? { ...shown, reasons: [METRICS.acwr.caveat] }
					: shown;
			})
		)
	);

	const volume = starts('volume');
	const groups = Map.groupBy(
		snapshot.volume.filter((r) => r.target),
		(r) => r.group
	);
	const mean = (values: number[]) =>
		cleanFloat(values.reduce((a, b) => a + b, 0) / values.length, 1);
	const bar = (value: number) => ({ value, text: number(value) });
	const rows = [...groups].map(([group, weeks]) => {
		const planned = weeks.filter((w) => w.planned !== null).map((w) => w.planned!);
		return {
			key: group,
			label: MUSCLE_GROUP_LABEL[group],
			value: bar(mean(weeks.map((w) => w.achieved))),
			range: [mean(weeks.map((w) => w.target![0])), mean(weeks.map((w) => w.target![1]))] as const,
			planned: planned.length ? bar(mean(planned)) : null
		};
	});
	const within = rows.filter(
		(r) => r.value.value >= r.range[0] && r.value.value <= r.range[1]
	).length;
	const setsData = {
		title: 'Hard sets a week by muscle group',
		unit: 'sets',
		token: SERIES_TOKEN.hypertrophy,
		rows
	};
	sections.push(
		section(
			'volume',
			volume,
			volume.map((f) => item(f)),
			{
				chart: rows.length
					? {
							body: 'range',
							data: setsData,
							title: setsData.title,
							context: ['Weekly mean over the block', 'Against your target ranges', 'Calculated'],
							summary: `${within} of ${plural(rows.length, 'group')} within range on average.`,
							table: rangeTable(setsData),
							height: rowsHeight(rows.length)
						}
					: null
			}
		)
	);

	if (snapshot.effectiveness.length) {
		const { keep, rotate } = directivesFrom({ snapshot, running: null }, null, []);
		const action = new Map([
			...keep.map((k) => [k.exercise, `Keep · ${k.reason}`] as const),
			...rotate.map((r) => [r.exercise, `Rotate · ${r.reason}`] as const)
		]);
		sections.push(
			section('effectiveness', [], [], {
				verdict: {
					level: rotate.length ? 'watch' : 'good',
					words: `${plural(keep.length, 'exercise')} to keep, ${rotate.length} to rotate`
				},
				table: {
					rowHeader: 'Exercise',
					columns: [{ label: 'How it did' }, { label: 'Next block' }],
					rows: starts('effectiveness').map((f) => ({
						label: f.label,
						values: [f.verdict.words, action.get(f.id.slice('effectiveness:'.length)) ?? 'Keep']
					}))
				}
			})
		);
	}

	const deload = byId.get('fatigue:deload');
	const adherence = [...(deload ? [deload] : []), ...starts('adherence:week', 'adherence:weekday')];
	sections.push(
		section(
			'adherence',
			adherence,
			adherence.map((f) => item(f))
		)
	);
	return sections;
}

/**
 * A cycle review as the screen shows it: `items` is the list page (a legacy review's dates),
 * `rows` its cycle rows (cycleRows), whose earlier reviews it links to, and `next` its next-block
 * card (nextCycleView).
 */
export function cycleReviewData(
	view: CycleReviewView,
	items: readonly ReviewListItem[],
	rows: readonly ReviewRow[],
	next: NextCycleView | null = null
): CycleReviewData {
	const { snapshot, review, decision } = view;
	const self = items.find((i) => i.id === review.id);
	const from = snapshot?.block.from ?? self?.startsOn ?? null;
	const to = snapshot?.block.to ?? self?.endsOn ?? null;
	const found = snapshot?.brief.findings.find((f) => f.id === 'adherence');
	const counts = snapshot?.adherence;
	const changes = view.laterChanges;
	return {
		kind: 'cycle',
		id: review.id,
		key: cycleKey(review.id),
		title: snapshot?.block.name ?? 'Cycle review',
		dates: from && to ? `${shortDate(from)} – ${shortDate(to)}` : '',
		summary: review.summary,
		legacy: view.legacy,
		adherence:
			found && counts
				? {
						pct: counts.pct,
						text: counts.pct === null ? null : (found.figures[0]?.words ?? null),
						level: found.verdict.level,
						words: found.verdict.words,
						counts: (['planned', 'completed', 'skipped', 'missed'] as const).map((k) => ({
							label: k[0]!.toUpperCase() + k.slice(1),
							value: counts[k],
							words: plural(counts[k], 'session')
						}))
					}
				: null,
		sections: cycleSections(view),
		stale: view.stale
			? {
					words: `Computed before ${plural(changes, 'later change')}`,
					detail: 'You’ve logged training in this block since. It shows the block as it was then.'
				}
			: null,
		earlier: rows.filter(
			(r) =>
				r.state === 'reviewed' && r.key !== cycleKey(review.id) && from && r.weekStartsOn < from
		),
		history:
			decision.state === 'applied' && decision.versionNumber !== null
				? {
						version: decision.versionNumber,
						label: `See version ${decision.versionNumber} in History`
					}
				: null,
		writeUp: view.writeUp.state === 'written' ? view.writeUp.text : null,
		next
	};
}
