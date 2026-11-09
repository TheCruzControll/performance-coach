/**
 * The concurrent-training rules beyond M3's (m7/20), named after the PRD sentences, on the PRD §5
 * weeks (periodisation/weeks.ts) and the M7 histories, in the week of Monday 9 November 2026.
 */
import { describe, expect, it } from 'vitest';
import type { Discipline } from '../../profile/catalog';
import { catalogueTraits } from '../interference';
import type { TraitsOf } from '../interference';
import { loadModel } from '../load/fatigue';
import type { ModelLogged } from '../load/fatigue';
import { fromLogged } from '../load/from-facts';
import { HISTORIES } from '../periodisation/histories';
import type { FactHistory } from '../periodisation/histories';
import { PRD_WEEKS, weekDay } from '../periodisation/weeks';
import { tradeoffSentence } from '../priority/weights';
import type { GoalPriority } from '../priority/weights';
import { CONCURRENT_RULES, RUN_LOAD_HIGH } from '../rules/concurrent';
import { SCORE_WEIGHTS } from '../rules/evaluation';
import { RANK_WEIGHTS } from '../rules/priority';
import { RULE_BY_ID } from '../rules/registry/index';
import type { WeekContext } from './concurrent';
import type { Finding } from './types';
import { evaluateWeek } from './week';
import type { EvaluatedSession } from './week';

// ---- Sessions: the PRD §5 weeks' own, moved where a test needs them -----------------------------

type Over = Partial<EvaluatedSession>;
const at = (session: EvaluatedSession, day: number, over: Over = {}) =>
	({ ...session, date: weekDay(day), ...over }) as EvaluatedSession;
/** Heavy squats (back squat 4 × 5 at RPE 8, then Romanian deadlifts), hard. */
const lowerA = (day: number, over?: Over) => at(PRD_WEEKS.squat_before_sparring()[0]!, day, over);
/** Hard sparring: a commitment, in the evening. */
const sparring = (day: number, over?: Over) => at(PRD_WEEKS.squat_before_sparring()[1]!, day, over);
const easyRun = (day: number) => at(PRD_WEEKS.squat_before_sparring()[2]!, day);
/** 11 hard lower-body sets, none heavy. */
const legVolume = (day: number) => at(PRD_WEEKS.legs_before_long_run()[1]!, day);
const intervals = (day: number) => at(PRD_WEEKS.intervals_after_demanding()[1]!, day);
const tempoRun = (day: number) => at(PRD_WEEKS.hard_days_back_to_back()[0]!, day);
const upperA = (day: number) => at(PRD_WEEKS.hard_days_back_to_back()[1]!, day);
/** Moderate work: neither hard nor easy. */
const accessories = (day: number, over?: Over) =>
	at(PRD_WEEKS.hard_days_back_to_back()[1]!, day, {
		title: 'Accessories',
		lineage: 'accessories',
		intensity: 'moderate',
		exercises: [],
		...over
	} as Over);

const logged = (history: FactHistory): ModelLogged[] => fromLogged(history);
/** The load model over `from` to the week's Sunday. */
const model = (planned: EvaluatedSession[], done: ModelLogged[], from: string, today: string) =>
	loadModel({ planned, logged: done, from, to: weekDay(6), today });

const rulesOf = (findings: readonly Finding[]) => findings.map((f) => f.rule);
const only = (findings: readonly Finding[], rule: keyof typeof CONCURRENT_RULES) =>
	findings.filter((f) => f.rule === `concurrent.${rule}`);
const evaluate = (sessions: EvaluatedSession[], context: WeekContext) =>
	evaluateWeek(sessions, { context });

