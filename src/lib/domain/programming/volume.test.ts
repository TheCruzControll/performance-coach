/**
 * The volume stage, through generateProgram: weekly hard sets per major group inside the goal's
 * range (counted by the shared plannedHardSets), pulling at least as much as pushing, the
 * nutrition phase's adjustments with their decisions, the session length kept with a
 * priority_tradeoff when the range cannot fit, and the dumbbells-only and injured-shoulder rules
 * still holding for the work it adds. Each plan is compared with the same plan made without the
 * volume stage, so what the stage changed is what is asserted.
 */
import { describe, expect, it } from 'vitest';
import { CATALOGUE, catalogueByKey } from '../exercises/index';
import type { NutritionPhase } from '../profile/catalog';
import type { TrainingProfile } from '../profile/types';
import { isHardSet, NON_WORKING_ROLES, plannedHardSets } from '../training/metrics';
import type { ProgramPlan, StrengthSessionPlan, WeekPlan } from '../training/types';
import type { MuscleGroup } from '../training/vocabulary';
import { DecisionLog } from './decisions';
import { generateProgram, STAGES } from './generate';
import { buildProgrammingInput } from './input';
import { SCENARIO_START, SCENARIOS } from './scenarios';
import type { ScenarioKey } from './scenarios';
import type { Draft } from './stage';
import { volume } from './stages/volume';
import { estimateMinutes } from './timefit';

const OPTIONS = { startsOn: SCENARIO_START, firstPlannedDay: SCENARIO_START };
const MUSCLES = new Map(CATALOGUE.map((e) => [e.key, e]));
const MAJOR: MuscleGroup[] = ['chest', 'back', 'shoulders', 'quads', 'hamstrings', 'hips'];

const inputOf = (profile: TrainingProfile) =>
	buildProgrammingInput(profile, { catalogue: CATALOGUE });
const generate = (profile: TrainingProfile) => generateProgram(inputOf(profile), OPTIONS);

/** The plan generateProgram makes, with the volume stage left out. */
function withoutVolume(profile: TrainingProfile): Pick<ProgramPlan, 'blocks' | 'decisions'> {
	const context = { input: inputOf(profile), options: OPTIONS, log: new DecisionLog() };
	let draft: Draft = { demand: null, blocks: [] };
	for (const stage of STAGES) if (stage.name !== 'volume') draft = stage.run(draft, context);
	return { blocks: draft.blocks, decisions: context.log.list() };
}

/** The minimal profile training for size, `days` days a week of `minutes` each. */
function hypertrophy(days: number, minutes: number, phase: NutritionPhase | null = null) {
	const p = SCENARIOS.minimal();
	p.goals[0]!.disciplines = ['hypertrophy'];
	p.schedule.daysPerWeek = days;
	p.schedule.sessionMinutes = minutes;
	p.profile.nutritionPhase = phase;
	return p;
}

const strengthIn = (week: WeekPlan) =>
	week.sessions.filter((s): s is StrengthSessionPlan => s.kind === 'strength');
/** The first block's weeks at full volume: the deload, taper and event weeks scale from them. */
const fullWeeks = (plan: Pick<ProgramPlan, 'blocks'>) =>
	plan.blocks[0]!.weeks.filter((w) => w.targets.volumeFactor >= 1);
const hardSets = (week: WeekPlan, group: MuscleGroup) =>
	plannedHardSets(week, MUSCLES).groups[group] ?? 0;
/** The least and the most hard sets `group` gets in a full-volume week. */
const spreadOf = (plan: Pick<ProgramPlan, 'blocks'>, group: MuscleGroup): [number, number] => {
	const counts = fullWeeks(plan).map((w) => hardSets(w, group));
	return [Math.min(...counts), Math.max(...counts)];
};
const keyOf = (e: StrengthSessionPlan['exercises'][number]) =>
	'key' in e.exercise ? e.exercise.key : '';

/** Hard sets of pushing and pulling exercises, by movement pattern. */
function pushPull(week: WeekPlan) {
	let [push, pull] = [0, 0];
	for (const e of strengthIn(week).flatMap((s) => s.exercises)) {
		const pattern = catalogueByKey.get(keyOf(e))!.pattern;
		for (const line of e.sets) {
			if (!isHardSet(!NON_WORKING_ROLES.includes(line.role), line.targetRpe)) continue;
			if (pattern === 'horizontal_push' || pattern === 'vertical_push') push += line.sets;
			if (pattern === 'horizontal_pull' || pattern === 'vertical_pull') pull += line.sets;
		}
	}
	return { push, pull };
}

