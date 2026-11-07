/**
 * Coaching memory on real Postgres (the M3 plan: M2's free-text preferences are linked, not
 * replaced; proposals and reviews are tables with lifecycle CHECKs only, filled by M5 and M6):
 * - An exercise preference may link to the library, which unlinks it when the exercise goes, and
 *   says where it was recorded (a closed list). M2's rows, and every save that names no source,
 *   read 'profile'. An owner likes or dislikes one exercise once, however it is spelled.
 * - A coach proposal's status is closed, and only an applied proposal names the version it made.
 * - One weekly review per owner and week (its Monday); one cycle review per block.
 * - Every coaching table is the owner's, so the test cleanup's truncate clears it.
 * Refusals are pinned to their SQLSTATE, table and constraint.
 */
import { readFileSync } from 'node:fs';
import { eq, getTableName, inArray, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Sentiment } from '../../../src/lib/domain/profile/catalog';
import {
	PREFERENCE_SOURCES,
	PROPOSAL_STATUSES,
	type PreferenceSource,
	type ProposalStatus
} from '../../../src/lib/domain/training/vocabulary';
import {
	coachProposals,
	cycleReviews,
	exercisePreferences,
	exercises,
	programBlocks,
	programs,
	programVersions,
	weeklyReviews,
	type Executor
} from '../../../src/lib/server/db';
import * as coachingSchema from '../../../src/lib/server/db/schema/coaching';
import { saveExercisePreferences } from '../../../src/lib/server/services/profile';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

/** Every table coaching.ts defines, so a new one cannot miss the owner's foreign key. */
const TABLES = Object.values(coachingSchema)
	.filter((value) => is(value, PgTable))
	.map((table) => getTableName(table))
	.sort();

const MONDAY = '2026-11-09';
const SUNDAY = '2026-11-15';

type PgError = { code?: string; table?: string; constraint?: string };
const UNDO = Symbol('undo');

/**
 * Run `write` in a savepoint that is always undone, so the test's transaction carries on and
 * rows it stores never collide: the Postgres error it failed with (drizzle wraps it as the
 * cause), or null when it was accepted.
 */
async function attempt(db: Executor, write: (tx: Executor) => Promise<unknown>) {
	try {
		await db.transaction(async (tx) => {
			await write(tx);
			throw UNDO;
		});
	} catch (err) {
		if (err === UNDO) return null;
		const { code, table, constraint } = ((err as { cause?: PgError }).cause ?? err) as PgError;
		return { code, table, constraint };
	}
	throw new Error('unreachable');
}

const CHECK = '23514';
const UNIQUE = '23505';
const refused = (code: string, table: string, constraint: string) => ({ code, table, constraint });

/** The catalogue's ids by key (every key must be in the catalogue). */
async function library<K extends string>(db: Executor, keys: K[]): Promise<Record<K, string>> {
	const rows = await db
		.select({ id: exercises.id, key: exercises.key })
		.from(exercises)
		.where(inArray(exercises.key, keys));
	expect(rows.map((row) => row.key).sort()).toEqual([...keys].sort());
	return Object.fromEntries(rows.map((row) => [row.key!, row.id])) as Record<K, string>;
}

/** A program with version 1 and its first block, for proposals and cycle reviews to name. */
async function storeProgram(db: Executor, ownerId: string) {
	const [program] = await db.insert(programs).values({ ownerId, title: 'Fight camp' }).returning();
	const version = async (number: number, parentVersionId: string | null) => {
		const [row] = await db
			.insert(programVersions)
			.values({
				programId: program!.id,
				number,
				parentVersionId,
				createdBy: number === 1 ? 'rules' : 'coach',
				summary: number === 1 ? 'Your first program' : 'Next block planned',
				startsOn: MONDAY,
				firstPlannedDay: MONDAY
			})
			.returning();
		return row!.id;
	};
	const first = await version(1, null);
	const second = await version(2, first);
	const [block] = await db
		.insert(programBlocks)
		.values({
			programId: program!.id,
			position: 1,
			phase: 'baseline',
			name: 'Baseline',
			startsOn: MONDAY,
			endsOn: SUNDAY
		})
		.returning();
	return { programId: program!.id, first, second, blockLineageId: block!.lineageId };
}

