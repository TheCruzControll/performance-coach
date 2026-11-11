import { describe, expect, it } from 'vitest';
import { staticRuleKeys } from '../../../../../scripts/rule-keys';
import { addDays, daysBetween } from '../../calendar';
import { CATALOGUE } from '../../exercises/index';
import type { BlockPlan, SessionPlan, WeekPlan } from '../../training/types';
import { DecisionLog } from '../decisions';
import { firstDraft, STAGES } from '../generate';
import { buildProgrammingInput } from '../index';
import type { ProgrammingInput } from '../input';
import type { GenerateOptions } from '../stage';
import { RULE_BY_ID } from '../rules/registry/index';
import { MUAY_THAI } from '../rules/running';
import { OPENERS } from '../rules/strength-phases';
import { BY_PRIORITY, MEET_TAPER, TAPER_SESSIONS, TAPERS } from '../rules/taper';
import { SCENARIO_START } from '../scenarios';
import { M7_SCENARIOS, m7Day } from './scenarios';
import { taperSessions, taperWeeks } from './taper';

/** A Sunday race in week 4: its taper's last week is that week. */
const SUNDAY = m7Day(4, 6);
const monday = (week: number) => m7Day(week, 0);

describe('taperWeeks', () => {
	it.each([
		['marathon', [0.8, 0.6, 0.4]],
		['half', [0.7, 0.5]],
		['other', [0.6]],
		['meet', [0.5]],
		['fight', [0.6]]
	] as const)(
		'tapers a %s over its weeks at its factors, ending in the race’s week',
		(event, factors) => {
			const taper = taperWeeks(event, 'primary', SUNDAY);
			expect(taper.form).toBe('full');
			expect(taper.weeks).toEqual(
				factors.map((factor, i) => ({ startsOn: monday(4 - (factors.length - 1 - i)), factor }))
			);
			expect(taper.ruleKey).toBe(`taper.${event}`);
			expect(taper.days).toBeNull();
		}
	);

	it('keeps one short strength session a week, 4 days out, in an endurance taper only', () => {
		for (const event of ['marathon', 'half', 'other'] as const)
			expect(taperWeeks(event, 'primary', SUNDAY).strength).toEqual({ perWeek: 1, daysOut: 4 });
		for (const event of ['meet', 'fight'] as const)
			expect(taperWeeks(event, 'primary', SUNDAY).strength).toBeNull();
	});

	it('gives a meet its openers at about 90 % 4–5 days out and no heavy lower body in the last 3 days', () => {
		expect(taperWeeks('meet', 'primary', SUNDAY).meet).toEqual({
			openers: { e1rmShare: 0.9, daysOut: [4, 5] },
			noHeavyLowerDays: 3,
			why: MEET_TAPER.why
		});
		expect(MEET_TAPER.openers).toBe(OPENERS);
		expect(taperWeeks('marathon', 'primary', SUNDAY).meet).toBeNull();
	});

	it('tapers a Monday race through the week before, as M3 does', () => {
		expect(taperWeeks('other', 'primary', m7Day(4, 0)).weeks).toEqual([
			{ startsOn: monday(3), factor: 0.6 }
		]);
	});

	it('gives a secondary event a 3-day mini-taper, and trains through a low-priority one', () => {
		expect(taperWeeks('marathon', 'secondary', SUNDAY)).toMatchObject({
			form: 'mini',
			weeks: [],
			days: { from: m7Day(4, 3), to: m7Day(4, 5), factor: 0.6 },
			strength: null,
			ruleKey: 'taper.priority'
		});
		expect(taperWeeks('meet', 'maintenance', SUNDAY)).toMatchObject({
			form: 'none',
			weeks: [],
			days: null,
			ruleKey: 'taper.priority'
		});
	});
});

/** M3's blocks for `input`: its stages from a draft with no season, prepare left out. */
function m3Blocks(input: ProgrammingInput, options: GenerateOptions): BlockPlan[] {
	const context = { input, options, log: new DecisionLog() };
	let draft = firstDraft({ input, periodisation: null });
	for (const stage of STAGES) draft = stage.run(draft, context);
	return draft.blocks;
}

/**
 * S9's first block (a runner who lifts): strength on Monday and Thursday, five runs. It is the
 * block M3's stages plan with no season (generator-season changes the generated one), so these
 * tests pin taperSessions and nothing else.
 */
function runnerWeeks(): WeekPlan[] {
	const input = buildProgrammingInput(M7_SCENARIOS.runnerLifter(), { catalogue: CATALOGUE });
	const [block] = m3Blocks(input, { startsOn: SCENARIO_START, firstPlannedDay: SCENARIO_START });
	return block!.weeks.slice(0, 4);
}

