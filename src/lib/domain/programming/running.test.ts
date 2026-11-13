/**
 * running.ts: no runs without a running goal; easy runs only for a new runner; the time-based
 * week 1 with no running specifics; one quality session when warranted; week 1 at the current
 * volume, then at most +10 % a week, growing with three runs too, with the deload dropping it;
 * fewer runs for a week too small for them; the long run's two caps and its session-length
 * trade-off; paces from a race or the easy pace, else effort; the marathon hooks.
 */
import { describe, expect, it } from 'vitest';
import { CATALOGUE } from '../exercises/index';
import type { Goal, RaceResult, RunningProfile, TrainingProfile } from '../profile/types';
import { runSegmentsSchema } from '../training/schemas';
import type { BlockPlan, RunSessionPlan, WeekPlan } from '../training/types';
import type { ExperienceLevel } from '../profile/catalog';
import { validate } from '../validation';
import { DecisionLog } from './decisions';
import { STAGES } from './generate';
import { buildProgrammingInput } from './input';
import { paceFor, trainingPaces, vdotFromEasyPace, vdotFromPerformance } from './paces';
import { MARATHON_HOOKS } from './rules/running';
import { SCENARIO_START, SCENARIOS, scenarioDay } from './scenarios';
import type { Draft, GenerateOptions } from './stage';

const OPTIONS = { startsOn: SCENARIO_START, firstPlannedDay: SCENARIO_START };

/** The draft once every stage up to and including `through` has run. */
function plan(profile: TrainingProfile, options: GenerateOptions = OPTIONS) {
	const input = buildProgrammingInput(profile, { catalogue: CATALOGUE });
	const context = { input, options, log: new DecisionLog() };
	let draft: Draft = { demand: null, blocks: [] };
	for (const stage of STAGES) {
		draft = stage.run(draft, context);
		if (stage.name === 'running') break;
	}
	const weeks = draft.blocks.filter((b) => !b.outline).flatMap((b) => b.weeks);
	const decision = (kind: string) => context.log.list().find((d) => d.kind === kind);
	return { input, blocks: draft.blocks, weeks, decisions: context.log.list(), decision };
}

const generated = (week: WeekPlan) =>
	week.sessions.filter((s): s is RunSessionPlan => s.kind === 'run' && s.source === 'generator');
const allRuns = (week: WeekPlan) =>
	week.sessions.filter((s): s is RunSessionPlan => s.kind === 'run');
const metres = (run: RunSessionPlan) =>
	run.segments.reduce((sum, s) => sum + (s.distanceMetres ?? 0) * (s.repeats ?? 1), 0);
const minutes = (run: RunSessionPlan) =>
	run.segments.reduce((sum, s) => sum + ((s.durationSeconds ?? 0) * (s.repeats ?? 1)) / 60, 0);
const total = (week: WeekPlan, size = metres) => generated(week).reduce((n, r) => n + size(r), 0);
const longRun = (week: WeekPlan) => generated(week).find((r) => r.type === 'long_run');

const AT = new Date('2026-11-01T08:00:00Z');
const running = (over: Partial<RunningProfile> = {}): RunningProfile => ({
	unit: 'km',
	weeklyDistance: null,
	runsPerWeek: null,
	longestRun: null,
	easyPaceSeconds: null,
	races: [],
	notes: null,
	updatedAt: AT,
	...over
});
const tenK: RaceResult = {
	id: '00000000-0000-4000-8000-000000000601',
	distance: '10k',
	customDistance: null,
	distanceMetres: 10_000,
	timeSeconds: 50 * 60,
	racedOn: '2026-10-04',
	eventName: null
};

/** A running goal (general unless given), at `level` if told, on 4 days of 60 minutes. */
function runner(level: ExperienceLevel | null, specifics: RunningProfile | null, goal?: Goal) {
	const p = SCENARIOS.minimal();
	const g = goal ?? { ...p.goals[0]!, title: 'Run more', disciplines: ['running'] };
	const entry = SCENARIOS.hybrid().experience[0]!;
	return {
		...p,
		goals: [g],
		experience: level ? [{ ...entry, discipline: g.disciplines[0]!, level }] : [],
		running: specifics,
		schedule: { ...p.schedule, daysPerWeek: 4, sessionMinutes: 60 }
	} satisfies TrainingProfile;
}

