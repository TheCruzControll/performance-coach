import { describe, expect, it } from 'vitest';
import { RUNNING_DISCIPLINES, type Discipline } from '#lib/domain/profile/catalog.ts';
import { SCHEMAS, validate } from '#lib/domain/profile/schemas.ts';
import type { MuayThaiProfile, RunningProfile } from '#lib/domain/profile/types.ts';
import {
	muayThaiDraft,
	newRace,
	normaliseTime,
	raceName,
	runningDraft,
	runningPayload,
	specificsDraft,
	specificsPayload,
	timeError,
	timeSeconds,
	type RaceDraft,
	type RunningDraft
} from './specifics';

const running: RunningProfile = {
	unit: 'km',
	weeklyDistance: 40,
	runsPerWeek: 4,
	longestRun: 18,
	easyPaceSeconds: 345,
	races: [
		{
			id: 'race-10k',
			distance: '10k',
			customDistance: null,
			distanceMetres: 10000,
			timeSeconds: 2730,
			racedOn: '2026-09-14',
			eventName: 'City 10K'
		},
		{
			id: 'race-half',
			distance: 'half_marathon',
			customDistance: null,
			distanceMetres: 21097.5,
			timeSeconds: 6330,
			racedOn: null,
			eventName: null
		}
	],
	notes: 'Long run on Sundays',
	updatedAt: new Date('2026-11-01T08:00:00Z')
};

const muayThai: MuayThaiProfile = {
	sessionsPerWeek: 3,
	sparringPerWeek: 1,
	fights: 2,
	notes: 'Southpaw',
	updatedAt: new Date('2026-11-01T08:00:00Z')
};

const nothing = { running: null, muayThai: null };

const inPlay = (...disciplines: Discipline[]) => ({
	disciplines,
	units: { weight: 'kg', distance: 'km' } as const
});

/** A blank running draft in km, with these fields. */
const draft = (fields: Partial<RunningDraft> = {}): RunningDraft => ({
	...runningDraft(null, 'km'),
	...fields
});

const race = (fields: Partial<RaceDraft>): RaceDraft => ({ ...newRace(), ...fields });

/** What the schema makes of a post, after the JSON the browser sends it as. */
const posted = (body: unknown) => validate(SCHEMAS.specifics, JSON.parse(JSON.stringify(body)));

describe('typed times', () => {
	it('read with any separator the iPhone’s decimal keypad has, or with ":"', () => {
		expect(timeSeconds('5.45')).toBe(345);
		expect(timeSeconds('5,45')).toBe(345);
		expect(timeSeconds('5 45')).toBe(345);
		expect(timeSeconds('5:45')).toBe(345);
		expect(timeSeconds('1.45.30')).toBe(6330);
		expect(timeSeconds('1:45:30')).toBe(6330);
		expect(timeSeconds(' 1 . 45 . 30 ')).toBe(6330);
	});

	it('become the one form parseDuration reads', () => {
		expect(normaliseTime('1.45.30')).toBe('1:45:30');
		expect(normaliseTime(' 5,45 ')).toBe('5:45');
		expect(normaliseTime('1  45 30')).toBe('1:45:30');
		expect(normaliseTime('1:45:30')).toBe('1:45:30');
	});

	it('are none when blank', () => {
		expect(timeSeconds('')).toBeNull();
		expect(timeSeconds('   ')).toBeNull();
	});

	it('stay as typed when they are not a time, "5.5" included (5:30 or 5:05?)', () => {
		for (const text of ['abc', '5.5', '5.75', '5..45', '545', '1.61.00']) {
			expect(timeSeconds(text), text).toBe(text);
		}
		expect(timeSeconds(' abc ')).toBe('abc');
	});
});

