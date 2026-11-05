/**
 * Training-profile sections through the services on real Postgres (PRD §3): experience per
 * discipline, optional strength baselines (measured vs estimated never conflated), running and
 * Muay Thai specifics, equipment, injuries, exercise likes/dislikes and schedule — each with a
 * round trip and validation errors for bad input.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
	baselineHistory,
	getBaselines,
	getEquipment,
	getExercisePreferences,
	getExperience,
	getInjuries,
	getSchedule,
	getSpecifics,
	saveBaselines,
	saveEquipment,
	saveExercisePreferences,
	saveExperience,
	saveInjuries,
	saveSchedule,
	saveSpecifics
} from '../../../src/lib/server/services/profile';
import { withRollback } from '../helpers';
import { clock, fieldErrors, makeOwner } from './fixtures';

describe('experience per discipline', () => {
	it('round-trips levels, years and frequency, keeping ids on re-save', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const first = await saveExperience(
				owner,
				{
					entries: [
						{ discipline: 'powerlifting', level: 'intermediate', years: 4, sessionsPerWeek: 3 },
						{ discipline: 'muay_thai', level: 'novice', years: 1.5, sessionsPerWeek: 2 },
						{
							discipline: 'custom',
							customLabel: 'Bouldering',
							level: 'new',
							years: null,
							sessionsPerWeek: 1
						}
					]
				},
				{ db }
			);
			expect(
				first.map((e) => [e.discipline, e.customLabel, e.level, e.years, e.sessionsPerWeek])
			).toEqual([
				['powerlifting', null, 'intermediate', 4, 3],
				['muay_thai', null, 'novice', 1.5, 2],
				['custom', 'Bouldering', 'new', null, 1]
			]);

			const second = await saveExperience(
				owner,
				{
					entries: [
						{ discipline: 'powerlifting', level: 'advanced', years: 5, sessionsPerWeek: 4 },
						{ discipline: 'muay_thai', level: 'novice', years: 1.5, sessionsPerWeek: 3 }
					]
				},
				{ db }
			);
			expect(second.find((e) => e.discipline === 'powerlifting')).toMatchObject({
				id: first[0]!.id,
				level: 'advanced',
				years: 5
			});
			expect(await getExperience(owner, { db })).toHaveLength(2);
		});
	});

	it('refuses an unnamed custom discipline, duplicates and unknown levels', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			expect(
				await fieldErrors(
					saveExperience(owner, { entries: [{ discipline: 'custom', level: 'new' }] }, { db })
				)
			).toEqual({ 'entries.0.customLabel': 'Name this discipline' });
			expect(
				await fieldErrors(
					saveExperience(
						owner,
						{
							entries: [
								{ discipline: 'running', level: 'new' },
								{ discipline: 'running', level: 'advanced' }
							]
						},
						{ db }
					)
				)
			).toEqual({ entries: 'Each discipline once' });
			expect(
				await fieldErrors(
					saveExperience(
						owner,
						{ entries: [{ discipline: 'running', level: 'pro', years: -1 }] },
						{ db }
					)
				)
			).toMatchObject({
				'entries.0.level': 'Pick your level',
				'entries.0.years': expect.any(String)
			});
		});
	});
});

describe('strength baselines (all optional)', () => {
	it('saves “I don’t know my 1RMs” with every lift blank', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const saved = await saveBaselines(owner, { unknown: true, lifts: [] }, { db });
			expect(saved).toEqual({ unknown: true, lifts: [] });
			expect(await getBaselines(owner, { db })).toEqual({ unknown: true, lifts: [] });
			const rows = await db.execute(sql`select count(*)::int as n from strength_baselines`);
			expect(rows.rows[0]).toEqual({ n: 0 });
		});
	});

	it('keeps measured and estimated maxes apart, with date and source', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { lifts } = await saveBaselines(
				owner,
				{
					unknown: false,
					lifts: [
						{
							lift: 'deadlift',
							source: 'competition',
							value: 230,
							unit: 'kg',
							achievedOn: '2026-06-01'
						},
						{ lift: 'back_squat', source: 'tested', value: 185, unit: 'kg' },
						{
							lift: 'bench_press',
							source: 'set',
							unit: 'kg',
							setWeight: 100,
							setReps: 5,
							setRpe: 8,
							achievedOn: '2026-10-30'
						},
						{ lift: 'overhead_press', source: 'estimate', value: 70, unit: 'kg' }
					]
				},
				{ db }
			);
			const by = Object.fromEntries(lifts.map((l) => [l.lift, l]));
			expect(by.deadlift).toMatchObject({
				kind: 'measured',
				source: 'competition',
				value: 230,
				achievedOn: '2026-06-01'
			});
			expect(by.back_squat).toMatchObject({ kind: 'measured', source: 'tested', value: 185 });
			// 100 kg × 5 @ RPE 8 → 81.1% on the RPE chart → ≈ 123.3 kg, estimated (never measured).
			expect(by.bench_press).toMatchObject({
				kind: 'estimated',
				source: 'set',
				setWeight: 100,
				setReps: 5,
				setRpe: 8,
				method: 'rpe-table',
				confidence: 'medium',
				achievedOn: '2026-10-30'
			});
			expect(by.bench_press!.value).toBeCloseTo(123.3, 0);
			expect(by.overhead_press).toMatchObject({ kind: 'estimated', source: 'estimate', value: 70 });

			// Straight from Postgres: the kinds survive exactly as derived.
			const stored = await db.execute<{ lift: string; kind: string; source: string }>(
				sql`select lift, kind, source from strength_baselines where owner_id = ${owner} order by lift`
			);
			expect(stored.rows).toEqual([
				{ lift: 'back_squat', kind: 'measured', source: 'tested' },
				{ lift: 'bench_press', kind: 'estimated', source: 'set' },
				{ lift: 'deadlift', kind: 'measured', source: 'competition' },
				{ lift: 'overhead_press', kind: 'estimated', source: 'estimate' }
			]);
		});
	});

	it('a client cannot mark an estimate as measured, and Postgres refuses it too', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { lifts } = await saveBaselines(
				owner,
				{
					unknown: false,
					lifts: [
						{
							lift: 'snatch',
							source: 'estimate',
							value: 90,
							unit: 'kg',
							kind: 'measured'
						}
					]
				},
				{ db }
			);
			expect(lifts[0]).toMatchObject({ kind: 'estimated' });
		});
		const error = await withRollback(async (db) => {
			const owner = await makeOwner(db);
			return db
				.execute(
					sql`insert into strength_baselines (owner_id, lift, kind, source, value, unit, set_weight, set_reps)
						values (${owner}, 'snatch', 'measured', 'set', 90, 'kg', 80, 3)`
				)
				.catch((e: unknown) => e);
		});
		expect((error as { cause?: { constraint?: string } }).cause?.constraint).toBe(
			'strength_baselines_kind_source_ck'
		);
	});

	it('a changed max supersedes the old row (history kept); an unchanged one keeps its id', async () => {
		await withRollback(async (db) => {
			const time = clock();
			const owner = await makeOwner(db);
			const squat = { lift: 'back_squat', source: 'tested', value: 180, unit: 'kg' };
			const bench = { lift: 'bench_press', source: 'tested', value: 120, unit: 'kg' };
			const first = await saveBaselines(
				owner,
				{ unknown: false, lifts: [squat, bench] },
				{ db, now: time.now }
			);
			time.advanceDays(30);
			const second = await saveBaselines(
				owner,
				{ unknown: false, lifts: [{ ...squat, value: 190 }, bench] },
				{ db, now: time.now }
			);
			const benchBefore = first.lifts.find((l) => l.lift === 'bench_press')!;
			expect(second.lifts.find((l) => l.lift === 'bench_press')!.id).toBe(benchBefore.id);
			expect(second.lifts.find((l) => l.lift === 'back_squat')!.value).toBe(190);

			const history = await baselineHistory(owner, { db });
			expect(history.filter((l) => l.lift === 'back_squat').map((l) => l.value)).toEqual([
				190, 180
			]);

			// Clearing every field (back to "unknown") supersedes, never deletes.
			await saveBaselines(owner, { unknown: true, lifts: [] }, { db, now: time.now });
			expect((await getBaselines(owner, { db })).lifts).toEqual([]);
			expect(await baselineHistory(owner, { db })).toHaveLength(3);
		});
	});

	it('refuses impossible numbers, sets it can’t estimate from, and lifts while “unknown”', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			expect(
				await fieldErrors(
					saveBaselines(
						owner,
						{
							unknown: false,
							lifts: [
								{ lift: 'deadlift', source: 'tested', value: 0, unit: 'kg' },
								{
									lift: 'bench_press',
									source: 'set',
									unit: 'kg',
									setWeight: 100,
									setReps: 15,
									setRpe: 5
								},
								{ lift: 'custom', source: 'tested', value: 50, unit: 'kg' }
							]
						},
						{ db }
					)
				)
			).toMatchObject({
				'lifts.0.value': '1RM between 1 and 500 kg',
				'lifts.1.setRpe': 'RPE between 6 and 10',
				'lifts.2.customLabel': 'Name the lift'
			});
			expect(
				await fieldErrors(
					saveBaselines(
						owner,
						{
							unknown: true,
							lifts: [{ lift: 'deadlift', source: 'tested', value: 200, unit: 'kg' }]
						},
						{ db }
					)
				)
			).toEqual({ lifts: 'Clear your lifts, or untick “I don’t know my 1RMs”' });
		});
	});
});

describe('running and Muay Thai specifics', () => {
	it('round-trips volume, easy pace, race times and Muay Thai frequency', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const saved = await saveSpecifics(
				owner,
				{
					running: {
						unit: 'km',
						weeklyDistance: 32.5,
						runsPerWeek: 3,
						longestRun: 18,
						easyPaceSeconds: 345,
						races: [
							{
								distance: 'half_marathon',
								timeSeconds: 6300,
								racedOn: '2026-04-12',
								eventName: 'Berlin Half'
							},
							{ distance: 'other', customDistance: 15, timeSeconds: 4200 }
						]
					},
					muayThai: { sessionsPerWeek: 3, sparringPerWeek: 1, fights: 0 }
				},
				{ db }
			);
			expect(saved.running).toMatchObject({
				unit: 'km',
				weeklyDistance: 32.5,
				runsPerWeek: 3,
				longestRun: 18,
				easyPaceSeconds: 345
			});
			expect(
				saved.running!.races.map((r) => [r.distance, r.distanceMetres, r.timeSeconds])
			).toEqual([
				['other', 15000, 4200],
				['half_marathon', 21097.5, 6300]
			]);
			expect(saved.muayThai).toMatchObject({ sessionsPerWeek: 3, sparringPerWeek: 1, fights: 0 });
			expect(await getSpecifics(owner, { db })).toEqual(saved);

			// A null section is left untouched.
			const again = await saveSpecifics(
				owner,
				{ running: null, muayThai: { sessionsPerWeek: 4, sparringPerWeek: 2, fights: 1 } },
				{ db }
			);
			expect(again.running?.weeklyDistance).toBe(32.5);
			expect(again.muayThai?.fights).toBe(1);
		});
	});

	it('refuses an unnamed custom race distance and impossible times', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			expect(
				await fieldErrors(
					saveSpecifics(
						owner,
						{
							running: {
								unit: 'mi',
								races: [
									{ distance: 'other', timeSeconds: 900 },
									{ distance: '5k', timeSeconds: 5 }
								]
							},
							muayThai: { sessionsPerWeek: 30 }
						},
						{ db }
					)
				)
			).toMatchObject({
				'running.races.0.customDistance': 'How far was it?',
				'running.races.1.timeSeconds': 'Enter your time as h:mm:ss or mm:ss',
				'muayThai.sessionsPerWeek': 'Sessions per week between 0 and 21'
			});
		});
	});
});

describe('equipment', () => {
	it('round-trips gym type, the equipment list and home equipment', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			expect(await getEquipment(owner, { db })).toBeNull();
			const saved = await saveEquipment(
				owner,
				{
					gymType: 'commercial',
					equipment: ['barbell', 'squat_rack', 'bench', 'dumbbells', 'cables'],
					homeEquipment: ['kettlebells', 'bands'],
					notes: 'No deadlift platform — use rubber tiles'
				},
				{ db }
			);
			expect(saved).toMatchObject({
				gymType: 'commercial',
				equipment: ['barbell', 'squat_rack', 'bench', 'dumbbells', 'cables'],
				homeEquipment: ['kettlebells', 'bands'],
				notes: 'No deadlift platform — use rubber tiles'
			});
			expect(
				await fieldErrors(
					saveEquipment(
						owner,
						{ gymType: 'castle', equipment: ['trebuchet'], homeEquipment: [] },
						{ db }
					)
				)
			).toMatchObject({ gymType: 'Pick where you train', 'equipment.0': 'Unknown equipment' });
		});
	});
});

describe('injuries and limitations', () => {
	it('round-trips area, severity, movements to avoid and the active flag; ids survive edits', async () => {
		await withRollback(async (db) => {
			const time = clock();
			const owner = await makeOwner(db);
			const [knee] = await saveInjuries(
				owner,
				{
					injuries: [
						{
							bodyArea: 'knee',
							side: 'left',
							severity: 'moderate',
							notes: 'Patellar tendon flares after running downhill',
							avoid: ['Jumping lunges', 'Downhill running'],
							active: true,
							since: '2026-09-01'
						}
					]
				},
				{ db, now: time.now }
			);
			expect(knee).toMatchObject({
				bodyArea: 'knee',
				side: 'left',
				severity: 'moderate',
				avoid: ['Jumping lunges', 'Downhill running'],
				active: true
			});
			time.advanceDays(20);
			const [resolved, shoulder] = await saveInjuries(
				owner,
				{
					injuries: [
						{ ...knee, active: false },
						{ bodyArea: 'shoulder', side: null, severity: 'mild', avoid: [], active: true }
					]
				},
				{ db, now: time.now }
			).then((list) => [
				list.find((i) => i.bodyArea === 'knee')!,
				list.find((i) => i.bodyArea === 'shoulder')!
			]);
			expect(resolved).toMatchObject({ id: knee!.id, active: false });
			expect(shoulder).toMatchObject({ severity: 'mild', active: true });
			const stored = await db.execute<{ resolved: boolean }>(
				sql`select resolved_at is not null as resolved from injuries where id = ${knee!.id}`
			);
			expect(stored.rows[0]).toEqual({ resolved: true });

			await saveInjuries(owner, { injuries: [shoulder] }, { db });
			expect((await getInjuries(owner, { db })).map((i) => i.id)).toEqual([shoulder!.id]);
		});
	});

	it('refuses an injury without an area or severity, or with an unknown id', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			expect(
				await fieldErrors(
					saveInjuries(owner, { injuries: [{ side: 'left', avoid: [''], active: true }] }, { db })
				)
			).toMatchObject({
				'injuries.0.bodyArea': 'Where is it?',
				'injuries.0.severity': 'How bad is it?',
				'injuries.0.avoid.0': 'Name the movement'
			});
			expect(
				await fieldErrors(
					saveInjuries(
						owner,
						{
							injuries: [
								{
									id: crypto.randomUUID(),
									bodyArea: 'neck',
									side: null,
									severity: 'mild',
									avoid: [],
									active: true
								}
							]
						},
						{ db }
					)
				)
			).toEqual({ injuries: 'That injury no longer exists — reload' });
		});
	});
});

describe('exercise likes and dislikes', () => {
	it('round-trips likes and dislikes; the same exercise cannot be both', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const saved = await saveExercisePreferences(
				owner,
				{
					items: [
						{ exercise: 'Front squat', sentiment: 'like' },
						{ exercise: 'Burpees', sentiment: 'dislike', reason: 'Wrists' }
					]
				},
				{ db }
			);
			expect(saved.map((p) => [p.exercise, p.sentiment, p.reason])).toEqual([
				['Burpees', 'dislike', 'Wrists'],
				['Front squat', 'like', null]
			]);
			// Same name, different case: the row (and its id) is updated, not duplicated.
			const flipped = await saveExercisePreferences(
				owner,
				{ items: [{ exercise: 'front squat', sentiment: 'dislike' }] },
				{ db }
			);
			expect(flipped).toEqual([
				{ id: saved[1]!.id, exercise: 'front squat', sentiment: 'dislike', reason: null }
			]);
			expect(await getExercisePreferences(owner, { db })).toEqual(flipped);
			expect(
				await fieldErrors(
					saveExercisePreferences(
						owner,
						{
							items: [
								{ exercise: 'Dips', sentiment: 'like' },
								{ exercise: 'DIPS', sentiment: 'dislike' }
							]
						},
						{ db }
					)
				)
			).toEqual({ items: 'Each exercise once — it can’t be liked and disliked' });
		});
	});
});

describe('schedule and availability', () => {
	it('round-trips days, times, session length and per-discipline commitments', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const empty = await getSchedule(owner, { db });
			expect(empty).toMatchObject({ daysPerWeek: null, availableDays: [], commitments: [] });

			const saved = await saveSchedule(
				owner,
				{
					daysPerWeek: 5,
					availableDays: ['mon', 'tue', 'wed', 'thu', 'sat', 'sun'],
					preferredTimes: ['early_morning', 'evening'],
					sessionMinutes: 75,
					constraints: 'Travel for work one week a month',
					commitments: [
						{
							discipline: 'muay_thai',
							label: 'Muay Thai class',
							days: ['tue', 'thu'],
							timeOfDay: 'evening',
							durationMinutes: 90,
							intensity: 'hard',
							notes: null
						}
					]
				},
				{ db }
			);
			expect(saved).toMatchObject({
				daysPerWeek: 5,
				availableDays: ['mon', 'tue', 'wed', 'thu', 'sat', 'sun'],
				preferredTimes: ['early_morning', 'evening'],
				sessionMinutes: 75,
				constraints: 'Travel for work one week a month'
			});
			expect(saved.commitments).toEqual([
				expect.objectContaining({
					label: 'Muay Thai class',
					days: ['tue', 'thu'],
					intensity: 'hard'
				})
			]);

			const commitment = saved.commitments[0]!;
			const edited = await saveSchedule(
				owner,
				{ ...saved, commitments: [{ ...commitment, days: ['tue', 'thu', 'sat'] }] },
				{ db }
			);
			expect(edited.commitments).toEqual([
				expect.objectContaining({ id: commitment.id, days: ['tue', 'thu', 'sat'] })
			]);
		});
	});

	it('refuses more sessions than available days and commitments without days', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			expect(
				await fieldErrors(
					saveSchedule(
						owner,
						{
							daysPerWeek: 4,
							availableDays: ['mon', 'wed'],
							preferredTimes: [],
							sessionMinutes: 5,
							commitments: [
								{
									discipline: 'running',
									label: 'Club run',
									days: [],
									timeOfDay: null,
									intensity: null
								}
							]
						},
						{ db }
					)
				)
			).toMatchObject({
				daysPerWeek: 'You picked 2 available days — fewer than 4 sessions',
				sessionMinutes: 'Between 10 and 300 minutes',
				'commitments.0.days': 'Pick at least one day'
			});
		});
	});
});
