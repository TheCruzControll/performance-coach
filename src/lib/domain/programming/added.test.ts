/**
 * added.ts: one session added to a planned week, built by the generator's own builders. Every kind
 * and intent passes the session contract, holds the week's RPE cap, keeps or trims its length,
 * refuses a run too short for its warm-up and main set, never prescribes a disliked exercise or one
 * an injury rules out, refuses a strength session no exercise fits, and gives the same session twice.
 */
import { describe, expect, it } from 'vitest';
import { CATALOGUE } from '../exercises/index';
import { addDays } from '../calendar';
import { addSessionSchema, ADDED_KINDS, ADD_INTENTS } from '../training/edits';
import type { AddSessionInput } from '../training/edits';
import type { TrainingProfile } from '../profile/types';
import { sessionPlanSchema } from '../training/schemas';
import type { SessionPlan, WeekPlan } from '../training/types';
import { validate } from '../validation';
import { buildProgrammingInput, toExerciseKey } from './input';
import type { ProgrammingInput } from './input';
import { AddRefusal, buildAddedSession } from './added';
import { isEligible } from './eligibility';
import { exerciseOf } from './selection';
import { SCENARIOS, SCENARIO_START } from './scenarios';

const DATE = addDays(SCENARIO_START, 3);

/** A planned week of the active program, at an RPE cap of 8 unless told. */
const weekAt = (rpeCap = 8): WeekPlan => ({
	kind: 'accumulation',
	startsOn: SCENARIO_START,
	endsOn: addDays(SCENARIO_START, 6),
	targets: { rpeCap, volumeFactor: 1, loadStep: 0, runVolumeFactor: 1 },
	sessions: []
});

const inputOf = (profile: TrainingProfile) =>
	buildProgrammingInput(profile, { catalogue: CATALOGUE });

const minimal = inputOf(SCENARIOS.minimal());
const hybrid = inputOf(SCENARIOS.hybrid());
const injured = inputOf(SCENARIOS.injuredShoulder());
const dumbbells = inputOf(SCENARIOS.dumbbellsOnly());
/** The minimal profile with Muay Thai trained: its input carries the Muay Thai profile. */
const withMuayThai = (sparringPerWeek: number | null) => {
	const base = SCENARIOS.minimal();
	return inputOf({
		...base,
		goals: [{ ...base.goals[0]!, title: 'Muay Thai', disciplines: ['muay_thai'] }],
		muayThai: {
			sessionsPerWeek: 2,
			sparringPerWeek,
			fights: null,
			notes: null,
			updatedAt: new Date('2026-11-01T08:00:00Z')
		}
	});
};

const request = (
	over: Partial<AddSessionInput> & Pick<AddSessionInput, 'kind'>
): AddSessionInput => ({
	date: DATE,
	...over
});

const build = (req: AddSessionInput, input: ProgrammingInput = minimal, cap = 8) =>
	buildAddedSession(req, weekAt(cap), input);

/** Every RPE a session prescribes: its own, its segments', its details' and its sets'. */
function rpesOf(session: SessionPlan): number[] {
	const own = session.targetRpe === null ? [] : [session.targetRpe];
	if (session.kind === 'run') {
		return [...own, ...session.segments.map((s) => s.targetRpe ?? 0)];
	}
	if (session.kind === 'other') return [...own, session.details.targetRpe ?? 0];
	return [...own, ...session.exercises.flatMap((e) => e.sets.map((s) => s.targetRpe ?? 0))];
}

const keysOf = (session: SessionPlan) =>
	session.kind === 'strength' ? session.exercises.map((e) => toExerciseKey(e.exercise)) : [];

