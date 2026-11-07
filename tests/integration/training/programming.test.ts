/**
 * The programming service on real Postgres (src/lib/server/services/programming): an M2 profile,
 * written through the M2 services, previewed as a generated program with its rationale, then
 * built as version 1 and read back. This is the brief's chain (create profile → generate
 * program → planned week → retrieve), for a full hybrid profile and the minimal onboarding one.
 *
 * The build regenerates what the preview showed and compares fingerprints, so every conflict
 * (a changed profile, a changed library, a new day) is refused with its reason and writes
 * nothing, and a repeated build returns the same program, whatever time zone was recorded.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { addDays } from '../../../src/lib/domain/calendar';
import { CATALOGUE } from '../../../src/lib/domain/exercises/index';
import {
	buildProgrammingInput,
	catalogueDigest,
	fingerprint,
	generateProgram,
	GENERATOR_ID,
	type ProgrammingInput
} from '../../../src/lib/domain/programming/index';
import { SCENARIOS, scenarioDay } from '../../../src/lib/domain/programming/scenarios';
import type { ProgramPlan } from '../../../src/lib/domain/training/types';
import type { Executor } from '../../../src/lib/server/db';
import {
	completeOnboarding,
	createGoal,
	saveBaselines,
	saveBasics,
	saveEquipment,
	saveExercisePreferences,
	saveExperience,
	saveSchedule,
	saveSpecifics
} from '../../../src/lib/server/services/profile';
import {
	buildProgram,
	previewProgram,
	ProgrammingConflictError,
	type ProgramPreview
} from '../../../src/lib/server/services/programming/index';
import {
	getPlannedSession,
	getProgramVersion,
	getTrainingWeek,
	type ProgramVersion
} from '../../../src/lib/server/services/programs/index';
import {
	ConflictError,
	TrainingInputError
} from '../../../src/lib/server/services/training/shared';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

/** A Thursday: 'next_monday' plans from the scenarios' Monday, SCENARIO_START. */
const TODAY = '2026-11-05';
const MONDAY = '2026-11-09';

const WEEKDAYS_BUT_SUNDAY = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const schedule = (over: Record<string, unknown> = {}) => ({
	daysPerWeek: 3,
	availableDays: [],
	preferredTimes: [],
	sessionMinutes: null,
	constraints: null,
	commitments: [],
	...over
});

const general = (title: string, disciplines: string[]) => ({
	kind: 'general',
	title,
	disciplines,
	focus: title,
	measure: 'Train every planned week'
});

const lift = (name: string, source: string, value: number) => ({
	lift: name,
	source,
	value,
	unit: 'kg'
});

/**
 * SCENARIOS.hybrid, through the M2 services: a marathon in week 20 first, then strength, around
 * hard Muay Thai classes on Tuesday and Thursday evenings.
 */
async function hybridOwner(db: Executor): Promise<string> {
	const owner = await makeOwner(db);
	await createGoal(
		owner,
		{
			kind: 'event',
			title: 'Marathon',
			disciplines: ['distance_running'],
			eventType: 'Marathon',
			eventDate: scenarioDay(20, 6)
		},
		{ db }
	);
	await createGoal(owner, general('Stay strong', ['strength']), { db });
	await createGoal(owner, general('Muay Thai', ['muay_thai']), { db });
	await saveExperience(
		owner,
		{
			entries: ['distance_running', 'strength', 'muay_thai'].map((discipline) => ({
				discipline,
				level: 'intermediate'
			}))
		},
		{ db }
	);
	await saveBaselines(
		owner,
		{
			unknown: false,
			lifts: [lift('back_squat', 'tested', 140), lift('bench_press', 'estimate', 100)]
		},
		{ db }
	);
	await saveSpecifics(
		owner,
		{
			running: {
				unit: 'km',
				weeklyDistance: 30,
				runsPerWeek: 4,
				longestRun: 18,
				easyPaceSeconds: 330,
				races: []
			},
			muayThai: null
		},
		{ db }
	);
	await saveEquipment(owner, { gymType: 'commercial', equipment: [], homeEquipment: [] }, { db });
	await saveSchedule(
		owner,
		schedule({
			daysPerWeek: 5,
			availableDays: WEEKDAYS_BUT_SUNDAY,
			preferredTimes: ['morning', 'evening'],
			sessionMinutes: 75,
			commitments: [
				{
					discipline: 'muay_thai',
					label: 'Muay Thai class',
					days: ['tue', 'thu'],
					timeOfDay: 'evening',
					durationMinutes: 90,
					intensity: 'hard'
				}
			]
		}),
		{ db }
	);
	await completeOnboarding(owner, { db });
	return owner;
}