describe('runningPayload', () => {
	it('posts typed times in seconds: easy pace 5.45 is 345 s, a half in 1.45.30 is 6330 s', () => {
		const payload = runningPayload(
			draft({
				weeklyDistance: 40,
				easyPace: '5.45',
				races: [race({ distance: 'half_marathon', time: '1.45.30' })]
			})
		);
		expect(payload).toMatchObject({
			weeklyDistance: 40,
			easyPaceSeconds: 345,
			races: [{ distance: 'half_marathon', timeSeconds: 6330 }]
		});
		expect(posted({ running: payload, muayThai: null }).ok).toBe(true);
	});

	it('posts a blank easy pace as none', () => {
		const payload = runningPayload(draft({ easyPace: '' }));
		expect(payload.easyPaceSeconds).toBeNull();
		expect(posted({ running: payload, muayThai: null }).ok).toBe(true);
	});

	it('keeps a time that is not one, so the schema refuses it in the browser and on the server', () => {
		const payload = runningPayload(
			draft({ easyPace: 'abc', races: [race({ distance: '10k', time: '5.5' })] })
		);
		const body = { running: payload, muayThai: null };
		// As built in the browser, and as the server parses it: NaN would arrive as null there,
		// and an easy pace that could not be read would be dropped without a word.
		for (const result of [validate(SCHEMAS.specifics, body), posted(body)]) {
			expect(result.ok ? {} : result.errors).toEqual({
				'running.easyPaceSeconds': 'Easy pace between 2:00 and 25:00',
				'running.races.0.timeSeconds': 'Enter your time as h:mm:ss or mm:ss'
			});
		}
	});

	it('keeps an “Other” race’s distance, and drops it for every other distance', () => {
		const payload = runningPayload(
			draft({
				races: [
					race({ distance: 'other', customDistance: 12, time: '58.10' }),
					race({ distance: '5k', customDistance: 12, time: '22.40' })
				]
			})
		);
		expect(payload.races.map((r) => [r.distance, r.customDistance])).toEqual([
			['other', 12],
			['5k', null]
		]);
	});

	it('asks how far an “Other” race was, and for a distance and a time on a new race', () => {
		const result = posted({
			running: runningPayload(
				draft({ races: [race({ distance: 'other', time: '58.10' }), newRace()] })
			),
			muayThai: null
		});
		expect(result.ok ? {} : result.errors).toEqual({
			'running.races.0.customDistance': 'How far was it?',
			'running.races.1.distance': 'Pick a distance',
			'running.races.1.timeSeconds': 'Enter your time as h:mm:ss or mm:ss'
		});
	});

	it('posts races in their places, without the keys that hold them on screen', () => {
		const races = [
			race({ distance: '5k', time: '22.40' }),
			race({ distance: '10k', time: '47.05' })
		];
		const payload = runningPayload(draft({ races }));
		expect(payload.races.map((r) => r.timeSeconds)).toEqual([1360, 2825]);
		expect(payload.races.every((r) => !('key' in r))).toBe(true);
	});
});

