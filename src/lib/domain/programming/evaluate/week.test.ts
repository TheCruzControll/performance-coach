/**
 * evaluate/week.ts: the one judge of a week, on the PRD §5 weeks (periodisation/weeks.ts), in the
 * week of Monday 9 November 2026.
 */
import { describe, expect, it } from 'vitest';
import { INTERFERENCE_RULES } from '../interference';
import { PRD_WEEKS, weekDay } from '../periodisation/weeks';
import type { PrdWeek } from '../periodisation/weeks';
import { GRADES, RESOLUTION_ORDER, SCORE_WEIGHTS } from '../rules/evaluation';
import { RULE_BY_ID } from '../rules/registry/index';
import type { Finding } from './types';
import { evaluateWeek } from './week';
import type { EvaluatedSession, EvaluateOptions } from './week';

const evaluate = (week: PrdWeek, options?: EvaluateOptions) =>
	evaluateWeek(PRD_WEEKS[week](), options);
const avoids = (findings: Finding[]) => findings.filter((f) => f.severity === 'avoid');
const rules = (findings: Finding[]) => findings.map((f) => f.rule);

/** A fixed shuffle: reversed, then every other one moved to the end. */
const shuffled = <T>(items: readonly T[]) => {
	const reversed = [...items].reverse();
	return [...reversed.filter((_, i) => i % 2 === 0), ...reversed.filter((_, i) => i % 2 === 1)];
};

describe('evaluateWeek: the PRD §5 conflicts', () => {
	it('squat_before_sparring gives one avoid finding, naming Monday and Tuesday, with its why', () => {
		const [finding, ...rest] = avoids(evaluate('squat_before_sparring').findings);
		expect(rest).toEqual([]);
		expect(finding).toEqual<Finding>({
			rule: 'placement.heavy_lower_before_hard',
			area: 'interference',
			severity: 'avoid',
			days: [weekDay(0), weekDay(1)],
			sessions: [
				{ lineage: 'lower-a', title: 'Lower A', date: weekDay(0) },
				{ lineage: 'muay-thai-sparring', title: 'Muay Thai sparring', date: weekDay(1) }
			],
			headline: 'Heavy lower body the day before hard Muay Thai',
			message:
				'Heavy lower body the day before hard Muay Thai: Lower A on Monday, then Muay Thai sparring on Tuesday.',
			why: INTERFERENCE_RULES.heavy_lower_before_hard.why,
			actionable: true
		});
		expect(RULE_BY_ID.get(finding!.rule)).toMatchObject({ area: finding!.area, status: 'active' });
	});

	it('legs_before_long_run and intervals_after_demanding give theirs', () => {
		const legs = avoids(evaluate('legs_before_long_run').findings);
		expect(legs.map((f) => [f.rule, f.headline, f.days])).toEqual([
			[
				'placement.heavy_lower_before_hard',
				'Heavy lower body the day before a long run',
				[weekDay(4), weekDay(5)]
			]
		]);
		const intervals = avoids(evaluate('intervals_after_demanding').findings);
		expect(intervals.map((f) => [f.rule, f.message, f.why])).toEqual([
			[
				'placement.intervals_after_very_demanding',
				'Intervals the day after a very demanding day: Muay Thai sparring on Tuesday, then Intervals on Wednesday.',
				INTERFERENCE_RULES.intervals_after_very_demanding.why
			]
		]);
	});

	it('hard_days_back_to_back gives a prefer finding only when the week has room', () => {
		const roomy = evaluate('hard_days_back_to_back');
		expect(roomy.findings.map((f) => [f.rule, f.severity, f.days])).toEqual([
			['placement.hard_days_apart', 'prefer', [weekDay(0), weekDay(1)]]
		]);
		expect(roomy).toMatchObject({ score: 100 - SCORE_WEIGHTS.prefer, grade: 'minor' });
		const full = evaluate('hard_days_back_to_back', { openDates: [weekDay(0), weekDay(1)] });
		expect(full.findings).toEqual([]);
	});

	it('clean_hybrid_week scores 100 and grades clear', () => {
		expect(evaluate('clean_hybrid_week')).toMatchObject({
			score: 100,
			grade: 'clear',
			findings: []
		});
	});

	it('grades an unexplained avoid finding ahead as conflicts, and scores each finding', () => {
		const week = evaluate('squat_before_sparring');
		expect(rules(week.findings)).toEqual([
			'placement.heavy_lower_before_hard',
			'placement.hard_days_apart'
		]);
		expect(week).toMatchObject({
			grade: 'conflicts',
			score: 100 - SCORE_WEIGHTS.avoid - SCORE_WEIGHTS.prefer
		});
	});

	it('leaves skipped sessions out: they will not happen', () => {
		const [lower, ...rest] = PRD_WEEKS.squat_before_sparring();
		const week = evaluateWeek([{ ...lower!, status: 'skipped' }, ...rest]);
		expect(week).toMatchObject({ score: 100, grade: 'clear', findings: [] });
	});
});