const preferenceRow = (db: Executor, exercise: string) =>
	db
		.select({
			exercise: exercisePreferences.exercise,
			exerciseId: exercisePreferences.exerciseId,
			source: exercisePreferences.source
		})
		.from(exercisePreferences)
		.where(eq(exercisePreferences.exercise, exercise));

/**
 * The committed migration's statements on exercise_preferences: the migration that adds its
 * source column, split as drizzle runs it.
 */
function preferenceMigration(): string[] {
	const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as {
		entries: { tag: string }[];
	};
	const adds = 'ALTER TABLE "exercise_preferences" ADD COLUMN "source"';
	const file = journal.entries
		.map((entry) => readFileSync(`drizzle/${entry.tag}.sql`, 'utf8'))
		.find((text) => text.includes(adds));
	if (!file) throw new Error('No committed migration adds exercise_preferences.source');
	return file
		.split('--> statement-breakpoint')
		.map((statement) => statement.trim())
		.filter((statement) => statement.includes('"exercise_preferences"'));
}

describe('exercise preferences', () => {
	it('link to the library and say where they were recorded, from a closed list', async () => {
		expectTypeOf<
			typeof exercisePreferences.$inferSelect.source
		>().toEqualTypeOf<PreferenceSource>();
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const ids = await library(db, ['back_squat']);
			await db.insert(exercisePreferences).values({
				ownerId: owner,
				exercise: 'Back squat',
				exerciseId: ids.back_squat,
				sentiment: 'dislike',
				reason: 'Never prescribe this again',
				source: 'swap'
			});
			expect(await preferenceRow(db, 'Back squat')).toEqual([
				{ exercise: 'Back squat', exerciseId: ids.back_squat, source: 'swap' }
			]);

			for (const source of PREFERENCE_SOURCES) {
				const write = (tx: Executor) =>
					tx.insert(exercisePreferences).values({
						ownerId: owner,
						exercise: `Burpees (${source})`,
						sentiment: 'dislike',
						source
					});
				expect(await attempt(db, write), source).toBeNull();
			}
			const unknown = (tx: Executor) =>
				tx.insert(exercisePreferences).values({
					ownerId: owner,
					exercise: 'Burpees',
					sentiment: 'dislike',
					source: 'import' as PreferenceSource
				});
			expect(await attempt(db, unknown)).toEqual(
				refused(CHECK, 'exercise_preferences', 'exercise_preferences_source_ck')
			);
		});
	});

	it("read 'profile', linked to the exercise its words name, when saved by Profile", async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { burpee } = await library(db, ['burpee']);
			await saveExercisePreferences(
				owner,
				{ items: [{ exercise: 'Burpees', sentiment: 'dislike', reason: 'Wrists' }] },
				{ db }
			);
			expect(await preferenceRow(db, 'Burpees')).toEqual([
				{ exercise: 'Burpees', exerciseId: burpee, source: 'profile' }
			]);
		});
	});

	it("read 'profile', unlinked, when stored before the migration that adds the link", async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			// The table as M2 left it, holding an M2 row; then the committed migration, as on a
			// production database that already has the owner's likes and dislikes.
			await db.execute(sql`alter table exercise_preferences drop column source`);
			await db.execute(sql`alter table exercise_preferences drop column exercise_id`);
			await db.execute(sql`insert into exercise_preferences (owner_id, exercise, sentiment, reason)
				values (${owner}, 'Front squat', 'like', null)`);
			for (const statement of preferenceMigration()) await db.execute(sql.raw(statement));

			expect(await preferenceRow(db, 'Front squat')).toEqual([
				{ exercise: 'Front squat', exerciseId: null, source: 'profile' }
			]);
		});
	});

	it('refuse a second preference for one exercise, however the owner named it', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { romanian_deadlift: rdl, deadlift } = await library(db, [
				'romanian_deadlift',
				'deadlift'
			]);
			const prefer =
				(exercise: string, exerciseId: string | null, sentiment: Sentiment = 'like') =>
				(tx: Executor) =>
					tx
						.insert(exercisePreferences)
						.values({ ownerId: owner, exercise, exerciseId, sentiment });
			await prefer('RDL', rdl)(db);

			const twice = refused(
				UNIQUE,
				'exercise_preferences',
				'exercise_preferences_owner_exercise_id_uq'
			);
			expect(await attempt(db, prefer('Romanian deadlift', rdl))).toEqual(twice);
			expect(await attempt(db, prefer('Barbell RDL', rdl, 'dislike'))).toEqual(twice);
			// Another exercise, and names the library does not know (no link), are each their own.
			expect(await attempt(db, prefer('Deadlift', deadlift))).toBeNull();
			await prefer('Sandbag carry', null)(db);
			expect(await attempt(db, prefer('Tyre flips', null, 'dislike'))).toBeNull();
		});
	});

	it('keep the preference, unlinked, when its custom exercise is deleted', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const [custom] = await db
				.insert(exercises)
				.values({
					ownerId: owner,
					name: 'Kettlebell suitcase march',
					pattern: 'carry',
					primaryMuscles: ['obliques', 'forearms'],
					equipment: ['kettlebells'],
					skillLevel: 'intermediate',
					measure: 'reps',
					loadType: 'external',
					repMin: 3,
					repMax: 5
				})
				.returning();
			await db.insert(exercisePreferences).values({
				ownerId: owner,
				exercise: 'Suitcase march',
				exerciseId: custom!.id,
				sentiment: 'like',
				source: 'workout'
			});
			await db.delete(exercises).where(eq(exercises.id, custom!.id));
			expect(await preferenceRow(db, 'Suitcase march')).toEqual([
				{ exercise: 'Suitcase march', exerciseId: null, source: 'workout' }
			]);
		});
	});
});