/** What a completed onboarding needs and nothing more: one goal and daysPerWeek. */
async function minimalOwner(db: Executor, { complete = true } = {}): Promise<string> {
	const owner = await makeOwner(db);
	await createGoal(owner, general('Get stronger', ['strength']), { db });
	await saveSchedule(owner, schedule(), { db });
	if (complete) await completeOnboarding(owner, { db });
	return owner;
}

/** The request a Build confirm sends back: the preview's dates and fingerprints. */
const confirm = (preview: ProgramPreview, today = TODAY, start = 'next_monday') => ({
	today,
	start,
	startsOn: preview.startsOn,
	firstPlannedDay: preview.firstPlannedDay,
	fingerprint: preview.fingerprint,
	digest: preview.digest
});

async function programCount(db: Executor): Promise<{ programs: number; decisions: number }> {
	const { rows } = await db.execute<{ programs: number; decisions: number }>(
		sql`select (select count(*)::int from programs) as programs,
			(select count(*)::int from programming_decisions) as decisions`
	);
	return rows[0]!;
}

/** The error a call was refused with (fails the test if it was not refused). */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
	const error = await promise.then(
		() => null,
		(err: unknown) => err
	);
	if (!error) throw new Error('expected the call to be refused');
	return error;
}

async function conflictReason(promise: Promise<unknown>): Promise<string> {
	const error = await refusal(promise);
	expect(error).toBeInstanceOf(ProgrammingConflictError);
	expect(error).toBeInstanceOf(ConflictError);
	return (error as ProgrammingConflictError).reason;
}

const ROW_ONLY = new Set(['id', 'lineage', 'status', 'movedFrom']);

/** Plain data without the keys only a stored row has. */
function withoutRowKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutRowKeys);
	if (value && typeof value === 'object' && !(value instanceof Date)) {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => !ROW_ONLY.has(key))
				.map(([key, field]) => [key, withoutRowKeys(field)])
		);
	}
	return value;
}

/** A stored version's tree as the plan it was stored from. */
const treeOfVersion = ({ title, startsOn, firstPlannedDay, blocks }: ProgramVersion) => ({
	title,
	startsOn,
	firstPlannedDay,
	blocks: withoutRowKeys(blocks)
});
const treeOfPlan = ({ decisions: _, ...tree }: ProgramPlan) => tree;

/** A decision in the words the owner reads, without where it points. */
const words = (d: { kind: string; summary: string; why: string; decidedBy: string }) => ({
	kind: d.kind,
	summary: d.summary,
	why: d.why,
	decidedBy: d.decidedBy
});

const previewedDecisions = (preview: ProgramPreview) =>
	Object.values(preview.decisions)
		.flat()
		.map(words)
		.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

/** Every exercise key a stored version prescribes. */
function prescribedKeys(stored: ProgramVersion): string[] {
	return stored.blocks.flatMap((b) =>
		b.weeks.flatMap((w) =>
			w.sessions.flatMap((s) =>
				s.kind === 'strength'
					? s.exercises.map((e) => ('key' in e.exercise ? e.exercise.key : e.exercise.customId))
					: []
			)
		)
	);
}