const strengthDays = (weeks: readonly WeekPlan[]) =>
	weeks.flatMap((w) => w.sessions.filter((s) => s.kind === 'strength').map((s) => s.date));
const exercisesOf = (s: SessionPlan) =>
	s.kind === 'strength'
		? s.exercises.map((e) => e.exercise)
		: s.kind === 'run'
			? s.segments.map((g) => g.kind)
			: [];

describe('taperSessions', () => {
	it('keeps one strength session a week in an endurance taper, none within 4 days of the race', () => {
		const weeks = runnerWeeks();
		const raceOn = weeks[3]!.endsOn;
		const out = taperSessions(weeks, taperWeeks('marathon', 'primary', raceOn));
		expect(strengthDays(weeks)).toHaveLength(8);
		// Each taper week keeps its shortest strength session at least 4 days out: Monday's.
		const [before, ...taper] = weeks.map((w) => w.startsOn);
		expect(strengthDays(out)).toEqual([before, addDays(before!, 3), ...taper]);
		for (const day of strengthDays(out.slice(1)))
			expect(daysBetween(day, raceOn)).toBeGreaterThanOrEqual(TAPER_SESSIONS.strength.daysOut);
	});

	it('keeps the shorter strength session, unless it falls within 4 days of the race', () => {
		const weeks = structuredClone(runnerWeeks());
		const raceOn = weeks[3]!.endsOn;
		// Thursday's session made the shorter one in the first taper week and in the race's week.
		for (const w of [weeks[1]!, weeks[3]!])
			w.sessions.find(
				(s) => s.kind === 'strength' && s.date === addDays(w.startsOn, 3)
			)!.estMinutes = 20;
		const out = taperSessions(weeks, taperWeeks('marathon', 'primary', raceOn));
		expect(strengthDays(out.slice(1))).toEqual([
			addDays(weeks[1]!.startsOn, 3),
			weeks[2]!.startsOn,
			// Thursday is 3 days before Sunday's race: Monday's is kept.
			weeks[3]!.startsOn
		]);
	});

	it('keeps every other session’s day and exercises, its volume cut and its intensity kept', () => {
		const weeks = runnerWeeks();
		const taper = taperWeeks('marathon', 'primary', weeks[3]!.endsOn);
		const out = taperSessions(weeks, taper);
		// The week before the taper is untouched.
		expect(out[0]).toBe(weeks[0]);
		taper.weeks.forEach(({ factor }, i) => {
			const before = weeks[i + 1]!.sessions.filter((s) => s.kind === 'run');
			const after = out[i + 1]!.sessions.filter((s) => s.kind === 'run');
			expect(after.map((s) => [s.date, s.type, s.targetRpe, exercisesOf(s)])).toEqual(
				before.map((s) => [s.date, s.type, s.targetRpe, exercisesOf(s)])
			);
			after.forEach((run, r) => {
				if (run.kind !== 'run' || before[r]!.kind !== 'run') throw new Error('a run');
				const was = before[r]!.segments;
				run.segments.forEach((g, k) => {
					expect([g.paceMinSecondsPerKm, g.paceMaxSecondsPerKm, g.hrZone]).toEqual([
						was[k]!.paceMinSecondsPerKm,
						was[k]!.paceMaxSecondsPerKm,
						was[k]!.hrZone
					]);
					const metres = g.distanceMetres ?? g.durationSeconds!;
					const wasMetres = was[k]!.distanceMetres ?? was[k]!.durationSeconds!;
					expect(Math.abs(metres - wasMetres * factor)).toBeLessThanOrEqual(50);
				});
			});
			const kept = out[i + 1]!.sessions.find((s) => s.kind === 'strength')!;
			const original = weeks[i + 1]!.sessions.find((s) => s.date === kept.date)!;
			if (kept.kind !== 'strength' || original.kind !== 'strength') throw new Error('strength');
			expect(exercisesOf(kept)).toEqual(exercisesOf(original));
			kept.exercises.forEach((e, x) =>
				e.sets.forEach((line, k) => {
					const was = original.exercises[x]!.sets[k]!;
					expect(line).toEqual({ ...was, sets: Math.max(1, Math.round(was.sets * factor)) });
				})
			);
		});
	});

	it('cuts a meet taper’s sets and keeps all its strength sessions', () => {
		const weeks = runnerWeeks();
		const out = taperSessions(weeks, taperWeeks('meet', 'primary', weeks[3]!.endsOn));
		expect(strengthDays(out)).toEqual(strengthDays(weeks));
		expect(out.slice(0, 3)).toEqual(weeks.slice(0, 3));
	});

	it('mini-tapers only the 3 days before a secondary race, and leaves a trained-through week as it is', () => {
		const weeks = runnerWeeks();
		const raceOn = weeks[3]!.endsOn;
		const out = taperSessions(weeks, taperWeeks('marathon', 'secondary', raceOn));
		const days = new Set([addDays(raceOn, -3), addDays(raceOn, -2), addDays(raceOn, -1)]);
		out
			.flatMap((w) => w.sessions)
			.forEach((s, i) => {
				const was = weeks.flatMap((w) => w.sessions)[i]!;
				expect(s.date).toBe(was.date);
				if (days.has(s.date)) expect(s.estMinutes).toBeLessThan(was.estMinutes);
				else expect(s).toBe(was);
			});
		expect(taperSessions(weeks, taperWeeks('marathon', 'maintenance', raceOn))).toEqual(weeks);
	});

	it('leaves a commitment run as it is', () => {
		const weeks = structuredClone(runnerWeeks());
		const club = weeks[3]!.sessions.find((s) => s.kind === 'run')!;
		club.source = 'commitment';
		const out = taperSessions(weeks, taperWeeks('marathon', 'primary', weeks[3]!.endsOn));
		expect(out[3]!.sessions).toContainEqual(club);
	});

	it('makes the last week’s Muay Thai technical, and leaves a commitment class as it is', () => {
		const weeks = runnerWeeks();
		const raceOn = weeks[3]!.endsOn;
		const last = structuredClone(weeks[3]!);
		const base = last.sessions.find((s) => s.kind === 'run')!;
		const muayThai = (
			source: 'generator' | 'commitment',
			kind: 'sparring' | 'class'
		): SessionPlan => ({
			...base,
			kind: 'other',
			type: 'muay_thai',
			discipline: 'muay_thai',
			date: last.startsOn,
			orderInDay: 2,
			title: kind === 'sparring' ? MUAY_THAI.sparring.title : 'Muay Thai',
			intensity: kind === 'sparring' ? MUAY_THAI.sparring.intensity : 'hard',
			targetRpe: 8,
			source,
			commitmentRef: source === 'commitment' ? '7a1c3c58-0a8f-4c3e-9e57-4f0f3c6f0a11' : null,
			details: { kind, durationMinutes: 60, targetRpe: 8, metrics: [], notes: null }
		});
		const plan = muayThai('generator', 'sparring');
		const cls = muayThai('commitment', 'class');
		last.sessions.push(plan, { ...cls, orderInDay: 3 });
		const [, , , tapered] = taperSessions(
			[...weeks.slice(0, 3), last],
			taperWeeks('marathon', 'primary', raceOn)
		);
		const others = tapered!.sessions.filter((s) => s.kind === 'other');
		expect(
			others.map((s) => [
				s.source,
				s.kind === 'other' && s.details.kind,
				s.kind === 'other' && s.details.durationMinutes,
				s.targetRpe,
				s.title,
				s.intensity
			])
		).toEqual([
			['generator', 'technical', 24, 8, MUAY_THAI.technical.title, MUAY_THAI.technical.intensity],
			['commitment', 'class', 60, 8, 'Muay Thai', 'hard']
		]);
	});
});

describe('the taper rules', () => {
	it(
		'registers each constant live, and every key taperWeeks cites resolves in this area',
		{ timeout: 60_000 },
		() => {
			const live = (id: string) => {
				const rule = RULE_BY_ID.get(id);
				return rule?.kind === 'constant' ? rule.values : undefined;
			};
			for (const event of Object.keys(TAPERS) as (keyof typeof TAPERS)[])
				expect(live(`taper.${event}`)).toBe(TAPERS[event]);
			expect(live('taper.sessions')).toBe(TAPER_SESSIONS);
			expect(live('taper.meet_openers')).toBe(MEET_TAPER);
			expect(live('taper.priority')).toBe(BY_PRIORITY);
			const cited = [
				...staticRuleKeys(['src/lib/domain/programming/periodisation/taper.ts'])
			].sort();
			expect(cited).toEqual([
				'taper.fight',
				'taper.half',
				'taper.marathon',
				'taper.meet',
				'taper.other',
				'taper.priority'
			]);
			for (const key of cited) expect(RULE_BY_ID.get(key)?.area).toBe('taper');
		}
	);
});