/** A goal's priority at `rank` (0 leads), with its rank weight. */
const goal = (title: string, disciplines: Discipline[], rank: number): GoalPriority => ({
	goalId: title.toLowerCase().replaceAll(' ', '-'),
	title,
	disciplines,
	priority: rank + 1,
	rank,
	weight: RANK_WEIGHTS[rank]!,
	mode: rank === 0 ? 'primary' : 'secondary',
	why: `${title} is in place ${rank + 1}.`,
	eventKind: null,
	eventDate: null,
	weeksToEvent: null,
	inWindow: false,
	rule: 'priority.rank_weights'
});
const strengthFirst = [goal('Get stronger', ['strength'], 0), goal('Fight', ['muay_thai'], 1)];
const BUILD: WeekContext = { week: { kind: 'build' } };

describe('PRD §2: hard Muay Thai sessions add fatigue (S10)', () => {
	it('hardCampWeek: residual fatigue before Tuesday’s heavy squats, naming Monday’s sparring', () => {
		const camp = logged(HISTORIES.hardCampWeek(1));
		const week = [lowerA(1)];
		const days = model(week, camp, weekDay(0), weekDay(1));
		const [finding, ...rest] = evaluate(week, { load: { days, logged: camp } }).findings;
		expect(rest).toEqual([]);
		expect(finding).toMatchObject({
			rule: 'concurrent.residual_fatigue_before_hard',
			area: 'concurrent',
			severity: 'avoid',
			days: [weekDay(0), weekDay(1)],
			sessions: [
				{ title: camp[0]!.title, date: weekDay(0) },
				{ lineage: 'lower-a', title: 'Lower A', date: weekDay(1) }
			],
			message: `A hard session on an overloaded system: ${camp[0]!.title} on Monday, then Lower A on Tuesday, with the nervous system still overloaded.`,
			why: CONCURRENT_RULES.residual_fatigue_before_hard.why
		});
		// Without Monday's sparring the same squats are fresh.
		const fresh = model(week, [], weekDay(0), weekDay(1));
		expect(evaluate(week, { load: { days: fresh, logged: [] } }).findings).toEqual([]);
	});
});

describe('PRD §2: high running volume vs. lower-body lifting recovery (S9)', () => {
	const MARATHON_BUILD: WeekContext['week'] = { kind: 'build', phase: 'marathon_build' };

	it('bigRunWeek with 18 lower-body hard sets flags run_volume_vs_leg_strength, naming the band', () => {
		const big = logged(HISTORIES.bigRunWeek(1));
		const [low, high] = RUN_LOAD_HIGH.band;
		const findings = evaluate([easyRun(6)], {
			load: { days: [], logged: big },
			week: MARATHON_BUILD
		}).findings;
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			rule: 'concurrent.run_volume_vs_leg_strength',
			severity: 'prefer',
			days: [weekDay(0), weekDay(3)]
		});
		expect(findings[0]!.message).toContain(
			`18 lower-body hard sets in a marathon build week, above the maintenance dose of ${low}–${high}`
		);
		// The same lifting in a week whose running is not high is left alone.
		expect(evaluate([easyRun(6)], { load: { days: [], logged: big } }).findings).toEqual([]);
	});

	it('RUN_LOAD_HIGH holds in a marathon build week with shortHistory, where M1’s ratio is null', () => {
		const short = logged(HISTORIES.shortHistory(0));
		const week = [lowerA(0), easyRun(2), legVolume(3)];
		const days = model(week, short, weekDay(-21), weekDay(0));
		const ours = days.filter((d) => d.date >= weekDay(0));
		expect(ours.every((d) => d.systems.aerobic.ratio === null)).toBe(true);
		const found = only(
			evaluate(week, { load: { days, logged: short }, week: MARATHON_BUILD }).findings,
			'run_volume_vs_leg_strength'
		);
		expect(found.map((f) => f.message)).toEqual([
			'Leg lifting above maintenance in a high-running week: 18 lower-body hard sets in a marathon build week, above the maintenance dose of 4–10: Lower A on Monday (7) and Legs volume on Thursday (11).'
		]);
		// An easy base week with the same history is not high.
		const base = evaluate(week, { load: { days, logged: short }, week: { kind: 'base' } });
		expect(only(base.findings, 'run_volume_vs_leg_strength')).toEqual([]);
	});
});