describe('evaluateWeek: resolutions', () => {
	it("owner_moved_conflict reads 'You moved Lower A here from Monday', at half the cost", () => {
		const week = evaluate('owner_moved_conflict');
		const [finding] = avoids(week.findings);
		expect(finding?.resolution).toEqual({
			kind: 'owner_moved',
			text: 'You moved Lower A here from Monday.'
		});
		expect(finding?.days).toEqual([weekDay(3), weekDay(4)]);
		const half = SCORE_WEIGHTS.resolved;
		// 100 − 12.5 − 4, rounded to a whole score.
		expect(week.score).toBe(
			Math.round(100 - SCORE_WEIGHTS.avoid * half - SCORE_WEIGHTS.prefer * half)
		);
		expect(week.score).toBe(84);
		expect(week.grade).toBe('minor');
	});

	it('commitments_only_clash is commitment_fixed', () => {
		const week = evaluate('commitments_only_clash');
		expect(week.findings.map((f) => [f.rule, f.resolution])).toEqual([
			[
				'placement.intervals_after_very_demanding',
				{
					kind: 'commitment_fixed',
					text: 'Strength class and Running club are fixed commitments, so they keep their days.'
				}
			]
		]);
		expect(week.grade).toBe('minor');
	});

	it('a priority hint gives priority_kept with its text, only for the sessions it names', () => {
		const text = 'Sparring keeps Tuesday: your fight comes before your squat.';
		const hinted = evaluate('squat_before_sparring', {
			hints: [{ kind: 'priority_tradeoff', lineage: 'lower-a', text }]
		});
		expect(hinted.findings.map((f) => f.resolution)).toEqual([
			{ kind: 'priority_kept', text },
			{ kind: 'priority_kept', text }
		]);
		const elsewhere = evaluate('squat_before_sparring', {
			hints: [{ kind: 'priority_tradeoff', lineage: 'long-run', text }]
		});
		expect(elsewhere.findings.map((f) => f.resolution)).toEqual([undefined, undefined]);
	});

	it('no_room when no open day is free to move a session to', () => {
		const week = evaluate('squat_before_sparring', {
			openDates: [weekDay(0), weekDay(1), weekDay(3)]
		});
		expect(avoids(week.findings)[0]?.resolution).toEqual({
			kind: 'no_room',
			text: 'The week has no free day to move Lower A to.'
		});
		const roomy = evaluate('squat_before_sparring', { openDates: [weekDay(0), weekDay(5)] });
		expect(avoids(roomy.findings)[0]?.resolution).toBeUndefined();
	});

	it('a finding whose days have passed is not actionable, and no longer grades the week', () => {
		const onTuesday = evaluate('squat_before_sparring', { today: weekDay(1) });
		expect(onTuesday.findings.map((f) => f.actionable)).toEqual([true, true]);
		const onWednesday = evaluate('squat_before_sparring', { today: weekDay(2) });
		expect(onWednesday.findings.map((f) => f.actionable)).toEqual([false, false]);
		expect(onWednesday.grade).toBe('clear');
		expect(onWednesday.score).toBe(onTuesday.score);
	});
});

