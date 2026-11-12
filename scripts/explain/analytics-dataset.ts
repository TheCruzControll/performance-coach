/**
 * The analytics owner of db:explain (m6-plan 'analytics-plans'): a second owner as large as
 * dataset.ts's, loaded into the same reset database, so M6's fact queries are explained on two
 * years of data that really exercise their joins.
 * - It is dataset.ts's generator on its own seed (the same PRNG, weeks, programs and catalogue),
 *   so ≥ 600 strength workouts, ≥ 15k sets, ≥ 400 runs with ≥ 6k segments and about 100 weeks
 *   of program versions with prescriptions, nearly every set linked to its planned exercise.
 * - On top: NOT_COMPLETED of the workouts abandoned or still in progress with their sets live (so
 *   the completed-workout join is real), a second Muay Thai class every other week (about 150,
 *   with rounds), a recovery note nearly every day (about 730), and the generator's input stored
 *   on each program's first version (targets.ts reads it).
 * - The owner's corrections and soft deletes are written into the rows, and a soft-deleted workout
 *   keeps its sets live: the loader only inserts, so no training_audit rows are written.
 * - The app allows one owner (owners_singleton_uq), and the size gate is set for one owner's
 *   history. So the loader replaces dataset.ts's training and program rows (TRUNCATE, the reset
 *   code's one bypass of the history guards) with these, under the same owner, then analyses: the
 *   relations hold one owner's two years, as production would.
 * - Its review history (generateReviewHistory, m6-plan 'analytics-explain'): a weekly review of
 *   every week before the newest reviewed one and a cycle review of every ended block, each with
 *   its proposal. SUPERSEDED_SHARE of them were refreshed (a superseded revision 1 beside the live
 *   revision 2) and REVISED_SHARE of the proposals revised ('Ask for changes'). Their computed
 *   columns are copied from reviews the services wrote on this data (ReviewTemplates), so each row
 *   is as large as a real one; the reviews a page load reads are those real ones.
 */
import { addDays, type IsoDate } from '../../src/lib/domain/calendar';
import { LIFTS } from '../../src/lib/domain/profile/catalog';
import type { ProgrammingInput } from '../../src/lib/domain/programming/input';
import { seededRandom } from '../../src/lib/domain/programming/random';
import { GYM_PRESETS } from '../../src/lib/domain/programming/rules/defaults';
import type pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { NEXT_CYCLE_TITLE } from '../../src/lib/server/services/reviews/cycle';
import { PROPOSAL_TITLE } from '../../src/lib/server/services/reviews/weekly';
import {
	FIRST_MONDAY,
	generateDataset,
	insertAll,
	loadDataset,
	WEEKS,
	type Dataset
} from './dataset';

/** The first of its seeds whose missed sessions leave ≥ 400 runs (407). */
export const ANALYTICS_SEED = 'db-explain/analytics/3';
/** The share of workouts never completed: two in three abandoned, the rest still in progress. */
export const NOT_COMPLETED = 0.03;
/** The share of days without a recovery note. */
const NO_NOTE = 0.015;
const DAY_MS = 86_400_000;

/** What the owner's programs were generated from: a hybrid athlete with one strength goal. */
const INPUT = {
	goals: [
		{
			...{ kind: 'general', title: 'Get stronger', disciplines: ['strength'] },
			...{ customDiscipline: null, eventType: null, eventDate: null, focus: null },
			...{ targetDate: null, priority: 1 }
		}
	],
	paused: [],
	maintenance: false,
	disciplines: ['strength', 'running', 'muay_thai'],
	experience: { strength: 'intermediate', running: 'intermediate', muay_thai: 'intermediate' },
	daysPerWeek: 6,
	availableDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
	preferredTimes: ['morning', 'evening'],
	sessionMinutes: 70,
	commitments: [],
	equipment: [...GYM_PRESETS.commercial],
	injuries: [],
	likes: [],
	dislikes: [],
	customExercises: [],
	baselines: Object.fromEntries(
		LIFTS.filter((lift) => lift !== 'custom').map((lift) => [lift, null])
	) as ProgrammingInput['baselines'],
	running: null,
	muayThai: null,
	nutritionPhase: null,
	bodyWeightKg: 80,
	assumptions: [],
	refs: { goals: [], paused: [], commitments: [] }
} satisfies ProgrammingInput;

/** Each week's stored targets (a deload's volume is 0.6), as a build stores them. */
const targetsOf = (kind: string | undefined) => ({
	...{ rpeCap: kind === 'deload' ? 7 : 9, volumeFactor: kind === 'deload' ? 0.6 : 1 },
	...{ loadStep: kind === 'deload' ? 0 : 0.025, runVolumeFactor: kind === 'deload' ? 0.7 : 1 }
});

