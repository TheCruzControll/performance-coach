import { describe, expect, it } from 'vitest';
import { workoutDayKits } from '../../../../tests/fixtures/workout-day';
import type { CustomMetric } from '../training/types';
import { createMutation } from './mutations';
import type { Mutation, MutationInput, MutationOf, MutationType, OtherFields } from './mutations';
import { checkMetrics, metricInput, metricTemplate, metricType } from './other';
import { project, replay } from './project';
import type { CanonicalWorkout } from './protocol';
import { otherTable } from './reducers/tables';
import type { OtherKit } from './types';

const KIT = workoutDayKits({ date: '2026-11-06' }).other;
const ADHOC: OtherKit = {
	...KIT,
	title: 'Conditioning',
	sessionType: 'conditioning',
	plannedLineage: null,
	plannedSessionId: null,
	programId: null,
	versionNumber: null,
	other: { kind: 'conditioning', durationMinutes: 45, targetRpe: null, metrics: [] }
};
const W = '00000000-0000-4000-8000-0000000000c1';

const [ROUNDS, SPARRED] = KIT.other.metrics as [CustomMetric, CustomMetric];
const FOCUS: CustomMetric = { key: 'focus', label: 'Focus', unit: null, value: 'Clinch' };
const metric = (
	key: string,
	label: string,
	value: CustomMetric['value'],
	unit: string | null = null
) => ({ key, label, unit, value }) satisfies CustomMetric;

let ids = 0;
const fresh = () => `fresh-${++ids}`;
const at = (second: number) => new Date(Date.UTC(2026, 10, 6, 19, 0, second)).toISOString();

function make<T extends MutationType>(
	type: T,
	input: Omit<MutationInput<T>, 'workoutId' | 'at'> & { second?: number }
): MutationOf<T> {
	const { second = 0, ...rest } = input;
	return createMutation(type, { workoutId: W, at: at(second), ...rest }, fresh);
}

const start = () =>
	make('workout.start', {
		entityId: W,
		payload: {
			kind: 'other',
			title: KIT.title,
			sessionType: KIT.sessionType,
			discipline: KIT.discipline,
			plannedSessionId: KIT.plannedSessionId,
			plannedLineage: KIT.plannedLineage,
			programId: KIT.programId
		}
	});

const session = (fields: Partial<OtherFields> = {}): OtherFields => ({
	kind: 'class',
	durationMinutes: 90,
	rpe: 7,
	metrics: [
		{ ...ROUNDS, value: 6 },
		{ ...SPARRED, value: false }
	],
	notes: null,
	...fields
});

const log = (fields: Partial<OtherFields> = {}, second = 60) =>
	make('other.log', { second, payload: session(fields) });

const view = (pending: readonly Mutation[], canonical: CanonicalWorkout | null = null) =>
	project(otherTable, { workoutId: W, kit: KIT, canonical, pending });

const serverModel = (mutations: readonly Mutation[]) =>
	replay(otherTable, { workoutId: W, kit: KIT, canonical: null, pending: mutations }).rows;

describe('metricInput', () => {
	it("types each value by the plan's template: rounds 6 is a number, sparred a yes/no", () => {
		expect(metricInput(ROUNDS, '6')).toStrictEqual({ ok: true, metric: { ...ROUNDS, value: 6 } });
		expect(metricInput(ROUNDS, ' 12 ')).toStrictEqual({
			ok: true,
			metric: { ...ROUNDS, value: 12 }
		});
		expect(metricInput(ROUNDS, 7)).toStrictEqual({ ok: true, metric: { ...ROUNDS, value: 7 } });
		expect(metricInput(SPARRED, true)).toStrictEqual({
			ok: true,
			metric: { ...SPARRED, value: true }
		});
		expect(metricInput(SPARRED, false)).toStrictEqual({
			ok: true,
			metric: { ...SPARRED, value: false }
		});
		expect(metricInput(FOCUS, '  Teeps ')).toStrictEqual({
			ok: true,
			metric: { ...FOCUS, value: 'Teeps' }
		});
		const calories = metric('bike_calories', 'Bike calories', 0, 'kcal');
		expect(metricInput(calories, '120.5')).toStrictEqual({
			ok: true,
			metric: { ...calories, value: 120.5 }
		});
	});

	it('keeps the metric it is given: its key, label and unit', () => {
		const result = metricInput(ROUNDS, '8');
		expect(result.ok && result.metric).toStrictEqual({
			key: 'rounds',
			label: 'Rounds',
			unit: null,
			value: 8
		});
	});

	it('refuses a value its type does not take, saying what it needs', () => {
		for (const raw of ['six', '', '  ', '0x10', '1e3', '6 rounds', Number.NaN, Infinity, true]) {
			expect(metricInput(ROUNDS, raw), String(raw)).toStrictEqual({
				ok: false,
				error: 'Rounds is a number'
			});
		}
		for (const raw of ['yes', 'true', 1, '']) {
			expect(metricInput(SPARRED, raw), String(raw)).toStrictEqual({
				ok: false,
				error: 'Sparred is yes or no'
			});
		}
		for (const raw of ['', '   ', 6, false]) {
			expect(metricInput(FOCUS, raw), String(raw)).toStrictEqual({
				ok: false,
				error: 'Focus is a short text'
			});
		}
	});

	it("reads a metric's type from its value: a number, a yes/no or a short text", () => {
		expect(metricType(6)).toBe('number');
		expect(metricType(0)).toBe('number');
		expect(metricType(false)).toBe('yes_no');
		expect(metricType('Clinch')).toBe('text');
	});
});