describe('previewing and building the week-1 baseline program', () => {
	it('runs the brief chain for a hybrid profile: M2 services → preview → build → planned week', async () => {
		await withRollback(async (db) => {
			const owner = await hybridOwner(db);
			const preview = await previewProgram(owner, { today: TODAY, start: 'next_monday' }, { db });

			// The M2 services store the scenario exactly as the generator's scenario tests read it.
			const scenario = buildProgrammingInput(SCENARIOS.hybrid(), { catalogue: CATALOGUE });
			const digest = catalogueDigest(CATALOGUE, []);
			expect(preview.digest).toBe(digest);
			expect(preview.fingerprint).toBe(fingerprint(scenario, digest));
			expect([preview.startsOn, preview.firstPlannedDay]).toEqual([MONDAY, MONDAY]);
			expect(preview.summary).toMatchObject({ startsOn: MONDAY, firstPlannedDay: MONDAY });
			expect(preview.decisions.purpose.map((d) => d.kind)).toContain('program_purpose');
			expect(preview.decisions.placement.map((d) => d.kind)).toContain('commitment_placed');
			expect(preview.decisions.loads.map((d) => d.kind)).toContain('load_basis');

			const built = await buildProgram(owner, confirm(preview), { db });
			expect(built).toEqual({
				programId: expect.any(String),
				versionId: expect.any(String),
				created: true
			});

			const week = await getTrainingWeek(owner, { date: MONDAY }, {}, { db });
			if (!week?.planned) throw new Error('week 1 is planned');
			expect(week).toMatchObject({ number: 1, startsOn: MONDAY, kind: 'baseline' });
			// The planned week is the previewed one, day by day.
			const shown = (sessions: { title: string; discipline: string; timeOfDay: unknown }[]) =>
				sessions.map((s) => [s.title, s.discipline, s.timeOfDay]);
			expect(week.days.map((d) => [d.date, shown(d.sessions)])).toEqual(
				preview.week.days.map((d) => [d.date, shown(d.sessions)])
			);
			const sessions = week.days.flatMap((d) => d.sessions);
			expect(new Set(sessions.map((s) => s.discipline))).toEqual(
				new Set(['distance_running', 'strength', 'muay_thai'])
			);
			// Muay Thai classes stay on their Tuesday and Thursday evenings.
			expect(
				sessions.filter((s) => s.discipline === 'muay_thai').map((s) => [s.date, s.timeOfDay])
			).toEqual([
				[addDays(MONDAY, 1), 'evening'],
				[addDays(MONDAY, 3), 'evening']
			]);
			expect(sessions.every((s) => s.timeOfDay !== null)).toBe(true);

			// Each strength session prescribes its sets.
			const lifts = sessions.filter((s) => s.kind === 'strength');
			expect(lifts.length).toBeGreaterThan(0);
			for (const s of lifts) {
				const session = await getPlannedSession(owner, s.lineage, {}, { db });
				if (session.kind !== 'strength') throw new Error('a strength session');
				expect(session.exercises.length).toBeGreaterThan(0);
				for (const e of session.exercises) expect(e.sets.length).toBeGreaterThan(0);
			}

			// The stored decisions are the previewed ones, plus the owner's confirmation.
			const stored = await getProgramVersion(owner, built.programId, 1, { db });
			const confirmed = stored.decisions.filter((d) => d.kind === 'owner_confirmed');
			expect(confirmed).toEqual([
				expect.objectContaining({
					decidedBy: 'owner',
					evidence: expect.objectContaining({ fingerprint: preview.fingerprint })
				})
			]);
			expect(
				stored.decisions
					.filter((d) => d.kind !== 'owner_confirmed')
					.map(words)
					.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
			).toEqual(previewedDecisions(preview));
			// Every stored decision says why.
			for (const d of stored.decisions) expect(d.why.trim()).not.toBe('');
		});
	});

	it('previews and builds the minimal onboarding profile, listing each default it assumed', async () => {
		await withRollback(async (db) => {
			const owner = await minimalOwner(db);
			const preview = await previewProgram(owner, { today: TODAY, start: 'next_monday' }, { db });

			expect(preview.decisions.assumptions.map((d) => [d.kind, d.ruleKey])).toEqual(
				expect.arrayContaining([
					['default_assumed', 'defaults.available_days'],
					['default_assumed', 'defaults.preferred_times'],
					['default_assumed', 'defaults.session_minutes'],
					['default_assumed', 'defaults.equipment'],
					['default_assumed', 'defaults.experience']
				])
			);
			const planned = preview.week.days.flatMap((d) => d.sessions);
			expect(planned.filter((s) => s.discipline === 'strength')).toHaveLength(3);

			const built = await buildProgram(owner, confirm(preview), { db });
			const week = await getTrainingWeek(owner, { date: MONDAY }, {}, { db });
			if (!week?.planned) throw new Error('week 1 is planned');
			expect(week.days.flatMap((d) => d.sessions)).toHaveLength(planned.length);
			const stored = await getProgramVersion(owner, built.programId, 1, { db });
			expect(stored.decisions.filter((d) => d.kind === 'default_assumed').length).toBe(
				preview.decisions.assumptions.length
			);
		});
	});

	it('previews the same program twice, and writes nothing', async () => {
		await withRollback(async (db) => {
			const owner = await hybridOwner(db);
			const request = { today: TODAY, start: 'this_week' as const };
			const first = await previewProgram(owner, request, { db });
			expect(await previewProgram(owner, request, { db })).toEqual(first);
			expect([first.startsOn, first.firstPlannedDay]).toEqual(['2026-11-02', TODAY]);
			expect(first.week.days.filter((d) => d.date < TODAY).flatMap((d) => d.sessions)).toEqual([]);
			expect(await programCount(db)).toEqual({ programs: 0, decisions: 0 });
		});
	});

	it('stores what reproduces version 1: its input snapshot, catalogue digest and generator', async () => {
		await withRollback(async (db) => {
			const owner = await hybridOwner(db);
			const preview = await previewProgram(owner, { today: TODAY, start: 'next_monday' }, { db });
			const built = await buildProgram(owner, confirm(preview), { db });
			const stored = await getProgramVersion(owner, built.programId, 1, { db });

			expect(stored.version).toMatchObject({
				createdBy: 'rules',
				generator: GENERATOR_ID,
				catalogueDigest: catalogueDigest(CATALOGUE, []),
				inputFingerprint: preview.fingerprint
			});
			const snapshot = stored.version.inputSnapshot as unknown as ProgrammingInput;
			expect(fingerprint(snapshot, stored.version.catalogueDigest!)).toBe(preview.fingerprint);
			const again = generateProgram(snapshot, {
				startsOn: stored.startsOn,
				firstPlannedDay: stored.firstPlannedDay
			});
			expect(treeOfVersion(stored)).toEqual(treeOfPlan(again));
			expect(stored.decisions.filter((d) => d.kind !== 'owner_confirmed').map(words)).toEqual(
				again.decisions.map(words)
			);
		});
	});

	it('never prescribes a disliked exercise', async () => {
		await withRollback(async (db) => {
			const owner = await minimalOwner(db);
			const before = await previewProgram(owner, { today: TODAY, start: 'next_monday' }, { db });
			const liked = before.week.days.flatMap((d) =>
				d.sessions.flatMap((s) =>
					s.kind === 'strength' ? s.exercises.map((e) => 'key' in e.exercise && e.exercise.key) : []
				)
			);
			expect(liked).toContain('back_squat');

			await saveExercisePreferences(
				owner,
				{ items: [{ exercise: 'Back squat', sentiment: 'dislike', reason: 'Knees' }] },
				{ db }
			);
			const preview = await previewProgram(owner, { today: TODAY, start: 'next_monday' }, { db });
			expect(preview.fingerprint).not.toBe(before.fingerprint);
			const built = await buildProgram(owner, confirm(preview), { db });
			const stored = await getProgramVersion(owner, built.programId, 1, { db });
			expect(prescribedKeys(stored).length).toBeGreaterThan(0);
			expect(prescribedKeys(stored)).not.toContain('back_squat');
		});
	});

	it('gives a dumbbells-only profile dumbbell, bench and bodyweight work only', async () => {
		await withRollback(async (db) => {
			const owner = await minimalOwner(db);
			await saveEquipment(
				owner,
				{ gymType: 'none', equipment: [], homeEquipment: ['dumbbells', 'bench'] },
				{ db }
			);
			const preview = await previewProgram(owner, { today: TODAY, start: 'next_monday' }, { db });
			const built = await buildProgram(owner, confirm(preview), { db });
			const stored = await getProgramVersion(owner, built.programId, 1, { db });

			const byKey = new Map(CATALOGUE.map((e) => [e.key, e]));
			const keys = prescribedKeys(stored);
			expect(keys.length).toBeGreaterThan(0);
			const equipment = new Set(keys.flatMap((key) => byKey.get(key)!.equipment));
			expect([...equipment].filter((e) => e !== 'dumbbells' && e !== 'bench')).toEqual([]);
			expect(equipment.has('dumbbells')).toBe(true);
		});
	});
});