describe('the owner’s own exercises', () => {
	it('count in the set-based rules through the lookup evaluateWeek is given', () => {
		const catalogue = legVolume(3) as Extract<EvaluatedSession, { kind: 'strength' }>;
		const own = {
			...catalogue,
			exercises: catalogue.exercises.map((e) => ({
				...e,
				exercise: { customId: (e.exercise as { key: string }).key }
			}))
		};
		const traitsOf: TraitsOf = (ref) =>
			catalogueTraits('customId' in ref ? { key: ref.customId } : ref);
		const context: WeekContext = { week: { kind: 'build', phase: 'marathon_build' } };
		const judge = (session: EvaluatedSession) =>
			only(evaluateWeek([session], { context, traitsOf }).findings, 'run_volume_vs_leg_strength');
		expect(judge(catalogue)).toHaveLength(1);
		expect(judge(own)).toEqual(judge(catalogue));
	});
});

describe('spacing hard days', () => {
	it('three hard days in a row is avoid, but three commitments are not', () => {
		const three = evaluate([tempoRun(0), upperA(1), intervals(2)], BUILD).findings;
		expect(only(three, 'three_hard_days')).toMatchObject([
			{
				severity: 'avoid',
				days: [weekDay(0), weekDay(1), weekDay(2)],
				message:
					'Three hard days in a row: Tempo run on Monday, Upper A on Tuesday, Intervals on Wednesday.'
			}
		]);
		const classes = evaluate([sparring(0), sparring(1), sparring(2)], BUILD).findings;
		expect(only(classes, 'three_hard_days')).toEqual([]);
		// M3 alone never judged it.
		expect(rulesOf(evaluateWeek([tempoRun(0), upperA(1), intervals(2)]).findings)).not.toContain(
			'concurrent.three_hard_days'
		);
	});

	it('caps hard days by experience, and the sessions that tax the nervous system', () => {
		const week = [lowerA(0), intervals(2), upperA(4), sparring(6)];
		const novice = evaluate(week, { experience: 'novice' }).findings;
		expect(only(novice, 'hard_days_cap').map((f) => [f.severity, f.days])).toEqual([
			['prefer', [weekDay(0), weekDay(2), weekDay(4), weekDay(6)]]
		]);
		expect(only(evaluate(week, { experience: 'intermediate' }).findings, 'hard_days_cap')).toEqual(
			[]
		);
		expect(only(novice, 'weekly_cns_cap').map((f) => f.message)).toEqual([
			'Many sessions that tax the nervous system: 4 sessions of heavy lifting, intervals or sparring (Lower A on Monday, Intervals on Wednesday, Upper A on Friday and Muay Thai sparring on Sunday), against 3.'
		]);
		expect(only(evaluate(week.slice(1), BUILD).findings, 'weekly_cns_cap')).toEqual([]);
	});
});