describe('weekly hard sets per major group', () => {
	it('gives a hypertrophy goal 10–20 hard sets for every major group in every full-volume week', () => {
		const p = hypertrophy(4, 75);
		const before = withoutVolume(p);
		expect(spreadOf(before, 'chest')[0]).toBeLessThan(10);
		const plan = generate(p);
		expect(fullWeeks(plan)).toHaveLength(4);
		for (const week of fullWeeks(plan)) {
			for (const group of MAJOR) {
				expect(hardSets(week, group), `${group} in ${week.startsOn}`).toBeGreaterThanOrEqual(10);
				expect(hardSets(week, group), `${group} in ${week.startsOn}`).toBeLessThanOrEqual(20);
			}
		}
	});

	it('gives strength 4–10 when a marathon ranks above it', () => {
		const plan = generate(SCENARIOS.hybrid());
		expect(plan.decisions.find((d) => d.kind === 'split_chosen')?.summary).toContain('maintenance');
		expect(spreadOf(withoutVolume(SCENARIOS.hybrid()), 'hamstrings')[0]).toBeLessThan(4);
		for (const week of fullWeeks(plan)) {
			for (const group of MAJOR) {
				expect(hardSets(week, group), `${group} in ${week.startsOn}`).toBeGreaterThanOrEqual(4);
				expect(hardSets(week, group), `${group} in ${week.startsOn}`).toBeLessThanOrEqual(10);
			}
		}
		const hamstrings = plan.decisions.find(
			(d) => d.kind === 'volume_adjusted' && d.evidence.group === 'Hamstrings'
		);
		expect(hamstrings).toMatchObject({
			ruleKey: 'volume.maintenance',
			summary: 'Hamstrings: 4.5–6.5 hard sets a week',
			why: 'Hamstrings gets 4.5–6.5 hard sets a week, for the 4–10 that suits keeping your strength. Sets were added to Sliding leg curl.',
			refs: ['blocks.0']
		});
	});

	it('says why a group stays over the range: in its heaviest weeks, or in every week and why', () => {
		const why = (plan: ProgramPlan, group: string) =>
			plan.decisions.find((d) => d.kind === 'volume_adjusted' && d.evidence.group === group)?.why;
		const plan = generate(SCENARIOS.minimal());
		expect(why(plan, 'Quads')).toBe(
			"Quads gets 8.5–16 hard sets a week, for the 8–14 that suits getting stronger. Its main lifts' back-off sets count as hard in the heaviest weeks, so those go over."
		);
		expect(why(plan, 'Back')).toBe(
			'Back gets 16–23.5 hard sets a week, for the 8–14 that suits getting stronger. Pulling keeps level with pushing, so it goes over every week.'
		);
		const bulk = SCENARIOS.minimal();
		bulk.profile.nutritionPhase = 'bulk';
		expect(why(generate(bulk), 'Glutes & hips')).toMatch(
			/\. Its main lifts, and work it shares with other groups, keep it over every week\.$/
		);
	});

	it.each(['beginner', 'powerlifter', 'injuredShoulder', 'hybrid', 'journey', 'minimal'] as const)(
		'%s: pulls at least as much as it pushes in every full-volume week',
		(key: ScenarioKey) => {
			for (const week of fullWeeks(generate(SCENARIOS[key]()))) {
				const { push, pull } = pushPull(week);
				expect(pull, week.startsOn).toBeGreaterThanOrEqual(push);
			}
		}
	);

	it('takes pushing down to pulling when pushing leads, and says so', () => {
		const p = SCENARIOS.powerlifter();
		p.schedule.sessionMinutes = 45;
		const before = fullWeeks(withoutVolume(p)).map(pushPull);
		expect(before.some((w) => w.push > w.pull)).toBe(true);
		const plan = generate(p);
		for (const week of fullWeeks(plan)) {
			const { push, pull } = pushPull(week);
			expect(pull, week.startsOn).toBeGreaterThanOrEqual(push);
		}
		expect(plan.decisions.find((d) => d.ruleKey === 'volume.push_pull')).toMatchObject({
			kind: 'volume_adjusted',
			summary: 'Pulling: 12 hard sets a week',
			refs: ['blocks.0']
		});
		expect(plan.decisions.find((d) => d.ruleKey === 'volume.push_pull')?.why).toMatch(
			/^Pulling gets 12 hard sets a week, for at least as many as pushing gets \(6–12\), so the shoulders stay balanced\. Sets came off .+\.$/
		);
	});

	it('names pulling in the trade-off when it cannot catch up within the session length', () => {
		const p = SCENARIOS.beginner();
		p.schedule.sessionMinutes = 45;
		const plan = generate(p);
		expect(
			fullWeeks(plan)
				.map(pushPull)
				.some((w) => w.push > w.pull)
		).toBe(true);
		const tradeoff = plan.decisions.find((d) => d.ruleKey === 'volume.session_length');
		expect(tradeoff?.summary).toMatch(/^Your 45-minute sessions over more .*pulling work$/);
	});
});