describe('a build that no longer matches its preview', () => {
	it("is a 'profile' conflict after a profile edit, and writes nothing", async () => {
		await withRollback(async (db) => {
			const owner = await minimalOwner(db);
			const preview = await previewProgram(owner, { today: TODAY, start: 'next_monday' }, { db });
			await saveSchedule(owner, schedule({ sessionMinutes: 45 }), { db });

			expect(await conflictReason(buildProgram(owner, confirm(preview), { db }))).toBe('profile');
			expect(await programCount(db)).toEqual({ programs: 0, decisions: 0 });
		});
	});

	it("is a 'library' conflict when a catalogue entry changed, and writes nothing", async () => {
		await withRollback(async (db) => {
			const owner = await minimalOwner(db);
			const preview = await previewProgram(owner, { today: TODAY, start: 'next_monday' }, { db });
			const [first, ...rest] = CATALOGUE;
			const catalogue = [{ ...first!, name: `${first!.name} (new wording)` }, ...rest];

			expect(await conflictReason(buildProgram(owner, confirm(preview), { db, catalogue }))).toBe(
				'library'
			);
			expect(await programCount(db)).toEqual({ programs: 0, decisions: 0 });
		});
	});

	it("is a 'start_date' conflict once 'This week' has begun without it, and writes nothing", async () => {
		await withRollback(async (db) => {
			const owner = await minimalOwner(db);
			const preview = await previewProgram(owner, { today: TODAY, start: 'this_week' }, { db });
			expect(preview.firstPlannedDay).toBe(TODAY);

			const tomorrow = addDays(TODAY, 1);
			expect(
				await conflictReason(buildProgram(owner, confirm(preview, tomorrow, 'this_week'), { db }))
			).toBe('start_date');
			expect(await programCount(db)).toEqual({ programs: 0, decisions: 0 });

			// The same preview, built on its own day, keeps its dates.
			const built = await buildProgram(owner, confirm(preview, TODAY, 'this_week'), { db });
			const stored = await getProgramVersion(owner, built.programId, 1, { db });
			expect([stored.startsOn, stored.firstPlannedDay]).toEqual(['2026-11-02', TODAY]);
		});
	});

	it('keeps the previewed next Monday when the build comes a day later', async () => {
		await withRollback(async (db) => {
			const owner = await minimalOwner(db);
			const preview = await previewProgram(owner, { today: TODAY, start: 'next_monday' }, { db });
			const built = await buildProgram(owner, confirm(preview, addDays(TODAY, 1)), { db });
			const stored = await getProgramVersion(owner, built.programId, 1, { db });
			expect([stored.startsOn, stored.firstPlannedDay]).toEqual([MONDAY, MONDAY]);
		});
	});
});