describe('checkMetrics', () => {
	const PLANNED = metricTemplate(KIT);

	it("reads the template from a planned session's kit, and none from an ad-hoc one", () => {
		expect(PLANNED).toStrictEqual(KIT.other.metrics);
		expect(metricTemplate(ADHOC)).toBeNull();
	});

	it('accepts an unknown metric key on an ad-hoc session and refuses it on a planned one', () => {
		const metrics = [{ ...ROUNDS, value: 7 }, metric('bike_calories', 'Bike calories', 120)];
		expect(checkMetrics(metrics, metricTemplate(ADHOC))).toStrictEqual({});
		expect(checkMetrics(metrics, PLANNED)).toStrictEqual({
			'payload.metrics.1.key': 'Bike calories is not one of this session’s metrics'
		});
	});

	it("accepts the plan's metrics, typed as the plan types them, in any order and any subset", () => {
		expect(checkMetrics(session().metrics, PLANNED)).toStrictEqual({});
		expect(checkMetrics([{ ...SPARRED, value: true }], PLANNED)).toStrictEqual({});
		expect(checkMetrics([], PLANNED)).toStrictEqual({});
	});

	it("refuses a planned metric whose value is not the plan's type, at its dotted path", () => {
		const metrics = [
			{ ...SPARRED, value: true },
			{ ...ROUNDS, value: 'six' }
		];
		expect(checkMetrics(metrics, PLANNED)).toStrictEqual({
			'payload.metrics.1.value': 'Rounds is a number'
		});
		expect(checkMetrics([{ ...SPARRED, value: 1 }], PLANNED)).toStrictEqual({
			'payload.metrics.0.value': 'Sparred is yes or no'
		});
	});
});

describe('the other reducer', () => {
	it('records the session on its first other.log, and waits for the workout before that', () => {
		expect(view([log()])).toBeNull();
		expect(view([start(), log()])!.other).toStrictEqual({ ...session(), pending: true });
		expect(view([], serverModel([start(), log()]))!.other).toStrictEqual({
			...session(),
			pending: false
		});
	});

	it('replaces every value when an other.log with rounds 7 follows one with rounds 6', () => {
		const first = log();
		const later = log(
			{
				durationMinutes: 95,
				rpe: 8,
				metrics: [{ ...ROUNDS, value: 7 }],
				notes: 'Sparred light'
			},
			120
		);
		const expected = {
			kind: 'class',
			durationMinutes: 95,
			rpe: 8,
			// Sparred, left out of the later send, is no longer recorded: values are absolute.
			metrics: [{ ...ROUNDS, value: 7 }],
			notes: 'Sparred light'
		};
		expect(view([start(), first, later])!.other).toStrictEqual({ ...expected, pending: true });
		expect(view([later], serverModel([start(), first]))!.other).toStrictEqual({
			...expected,
			pending: true
		});
		expect(serverModel([start(), first, later])!.other).toStrictEqual(expected);
	});

	it('replays deterministically and idempotently, whatever the server already applied', () => {
		const M = [start(), log(), log({ metrics: [{ ...ROUNDS, value: 7 }] }, 120)];
		const settled = serverModel(M);
		expect(settled!.other).toStrictEqual(session({ metrics: [{ ...ROUNDS, value: 7 }] }));
		for (let k = 0; k <= M.length; k++) {
			for (let i = 0; i <= k; i++) {
				const v = view(M.slice(i), serverModel(M.slice(0, k)));
				expect(v && { ...v.other!, pending: false }, `k ${k}, i ${i}`).toStrictEqual({
					...settled!.other!,
					pending: false
				});
			}
		}
		expect(serverModel([...M, M[2]!])).toStrictEqual(settled);
		expect(view(M)).toStrictEqual(view(M));
	});

	it("keeps only the session's fields: nothing else a payload holds reaches the record", () => {
		const extra = { ...{ workoutId: 'another', paceSecondsPerKm: 1 } };
		const sneaky = make('other.log', {
			payload: {
				...session(),
				...extra,
				metrics: [{ ...ROUNDS, value: 6, ...{ score: 10 } }]
			}
		});
		expect(view([start(), sneaky])!.other).toStrictEqual({
			...session({ metrics: [{ ...ROUNDS, value: 6 }] }),
			pending: true
		});
	});
});