describe('same day, with strength ranked first', () => {
	const morning = { timeOfDay: 'morning', orderInDay: 1 } as const;
	const evening = { timeOfDay: 'evening', orderInDay: 2 } as const;

	it('morning strength, then evening Muay Thai, is clean', () => {
		const week = [lowerA(0, morning), sparring(0, evening)];
		expect(evaluate(week, { priorities: strengthFirst }).findings).toEqual([]);
	});

	it('the reverse is prefer, and both in the morning is avoid', () => {
		const reverse = evaluate([sparring(0, morning), lowerA(0, evening)], {
			priorities: strengthFirst
		}).findings;
		expect(reverse.map((f) => [f.rule, f.severity, f.message])).toEqual([
			[
				'concurrent.same_day_priority_order',
				'prefer',
				'The higher-priority session comes second: Muay Thai sparring, then Lower A, on Monday; Lower A’s goal ranks higher, so it goes first.'
			]
		]);
		const both = evaluate([lowerA(0, morning), sparring(0, { ...morning, orderInDay: 2 })], {
			priorities: strengthFirst
		}).findings;
		expect(both.map((f) => [f.rule, f.severity])).toEqual([
			['concurrent.same_day_separation', 'avoid']
		]);
		// A hard session and a moderate one too close are advice only; six hours apart, nothing.
		const near = [lowerA(0, morning), accessories(0, { timeOfDay: 'midday', orderInDay: 2 })];
		expect(
			only(evaluate(near, BUILD).findings, 'same_day_separation').map((f) => [
				f.severity,
				f.message
			])
		).toEqual([
			[
				'prefer',
				'Two sessions too close together: Lower A in the morning, then Accessories at midday, on Monday: 5 hours apart, under 6.'
			]
		]);
		const apart = [lowerA(0, morning), accessories(0, { timeOfDay: 'afternoon', orderInDay: 2 })];
		expect(evaluate(apart, BUILD).findings).toEqual([]);
	});

	it('without priorities, M3’s same_day_order fires as before', () => {
		const week = [lowerA(0, morning), sparring(0, evening)];
		expect(rulesOf(evaluate(week, BUILD).findings)).toEqual(['placement.same_day_order']);
		expect(rulesOf(evaluateWeek(week).findings)).toEqual(['placement.same_day_order']);
	});
});

describe('limits', () => {
	it('heavy squats 4 days before a race give event_protection; 5 days do not', () => {
		const race = { date: weekDay(6), kind: 'other', title: 'City 10K' } as const;
		const close = evaluate([lowerA(2)], { events: [race] }).findings;
		expect(close.map((f) => [f.rule, f.severity, f.message])).toEqual([
			[
				'concurrent.event_protection',
				'avoid',
				'Too close to your event: Lower A on Wednesday, 4 days before City 10K on Sunday; keep heavy lower body at least 5 days out.'
			]
		]);
		expect(evaluate([lowerA(1)], { events: [race] }).findings).toEqual([]);
		const fight = { date: weekDay(6), kind: 'fight', title: 'Fight night' } as const;
		expect(rulesOf(evaluate([sparring(0)], { events: [fight] }).findings)).toEqual([
			'concurrent.event_protection'
		]);
		const meet = { date: weekDay(4), kind: 'meet', title: 'Meet' } as const;
		expect(evaluate([lowerA(0)], { events: [meet] }).findings).toEqual([]);
		const heavy = lowerA(1, {
			exercises: [
				{
					exercise: { key: 'back_squat' },
					sets: [{ role: 'working', sets: 1, targetRpe: 9, loadKind: 'rpe_based', loadValue: null }]
				}
			]
		} as Over);
		expect(rulesOf(evaluate([heavy], { events: [meet] }).findings)).toEqual([
			'concurrent.event_protection'
		]);
	});

	it('an RPE 8 session in a deload or recovery week gives recovery_week_limits; a cutback week’s strength is not limited', () => {
		for (const kind of ['deload', 'recovery'] as const) {
			expect(
				only(evaluate([lowerA(0)], { week: { kind } }).findings, 'recovery_week_limits')
			).toMatchObject([{ severity: 'avoid', sessions: [{ title: 'Lower A' }] }]);
		}
		expect(evaluate([lowerA(0)], { week: { kind: 'cutback' } }).findings).toEqual([]);
		// The week's own targets win over the default cap.
		const own = { rpeCap: 8, volumeFactor: 0.6, loadStep: 0, runVolumeFactor: 0.7 };
		expect(evaluate([lowerA(0)], { week: { kind: 'deload', targets: own } }).findings).toEqual([]);
		// A cutback week limits its running minutes.
		const runs = [easyRun(1), easyRun(3)];
		const cutback = evaluate(runs, { week: { kind: 'cutback', runMinutesTarget: 60 } }).findings;
		expect(cutback.map((f) => f.message)).toEqual([
			'Harder than this light week allows: 80 minutes of running (Easy run on Tuesday and Easy run on Thursday), above this cutback week’s 60.'
		]);
	});

	it('a third hard sparring session gives sparring_cap', () => {
		const two = evaluate([sparring(0), sparring(3)], BUILD).findings;
		expect(only(two, 'sparring_cap')).toEqual([]);
		const three = evaluate([sparring(0), sparring(2), sparring(4)], BUILD).findings;
		expect(only(three, 'sparring_cap').map((f) => [f.severity, f.days])).toEqual([
			['avoid', [weekDay(0), weekDay(2), weekDay(4)]]
		]);
	});
});

