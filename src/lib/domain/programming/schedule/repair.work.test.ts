/**
 * schedule/repair.ts's work, counted rather than timed: the canonical JSON it writes (random.ts's
 * canonicalJson, counted through a pass-through mock). A repair evaluates about a hundred weeks,
 * and checkConcurrent wrote JSON for every session of every one of them: a third of its time. A
 * count holds on any machine, where the 100 ms budget in repair.test.ts is a clock.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Random from '../random';

const written = vi.hoisted(() => ({ count: 0 }));
vi.mock('../random', async (original) => {
	const actual = await original<typeof Random>();
	return {
		...actual,
		canonicalJson: (value: unknown) => {
			written.count += 1;
			return actual.canonicalJson(value);
		}
	};
});

import { addDays } from '../../calendar';
import { CATALOGUE } from '../../exercises/index';
import { checkConcurrent } from '../evaluate/concurrent';
import type { WeekContext } from '../evaluate/concurrent';
import type { EvaluatedSession } from '../evaluate/week';
import { buildProgrammingInput, generateProgram } from '../index';
import { M7_SCENARIOS } from '../periodisation/scenarios';
import { PRD_WEEKS, weekDay } from '../periodisation/weeks';
import { effectivePriorities } from '../priority/weights';
import { SCENARIO_START } from '../scenarios';
import { repairWeek } from './repair';
import type { RepairContext } from './repair';

beforeEach(() => {
	written.count = 0;
});

describe('checkConcurrent: canonical JSON only to break a tie', () => {
	const [lowerA, sparring, easyRun] = PRD_WEEKS.squat_before_sparring();
	const context: WeekContext = { week: { kind: 'build' } };

	it('writes none when no two sessions share a date and an order in the day', () => {
		const week = [lowerA!, sparring!, easyRun!].map((s, n) => ({ ...s, date: weekDay(n * 2) }));
		checkConcurrent(week, context);
		expect(written.count).toBe(0);
	});

	it('writes one for each session of a tie, and keeps the order the JSON gives', () => {
		const tied = [
			{ ...easyRun!, date: weekDay(0), orderInDay: 1 },
			{ ...lowerA!, date: weekDay(0), orderInDay: 1 },
			{ ...sparring!, date: weekDay(3) }
		];
		const findings = checkConcurrent(tied, context);
		expect(written.count).toBe(2);
		expect(checkConcurrent(tied.toReversed(), context)).toEqual(findings);
	});
});

describe('repairWeek: canonical JSON per session, not per week evaluated', () => {
	const input = buildProgrammingInput(M7_SCENARIOS.multiGoal(), { catalogue: CATALOGUE });
	const plan = generateProgram(input, {
		startsOn: SCENARIO_START,
		firstPlannedDay: SCENARIO_START
	});
	const week = plan.blocks[0]!.weeks[1]!;
	const ctx: RepairContext = {
		open: Array.from({ length: 7 }, (_, n) => addDays(week.startsOn, n)),
		preferredTimes: input.preferredTimes,
		priorities: effectivePriorities(input, week.startsOn),
		level: 'intermediate',
		week: { kind: week.kind }
	};
	const lowerA = PRD_WEEKS.squat_before_sparring()[0]!;
	const clash: EvaluatedSession[] = [
		...week.sessions.map((s) => ({ ...s })),
		{ ...lowerA, date: week.startsOn }
	];

	it('writes under three canonical JSONs an evaluation on multiGoal’s clashing week', () => {
		const r = repairWeek(clash, ctx);
		expect(r.evaluations).toBeGreaterThan(50);
		// The week's one lasting tie costs checkConcurrent two an evaluation; the rest is a few
		// per session: ordering the given and repaired weeks, and trying each one's easier version.
		expect(written.count).toBeLessThan(3 * r.evaluations);
	});
});
