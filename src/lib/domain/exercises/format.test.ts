import { describe, expect, it } from 'vitest';
import { CATALOGUE_HEADER, parseTable } from './format';

const COLUMNS = [
	'key',
	'name',
	'aliases',
	'pattern',
	'primary',
	'secondary',
	'equipment',
	'group',
	'skill',
	'reps',
	'seconds',
	'uni',
	'measure/load',
	'tags',
	'disciplines',
	'lift'
] as const;
type Row = Record<(typeof COLUMNS)[number], string>;

const BACK_SQUAT: Row = {
	key: 'back_squat',
	name: 'Back squat',
	aliases: 'Squat, High-bar squat',
	pattern: 'squat',
	primary: 'quads, glutes',
	secondary: 'adductors, lower_back',
	equipment: 'barbell, squat_rack',
	group: 'knee_dominant_bilateral',
	skill: 'intermediate',
	reps: '3-8',
	seconds: '-',
	uni: '-',
	'measure/load': 'reps/external',
	tags: 'compound, spinal_loading',
	disciplines: 'powerlifting, strength',
	lift: 'back_squat'
};
const SPLIT_SQUAT: Row = {
	...BACK_SQUAT,
	key: 'bulgarian_split_squat',
	name: 'Bulgarian split squat',
	aliases: 'Rear-foot-elevated split squat',
	pattern: 'lunge',
	secondary: 'adductors',
	equipment: 'dumbbells, bench',
	group: 'single_leg_knee',
	skill: 'beginner',
	reps: '8-12',
	uni: 'y',
	tags: 'compound',
	disciplines: '-',
	lift: '-'
};
const PLANK: Row = {
	...BACK_SQUAT,
	key: 'plank',
	name: 'Plank',
	aliases: '-',
	pattern: 'anti_extension',
	primary: 'abs',
	secondary: '-',
	equipment: '-',
	group: '-',
	skill: 'beginner',
	reps: '-',
	seconds: '45',
	'measure/load': 'time/bodyweight',
	tags: '-',
	disciplines: '-',
	lift: '-'
};

const line = (row: Row) => COLUMNS.map((column) => row[column]).join(' | ');
/** A table as a catalogue part writes it: the template literal opens on its own line. */
const table = (...rows: Row[]) => ['', CATALOGUE_HEADER, ...rows.map(line), ''].join('\n');