describe('costs and trade-offs', () => {
	it('costs scale with the harmed goal’s weight', () => {
		const race = { date: weekDay(6), kind: 'other', title: 'City 10K', goalId: 'race' } as const;
		const ranked = (rank: number) => [
			goal('Race', ['running'], rank),
			goal('Lift', ['strength'], 1 - rank)
		];
		const at = (rank: number) =>
			evaluate([lowerA(2)], { events: [race], priorities: ranked(rank) });
		expect(evaluate([lowerA(2)], { events: [race] }).score).toBe(100 - SCORE_WEIGHTS.avoid);
		expect(at(0).score).toBe(100 - SCORE_WEIGHTS.avoid * RANK_WEIGHTS[0]);
		// Second in line, the race gives way to the lifting, at half the cost.
		expect(at(1).score).toBe(
			Math.round(100 - SCORE_WEIGHTS.avoid * RANK_WEIGHTS[1] * SCORE_WEIGHTS.resolved)
		);
		// M3's findings (heavy legs before sparring, and the two hard days back to back) are
		// weighted the same way, by the later session's goal: Fight, second in line.
		const fightSecond = [
			goal('Marathon', ['running'], 0),
			goal('Fight', ['muay_thai'], 1),
			goal('Lift', ['strength'], 2)
		];
		const s2 = evaluateWeek(PRD_WEEKS.squat_before_sparring(), {
			context: { priorities: fightSecond }
		});
		expect(s2.findings.every((f) => f.resolution === undefined)).toBe(true);
		const m3Cost = SCORE_WEIGHTS.avoid + SCORE_WEIGHTS.prefer;
		expect(evaluateWeek(PRD_WEEKS.squat_before_sparring()).score).toBe(100 - m3Cost);
		expect(s2.score).toBe(Math.round(100 - m3Cost * RANK_WEIGHTS[1]));
	});

	it('a conflict a higher-priority goal holds carries tradeoffSentence, at half its cost', () => {
		const liftFirst = [goal('Lift', ['strength'], 0), goal('Fight', ['muay_thai'], 2)];
		const { findings, score } = evaluateWeek(PRD_WEEKS.squat_before_sparring(), {
			context: { priorities: liftFirst }
		});
		const heavy = findings.find((f) => f.rule === 'placement.heavy_lower_before_hard')!;
		expect(heavy.resolution).toEqual({
			kind: 'priority_kept',
			text: tradeoffSentence(liftFirst[0]!, liftFirst[1]!, heavy.headline)
		});
		expect(findings.every((f) => f.resolution?.kind === 'priority_kept')).toBe(true);
		const cost = (SCORE_WEIGHTS.avoid + SCORE_WEIGHTS.prefer) * RANK_WEIGHTS[2];
		expect(score).toBe(Math.round(100 - cost * SCORE_WEIGHTS.resolved));
	});

	it('lifting kept over a lower-ranked race or running goal names the goal it harms', () => {
		const [lift, race] = [goal('Lift', ['strength'], 0), goal('Race', ['running'], 1)];
		const event = {
			date: weekDay(6),
			kind: 'other',
			title: 'City 10K',
			goalId: race.goalId
		} as const;
		const raced = evaluate([lowerA(2)], { events: [event], priorities: [race, lift] });
		expect(raced.findings.map((f) => [f.rule, f.resolution])).toEqual([
			[
				'concurrent.event_protection',
				{
					kind: 'priority_kept',
					text: tradeoffSentence(lift, race, CONCURRENT_RULES.event_protection.headline)
				}
			]
		]);
		expect(raced.score).toBe(
			Math.round(100 - SCORE_WEIGHTS.avoid * RANK_WEIGHTS[1] * SCORE_WEIGHTS.resolved)
		);
		expect(raced.grade).not.toBe('conflicts');
		const built = evaluate([lowerA(0), legVolume(3)], {
			week: { kind: 'build', phase: 'marathon_build' },
			priorities: [race, lift]
		});
		expect(only(built.findings, 'run_volume_vs_leg_strength')[0]!.resolution).toEqual({
			kind: 'priority_kept',
			text: tradeoffSentence(lift, race, CONCURRENT_RULES.run_volume_vs_leg_strength.headline)
		});
	});
});