describe('the evaluation rules in the registry', () => {
	it('lists the weights, grades and resolution order live, and the actionable rule', () => {
		const live = (id: string) => {
			const rule = RULE_BY_ID.get(id);
			return rule?.kind === 'constant' ? rule.values : undefined;
		};
		expect(live('evaluation.score_weights')).toBe(SCORE_WEIGHTS);
		expect(live('evaluation.grades')).toBe(GRADES);
		expect(live('evaluation.resolution_order')).toBe(RESOLUTION_ORDER);
		expect(RULE_BY_ID.get('evaluation.actionable')).toMatchObject({
			area: 'evaluation',
			kind: 'behaviour',
			source: 'src/lib/domain/programming/evaluate/week.ts#evaluateWeek'
		});
	});
});

describe('evaluateWeek: determinism', () => {
	const weeks = Object.keys(PRD_WEEKS) as PrdWeek[];

	it.each(weeks)(
		'%s: shuffled input gives a deep-equal result and the same fingerprint',
		(week) => {
			const sessions = PRD_WEEKS[week]();
			const options = { today: weekDay(2) };
			expect(evaluateWeek(shuffled(sessions), options)).toEqual(evaluateWeek(sessions, options));
		}
	);

	it('several matching hints give the same result in any order', () => {
		const hints = [
			{ kind: 'priority_tradeoff', lineage: 'lower-a', text: 'Your squat keeps Monday.' },
			{ kind: 'priority_tradeoff', lineage: 'muay-thai-sparring', text: 'Sparring keeps Tuesday.' }
		] as const;
		const forward = evaluate('squat_before_sparring', { hints });
		expect(evaluate('squat_before_sparring', { hints: [...hints].reverse() })).toEqual(forward);
	});

	it('changes the fingerprint when what was judged changes', () => {
		const base = evaluate('squat_before_sparring').fingerprint;
		expect(base).toMatch(/^[0-9a-f]{16}$/);
		expect(evaluate('squat_before_sparring', { today: weekDay(3) }).fingerprint).not.toBe(base);
		const [lower, ...rest] = PRD_WEEKS.squat_before_sparring();
		const moved: EvaluatedSession = { ...lower!, date: weekDay(2) };
		expect(evaluateWeek([moved, ...rest]).fingerprint).not.toBe(base);
	});

	it('more findings never score higher', () => {
		const scores = weeks.map((week) => evaluate(week));
		for (const a of scores) {
			for (const b of scores) {
				if (a.findings.length > b.findings.length) {
					const unresolved = (w: typeof a) => w.findings.every((f) => !f.resolution);
					if (unresolved(a) && unresolved(b)) expect(a.score).toBeLessThanOrEqual(b.score);
				}
			}
		}
		// Adding a session that adds a finding never raises the score.
		const base = PRD_WEEKS.intervals_after_demanding();
		const before = evaluateWeek(base);
		const after = evaluateWeek([...base, ...PRD_WEEKS.squat_before_sparring()]);
		expect(after.findings.length).toBeGreaterThan(before.findings.length);
		expect(after.score).toBeLessThan(before.score);
		const crowded = evaluateWeek([
			...PRD_WEEKS.squat_before_sparring(),
			...PRD_WEEKS.legs_before_long_run(),
			...PRD_WEEKS.intervals_after_demanding()
		]);
		expect(crowded.score).toBeGreaterThanOrEqual(0);
	});

	it("findings carry titles, dates and lineages, never the caller's objects", () => {
		const sessions = PRD_WEEKS.squat_before_sparring();
		const { findings } = evaluateWeek(sessions);
		for (const finding of findings) {
			for (const named of finding.sessions) {
				expect(Object.keys(named).sort()).toEqual(['date', 'lineage', 'title']);
				expect(sessions).not.toContain(named);
			}
		}
		const before = structuredClone(findings);
		sessions[0]!.title = 'Renamed';
		expect(findings).toEqual(before);
	});
});
