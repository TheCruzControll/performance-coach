/**
 * other.ts: a custom-discipline goal's named sessions with their decision; Muay Thai technique
 * by default and the Muay Thai profile's formats when told; mobility on free days no goal asks
 * for; and every run segment list and metrics array the generator writes, in every scenario,
 * passes the domain schemas.
 */
import { describe, expect, it } from 'vitest';
import { CATALOGUE } from '../exercises/index';
import type { Goal, Schedule, TrainingProfile } from '../profile/types';
import {
	customMetricsSchema,
	otherDetailsSchema,
	programPlanSchema,
	runSegmentsSchema
} from '../training/schemas';
import type { OtherSessionPlan, WeekPlan } from '../training/types';
import { validate } from '../validation';
import { DecisionLog } from './decisions';
import { generateProgram, STAGES } from './generate';
import { buildProgrammingInput } from './input';
import { SCENARIO_START, SCENARIOS } from './scenarios';
import type { Draft } from './stage';

const OPTIONS = { startsOn: SCENARIO_START, firstPlannedDay: SCENARIO_START };
const inputOf = (profile: TrainingProfile) =>
	buildProgrammingInput(profile, { catalogue: CATALOGUE });

/** The draft once every stage up to and including `other` has run. */
function plan(profile: TrainingProfile) {
	const input = inputOf(profile);
	const context = { input, options: OPTIONS, log: new DecisionLog() };
	let draft: Draft = { demand: null, blocks: [] };
	for (const stage of STAGES) {
		draft = stage.run(draft, context);
		if (stage.name === 'other') break;
	}
	const weeks = draft.blocks.filter((b) => !b.outline).flatMap((b) => b.weeks);
	return { input, weeks, decisions: context.log.list() };
}

const others = (week: WeekPlan) =>
	week.sessions.filter(
		(s): s is OtherSessionPlan => s.kind === 'other' && s.source === 'generator'
	);

function variant(schedule: Partial<Schedule>, goal: Partial<Goal>): TrainingProfile {
	const p = SCENARIOS.minimal();
	return {
		...p,
		goals: [{ ...p.goals[0]!, ...goal }],
		schedule: { ...p.schedule, ...schedule }
	};
}

const BOULDERING: Partial<Goal> = {
	title: 'Climb V5',
	disciplines: ['custom'],
	customDiscipline: 'Bouldering'
};
const MUAY_THAI: Partial<Goal> = { title: 'Muay Thai', disciplines: ['muay_thai'] };