/** The analytics history of `ownerId` (the one owner of the database it is loaded into). */
export function generateAnalyticsDataset(ownerId: string, seed: string = ANALYTICS_SEED): Dataset {
	const d = generateDataset(seed);
	const rng = seededRandom(`${seed}/analytics`);
	const hex = () =>
		Math.floor(rng.next() * 2 ** 32)
			.toString(16)
			.padStart(8, '0');
	const id = () => {
		const h = hex() + hex() + hex() + hex();
		return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`;
	};
	const generated = d.owner.id!;
	for (const rows of Object.values(d))
		if (Array.isArray(rows))
			for (const row of rows as { ownerId?: string }[])
				if (row.ownerId === generated) row.ownerId = ownerId;
	d.owner = { ...d.owner, id: ownerId };

	// The edits as stored rows: a correction's weight, a soft-deleted set, a soft-deleted workout
	// whose sets stay live.
	const corrected = new Map(d.edits.sets.map((edit) => [edit.clientMutationId, edit]));
	const deletedSets = new Set(d.edits.deletedSets);
	const deletedWorkouts = new Set(d.edits.deletedWorkouts);
	d.setRecords = d.setRecords.map((set) => {
		const edit = corrected.get(set.clientMutationId);
		const deletedAt = deletedSets.has(set.clientMutationId)
			? new Date(set.performedAt!.getTime() + DAY_MS)
			: null;
		return { ...set, ...(edit && { weight: edit.weight, e1rmKg: edit.e1rmKg }), deletedAt };
	});
	d.edits = { sets: [], deletedSets: [], deletedWorkouts: [] };

	const extra = {
		workouts: [] as Dataset['workouts'],
		others: [] as Dataset['otherSessionRecords']
	};
	for (let w = 0; w < WEEKS; w += 2) {
		const workoutId = id();
		const startedAt = new Date(Date.parse(`${addDays(FIRST_MONDAY, w * 7 + 5)}T17:00:00Z`));
		extra.workouts.push({
			...{ id: workoutId, ownerId, clientId: id(), kind: 'other', discipline: 'muay_thai' },
			...{ sessionType: 'muay_thai', title: 'muay thai', status: 'completed', startedAt },
			...{ finishedAt: new Date(startedAt.getTime() + 5_700_000), durationSeconds: 5_700 },
			sessionRpe: 8
		});
		extra.others.push({ workoutId, ownerId, kind: 'class', durationMinutes: 90, rpe: 8 });
	}
	d.workouts = [...d.workouts, ...extra.workouts].map((workout) => {
		const deletedAt = deletedWorkouts.has(workout.clientId)
			? new Date(workout.startedAt!.getTime() + DAY_MS)
			: null;
		const roll = rng.next();
		if (roll >= NOT_COMPLETED) return { ...workout, deletedAt };
		return roll < (NOT_COMPLETED * 2) / 3
			? { ...workout, deletedAt, status: 'abandoned' }
			: { ...workout, deletedAt, status: 'in_progress', finishedAt: null, durationSeconds: null };
	});
	const rounds = (kind: string) =>
		kind === 'class' ? [{ key: 'rounds', label: 'Rounds', unit: null, value: 5 + rng.int(6) }] : [];
	d.otherSessionRecords = [...d.otherSessionRecords, ...extra.others].map((other) => ({
		...other,
		metrics: rounds(other.kind)
	}));

	const noted = new Set<IsoDate>(d.recoveryNotes.map((note) => note.notedOn));
	for (let day = 0; day < WEEKS * 7; day++) {
		const notedOn = addDays(FIRST_MONDAY, day);
		if (noted.has(notedOn) || rng.next() < NO_NOTE) continue;
		d.recoveryNotes.push({
			...{ ownerId, clientMutationId: id(), notedOn, sleepHours: 6 + 0.5 * rng.int(6) },
			...{ soreness: 1 + rng.int(5), energy: 1 + rng.int(5), stress: 1 + rng.int(5), note: null }
		});
	}

	d.programWeeks = d.programWeeks.map((week) => ({ ...week, targets: targetsOf(week.kind) }));
	d.programVersions = d.programVersions.map((version) =>
		version.generator ? { ...version, inputSnapshot: INPUT } : version
	);
	return d;
}

/** Truncates the owner's training and program rows, inserts the analytics history, analyses. */
export async function loadAnalyticsDataset(client: pg.ClientBase, d: Dataset): Promise<void> {
	// The week rollups are summed from the workouts: truncated with them (TRUNCATE fires no trigger).
	await client.query('truncate programs, workouts, recovery_notes, strength_week_rollups cascade');
	await loadDataset(client, d, { owner: false });
}

/** The share of reviews refreshed once: a superseded revision 1 beside the live revision 2. */
export const SUPERSEDED_SHARE = 0.1;
/** The share of proposals the owner asked to change, each revised up to REVISIONS_MAX times. */
export const REVISED_SHARE = 0.2;
export const REVISIONS_MAX = 3;

/** A stored review's computed columns, copied onto every generated review of its kind. */
/** A jsonb column's value, as the schema types it. */
type Json = Record<string, unknown>;

export interface ReviewTemplate {
	snapshot: Json;
	summary: string;
	snapshotVersion: number;
	analyticsVersion: number;
	inputsDigest: string;
}

/** A stored next_cycle proposal's content, copied onto every generated cycle review's proposal. */
export interface ProposalTemplate {
	summary: string;
	rationale: string;
	payload: Json;
	evidence: Json;
	diff: Json | null;
	impact: Json | null;
	payloadHash: string;
}

export interface ReviewTemplates {
	weekly: ReviewTemplate;
	cycle: ReviewTemplate;
	nextCycle: ProposalTemplate;
}

type Insert<T extends { $inferInsert: unknown }> = T['$inferInsert'];
type Proposal = Insert<typeof schema.coachProposals>;

/** How each proposal ended, applied after the inserts (a proposal is stored 'proposed'). */
interface Decision {
	id: string;
	status: 'accepted' | 'rejected' | 'superseded';
	closedAt: Date;
	supersededReason: 'revised' | 'review_refreshed' | 'sessions_passed' | null;
}

export interface ReviewHistory {
	weeklyReviews: Insert<typeof schema.weeklyReviews>[];
	cycleReviews: Insert<typeof schema.cycleReviews>[];
	coachProposals: Proposal[];
	decisions: Decision[];
}

/** What a generated review is made from: its revision, when, whether refreshed, its id. */
interface Revision {
	id: string;
	revision: number;
	createdAt: Date;
	/** Superseded by a refresh, so its proposal was superseded with it. */
	refreshed: boolean;
}

const DAY = 86_400_000;

/**
 * The owner's review history up to `today`, leaving out the week and block whose reviews the
 * services wrote (`written`): those are the live reviews a page load reads.
 */
export function generateReviewHistory(
	d: Dataset,
	templates: ReviewTemplates,
	{ today, written }: { today: IsoDate; written: { week: IsoDate; blockLineage: string } },
	seed: string = `${ANALYTICS_SEED}/reviews`
): ReviewHistory {
	const rng = seededRandom(seed);
	const hex = () =>
		Math.floor(rng.next() * 2 ** 32)
			.toString(16)
			.padStart(8, '0');
	const id = () => {
		const h = hex() + hex() + hex() + hex();
		return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`;
	};
	const ownerId = d.owner.id!;
	const heads = new Map(d.heads.map((head) => [head.programId, head.versionId]));
	const h: ReviewHistory = {
		weeklyReviews: [],
		cycleReviews: [],
		coachProposals: [],
		decisions: []
	};

	/** A review's proposal, then its revisions, each decided; returns the one the review links. */
	function propose(content: Omit<Proposal, 'id' | 'ownerId'>, { createdAt, refreshed }: Revision) {
		const count = rng.next() < REVISED_SHARE ? 1 + rng.int(REVISIONS_MAX) : 0;
		const ids = Array.from({ length: count + 1 }, id);
		const roll = rng.next();
		ids.forEach((proposalId, i) => {
			const at = new Date(createdAt.getTime() + i * DAY);
			const revisionOf = i ? ids[i - 1]! : null;
			h.coachProposals.push({ ...content, id: proposalId, ownerId, revisionOf, createdAt: at });
			const closedAt = new Date(at.getTime() + 3_600_000);
			const decision = (status: Decision['status'], reason: Decision['supersededReason'] = null) =>
				h.decisions.push({ id: proposalId, status, closedAt, supersededReason: reason });
			if (i < count) decision('superseded', 'revised');
			else if (refreshed) decision('superseded', 'review_refreshed');
			else if (roll < 0.7) decision('accepted');
			else if (roll < 0.9) decision('rejected');
			else decision('superseded', 'sessions_passed');
		});
		return ids[0]!;
	}

	/** The live review and, SUPERSEDED_SHARE of the time, the revision 1 it replaced. */
	function revisions<R>(createdAt: Date, make: (r: Revision) => R) {
		const refreshed = rng.next() < SUPERSEDED_SHARE;
		const live: Revision = { id: id(), revision: refreshed ? 2 : 1, createdAt, refreshed: false };
		const liveRow = { ...make(live), id: live.id };
		if (!refreshed) return [liveRow];
		const first: Revision = {
			id: id(),
			revision: 1,
			createdAt: new Date(+createdAt - 2 * DAY),
			refreshed
		};
		return [
			{ ...make(first), id: first.id, supersededAt: createdAt, supersededBy: live.id },
			liveRow
		];
	}
	const computed = ({
		snapshot,
		summary,
		snapshotVersion,
		analyticsVersion,
		inputsDigest
	}: ReviewTemplate) => ({ snapshot, summary, snapshotVersion, analyticsVersion, inputsDigest });
	const morningAfter = (day: IsoDate) => new Date(Date.parse(`${addDays(day, 1)}T07:30:00Z`));

	const blocks = d.programBlocks.filter((block) => heads.has(block.programId));
	for (let w = 0; w < WEEKS; w++) {
		const monday = addDays(FIRST_MONDAY, w * 7);
		if (monday >= written.week) break;
		const block = blocks.find((b) => b.startsOn! <= monday && monday <= b.endsOn!);
		const programId = block?.programId ?? null;
		const versionId = programId && heads.get(programId)!;
		const { weekly } = templates;
		const rows = revisions(morningAfter(addDays(monday, 6)), (r) => ({
			...{ ownerId, weekStartsOn: monday, programId, versionId },
			...{ revision: r.revision, createdAt: r.createdAt, ...computed(weekly) },
			proposalId:
				programId &&
				propose(
					{
						...{ kind: 'program_adjustment', title: PROPOSAL_TITLE, programId },
						...{ baseVersionId: versionId, payloadVersion: 1, payloadHash: hex() + hex() },
						summary: `${1 + rng.int(4)} changes to next week`,
						rationale: `From your review of the week of ${monday}: ${weekly.summary}`,
						payload: { ops: Array.from({ length: 1 + rng.int(4) }, () => ({ op: 'swap' })) },
						evidence: {
							adjustments: [],
							source: {
								kind: 'weekly_review',
								reviewId: r.id,
								revision: r.revision,
								weekStartsOn: monday
							}
						}
					},
					r
				)
		}));
		h.weeklyReviews.push(...rows);
	}
	for (const block of blocks) {
		if (block.endsOn! >= today || block.lineageId === written.blockLineage) continue;
		const { cycle, nextCycle } = templates;
		const versionId = heads.get(block.programId)!;
		const rows = revisions(morningAfter(block.endsOn!), (r) => ({
			...{ ownerId, programId: block.programId, blockLineageId: block.lineageId!, versionId },
			...{ blockStartsOn: block.startsOn, blockEndsOn: block.endsOn },
			...{ revision: r.revision, createdAt: r.createdAt, ...computed(cycle) },
			proposalId: propose(
				{
					...{ kind: 'next_cycle', title: NEXT_CYCLE_TITLE, programId: block.programId },
					...{ baseVersionId: versionId, payloadVersion: 1, payloadHash: nextCycle.payloadHash },
					...{ summary: nextCycle.summary, rationale: nextCycle.rationale },
					...{ payload: nextCycle.payload, diff: nextCycle.diff, impact: nextCycle.impact },
					evidence: {
						...nextCycle.evidence,
						source: { kind: 'cycle_review', reviewId: r.id, revision: r.revision }
					}
				},
				r
			)
		}));
		h.cycleReviews.push(...rows);
	}
	return h;
}
/** Inserts the review history in one transaction, decides its proposals, then analyses. */
export async function loadReviewHistory(client: pg.ClientBase, h: ReviewHistory): Promise<void> {
	await client.query('begin');
	try {
		await insertAll(client, schema.coachProposals, h.coachProposals);
		await insertAll(client, schema.weeklyReviews, h.weeklyReviews);
		await insertAll(client, schema.cycleReviews, h.cycleReviews);
		await client.query(
			`update coach_proposals p set status = e.status, closed_at = e."closedAt",
			   superseded_reason = e."supersededReason"
			 from jsonb_to_recordset($1::jsonb) e(id uuid, status text, "closedAt" timestamptz,
			   "supersededReason" text)
			 where p.id = e.id`,
			[JSON.stringify(h.decisions)]
		);
		await client.query('commit');
	} catch (err) {
		await client.query('rollback');
		throw err;
	}
	await client.query('analyze');
}
