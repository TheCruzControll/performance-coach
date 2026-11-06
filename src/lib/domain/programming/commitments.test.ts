/**
 * commitments.ts: each fixed commitment becomes a session of its own discipline on its weekdays
 * in every planned week, with its time of day, its told or defaulted duration and intensity and
 * the commitment it comes from, counted toward its quota, with one commitment_placed decision.
 */
import { describe, expect, it } from 'vitest';
import { CATALOGUE } from '../exercises/index';
import { plannedHardSets } from '../training/metrics';
import type { Commitment, Goal, Schedule, TrainingProfile } from '../profile/types';
import type { BlockPlan, SessionPlan } from '../training/types';
import { DecisionLog } from './decisions';
import { generatedFor } from './demand';
import { STAGES } from './generate';
import { buildProgrammingInput } from './input';
import { SCENARIO_START, SCENARIOS, scenarioDay } from './scenarios';
import type { Draft, GenerateOptions } from './stage';

const OPTIONS = { startsOn: SCENARIO_START, firstPlannedDay: SCENARIO_START };

/** The draft once every stage up to and including `through` has run. */
function plan(profile: TrainingProfile, through: string, options: GenerateOptions = OPTIONS) {
	const input = buildProgrammingInput(profile, { catalogue: CATALOGUE });
	const context = { input, options, log: new DecisionLog() };
	let draft: Draft = { demand: null, blocks: [] };
	for (const stage of STAGES) {
		draft = stage.run(draft, context);
		if (stage.name === through) break;
	}
	return { input, draft, decisions: context.log.list() };
}

const weeksOf = (blocks: BlockPlan[]) => blocks.filter((b) => !b.outline).flatMap((b) => b.weeks);
const fixed = (blocks: BlockPlan[]) =>
	weeksOf(blocks).map((w) => w.sessions.filter((s) => s.source === 'commitment'));
const at = (blocks: BlockPlan[], path: string): SessionPlan => {
	const [, b, , w, , s] = path.split('.').map(Number);
	return blocks[b!]!.weeks[w!]!.sessions[s!]!;
};

const club = (over: Partial<Commitment> & Pick<Commitment, 'discipline' | 'days'>): Commitment => ({
	id: '00000000-0000-4000-8000-000000000299',
	label: 'Club',
	timeOfDay: 'evening',
	durationMinutes: 60,
	intensity: 'moderate',
	notes: null,
	...over
});

function variant(schedule: Partial<Schedule>, goals?: Goal[]): TrainingProfile {
	const p = SCENARIOS.minimal();
	return { ...p, goals: goals ?? p.goals, schedule: { ...p.schedule, ...schedule } };
}