describe('building twice', () => {
	it('returns the same program, also when the time zone was recorded between the builds', async () => {
		await withRollback(async (db) => {
			const owner = await hybridOwner(db);
			const preview = await previewProgram(owner, { today: TODAY, start: 'next_monday' }, { db });
			const first = await buildProgram(owner, confirm(preview), { db });
			const counted = await programCount(db);

			expect(await buildProgram(owner, confirm(preview), { db })).toEqual({
				...first,
				created: false
			});
			await saveBasics(
				owner,
				{ name: 'Niko', weightUnit: 'kg', distanceUnit: 'km', timeZone: 'Pacific/Auckland' },
				{ db }
			);
			expect(await buildProgram(owner, confirm(preview), { db })).toEqual({
				...first,
				created: false
			});
			expect(await programCount(db)).toEqual(counted);
			expect(counted.programs).toBe(1);
		});
	});
});

describe('a profile that has not finished onboarding', () => {
	it('is refused a preview and a build', async () => {
		await withRollback(async (db) => {
			const owner = await minimalOwner(db, { complete: false });
			const preview = await refusal(
				previewProgram(owner, { today: TODAY, start: 'next_monday' }, { db })
			);
			expect(preview).toBeInstanceOf(TrainingInputError);
			expect((preview as TrainingInputError).errors).toEqual({
				onboarding: expect.any(String)
			});

			const build = await refusal(
				buildProgram(
					owner,
					{
						today: TODAY,
						start: 'next_monday',
						startsOn: MONDAY,
						firstPlannedDay: MONDAY,
						fingerprint: '0123456789abcdef',
						digest: catalogueDigest(CATALOGUE, [])
					},
					{ db }
				)
			);
			expect(build).toBeInstanceOf(TrainingInputError);
			expect((build as TrainingInputError).errors).toEqual({ onboarding: expect.any(String) });
			expect(await programCount(db)).toEqual({ programs: 0, decisions: 0 });
		});
	});

	it('refuses a request no preview could have sent', async () => {
		await withRollback(async (db) => {
			const owner = await minimalOwner(db);
			const preview = await previewProgram(owner, { today: TODAY, start: 'next_monday' }, { db });
			const errors = async (request: object) => {
				const error = await refusal(
					buildProgram(owner, { ...confirm(preview), ...request }, { db })
				);
				expect(error).toBeInstanceOf(TrainingInputError);
				return Object.keys((error as TrainingInputError).errors);
			};
			expect(await errors({ start: 'someday' })).toEqual(['start']);
			expect(await errors({ startsOn: addDays(MONDAY, 1) })).toEqual(['startsOn']);
			expect(
				await errors({ firstPlannedDay: addDays(MONDAY, 7), startsOn: addDays(MONDAY, 7) })
			).toEqual(['firstPlannedDay']);
			expect(await errors({ fingerprint: 'not a fingerprint' })).toEqual(['fingerprint']);
			expect(await programCount(db)).toEqual({ programs: 0, decisions: 0 });
		});
	});
});