describe('planRuns', () => {
	it('gives no runs without a running discipline, only a running commitment’s own', () => {
		const strength = plan(SCENARIOS.beginner());
		expect(strength.weeks.flatMap(allRuns)).toEqual([]);
		const hooks = strength.blocks.flatMap((b) => Object.keys(b.progression));
		expect(hooks.filter((key) => /^(run|longRun|quality)/.test(key))).toEqual([]);
		for (const kind of ['run_volume', 'run_pace_source', 'quality_session']) {
			expect(strength.decision(kind)).toBeUndefined();
		}
		const p = SCENARIOS.beginner();
		p.schedule.commitments.push({
			id: '00000000-0000-4000-8000-000000000299',
			discipline: 'running',
			label: 'Parkrun',
			days: ['sat'],
			timeOfDay: 'morning',
			durationMinutes: 30,
			intensity: 'hard',
			notes: null
		});
		const club = plan(p);
		expect(club.weeks.map((w) => allRuns(w).map((r) => [r.title, r.source]))).toEqual(
			club.weeks.map(() => [['Parkrun', 'commitment']])
		);
	});

	it('gives a new runner easy runs only, by time, each with an RPE and a heart-rate zone', () => {
		const { weeks, decision } = plan(runner(null, null));
		expect(generated(weeks[0]!).map(minutes)).toEqual([30, 30, 30, 30]);
		for (const run of weeks.flatMap(generated)) {
			expect(run).toMatchObject({ type: 'easy_run', intensity: 'easy', targetRpe: 4.5 });
			expect(run.segments).toEqual([
				expect.objectContaining({
					kind: 'easy',
					distanceMetres: null,
					paceMinSecondsPerKm: null,
					hrZone: 2,
					targetRpe: 4.5
				})
			]);
		}
		expect(decision('quality_session')).toMatchObject({
			summary: 'Quality running: easy running only',
			why: expect.stringContaining('You’re new to running, so every run is easy'),
			refs: []
		});
	});

	it('plans a time-based week 1 with no running specifics: easy runs of 30 min and a 45-minute long run', () => {
		const { weeks, decision, decisions } = plan(runner('novice', null));
		expect(generated(weeks[0]!).map((r) => [r.type, minutes(r)])).toEqual([
			['easy_run', 30],
			['easy_run', 30],
			['easy_run', 30],
			['long_run', 45]
		]);
		expect(total(weeks[1]!, minutes)).toBeGreaterThan(135);
		expect(total(weeks[1]!, minutes)).toBeLessThanOrEqual(135 * 1.1);
		expect(minutes(longRun(weeks[1]!)!)).toBeLessThanOrEqual(45 * 1.1);
		expect(weeks.flatMap(generated).filter((r) => r.intensity === 'hard')).toEqual([]);
		expect(decision('run_volume')).toMatchObject({
			summary: 'Week 1 running: 135 min over 4 runs',
			refs: ['blocks.0.weeks.0']
		});
		expect(decision('run_volume')!.why).toContain(
			'time and effort, since you haven’t said how much you run: easy runs of 30 min at RPE 4.5 and a 45-minute long run.'
		);
		expect(decisions.map((d) => d.ruleKey)).toContain('defaults.running_volume');
	});

	it('gives an intermediate runner with a half marathon one tempo run a week, none in the deload', () => {
		const half: Goal = {
			...SCENARIOS.hybrid().goals[0]!,
			title: 'Half marathon',
			eventType: 'Half marathon',
			eventDate: scenarioDay(16, 6)
		};
		const specifics = running({ weeklyDistance: 30, longestRun: 14, easyPaceSeconds: 330 });
		const { weeks, decision } = plan(runner('intermediate', specifics, half));
		const quality = weeks.map((w) => generated(w).filter((r) => r.intensity === 'hard'));
		expect(quality.map((q) => q.map((r) => r.type))).toEqual([
			['tempo_run'],
			['tempo_run'],
			['tempo_run'],
			['tempo_run'],
			[]
		]);
		// By date: an easy run, the tempo run midweek, another easy run, the long run last.
		expect(generated(weeks[0]!).map((r) => r.type)).toEqual([
			'easy_run',
			'tempo_run',
			'easy_run',
			'long_run'
		]);
		expect(quality[0]![0]!.segments.map((s) => [s.kind, s.durationSeconds])).toEqual([
			['warm_up', 600],
			['tempo', 1200],
			['cool_down', 600]
		]);
		expect(decision('quality_session')).toMatchObject({
			summary: 'Quality running: one tempo run a week',
			refs: expect.arrayContaining([expect.stringMatching(/^blocks\.0\.weeks\.0\.sessions\.\d$/)])
		});
		expect(decision('quality_session')!.refs).toHaveLength(4);
	});

	it('starts 25 km a week at about 25 km, grows at most 10 % in week 2, and drops in the deload', () => {
		const specifics = running({ weeklyDistance: 25, longestRun: 10, easyPaceSeconds: 360 });
		const { weeks, blocks, decision } = plan(runner('novice', specifics));
		const totals = weeks.map((w) => total(w));
		expect(weeks.map((w) => w.kind)).toEqual([
			'baseline',
			'accumulation',
			'accumulation',
			'accumulation',
			'deload'
		]);
		expect(totals[0]).toBeGreaterThanOrEqual(24_500);
		expect(totals[0]).toBeLessThanOrEqual(25_000);
		expect(totals[1]).toBeGreaterThan(totals[0]!);
		expect(totals[1]).toBeLessThanOrEqual(27_500);
		// Each week holds at most its planned volume, 25 km × its factor, each run rounded down.
		weeks.forEach((w, i) => {
			expect(totals[i]).toBeLessThanOrEqual(25_000 * w.targets.runVolumeFactor);
		});
		expect(totals[4]).toBeLessThan(totals[0]!);
		expect(totals[4]).toBeLessThan(totals[3]!);
		expect(blocks[0]!.progression).toMatchObject({
			runWeek1Metres: 25_000,
			runWeeklyIncreaseMax: 0.1
		});
		expect(decision('run_volume')!.summary).toBe('Week 1 running: 24.9 km over 4 runs');
		// generator-running: E pace of the VDOT the told easy pace implies.
		const [fast, slow] = paceFor('easy', trainingPaces(vdotFromEasyPace(360)));
		for (const run of weeks.flatMap(generated)) {
			expect(run.segments[0]).toMatchObject({
				paceMinSecondsPerKm: fast,
				paceMaxSecondsPerKm: slow
			});
			expect(run.estMinutes).toBe(Math.round((metres(run) / 1000) * 6));
		}
	});

	it('grows a three-run week and the hybrid scenario’s running, long run too, every building week', () => {
		const three = runner('novice', running({ weeklyDistance: 30, easyPaceSeconds: 360 }));
		three.schedule.daysPerWeek = 3;
		for (const profile of [three, SCENARIOS.hybrid()]) {
			const building = plan(profile).weeks.filter((w) => w.kind !== 'deload');
			expect(building).toHaveLength(4);
			for (const [i, week] of building.entries()) {
				if (i === 0) continue;
				expect(total(week)).toBeGreaterThan(total(building[i - 1]!));
				expect(metres(longRun(week)!)).toBeGreaterThan(metres(longRun(building[i - 1]!)!));
			}
		}
	});

	it('holds each week to 10 % over the most a week before it ran, a quality session included', () => {
		const half: Goal = {
			...SCENARIOS.hybrid().goals[0]!,
			title: 'Half marathon',
			eventType: 'Half marathon',
			eventDate: scenarioDay(16, 6)
		};
		// A new runner's week 1, held to 16.5 of 20 km by the told longest run, before the long run
		// and the tempo run arrive; and weeks too small for the tempo run and a 2 km run besides.
		const held = runner(
			null,
			running({ weeklyDistance: 20, longestRun: 5, easyPaceSeconds: 360 }),
			half
		);
		held.schedule.daysPerWeek = 3;
		const small = runner(null, running({ weeklyDistance: 5, easyPaceSeconds: 360 }), half);
		for (const profile of [held, small]) {
			const { weeks } = plan(profile);
			// Each run's metres, or its minutes at the 6:00 easy pace.
			const ran = weeks.map((w) =>
				generated(w).reduce((n, r) => n + metres(r) + (minutes(r) * 1000) / 6, 0)
			);
			ran.forEach((week, i) => {
				if (i > 0) expect(week).toBeLessThanOrEqual(1.1 * Math.max(...ran.slice(0, i)));
			});
			if (profile === held) expect(generated(weeks[1]!).map((r) => r.type)).toContain('tempo_run');
		}
	});

	it('plans fewer runs when a week is too small for each to reach 2 km, so week 1 holds its volume', () => {
		const { weeks, decision } = plan(runner('novice', running({ weeklyDistance: 5 })));
		const totals = weeks.map((w) => total(w));
		expect(totals[0]).toBe(5_000);
		weeks.forEach((w, i) => {
			expect(totals[i]).toBeLessThanOrEqual(5_000 * w.targets.runVolumeFactor);
		});
		expect(totals[4]).toBeLessThan(totals[0]!);
		for (const run of weeks.flatMap(generated)) expect(metres(run)).toBeGreaterThanOrEqual(2_000);
		expect(decision('run_volume')!.summary).toBe('Week 1 running: 5 km over 2 runs');
		expect(decision('run_volume')!.why).toContain(
			'A run under 2 km isn’t worth planning, so week 1 has 2 of your 4 runs'
		);
	});

	it('holds the long run to 30 % of the week and 10 % over the longest run before it', () => {
		const cases = [
			{ weeklyDistance: 40, longestRun: 6, week1Long: 6_600 },
			{ weeklyDistance: 30, longestRun: 30, week1Long: 9_000 }
		];
		for (const { weeklyDistance, longestRun, week1Long } of cases) {
			const specifics = running({ weeklyDistance, longestRun, easyPaceSeconds: 360 });
			const { weeks } = plan(runner('novice', specifics));
			expect(metres(longRun(weeks[0]!)!)).toBe(week1Long);
			let longest = longestRun * 1000;
			for (const week of weeks) {
				const long = metres(longRun(week)!);
				expect(long).toBeLessThanOrEqual(
					0.3 * weeklyDistance * 1000 * week.targets.runVolumeFactor
				);
				expect(long).toBeLessThanOrEqual(longest * 1.1);
				for (const run of generated(week)) expect(metres(run)).toBeLessThanOrEqual(long);
				longest = Math.max(longest, ...generated(week).map(metres));
			}
		}
	});

	it('lets the long run outrun the session length with a decision, and keeps every other run to it', () => {
		const specifics = running({ weeklyDistance: 60, longestRun: 20, easyPaceSeconds: 360 });
		const p = runner('novice', specifics);
		p.schedule.sessionMinutes = 45;
		const { weeks, decision } = plan(p);
		for (const run of weeks.flatMap(generated)) {
			if (run.type === 'long_run') expect(run.estMinutes).toBeGreaterThan(45);
			else expect(run.estMinutes).toBeLessThanOrEqual(45);
		}
		expect(decision('priority_tradeoff')).toMatchObject({
			ruleKey: 'running.long_run_length',
			summary: 'The long run over your 45-minute sessions',
			refs: weeks.map((_, w) => `blocks.0.weeks.${w}.sessions.3`)
		});
		expect(decision('run_volume')!.why).toContain(
			'The long run is held to 30 % of the week and no other run outgrows it or your 45-minute sessions, so week 1 holds 40.5 km.'
		);
	});

	it('takes interval paces from a 10K time, and falls back to RPE and heart-rate zone', () => {
		// generator-running: I pace of the race's VDOT by Daniels' formula.
		const vdot = vdotFromPerformance(10_000, 50 * 60);
		const [fast, slow] = paceFor('interval', trainingPaces(vdot));
		const raced = plan(runner('intermediate', running({ weeklyDistance: 30, races: [tenK] })));
		raced.weeks.forEach((week) => {
			const intervals = generated(week).find((r) => r.type === 'interval_run');
			if (week.kind === 'deload') return expect(intervals).toBeUndefined();
			expect(validate(runSegmentsSchema, intervals!.segments).ok).toBe(true);
			expect(intervals!.segments.map((s) => [s.kind, s.repeats, s.durationSeconds])).toEqual([
				['warm_up', null, 600],
				['interval', 5, 180],
				['recovery', 5, 120],
				['cool_down', null, 600]
			]);
			expect(intervals!.segments[1]).toMatchObject({
				paceMinSecondsPerKm: fast,
				paceMaxSecondsPerKm: slow,
				hrZone: 5,
				targetRpe: Math.min(8, week.targets.rpeCap)
			});
		});
		expect(raced.decision('run_pace_source')).toMatchObject({
			summary: `Run targets from your race time, a VDOT of ${Math.round(vdot)}`,
			why: expect.stringContaining(
				`Paces come from your 10K in 50:00 on 4 Oct, a VDOT of ${Math.round(vdot)}, by Daniels’ formula.`
			)
		});

		// A 5K in 24:00 sets its own VDOT, and the paces follow it.
		const fiveK = { ...tenK, distance: '5k' as const, distanceMetres: 5000, timeSeconds: 24 * 60 };
		const five = plan(runner('intermediate', running({ weeklyDistance: 30, races: [fiveK] })));
		const fiveIntervals = generated(five.weeks[1]!).find((r) => r.type === 'interval_run')!;
		const [fiveFast, fiveSlow] = paceFor(
			'interval',
			trainingPaces(vdotFromPerformance(5000, 1440))
		);
		expect(fiveIntervals.segments[1]).toMatchObject({
			paceMinSecondsPerKm: fiveFast,
			paceMaxSecondsPerKm: fiveSlow
		});
		expect(five.decision('run_pace_source')!.why).toContain('your 5K in 24:00 on 4 Oct');

		const effort = plan(runner('intermediate', running({ weeklyDistance: 30 })));
		const intervals = generated(effort.weeks[1]!).find((r) => r.type === 'interval_run')!;
		for (const s of intervals.segments) {
			expect(s).toMatchObject({ paceMinSecondsPerKm: null, paceMaxSecondsPerKm: null });
			expect(s.hrZone).not.toBeNull();
			expect(s.targetRpe).not.toBeNull();
		}
		expect(intervals.segments[1]).toMatchObject({ hrZone: 5, targetRpe: 7.5 });
		expect(effort.decision('run_pace_source')!.summary).toBe('Run targets from effort');
	});

	it('plans no quality session when a hard club run is one already, or the week has too few runs', () => {
		const p = runner('intermediate', running({ weeklyDistance: 30 }));
		p.schedule.commitments.push({
			id: '00000000-0000-4000-8000-000000000299',
			discipline: 'running',
			label: 'Track night',
			days: ['tue'],
			timeOfDay: 'evening',
			durationMinutes: 60,
			intensity: 'hard',
			notes: null
		});
		const club = plan(p);
		expect(club.weeks.flatMap(generated).filter((r) => r.intensity === 'hard')).toEqual([]);
		expect(club.decision('quality_session')!.why).toBe(
			'Track night is a hard run already, so it is the week’s quality session.'
		);
		const two = runner('intermediate', running({ weeklyDistance: 30 }));
		two.schedule.daysPerWeek = 2;
		const few = plan(two);
		expect(few.weeks.flatMap(generated).filter((r) => r.intensity === 'hard')).toEqual([]);
		expect(few.decision('quality_session')!.why).toBe(
			'With 2 runs a week every run stays easy: a quality session needs 3.'
		);
	});

	it('keeps a run off a running-club day while another day has none', () => {
		const p = runner('novice', null);
		const at = (discipline: 'running' | 'muay_thai', label: string, day: 'mon' | 'wed') => ({
			id: `00000000-0000-4000-8000-00000000029${day === 'mon' ? 1 : 2}`,
			discipline,
			label,
			days: [day],
			timeOfDay: 'evening' as const,
			durationMinutes: 60,
			intensity: 'moderate' as const,
			notes: null
		});
		// Both days hold a class, so the one generated run is a second session on one of them.
		p.schedule = {
			...p.schedule,
			daysPerWeek: 2,
			availableDays: ['mon', 'wed'],
			preferredTimes: ['morning', 'evening'],
			commitments: [at('running', 'Running club', 'mon'), at('muay_thai', 'Muay Thai class', 'wed')]
		};
		const { weeks } = plan(p);
		for (const [w, week] of weeks.entries()) {
			expect(generated(week).map((r) => r.date)).toEqual([scenarioDay(w + 1, 2)]);
		}
	});

	it('takes every pace from the race when an easy pace is told too (generator-running)', () => {
		const both = running({ weeklyDistance: 30, easyPaceSeconds: 330, races: [tenK] });
		const { weeks, decision } = plan(runner('intermediate', both));
		const paces = trainingPaces(vdotFromPerformance(10_000, 50 * 60));
		const [easy] = generated(weeks[1]!).filter((r) => r.type === 'easy_run');
		const [fast, slow] = paceFor('easy', paces);
		expect(easy!.segments[0]).toMatchObject({
			paceMinSecondsPerKm: fast,
			paceMaxSecondsPerKm: slow
		});
		const intervals = generated(weeks[1]!).find((r) => r.type === 'interval_run')!;
		expect(intervals.segments[1]).toMatchObject({
			paceMinSecondsPerKm: paceFor('interval', paces)[0]
		});
		expect(decision('run_pace_source')!.why).toContain('Paces come from your 10K in 50:00');
	});

	it('leads a marathon 20 weeks out through outline phases to race day, each with its hooks', () => {
		const { blocks, input } = plan(SCENARIOS.hybrid());
		expect(blocks.map((b: BlockPlan) => [b.phase, b.outline])).toEqual([
			['marathon_base', false],
			['marathon_build', true],
			['marathon_peak', true],
			['marathon_taper', true]
		]);
		expect(blocks.at(-1)!.endsOn).toBe(input.goals[0]!.eventDate);
		expect(blocks.at(-1)!.endsOn).toBe(scenarioDay(20, 6));
		for (const block of blocks)
			expect(block.progression).toMatchObject(MARATHON_HOOKS[block.phase]!);
		expect(blocks[0]!.progression).toMatchObject({ runWeek1Metres: 30_000, longRunShareMax: 0.3 });
	});

	it('leaves out the runs a partial week 1 has no day for, keeping the long run, and says so', () => {
		const specifics = running({ weeklyDistance: 25, longestRun: 10, easyPaceSeconds: 360 });
		const saturday = scenarioDay(1, 5);
		const { weeks, decision } = plan(runner('novice', specifics), {
			...OPTIONS,
			firstPlannedDay: saturday
		});
		expect(generated(weeks[0]!).map((r) => [r.date, r.type])).toEqual([
			[saturday, 'easy_run'],
			[scenarioDay(1, 6), 'long_run']
		]);
		expect(generated(weeks[1]!)).toHaveLength(4);
		expect(decision('run_volume')!.why).toContain(
			`Week 1 starts on ${saturday}, so 2 of its runs have no day left.`
		);

		// A running club on a day before the first planned day is missing from week 1 too.
		const p = runner('novice', null);
		p.schedule.commitments.push({
			id: '00000000-0000-4000-8000-000000000299',
			discipline: 'running',
			label: 'Running club',
			days: ['wed'],
			timeOfDay: 'evening',
			durationMinutes: 60,
			intensity: 'moderate',
			notes: null
		});
		const friday = scenarioDay(1, 4);
		const late = plan(p, { ...OPTIONS, firstPlannedDay: friday });
		expect(allRuns(late.weeks[0]!).map((r) => r.source)).not.toContain('commitment');
		expect(late.decision('run_volume')!.why).toContain(
			`Week 1 starts on ${friday}, so 1 of its runs has no day left.`
		);
	});
});