describe('specificsDraft', () => {
	it('has running while either running discipline is in play, and Muay Thai while it is', () => {
		for (const discipline of RUNNING_DISCIPLINES) {
			const state = specificsDraft(nothing, inPlay(discipline));
			expect(state.running, discipline).toEqual(runningDraft(null, 'km'));
			expect(state.muayThai, discipline).toBeNull();
		}
		expect(specificsDraft(nothing, inPlay('muay_thai'))).toEqual({
			running: null,
			muayThai: { sessionsPerWeek: null, sparringPerWeek: null, fights: null, notes: null }
		});
	});

	it('has neither while neither is in play and nothing is saved', () => {
		expect(specificsDraft(nothing, inPlay())).toEqual({ running: null, muayThai: null });
		expect(specificsDraft(nothing, inPlay('powerlifting', 'hypertrophy', 'custom'))).toEqual({
			running: null,
			muayThai: null
		});
	});

	it('edits what was saved, goal or not: times written out, races keyed by their ids', () => {
		expect(specificsDraft({ running, muayThai }, inPlay())).toEqual({
			running: {
				unit: 'km',
				weeklyDistance: 40,
				runsPerWeek: 4,
				longestRun: 18,
				easyPace: '5:45',
				races: [
					{
						key: 'race-10k',
						distance: '10k',
						customDistance: null,
						time: '45:30',
						racedOn: '2026-09-14',
						eventName: 'City 10K'
					},
					{
						key: 'race-half',
						distance: 'half_marathon',
						customDistance: null,
						time: '1:45:30',
						racedOn: null,
						eventName: null
					}
				],
				notes: 'Long run on Sundays'
			},
			muayThai: { sessionsPerWeek: 3, sparringPerWeek: 1, fights: 2, notes: 'Southpaw' }
		});
	});

	it('keeps saved running in its own unit, and starts new running in the owner’s', () => {
		const miles = { disciplines: ['running'] as Discipline[], units: { distance: 'mi' } as const };
		expect(specificsDraft({ running, muayThai: null }, miles).running?.unit).toBe('km');
		expect(specificsDraft(nothing, miles).running?.unit).toBe('mi');
	});

	it('saves straight back: what was saved posts the same values, blank parts pass too', () => {
		expect(posted(specificsPayload(specificsDraft({ running, muayThai }, inPlay())))).toEqual({
			ok: true,
			data: {
				running: {
					unit: 'km',
					weeklyDistance: 40,
					runsPerWeek: 4,
					longestRun: 18,
					easyPaceSeconds: 345,
					races: [
						{
							distance: '10k',
							customDistance: null,
							timeSeconds: 2730,
							racedOn: '2026-09-14',
							eventName: 'City 10K'
						},
						{
							distance: 'half_marathon',
							customDistance: null,
							timeSeconds: 6330,
							racedOn: null,
							eventName: null
						}
					],
					notes: 'Long run on Sundays'
				},
				muayThai: { sessionsPerWeek: 3, sparringPerWeek: 1, fights: 2, notes: 'Southpaw' }
			}
		});
		const blank = { running: runningDraft(null, 'mi'), muayThai: muayThaiDraft(null) };
		expect(posted(specificsPayload(blank)).ok).toBe(true);
	});

	it('posts no part that is not shown, which leaves it as it was saved', () => {
		expect(specificsPayload({ running: null, muayThai: null })).toEqual({
			running: null,
			muayThai: null
		});
	});
});

describe('races on screen', () => {
	it('start with no distance picked and a key no other race has', () => {
		const [a, b] = [newRace(), newRace()];
		expect(a).toMatchObject({ distance: null, customDistance: null, time: '', racedOn: null });
		expect(a.key).not.toBe(b.key);
		expect([a.key, b.key]).not.toContain(running.races[0]!.id);
	});

	it('are named by their distance, or by how far an “Other” one was', () => {
		expect(raceName(race({ distance: 'half_marathon' }), 'km')).toBe('Half marathon');
		expect(raceName(race({ distance: '10k' }), 'mi')).toBe('10K');
		expect(raceName(race({ distance: 'other', customDistance: 12.5 }), 'mi')).toBe('12.5 mi');
		expect(raceName(race({ distance: 'other' }), 'km')).toBe('Other');
		expect(raceName(newRace(), 'km')).toBe('New race');
	});
});

describe('timeError', () => {
	const format = 'Type it as m.ss, like 5.45';

	it('says how to type a time when what is there is not one', () => {
		expect(timeError('abc', 'Easy pace between 2:00 and 25:00', format)).toBe(format);
		expect(timeError('5.5', 'Easy pace between 2:00 and 25:00', format)).toBe(format);
		expect(timeError('', 'Enter your time as h:mm:ss or mm:ss', format)).toBe(format);
	});

	it('keeps the schema’s message for a time out of range, and says nothing without one', () => {
		expect(timeError('1.30', 'Easy pace between 2:00 and 25:00', format)).toBe(
			'Easy pace between 2:00 and 25:00'
		);
		expect(timeError('abc', undefined, format)).toBeUndefined();
	});
});
