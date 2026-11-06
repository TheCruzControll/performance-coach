/**
 * The other sessions (PRD §5), by the numbers in rules/running.ts, each within the session
 * length and the week's RPE cap, its load minutes × target RPE through M1's sessionLoad:
 * - the Muay Thai sessions a week still needs after its classes: technical at RPE 6 by default
 *   (DEFAULTS.muay_thai_sessions, which blocks.ts explains); with the Muay Thai profile told,
 *   technique and pad work by turns, and one sparring session in a building week for an owner
 *   who spars
 * - a custom-discipline goal's sessions with no commitment for them, titled with its name, at RPE
 *   6 for the session length, with a default_assumed decision saying their content is the owner's
 * - a mobility session on each free day no goal asks for
 * They go on days naively, one a day and off days holding one of their type where another is
 * free, until placement (m3/23) places every session.
 *
 * Pure: no clock, no randomness, no I/O.
 */
import type { IsoDate } from '../calendar.ts';
import { STEP_INFO } from '../profile/onboarding.ts';
import { sessionLoadOf } from '../training/metrics.ts';
import type { BlockPlan, CustomMetric, OtherSessionPlan, WeekPlan } from '../training/types.ts';
import type { OtherSessionKind, SessionIntensity } from '../training/vocabulary.ts';
import { nextOrder, sessionPath } from './commitments.ts';
import type { DecisionLog } from './decisions.ts';
import { clip, generatedFor } from './demand.ts';
import type { WeekDemand } from './demand.ts';
import type { ProgrammingInput } from './input.ts';
import { CUSTOM_SESSION_RPE, MOBILITY, MUAY_THAI } from './rules/running.ts';
import { naiveDates, openDates } from './running.ts';
import type { GenerateOptions } from './stage.ts';

type Fields = Pick<OtherSessionPlan, 'type' | 'title' | 'discipline' | 'customDiscipline'> & {
	kind: OtherSessionKind;
	minutes: number;
	rpe: number;
	intensity: SessionIntensity;
	metrics: CustomMetric[];
};

function otherSession(f: Fields, date: IsoDate, orderInDay: number, rpeCap: number) {
	const targetRpe = Math.min(f.rpe, rpeCap);
	return {
		kind: 'other',
		date,
		timeOfDay: null,
		orderInDay,
		type: f.type,
		title: f.title,
		discipline: f.discipline,
		customDiscipline: f.customDiscipline,
		intensity: f.intensity,
		estMinutes: f.minutes,
		estLoad: sessionLoadOf({ estMinutes: f.minutes, targetRpe }),
		targetRpe,
		source: 'generator',
		commitmentRef: null,
		instructions: null,
		notes: null,
		details: {
			kind: f.kind,
			durationMinutes: f.minutes,
			targetRpe,
			metrics: f.metrics,
			notes: null
		}
	} satisfies OtherSessionPlan;
}

/** The formats of a week's `count` generated Muay Thai sessions. */
function muayThaiKinds(input: ProgrammingInput, week: WeekPlan, count: number) {
	const told = input.muayThai !== null;
	const spars =
		(input.muayThai?.sparringPerWeek ?? 0) > 0 && MUAY_THAI.sparringWeeks.includes(week.kind);
	return Array.from({ length: count }, (_, i) =>
		spars && count > 1 && i === count - 1 ? 'sparring' : told && i % 2 ? 'pad_work' : 'technical'
	);
}

/** The planned weeks' Muay Thai, custom-discipline and mobility sessions, around those placed. */
export function planOther(
	blocks: readonly BlockPlan[],
	demand: WeekDemand,
	input: ProgrammingInput,
	{ firstPlannedDay }: GenerateOptions,
	log: DecisionLog
): BlockPlan[] {
	const { allocation, budget } = demand;
	const minutes = input.sessionMinutes;
	const custom = allocation.streams.find((s) => s.stream === 'custom');
	const name = custom ? (custom.goal.customDiscipline ?? custom.goal.title) : '';
	const customPaths: string[] = [];

	const planned = blocks.map((block, b) => ({
		...block,
		weeks: block.weeks.map((week, w) => {
			const sessions = [...week.sessions];
			const open = openDates(week, budget.days, firstPlannedDay);
			const add = (all: Fields[], paths?: string[]) => {
				if (!all.length) return;
				const dates = naiveDates(sessions, open, all.length, (on) =>
					on.some((s) => s.type === all[0]!.type)
				);
				dates.forEach((date, i) => {
					paths?.push(sessionPath(b, w, sessions.length));
					sessions.push(
						otherSession(all[i]!, date, nextOrder(sessions, date), week.targets.rpeCap)
					);
				});
			};
			const mt = muayThaiKinds(input, week, generatedFor(allocation, 'muay_thai'));
			add(
				mt.map((kind): Fields => ({
					...MUAY_THAI[kind],
					kind,
					type: 'muay_thai',
					discipline: 'muay_thai',
					customDiscipline: null,
					minutes,
					metrics: [
						{ key: 'rounds', label: 'Rounds', unit: null, value: MUAY_THAI[kind].rounds },
						{
							key: 'round_length',
							label: 'Round length',
							unit: 'min',
							value: MUAY_THAI.roundMinutes
						}
					]
				}))
			);
			const own: Fields = {
				kind: 'custom',
				type: 'custom',
				title: clip(name, 60),
				discipline: 'custom',
				customDiscipline: clip(name, 40),
				minutes,
				rpe: CUSTOM_SESSION_RPE,
				intensity: 'moderate',
				metrics: []
			};
			add(
				Array.from({ length: generatedFor(allocation, 'custom') }, () => own),
				customPaths
			);
			const mobility: Fields = {
				kind: 'mobility',
				type: 'mobility',
				title: 'Mobility',
				// Mobility serves every goal: it counts as general athletic work.
				discipline: 'athletic',
				customDiscipline: null,
				minutes: Math.min(MOBILITY.minutes, minutes),
				rpe: MOBILITY.rpe,
				intensity: 'easy',
				metrics: []
			};
			add(Array.from({ length: allocation.mobility }, () => mobility));
			return { ...week, sessions };
		})
	}));

	if (custom && generatedFor(allocation, 'custom')) {
		const count = generatedFor(allocation, 'custom');
		log.add('default_assumed', 'other.custom_sessions', customPaths, {
			missing: clip(`You haven’t told the coach what your ${name} sessions hold.`, 200),
			assumed: clip(
				`${count} ${name} session${count > 1 ? 's' : ''} a week of ${minutes} min at RPE ${CUSTOM_SESSION_RPE}`,
				200
			),
			rationale:
				'Their content is your own: the coach plans their time and effort around the rest of your week, and you decide what goes in them.',
			section: STEP_INFO.schedule.title
		});
	}
	return planned;
}
