import { describe, expect, it } from 'vitest';
import {
	parseRef,
	SOURCE_TYPE_LABEL,
	SOURCE_TYPES,
	sourceAction,
	type SourceAction,
	type SourceRef,
	type SourceType
} from './sources';

/** What each type does with a plain id; a set, run and pain report also carry their workout. */
const EXPECTED: Record<SourceType, SourceAction | null> = {
	workout: { kind: 'link', href: '/progress/workouts/w1' },
	set: { kind: 'link', href: '/progress/workouts/wk9' },
	run: { kind: 'link', href: '/progress/workouts/wk9' },
	session: { kind: 'link', href: '/train/session/w1' },
	version: null, // 'w1' is not a version number
	decision: null,
	goal: { kind: 'link', href: '/profile/goals' },
	baseline: { kind: 'link', href: '/profile/strength' },
	preference: { kind: 'link', href: '/profile/exercises' },
	proposal: { kind: 'link', href: '/coach/proposals/w1' },
	review: null,
	note: null,
	exercise: { kind: 'exercise_history', exerciseId: 'w1' },
	pain_report: { kind: 'link', href: '/progress/workouts/wk9' },
	date: null
};

const HOSTILE = [
	'//evil.example',
	'https://evil.example/x',
	'\\\\evil.example',
	'/\\evil.example',
	'javascript:alert(1)',
	'..',
	'.',
	'%2e%2e',
	'a/../../b',
	'?next=//evil.example',
	'#frag',
	' ',
	'\u0000',
	'\ud800'
];

describe('sourceAction', () => {
	it('maps every ref type to a link, the exercise-history sheet or nothing', () => {
		expect(Object.keys(EXPECTED).sort()).toEqual([...SOURCE_TYPES].sort());
		for (const type of SOURCE_TYPES) {
			expect(sourceAction({ type, id: 'w1', workoutId: 'wk9' }), type).toEqual(EXPECTED[type]);
		}
	});

	it('links a version by its number, and nothing else', () => {
		expect(sourceAction({ type: 'version', id: '3' })).toEqual({
			kind: 'link',
			href: '/train/history/3'
		});
		for (const id of ['0', '03', '-1', '1.5', '1e3', 'latest'])
			expect(sourceAction({ type: 'version', id }), id).toBeNull();
	});

	it('needs the workout a set, a run or a pain report was logged in', () => {
		for (const type of ['set', 'run', 'pain_report'] as const) {
			expect(sourceAction({ type, id: 's1' }), type).toBeNull();
			expect(sourceAction({ type, id: 's1', workoutId: '..' }), type).toBeNull();
		}
	});

	it('encodes ids into one path segment', () => {
		expect(sourceAction({ type: 'workout', id: 'a/b?c#d e%' })).toEqual({
			kind: 'link',
			href: '/progress/workouts/a%2Fb%3Fc%23d%20e%25'
		});
		expect(sourceAction({ type: 'session', id: 'é' })).toEqual({
			kind: 'link',
			href: '/train/session/%C3%A9'
		});
		expect(sourceAction({ type: 'set', id: 's', workoutId: 'x/y' })).toEqual({
			kind: 'link',
			href: '/progress/workouts/x%2Fy'
		});
	});

	it('never builds an absolute, protocol-relative or traversing URL, whatever the id', () => {
		const base = 'https://coach.test';
		for (const type of SOURCE_TYPES) {
			for (const id of HOSTILE) {
				const action = sourceAction({ type, id, workoutId: id });
				if (action?.kind !== 'link') continue;
				expect(action.href, `${type} ${JSON.stringify(id)}`).toMatch(/^\/[a-z]/);
				const url = new URL(action.href, base);
				expect(url.origin).toBe(base);
				expect(url.pathname.split('/').slice(0, 3)).toEqual(action.href.split('/').slice(0, 3));
				expect(url.search + url.hash).toBe('');
			}
		}
	});
});

describe('parseRef', () => {
	it('reads type:id and type:id|label', () => {
		expect(parseRef('workout:3f2a-01')).toEqual({ type: 'workout', id: '3f2a-01' });
		expect(parseRef('pain_report:p_1|  Left knee ')).toEqual({
			type: 'pain_report',
			id: 'p_1',
			label: 'Left knee'
		});
		expect(parseRef('version:4|')).toEqual({ type: 'version', id: '4' });
		expect(parseRef('date:2026-11-02|Monday')).toEqual({
			type: 'date',
			id: '2026-11-02',
			label: 'Monday'
		});
	});

	it('refuses unknown types, unsafe ids, impossible dates and bracketed labels', () => {
		for (const text of [
			'workouts:1',
			'Workout:1',
			':1',
			'workout:',
			'workout:-1',
			'workout:a/b',
			'workout:a b',
			`workout:${'a'.repeat(81)}`,
			'workout:1|a]b',
			'workout:1|a|b',
			'workout:1|line\nbreak',
			`workout:1|${'x'.repeat(81)}`,
			'date:2026-02-30',
			'date:today',
			'constructor:1'
		])
			expect(parseRef(text), text).toBeNull();
	});

	it('labels every type', () => {
		for (const type of SOURCE_TYPES) expect(SOURCE_TYPE_LABEL[type].trim(), type).toBeTruthy();
		const ref: SourceRef = { type: 'exercise', id: 'bench_press' };
		expect(parseRef(`${ref.type}:${ref.id}`)).toEqual(ref);
	});
});