describe('coach proposals', () => {
	const proposal = (ownerId: string, values: Partial<typeof coachProposals.$inferInsert> = {}) =>
		({
			ownerId,
			kind: 'program_edit',
			title: 'Swap Thursday’s squats for split squats',
			summary: 'Thursday’s squats move to split squats for three weeks.',
			rationale: 'Your knee was sore after the last two squat sessions.',
			payload: { swap: { from: 'back_squat', to: 'bulgarian_split_squat' } },
			evidence: { workouts: [] },
			...values
		}) satisfies typeof coachProposals.$inferInsert;

	it('move from proposed to accepted to applied, which names the version it made', async () => {
		expectTypeOf<typeof coachProposals.$inferSelect.status>().toEqualTypeOf<ProposalStatus>();
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const plan = await storeProgram(db, owner);
			const [row] = await db
				.insert(coachProposals)
				.values(proposal(owner, { programId: plan.programId, baseVersionId: plan.first }))
				.returning();
			expect(row).toMatchObject({ status: 'proposed', appliedVersionId: null });

			const move = (values: Partial<typeof coachProposals.$inferInsert>) =>
				db.update(coachProposals).set(values).where(eq(coachProposals.id, row!.id));
			await move({ status: 'accepted' });
			await move({ status: 'applied', appliedVersionId: plan.second });
			const [applied] = await db
				.select()
				.from(coachProposals)
				.where(eq(coachProposals.id, row!.id));
			expect(applied).toMatchObject({
				status: 'applied',
				programId: plan.programId,
				baseVersionId: plan.first,
				appliedVersionId: plan.second,
				payload: { swap: { from: 'back_squat', to: 'bulgarian_split_squat' } }
			});

			// A proposal about no program (a preference, a goal) and a rejected one.
			for (const status of PROPOSAL_STATUSES.filter((s) => s !== 'applied')) {
				const write = (tx: Executor) =>
					tx.insert(coachProposals).values(proposal(owner, { status }));
				expect(await attempt(db, write), status).toBeNull();
			}
		});
	});

	it('refuse an unknown status, and an applied version on any proposal but an applied one', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const plan = await storeProgram(db, owner);
			const onPlan = { programId: plan.programId, baseVersionId: plan.first };
			const insert = (values: Partial<typeof coachProposals.$inferInsert>) => (tx: Executor) =>
				tx.insert(coachProposals).values(proposal(owner, { ...onPlan, ...values }));
			const ck = (name: string) => refused(CHECK, 'coach_proposals', `coach_proposals_${name}_ck`);

			expect(await attempt(db, insert({ status: 'pending' as ProposalStatus }))).toEqual(
				ck('status')
			);
			expect(await attempt(db, insert({ status: 'applied' }))).toEqual(ck('applied'));
			for (const status of ['proposed', 'accepted', 'rejected'] as const) {
				expect(
					await attempt(db, insert({ status, appliedVersionId: plan.second })),
					status
				).toEqual(ck('applied'));
			}
			// A version is a program's: none without the program.
			expect(await attempt(db, insert({ programId: null }))).toEqual(ck('program'));
			expect(await attempt(db, insert({ rationale: '' }))).toEqual(ck('rationale'));
			expect(await attempt(db, insert({ title: '' }))).toEqual(ck('title'));
		});
	});
});