describe('parseTable', () => {
	it('parses a valid table, unilateral and time-measured entries included', () => {
		expect(parseTable('part.ts', table(BACK_SQUAT, SPLIT_SQUAT, PLANK))).toEqual([
			{
				key: 'back_squat',
				name: 'Back squat',
				aliases: ['Squat', 'High-bar squat'],
				pattern: 'squat',
				primaryMuscles: ['quads', 'glutes'],
				secondaryMuscles: ['adductors', 'lower_back'],
				equipment: ['barbell', 'squat_rack'],
				substitutionGroup: 'knee_dominant_bilateral',
				skillLevel: 'intermediate',
				repMin: 3,
				repMax: 8,
				defaultSeconds: null,
				unilateral: false,
				measure: 'reps',
				loadType: 'external',
				tags: ['compound', 'spinal_loading'],
				disciplines: ['powerlifting', 'strength'],
				baselineLift: 'back_squat'
			},
			expect.objectContaining({
				key: 'bulgarian_split_squat',
				unilateral: true,
				repMin: 8,
				repMax: 12,
				disciplines: [],
				baselineLift: null
			}),
			expect.objectContaining({
				key: 'plank',
				aliases: [],
				secondaryMuscles: [],
				equipment: [],
				substitutionGroup: null,
				repMin: null,
				repMax: null,
				defaultSeconds: 45,
				measure: 'time',
				loadType: 'bodyweight'
			})
		]);
	});

	it('takes a single rep count, padded cells and blank lines', () => {
		const padded = line({ ...BACK_SQUAT, reps: '5' }).replaceAll(' | ', '   |  ');
		const [squat] = parseTable('part.ts', `\n  ${CATALOGUE_HEADER}\n\n\t${padded}   \n`);
		expect(squat).toMatchObject({
			key: 'back_squat',
			repMin: 5,
			repMax: 5,
			baselineLift: 'back_squat'
		});
	});

	it('gives an empty part (the header alone) no exercises', () => {
		expect(parseTable('part.ts', `\n${CATALOGUE_HEADER}\n`)).toEqual([]);
	});

	const squat = (field: Partial<Row>) => table({ ...BACK_SQUAT, ...field });
	const plank = (field: Partial<Row>) => table({ ...PLANK, ...field });
	it.each([
		['an unknown pattern', squat({ pattern: 'squatt' }), "unknown pattern 'squatt'"],
		['an unknown primary muscle', squat({ primary: 'quads, glute' }), "unknown muscle 'glute'"],
		['an unknown secondary muscle', squat({ secondary: 'core' }), "unknown muscle 'core'"],
		['an unknown equipment key', squat({ equipment: 'rack' }), "unknown equipment 'rack'"],
		['an unknown skill level', squat({ skill: 'novice' }), "unknown skill level 'novice'"],
		['an unknown tag', squat({ tags: 'heavy' }), "unknown tag 'heavy'"],
		['an unknown discipline', squat({ disciplines: 'crossfit' }), "unknown discipline 'crossfit'"],
		["M2's custom discipline", squat({ disciplines: 'custom' }), "unknown discipline 'custom'"],
		['an unknown lift', squat({ lift: 'squat' }), "unknown lift 'squat'"],
		['an unknown measure', squat({ 'measure/load': 'sets/external' }), "unknown measure 'sets'"],
		['an unknown load type', squat({ 'measure/load': 'reps/bar' }), "unknown load type 'bar'"],
		['reps 8-5', squat({ reps: '8-5' }), 'reps 8-5 run high to low'],
		['zero reps', squat({ reps: '0-5' }), "reps must be a whole number ≥ 1 or '-', not '0'"],
		['reps in words', squat({ reps: 'five' }), "reps must be '8', '6-10' or '-', not 'five'"],
		[
			'a reps-measured entry without reps',
			squat({ reps: '-' }),
			'a reps-measured entry needs reps'
		],
		[
			'reps without the reps measure',
			plank({ reps: '3-5' }),
			'reps are for the reps measure, not time'
		],
		[
			'seconds on a reps-measured entry',
			squat({ seconds: '30' }),
			'seconds are for the time measure'
		],
		[
			'a time measure without seconds',
			plank({ seconds: '-' }),
			'a time-measured entry needs seconds'
		],
		[
			'seconds that are not a count',
			plank({ seconds: '45s' }),
			'seconds must be a whole number ≥ 1'
		],
		['uni other than y or -', squat({ uni: 'yes' }), "uni must be 'y' or '-', not 'yes'"],
		['no primary muscle', squat({ primary: '-' }), 'primary needs at least one muscle'],
		['a muscle both primary and secondary', squat({ secondary: 'glutes' }), "'glutes' is both"],
		['a muscle listed twice', squat({ primary: 'quads, quads' }), 'a muscle is listed twice'],
		['a key not in snake_case', squat({ key: 'BackSquat' }), "key 'BackSquat' must be snake_case"],
		['a group not in snake_case', squat({ group: 'Knee dominant' }), "group 'Knee dominant' must"],
		['a missing name', squat({ name: '-' }), 'name is required'],
		['a missing column', table(BACK_SQUAT).replace(' | back_squat\n', '\n'), 'expected 16 columns']
	])('refuses %s, naming the file, the line and the entry', (_case, text, message) => {
		// The entry is on line 3: the literal opens on line 1 and the header is line 2.
		const key = text.split('\n')[2]!.split('|')[0]!.trim();
		expect(() => parseTable('catalogue/lower.ts', text)).toThrow(
			`catalogue/lower.ts:3 (${key}): ${message}`
		);
	});

	it('refuses a duplicate key on the line that repeats it', () => {
		const text = table(BACK_SQUAT, SPLIT_SQUAT, { ...PLANK, key: 'back_squat' });
		expect(() => parseTable('catalogue/upper.ts', text)).toThrow(
			"catalogue/upper.ts:5 (back_squat): duplicate key 'back_squat'"
		);
	});

	it('refuses a table without the header, or with any other first line', () => {
		expect(() => parseTable('catalogue/lower.ts', `\n${line(BACK_SQUAT)}\n`)).toThrow(
			`catalogue/lower.ts:2: the table must start with '${CATALOGUE_HEADER}'`
		);
		const renamed = CATALOGUE_HEADER.replace('uni', 'unilateral');
		expect(() => parseTable('catalogue/lower.ts', `${renamed}\n${line(BACK_SQUAT)}`)).toThrow(
			'catalogue/lower.ts:1: the table must start with'
		);
		expect(() => parseTable('catalogue/lower.ts', '\n  \n')).toThrow(
			`catalogue/lower.ts: the table has no '${CATALOGUE_HEADER}' header`
		);
	});

	it("keeps the header literal fixed: it is the catalogue's bundle signature", () => {
		expect(CATALOGUE_HEADER).toBe(
			'key | name | aliases | pattern | primary | secondary | equipment | group | skill | reps | seconds | uni | measure/load | tags | disciplines | lift'
		);
	});
});