describe('determinism', () => {
	/** A fixed shuffle: reversed, then every other one moved to the end. */
	const shuffled = <T>(items: readonly T[]) => {
		const reversed = [...items].reverse();
		return [...reversed.filter((_, i) => i % 2 === 0), ...reversed.filter((_, i) => i % 2 === 1)];
	};

	it('findings are order-independent, each with its why and a registered rule', () => {
		const camp = logged(HISTORIES.hardCampWeek(1));
		const week = [
			lowerA(1),
			intervals(2),
			sparring(3),
			sparring(4, { timeOfDay: 'morning' }),
			lowerA(4, { timeOfDay: 'midday', orderInDay: 2, lineage: 'lower-b', title: 'Lower B' }),
			sparring(5)
		];
		const days = model(week, camp, weekDay(0), weekDay(1));
		const context: WeekContext = {
			load: { days, logged: camp },
			priorities: strengthFirst,
			week: { kind: 'deload' },
			events: [{ date: weekDay(6), kind: 'fight', title: 'Fight night' }],
			experience: 'new'
		};
		const forward = evaluate(week, context);
		const reversed = evaluate(shuffled(week), {
			...context,
			load: { days, logged: shuffled(camp) },
			priorities: shuffled(strengthFirst)
		});
		expect(reversed).toEqual(forward);
		const concurrent = forward.findings.filter((f) => f.area === 'concurrent');
		expect(new Set(concurrent.map((f) => f.rule))).toEqual(
			new Set(
				Object.keys(CONCURRENT_RULES)
					.filter((rule) => rule !== 'run_volume_vs_leg_strength')
					.map((rule) => `concurrent.${rule}`)
			)
		);
		for (const f of forward.findings) {
			expect(f.why.length).toBeGreaterThan(20);
			expect(RULE_BY_ID.get(f.rule)).toMatchObject({ area: f.area, status: 'active' });
			expect(f.message.startsWith(`${f.headline}:`)).toBe(true);
		}
		const firstDays = forward.findings.map((f) => f.days[0]!);
		expect(firstDays).toEqual([...firstDays].sort());
	});

	it('same-day findings for several events do not follow the events’ order', () => {
		const events = [
			{ date: weekDay(5), kind: 'other', title: 'Parkrun' },
			{ date: weekDay(6), kind: 'other', title: 'City 10K' }
		] as const;
		const forward = evaluate([lowerA(2)], { events });
		expect(only(forward.findings, 'event_protection')).toHaveLength(2);
		expect(evaluate([lowerA(2)], { events: [...events].reverse() })).toEqual(forward);
	});

	it('without a context the week is judged exactly as before', () => {
		const week = PRD_WEEKS.squat_before_sparring();
		expect(evaluateWeek(week, { context: {} })).toEqual(evaluateWeek(week));
	});
});