describe('placeCommitments', () => {
	it('turns Tue/Thu Muay Thai classes into evening sessions on those dates every week, with a decision', () => {
		const { draft, input, decisions } = plan(SCENARIOS.hybrid(), 'commitments');
		const weeks = fixed(draft.blocks);
		expect(weeks).toHaveLength(5);
		weeks.forEach((sessions, w) => {
			expect(sessions.map((s) => s.date)).toEqual([scenarioDay(w + 1, 1), scenarioDay(w + 1, 3)]);
			for (const s of sessions) {
				expect(s).toMatchObject({
					kind: 'other',
					type: 'muay_thai',
					title: 'Muay Thai class',
					discipline: 'muay_thai',
					customDiscipline: null,
					timeOfDay: 'evening',
					orderInDay: 1,
					intensity: 'hard',
					estMinutes: 90,
					targetRpe: 8,
					estLoad: 720,
					source: 'commitment',
					commitmentRef: input.refs.commitments[0],
					details: { kind: 'class', durationMinutes: 90, targetRpe: 8, metrics: [], notes: null }
				});
			}
		});
		const placed = decisions.filter((d) => d.kind === 'commitment_placed');
		expect(placed).toHaveLength(1);
		expect(placed[0]!.summary).toBe('Muay Thai class on Tuesday and Thursday');
		expect(placed[0]!.why).toBe(
			'Muay Thai class is one of your fixed commitments, so it goes in first, every Tuesday and Thursday (evening), for 90 min at hard intensity, and the rest of the week is planned around it. It counts as one of your Muay Thai sessions.'
		);
		expect(placed[0]!.refs).toHaveLength(10);
		expect(placed[0]!.refs.map((path) => at(draft.blocks, path))).toEqual(weeks.flat());
	});

	it('places nothing before the first planned day, and orders a day’s commitments by time', () => {
		// Sorted by content the Muay Thai class comes first; by time the morning class does.
		const lifting = club({
			discipline: 'strength',
			label: 'Lifting class',
			days: ['tue', 'thu'],
			timeOfDay: 'morning'
		});
		const p = SCENARIOS.hybrid();
		p.schedule.commitments.push(lifting);
		const { draft, input } = plan(p, 'commitments', {
			...OPTIONS,
			firstPlannedDay: scenarioDay(1, 2)
		});
		expect(input.commitments.map((c) => c.label)).toEqual(['Muay Thai class', 'Lifting class']);
		const [week1, week2] = fixed(draft.blocks);
		expect(week1!.map((s) => [s.date, s.title, s.orderInDay])).toEqual([
			[scenarioDay(1, 3), 'Lifting class', 1],
			[scenarioDay(1, 3), 'Muay Thai class', 2]
		]);
		expect(week2!.map((s) => [s.date, s.title, s.timeOfDay])).toEqual([
			[scenarioDay(2, 1), 'Lifting class', 'morning'],
			[scenarioDay(2, 1), 'Muay Thai class', 'evening'],
			[scenarioDay(2, 3), 'Lifting class', 'morning'],
			[scenarioDay(2, 3), 'Muay Thai class', 'evening']
		]);
		expect(week2![0]).toMatchObject({ type: 'strength_class', discipline: 'strength' });
	});

	it('makes a Wednesday running club of 60 min a timed run, with one generated run fewer', () => {
		const running: Goal = {
			...SCENARIOS.minimal().goals[0]!,
			title: 'Run more',
			disciplines: ['running']
		};
		const without = plan(variant({ daysPerWeek: 4 }, [running]), 'commitments');
		const wednesday = club({ discipline: 'running', label: 'Running club', days: ['wed'] });
		const { draft, decisions } = plan(
			variant({ daysPerWeek: 4, commitments: [wednesday] }, [running]),
			'commitments'
		);
		expect(generatedFor(draft.demand!.allocation, 'runs')).toBe(
			generatedFor(without.draft.demand!.allocation, 'runs') - 1
		);
		expect(fixed(draft.blocks)[0]).toEqual([
			expect.objectContaining({
				kind: 'run',
				type: 'easy_run',
				date: scenarioDay(1, 2),
				discipline: 'running',
				estMinutes: 60,
				targetRpe: 6,
				segments: [
					{
						kind: 'steady',
						repeatGroup: null,
						repeats: null,
						distanceMetres: null,
						durationSeconds: 3600,
						paceMinSecondsPerKm: null,
						paceMaxSecondsPerKm: null,
						hrZone: 3,
						targetRpe: 6
					}
				]
			})
		]);
		expect(decisions.find((d) => d.kind === 'commitment_placed')!.why).toContain(
			'It counts as one of your runs, and its 60 minutes count toward your weekly running.'
		);
	});

	it('counts a strength class as a strength day with no hard sets credited', () => {
		const crossfit = club({
			discipline: 'strength',
			label: 'CrossFit class',
			days: ['mon'],
			intensity: 'hard'
		});
		const without = plan(variant({}), 'commitments');
		const { draft, decisions } = plan(variant({ commitments: [crossfit] }), 'commitments');
		const strength = draft.demand!.allocation.streams.find((s) => s.stream === 'strength')!;
		expect(strength).toMatchObject({ committed: 1 });
		expect(strength.generated).toBe(generatedFor(without.draft.demand!.allocation, 'strength') - 1);
		const [session] = fixed(draft.blocks)[0]!;
		expect(session).toMatchObject({
			kind: 'other',
			type: 'strength_class',
			discipline: 'strength',
			intensity: 'hard',
			targetRpe: 8,
			details: { kind: 'class', durationMinutes: 60, targetRpe: 8 }
		});
		expect(plannedHardSets(weeksOf(draft.blocks)[0]!, new Map()).groups).toEqual({});
		expect(decisions.find((d) => d.kind === 'commitment_placed')!.why).toContain(
			'It counts as one of your strength days. The class sets its content, so no hard sets are credited for it.'
		);
	});

	it('says when no goal trains a commitment, so it adds to the week', () => {
		const wednesday = club({ discipline: 'running', label: 'Running club', days: ['wed'] });
		const { decisions } = plan(variant({ commitments: [wednesday] }), 'commitments');
		expect(decisions.find((d) => d.kind === 'commitment_placed')!.why).toContain(
			'No goal of yours trains it, so it adds to your week rather than taking a planned session’s place.'
		);
	});

	it('gives a commitment with no duration or intensity the defaults, with decisions', () => {
		const { draft, decisions } = plan(SCENARIOS.journey(), 'commitments');
		for (const s of fixed(draft.blocks).flat()) {
			expect(s).toMatchObject({
				estMinutes: 90,
				intensity: 'moderate',
				targetRpe: 6,
				estLoad: 540
			});
		}
		const assumed = decisions.filter((d) => d.kind === 'default_assumed').map((d) => d.evidence);
		expect(assumed).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ field: 'commitments.0.intensity', value: 'moderate' }),
				expect.objectContaining({ field: 'commitments.0.durationMinutes', value: 90 })
			])
		);
		expect(decisions.find((d) => d.kind === 'commitment_placed')!.why).toMatch(
			/for 90 min at moderate intensity, .* You haven’t said how long it lasts or how hard it is, so the coach assumed both\.$/
		);
		const told = SCENARIOS.journey();
		told.schedule.commitments[0]!.durationMinutes = 75;
		const placed = plan(told, 'commitments').decisions.find((d) => d.kind === 'commitment_placed')!;
		expect(placed.why).toMatch(/You haven’t said how hard it is, so the coach assumed it\.$/);
	});
});