describe('buildAddedSession', () => {
	it('builds every kind at every intent, a session the contract accepts', () => {
		for (const input of [minimal, hybrid, injured, dumbbells]) {
			for (const kind of ADDED_KINDS) {
				for (const intent of ADD_INTENTS) {
					const session = build(request({ kind, intent }), input);
					expect(validate(sessionPlanSchema, session).ok, `${kind} ${intent}`).toBe(true);
					expect(session).toMatchObject({ date: DATE, orderInDay: 1, source: 'generator' });
				}
			}
		}
	});

	it('maps each kind to its session: a run, a strength session or another session', () => {
		const input = withMuayThai(0);
		expect(build(request({ kind: 'run' }), input).kind).toBe('run');
		expect(build(request({ kind: 'strength' }), input).kind).toBe('strength');
		expect(build(request({ kind: 'hypertrophy' }), input).kind).toBe('strength');
		expect(build(request({ kind: 'muay_thai' }), input).kind).toBe('other');
		expect(build(request({ kind: 'conditioning' }), input).kind).toBe('other');
	});

	it('holds every prescribed RPE to the week’s cap', () => {
		for (const intent of ADD_INTENTS) {
			for (const kind of ADDED_KINDS) {
				const session = build(request({ kind, intent }), hybrid, 6);
				for (const rpe of rpesOf(session)) {
					expect(rpe, `${kind} ${intent}`).toBeLessThanOrEqual(6);
				}
			}
		}
	});

	it('keeps the length asked for, the kind’s own when none is asked, and trims strength to it', () => {
		const easy = build(request({ kind: 'run', intent: 'easy', durationMinutes: 40 }));
		expect(easy).toMatchObject({ estMinutes: 40 });
		expect(build(request({ kind: 'run', intent: 'easy' }))).toMatchObject({ estMinutes: 30 });
		// A moderate run's tempo is QUALITY's tempo minutes at most: 10 + 20 + 10, not the 45 asked.
		expect(build(request({ kind: 'run', intent: 'moderate', durationMinutes: 45 }))).toMatchObject({
			estMinutes: 40
		});
		expect(build(request({ kind: 'run', intent: 'moderate', durationMinutes: 30 }))).toMatchObject({
			estMinutes: 30
		});
		expect(build(request({ kind: 'muay_thai', durationMinutes: 50 }))).toMatchObject({
			estMinutes: 50,
			details: { durationMinutes: 50 }
		});
		expect(build(request({ kind: 'conditioning', durationMinutes: 20 }))).toMatchObject({
			estMinutes: 20
		});
		expect(build(request({ kind: 'conditioning' }))).toMatchObject({ estMinutes: 30 });
		// A conditioning session takes the session length when that is shorter than its 30 minutes.
		const short = { ...minimal, sessionMinutes: 20 };
		expect(build(request({ kind: 'conditioning' }), short)).toMatchObject({ estMinutes: 20 });
		expect(build(request({ kind: 'conditioning', durationMinutes: 25 }), short)).toMatchObject({
			estMinutes: 25
		});
		const strength = build(request({ kind: 'strength', intent: 'hard', durationMinutes: 25 }));
		expect(strength.kind === 'strength' && strength.estMinutes <= 25).toBe(true);
		const usual = build(request({ kind: 'strength', intent: 'hard' }));
		expect(usual.estMinutes).toBeLessThanOrEqual(minimal.sessionMinutes);
	});

	it('refuses a moderate or hard run under 30 minutes, at its length', () => {
		for (const intent of ['moderate', 'hard'] as const) {
			let refusal: unknown;
			try {
				build(request({ kind: 'run', intent, durationMinutes: 25 }));
			} catch (error) {
				refusal = error;
			}
			expect(refusal).toBeInstanceOf(AddRefusal);
			expect(refusal).toMatchObject({
				field: 'durationMinutes',
				message: 'A moderate or hard run needs at least 30 minutes'
			});
		}
		expect(build(request({ kind: 'run', intent: 'hard', durationMinutes: 30 })).estMinutes).toBe(
			30
		);
		expect(build(request({ kind: 'run', intent: 'easy', durationMinutes: 10 })).estMinutes).toBe(
			10
		);
	});

	it('maps each run intent to its run, with the warm-up and cool-down its quality needs', () => {
		const easy = build(request({ kind: 'run', intent: 'easy' }), hybrid);
		expect(easy).toMatchObject({ kind: 'run', type: 'easy_run', title: 'Easy run' });
		expect(easy.kind === 'run' && easy.segments.map((s) => s.kind)).toEqual(['easy']);

		const tempo = build(request({ kind: 'run', intent: 'moderate', durationMinutes: 45 }), hybrid);
		expect(tempo).toMatchObject({
			kind: 'run',
			type: 'tempo_run',
			discipline: 'distance_running',
			intensity: 'hard'
		});
		expect(tempo.kind === 'run' && tempo.segments.map((s) => s.kind)).toEqual([
			'warm_up',
			'tempo',
			'cool_down'
		]);
		if (tempo.kind !== 'run') throw new Error('a run');
		expect(tempo.segments[1]?.durationSeconds).toBe(20 * 60);
		const trimmed = build(
			request({ kind: 'run', intent: 'moderate', durationMinutes: 30 }),
			hybrid
		);
		if (trimmed.kind !== 'run') throw new Error('a run');
		expect(trimmed.segments[1]?.durationSeconds).toBe(10 * 60);

		const hard = build(request({ kind: 'run', intent: 'hard', durationMinutes: 40 }), minimal);
		expect(hard).toMatchObject({ kind: 'run', type: 'interval_run', discipline: 'running' });
		if (hard.kind !== 'run') throw new Error('a run');
		const [, work, jog] = hard.segments;
		expect(hard.segments.map((s) => s.kind)).toEqual([
			'warm_up',
			'interval',
			'recovery',
			'cool_down'
		]);
		expect(work?.repeats).toBeGreaterThanOrEqual(2);
		expect(work?.repeats).toBeLessThanOrEqual(5);
		expect(jog?.repeats).toBe(work?.repeats);
		expect(hard.estMinutes).toBeLessThanOrEqual(40);
	});

	it('never prescribes a disliked exercise', () => {
		const first = keysOf(build(request({ kind: 'strength', intent: 'moderate' }), minimal))[0]!;
		const without = { ...minimal, dislikes: [...minimal.dislikes, first] };
		expect(keysOf(build(request({ kind: 'strength', intent: 'moderate' }), without))).not.toContain(
			first
		);
	});

	it('never prescribes an exercise an injury rules out', () => {
		const session = build(request({ kind: 'strength', intent: 'hard' }), injured);
		const keys = keysOf(session);
		expect(keys.length).toBeGreaterThan(0);
		for (const key of keys) {
			const exercise = exerciseOf(injured, key)!;
			expect(isEligible(exercise, injured).ok, key).toBe(true);
		}
	});

	it('refuses a strength session no exercise fits, at its kind', () => {
		const all = { ...minimal, dislikes: CATALOGUE.map((e) => e.key) };
		let refusal: unknown;
		try {
			build(request({ kind: 'strength' }), all);
		} catch (error) {
			refusal = error;
		}
		expect(refusal).toBeInstanceOf(AddRefusal);
		expect(refusal).toMatchObject({
			field: 'kind',
			message: 'No exercises fit your equipment and injuries'
		});
	});

	it('sets a strength session by RPE, at its intent’s RPE under the cap', () => {
		const topRpe = (session: SessionPlan) => {
			if (session.kind !== 'strength') throw new Error('a strength session');
			return session.exercises[0]!.sets.find((s) => s.role === 'top')?.targetRpe;
		};
		expect(topRpe(build(request({ kind: 'strength', intent: 'easy' })))).toBe(6);
		expect(topRpe(build(request({ kind: 'strength', intent: 'hard' })))).toBe(8);
		expect(topRpe(build(request({ kind: 'strength', intent: 'hard' }), minimal, 7))).toBe(7);
		const session = build(request({ kind: 'strength' }));
		if (session.kind !== 'strength') throw new Error('a strength session');
		for (const e of session.exercises) {
			for (const s of e.sets) {
				expect(s).toMatchObject({ loadKind: 'rpe_based', loadValue: null, loadUnit: null });
			}
		}
	});

	it('rotates the day by the strength sessions already in the week', () => {
		const first = build(request({ kind: 'strength' }));
		const next = buildAddedSession(
			request({ kind: 'strength' }),
			{
				...weekAt(),
				sessions: [{ ...first, orderInDay: 1 }]
			},
			minimal
		);
		expect(keysOf(next)).not.toEqual(keysOf(first));
	});

	it('builds hypertrophy as hypertrophy, and conditioning as athletic conditioning', () => {
		expect(build(request({ kind: 'hypertrophy' }))).toMatchObject({
			kind: 'strength',
			discipline: 'hypertrophy',
			type: 'hypertrophy'
		});
		expect(build(request({ kind: 'conditioning', intent: 'hard' }))).toMatchObject({
			kind: 'other',
			type: 'conditioning',
			discipline: 'athletic',
			intensity: 'hard',
			targetRpe: 8,
			details: { kind: 'conditioning' }
		});
	});

	it('chooses muay thai by intent, and pad work for a hard session with no sparring', () => {
		const titleOf = (intent: 'easy' | 'moderate' | 'hard', sparring: number | null) => {
			const session = build(request({ kind: 'muay_thai', intent }), withMuayThai(sparring));
			return session.kind === 'other' ? session.details.kind : null;
		};
		expect(titleOf('easy', 2)).toBe('technical');
		expect(titleOf('moderate', 2)).toBe('pad_work');
		expect(titleOf('hard', 2)).toBe('sparring');
		expect(titleOf('hard', 0)).toBe('pad_work');
		expect(titleOf('hard', null)).toBe('pad_work');
	});

	it('gives pad work for a hard Muay Thai session in a week with no sparring, a deload one', () => {
		const deload = { ...weekAt(), kind: 'deload' as const };
		const hard = buildAddedSession(
			request({ kind: 'muay_thai', intent: 'hard' }),
			deload,
			withMuayThai(2)
		);
		expect(hard.kind === 'other' && hard.details.kind).toBe('pad_work');
		const accumulation = build(request({ kind: 'muay_thai', intent: 'hard' }), withMuayThai(2));
		expect(accumulation.kind === 'other' && accumulation.details.kind).toBe('sparring');
	});

	it('defaults the intent to easy for a run and moderate for every other kind', () => {
		expect(build(request({ kind: 'run' }), hybrid)).toEqual(
			build(request({ kind: 'run', intent: 'easy' }), hybrid)
		);
		expect(build(request({ kind: 'muay_thai' }), withMuayThai(0))).toEqual(
			build(request({ kind: 'muay_thai', intent: 'moderate' }), withMuayThai(0))
		);
		expect(build(request({ kind: 'conditioning' }))).toMatchObject({ intensity: 'moderate' });
		expect(build(request({ kind: 'strength' }))).toEqual(
			build(request({ kind: 'strength', intent: 'moderate' }))
		);
	});

	it('places the session at the owner’s time of day, or leaves it open', () => {
		expect(build(request({ kind: 'run', timeOfDay: 'evening' }))).toMatchObject({
			timeOfDay: 'evening'
		});
		expect(build(request({ kind: 'run' }))).toMatchObject({ timeOfDay: null });
	});

	it('is deterministic: the same request and input give the same session', () => {
		for (const kind of ADDED_KINDS) {
			const req = request({ kind, intent: 'moderate' });
			expect(build(req, hybrid)).toEqual(build(req, hybrid));
		}
	});
});

describe('addSessionSchema', () => {
	it('takes a kind and a day, and takes the rest optionally, within the length bounds', () => {
		expect(validate(addSessionSchema, { date: DATE, kind: 'run' }).ok).toBe(true);
		expect(validate(addSessionSchema, { date: DATE, kind: 'run', durationMinutes: 10 }).ok).toBe(
			true
		);
		expect(validate(addSessionSchema, { date: DATE, kind: 'run', durationMinutes: 9 }).ok).toBe(
			false
		);
		expect(validate(addSessionSchema, { date: DATE, kind: 'run', durationMinutes: 301 }).ok).toBe(
			false
		);
		expect(validate(addSessionSchema, { date: DATE, kind: 'yoga' }).ok).toBe(false);
	});
});