describe('the nutrition phase', () => {
	const total = (plan: Pick<ProgramPlan, 'blocks'>, side: 0 | 1) =>
		MAJOR.reduce((sum, g) => sum + spreadOf(plan, g)[side]!, 0);
	/** Every line's role and RPE in each week: what intensity the plan asks for. */
	const intensity = (plan: Pick<ProgramPlan, 'blocks'>) =>
		plan.blocks[0]!.weeks.map(
			(w) =>
				new Set(
					strengthIn(w).flatMap((s) =>
						s.exercises.flatMap((e) => e.sets.map((l) => `${l.role}@${l.targetRpe}`))
					)
				)
		);

	it('a cut takes about a fifth of the sets off, at the same intensity, with decisions', () => {
		const kept = generate(hypertrophy(4, 75));
		const cut = generate(hypertrophy(4, 75, 'cut'));
		const share = total(cut, 0) / total(kept, 0);
		expect(share).toBeGreaterThanOrEqual(0.75);
		expect(share).toBeLessThanOrEqual(0.85);
		for (const g of MAJOR) expect(spreadOf(cut, g)[1]).toBeLessThanOrEqual(spreadOf(kept, g)[1]);
		expect(intensity(cut)).toEqual(intensity(kept));
		const decisions = cut.decisions.filter((d) => d.kind === 'volume_adjusted');
		expect(decisions.length).toBeGreaterThan(0);
		for (const d of decisions) {
			expect(d.ruleKey).toBe('volume.cut');
			expect(d.why).toContain('that suits building muscle on a cut');
			expect(d.why).toContain(
				'Your cut takes about a fifth of the sets off, at the same intensity'
			);
		}
	});

	it('a strength cut takes about a fifth off too, back-off sets among them, never a top set', () => {
		const strength = (phase: NutritionPhase | null) => {
			const p = SCENARIOS.minimal();
			p.profile.nutritionPhase = phase;
			return p;
		};
		const kept = generate(strength(null));
		const cut = generate(strength('cut'));
		const sets = (plan: Pick<ProgramPlan, 'blocks'>) =>
			fullWeeks(plan).reduce((n, w) => n + MAJOR.reduce((m, g) => m + hardSets(w, g), 0), 0);
		const share = sets(cut) / sets(kept);
		expect(share).toBeGreaterThanOrEqual(0.75);
		expect(share).toBeLessThanOrEqual(0.85);
		const tops = (plan: Pick<ProgramPlan, 'blocks'>) =>
			plan.blocks[0]!.weeks.flatMap(strengthIn).flatMap((s) =>
				s.exercises.flatMap((e) => e.sets.filter((l) => l.role === 'top'))
			);
		expect(tops(cut)).toEqual(tops(kept));
		expect(intensity(cut)).toEqual(intensity(kept));
	});

	it('a cut in sessions too short for the range only takes sets off and still names the time', () => {
		const home = (phase: NutritionPhase | null) => {
			const p = SCENARIOS.dumbbellsOnly();
			p.profile.nutritionPhase = phase;
			return p;
		};
		const [kept, cut] = [generate(home(null)), generate(home('cut'))];
		fullWeeks(cut).forEach((week, w) => {
			for (const g of MAJOR) {
				expect(hardSets(week, g), `${g} in ${week.startsOn}`).toBeLessThanOrEqual(
					hardSets(fullWeeks(kept)[w]!, g)
				);
			}
		});
		expect(cut.decisions.find((d) => d.ruleKey === 'volume.session_length')?.summary).toBe(
			'Your 45-minute sessions over more shoulders, hamstrings and pulling work'
		);
	});

	it('gives the phase as the reason only where it changed the sets', () => {
		const p = SCENARIOS.minimal();
		p.profile.nutritionPhase = 'bulk';
		const plan = generate(p);
		const why = (group: string) =>
			plan.decisions.find((d) => d.kind === 'volume_adjusted' && d.evidence.group === group)?.why;
		expect(spreadOf(plan, 'back')).toEqual(spreadOf(withoutVolume(p), 'back'));
		expect(why('Back')).not.toContain('Your bulk');
		expect(why('Chest')).toContain(
			'Your bulk moves it toward the top of the range: sets were added'
		);
	});

	it('a bulk moves every major group toward the top of the range, with decisions', () => {
		const kept = generate(hypertrophy(4, 75));
		const bulk = generate(hypertrophy(4, 75, 'bulk'));
		expect(total(bulk, 0)).toBeGreaterThan(total(kept, 0) + 15);
		for (const g of MAJOR) {
			expect(spreadOf(bulk, g)[0], g).toBeGreaterThanOrEqual(spreadOf(kept, g)[0]);
			expect(spreadOf(bulk, g)[0], g).toBeGreaterThanOrEqual(14);
		}
		const decisions = bulk.decisions.filter((d) => d.kind === 'volume_adjusted');
		expect(decisions.length).toBeGreaterThan(0);
		for (const d of decisions) {
			expect(d.ruleKey).toBe('volume.bulk');
			expect(d.why).toContain('for the top of the 10–20 that suits building muscle');
		}
	});

	it('a hypertrophy bulk in 3 × 45-minute sessions stays within 45 minutes and records the trade-off', () => {
		const input = inputOf(hypertrophy(3, 45, 'bulk'));
		const plan = generateProgram(input, OPTIONS);
		const sessions = plan.blocks[0]!.weeks.flatMap(strengthIn);
		expect(sessions.length).toBeGreaterThan(0);
		for (const s of sessions) {
			expect(s.estMinutes).toBe(estimateMinutes(s, input));
			expect(s.estMinutes).toBeLessThanOrEqual(45);
		}
		expect(spreadOf(plan, 'chest')[0]).toBeLessThan(10);
		const tradeoffs = plan.decisions.filter((d) => d.kind === 'priority_tradeoff');
		expect(tradeoffs).toEqual([
			expect.objectContaining({
				ruleKey: 'volume.session_length',
				refs: ['blocks.0'],
				why: 'Reaching the top of the 10–20 that suits building muscle would take more sets than your 45-minute sessions hold, so the session length comes first.'
			})
		]);
		expect(tradeoffs[0]!.summary).toMatch(/^Your 45-minute sessions over more chest, .+ work$/);
	});
});