describe('reviews', () => {
	const review = (ownerId: string, weekStartsOn: string) =>
		({
			ownerId,
			weekStartsOn,
			snapshot: { planned: 5, completed: 4 },
			summary: 'Four of five sessions done; squats moved well.'
		}) satisfies typeof weeklyReviews.$inferInsert;

	it('keep one weekly review per owner and week, starting on its Monday', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const plan = await storeProgram(db, owner);
			const [suggested] = await db
				.insert(coachProposals)
				.values({
					ownerId: owner,
					kind: 'program_edit',
					title: 'Add a rest day',
					summary: 'Friday becomes a rest day.',
					rationale: 'Sleep has been short all week.',
					payload: {},
					programId: plan.programId,
					baseVersionId: plan.first
				})
				.returning();
			const [stored] = await db
				.insert(weeklyReviews)
				.values({ ...review(owner, MONDAY), narrative: 'A solid week.', proposalId: suggested!.id })
				.returning();
			expect(stored).toMatchObject({ weekStartsOn: MONDAY, proposalId: suggested!.id });

			const write = (weekStartsOn: string) => (tx: Executor) =>
				tx.insert(weeklyReviews).values(review(owner, weekStartsOn));
			expect(await attempt(db, write(MONDAY))).toEqual(
				refused(UNIQUE, 'weekly_reviews', 'weekly_reviews_owner_week_uq')
			);
			expect(await attempt(db, write('2026-11-16'))).toBeNull();
			// A Tuesday would be a second review of the same week under another date.
			expect(await attempt(db, write('2026-11-10'))).toEqual(
				refused(CHECK, 'weekly_reviews', 'weekly_reviews_week_ck')
			);
		});
	});

	it('keep one cycle review per block, naming the version that plans the next', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const plan = await storeProgram(db, owner);
			const cycle = (values: Partial<typeof cycleReviews.$inferInsert> = {}) =>
				({
					ownerId: owner,
					programId: plan.programId,
					blockLineageId: plan.blockLineageId,
					snapshot: { adherence: 0.9 },
					summary: 'Squat e1RM up 5 kg; ready for the next block.',
					...values
				}) satisfies typeof cycleReviews.$inferInsert;
			const [stored] = await db
				.insert(cycleReviews)
				.values(cycle({ nextVersionId: plan.second, narrative: 'The baseline block is done.' }))
				.returning();
			expect(stored).toMatchObject({
				blockLineageId: plan.blockLineageId,
				nextVersionId: plan.second
			});

			expect(await attempt(db, (tx) => tx.insert(cycleReviews).values(cycle()))).toEqual(
				refused(UNIQUE, 'cycle_reviews', 'cycle_reviews_block_uq')
			);
			const otherBlock = cycle({ blockLineageId: crypto.randomUUID() });
			expect(await attempt(db, (tx) => tx.insert(cycleReviews).values(otherBlock))).toBeNull();
		});
	});
});

describe('ownership', () => {
	it("gives every coaching table the owner's foreign key, so the test cleanup clears it", async () => {
		expect(TABLES).toEqual(['coach_proposals', 'cycle_reviews', 'weekly_reviews']);
		await withRollback(async (db) => {
			const { rows } = await db.execute<{ table: string }>(sql`
				select c.conrelid::regclass::text as table
				from pg_constraint c
				join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
				where c.contype = 'f' and c.confrelid = 'owners'::regclass and c.confdeltype = 'c'
					and a.attname = 'owner_id'`);
			const owned = rows.map((row) => row.table);
			expect(owned).toEqual(expect.arrayContaining([...TABLES, 'exercise_preferences']));
		});
	});
});