describe('planOther', () => {
	it('gives a custom-discipline goal sessions titled with its name, at RPE 6 for the session length', () => {
		const { weeks, decisions } = plan(variant({ daysPerWeek: 2 }, BOULDERING));
		const paths: string[] = [];
		weeks.forEach((week, w) => {
			const sessions = others(week);
			expect(sessions).toHaveLength(2);
			for (const s of sessions) {
				expect(s).toMatchObject({
					type: 'custom',
					title: 'Bouldering',
					discipline: 'custom',
					customDiscipline: 'Bouldering',
					intensity: 'moderate',
					estMinutes: 60,
					targetRpe: 6,
					estLoad: 360,
					details: { kind: 'custom', durationMinutes: 60, targetRpe: 6, metrics: [], notes: null }
				});
				paths.push(`blocks.0.weeks.${w}.sessions.${week.sessions.indexOf(s)}`);
			}
			expect(new Set(sessions.map((s) => s.date)).size).toBe(2);
		});
		const decision = decisions.find((d) => d.ruleKey === 'other.custom_sessions')!;
		expect(decision).toMatchObject({
			kind: 'default_assumed',
			summary: 'Assumed 2 Bouldering sessions a week of 60 min at RPE 6',
			refs: paths
		});
		expect(decision.why).toBe(
			'You haven’t told the coach what your Bouldering sessions hold. The coach assumed 2 Bouldering sessions a week of 60 min at RPE 6. Their content is your own: the coach plans their time and effort around the rest of your week, and you decide what goes in them. Change it in Profile → Schedule.'
		);
	});

	it('plans Muay Thai technique at RPE 6 when there is no class and no Muay Thai profile', () => {
		const { weeks, decisions } = plan(variant({}, MUAY_THAI));
		for (const s of weeks.flatMap(others)) {
			expect(s).toMatchObject({
				type: 'muay_thai',
				title: 'Muay Thai technique',
				discipline: 'muay_thai',
				targetRpe: 6,
				details: {
					kind: 'technical',
					durationMinutes: 60,
					metrics: [
						{ key: 'rounds', label: 'Rounds', unit: null, value: 8 },
						{ key: 'round_length', label: 'Round length', unit: 'min', value: 3 }
					]
				}
			});
		}
		expect(weeks.map((w) => others(w).length)).toEqual([3, 3, 3, 3, 3]);
		expect(decisions.map((d) => d.ruleKey)).toContain('defaults.muay_thai_sessions');
	});

	it('takes turns with pad work when the Muay Thai profile is told, sparring only in building weeks', () => {
		const p = variant({ daysPerWeek: 4 }, MUAY_THAI);
		p.muayThai = {
			sessionsPerWeek: 4,
			sparringPerWeek: 1,
			fights: 2,
			notes: null,
			updatedAt: new Date(0)
		};
		const { weeks } = plan(p);
		const kinds = weeks.map((w) => others(w).map((s) => s.details.kind));
		expect(kinds[0]).toEqual(['technical', 'pad_work', 'technical', 'pad_work']);
		expect(kinds[1]).toEqual(['technical', 'pad_work', 'technical', 'sparring']);
		expect(kinds[4]).toEqual(['technical', 'pad_work', 'technical', 'pad_work']);
		weeks.forEach((week) => {
			for (const s of others(week)) expect(s.targetRpe).toBeLessThanOrEqual(week.targets.rpeCap);
		});
		expect(others(weeks[1]!).at(-1)).toMatchObject({ title: 'Muay Thai sparring', targetRpe: 7.5 });
	});

	it('gives each free day no goal asks for a short, easy mobility session', () => {
		const { weeks } = plan(variant({ daysPerWeek: 6 }, {}));
		for (const week of weeks) {
			const mobility = others(week);
			expect(mobility).toHaveLength(2);
			for (const s of mobility) {
				expect(s).toMatchObject({
					type: 'mobility',
					title: 'Mobility',
					discipline: 'athletic',
					intensity: 'easy',
					estMinutes: 30,
					targetRpe: 3,
					details: { kind: 'mobility', durationMinutes: 30, metrics: [] }
				});
			}
		}
		const short = plan(variant({ daysPerWeek: 6, sessionMinutes: 20 }, {}));
		expect(others(short.weeks[0]!).map((s) => s.estMinutes)).toEqual([20, 20]);
	});

	const profiles: Record<string, () => TrainingProfile> = {
		...SCENARIOS,
		bouldering: () => variant({ daysPerWeek: 2 }, BOULDERING),
		muayThai: () => variant({ daysPerWeek: 4 }, MUAY_THAI),
		mobility: () => variant({ daysPerWeek: 6 }, {})
	};

	/** The profiles with runs or other sessions; the rest train strength alone. */
	const MIXED = ['hybrid', 'journey', 'bouldering', 'muayThai', 'mobility'];

	it.each(Object.keys(profiles))(
		'writes run segments and metrics the domain schemas accept: %s',
		(key) => {
			const generated = generateProgram(inputOf(profiles[key]!()), OPTIONS);
			expect(validate(programPlanSchema, generated).ok).toBe(true);
			const sessions = generated.blocks.flatMap((b) => b.weeks).flatMap((w) => w.sessions);
			const checked = sessions.filter((s) => s.kind === 'run' || s.kind === 'other');
			if (MIXED.includes(key)) expect(checked.length).toBeGreaterThan(0);
			for (const session of checked) {
				if (session.kind === 'run') {
					expect(validate(runSegmentsSchema, session.segments)).toEqual({
						ok: true,
						data: session.segments
					});
				}
				if (session.kind === 'other') {
					expect(validate(customMetricsSchema, session.details.metrics).ok).toBe(true);
					expect(validate(otherDetailsSchema, session.details)).toEqual({
						ok: true,
						data: session.details
					});
				}
			}
		}
	);
});