describe('the volume stage', () => {
	it('dumbbells only and an injured shoulder: the work it adds holds to them too', () => {
		const home = SCENARIOS.dumbbellsOnly();
		home.goals[0]!.disciplines = ['hypertrophy'];
		home.schedule.sessionMinutes = 75;
		const shoulder = SCENARIOS.injuredShoulder();
		shoulder.goals[0]!.disciplines = ['hypertrophy'];
		shoulder.schedule.sessionMinutes = 75;
		for (const [p, holds] of [
			[
				home,
				(e: (typeof CATALOGUE)[number]) =>
					e.equipment.every((i) => i === 'dumbbells' || i === 'bench')
			],
			[shoulder, (e: (typeof CATALOGUE)[number]) => !e.tags.includes('overhead')]
		] as const) {
			const keys = (plan: Pick<ProgramPlan, 'blocks'>) =>
				new Set(plan.blocks[0]!.weeks.flatMap(strengthIn).flatMap((s) => s.exercises.map(keyOf)));
			const before = keys(withoutVolume(p));
			const after = keys(generate(p));
			expect([...after].filter((k) => !before.has(k)).length).toBeGreaterThan(0);
			for (const key of after) expect(holds(catalogueByKey.get(key)!), key).toBe(true);
		}
	});

	it('changes only work besides the main lifts, alike in every week of the block', () => {
		const p = hypertrophy(4, 75);
		const before = withoutVolume(p).blocks[0]!.weeks;
		const weeks = generate(p).blocks[0]!.weeks;
		const mains = (w: WeekPlan) =>
			strengthIn(w).map((s) => s.exercises.filter((e) => e.sets.some((l) => l.role === 'top')));
		const shape = (w: WeekPlan) =>
			strengthIn(w).map((s) => [
				s.title,
				s.exercises.map((e) => [keyOf(e), e.sets.map((l) => l.sets)])
			]);
		weeks.forEach((week, i) => {
			expect(mains(week)).toEqual(mains(before[i]!));
			expect(shape(week)).toEqual(shape(weeks[0]!));
		});
		expect(shape(weeks[0]!)).not.toEqual(shape(before[0]!));
	});

	it.each(Object.keys(SCENARIOS) as ScenarioKey[])(
		'%s: adds sets only where they fit, so timefit trims no session it would not have',
		(key) => {
			const trimmed = (plan: Pick<ProgramPlan, 'decisions'>) =>
				plan.decisions.filter((d) => d.kind === 'time_trimmed').flatMap((d) => d.refs);
			const before = new Set(trimmed(withoutVolume(SCENARIOS[key]())));
			expect(trimmed(generate(SCENARIOS[key]())).filter((ref) => !before.has(ref))).toEqual([]);
		}
	);

	it('leaves the draft as it is when no goal asks for strength', () => {
		const p = SCENARIOS.minimal();
		p.goals[0]!.disciplines = ['running'];
		const context = { input: inputOf(p), options: OPTIONS, log: new DecisionLog() };
		let draft: Draft = { demand: null, blocks: [] };
		for (const stage of STAGES.slice(
			0,
			STAGES.findIndex((s) => s.name === 'volume')
		))
			draft = stage.run(draft, context);
		const before = context.log.list().length;
		expect(volume(draft, context)).toBe(draft);
		expect(context.log.list()).toHaveLength(before);
	});
});
