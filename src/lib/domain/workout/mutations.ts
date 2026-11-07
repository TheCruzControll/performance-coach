/**
 * What the outbox carries (wire format v1; the offline workout sync ADR): 16 mutation types in one
 * envelope, the identity rule and entity keys; the dependencies the outbox and the server order
 * by are order.ts's. Device actions (LocalAction) go through the same dispatch but are never sent.
 *
 * After merge, only new types and optional payload fields are added.
 */
import type { BodyArea, Discipline, Severity } from '../profile/catalog.ts';
import type { CustomExercise, CustomMetric, SessionKind } from '../training/types.ts';
import type * as v from '../training/vocabulary.ts';
import type { WeightUnit } from '../units.ts';
import type { AddedExercise, Instant, LoggedSet, PreviousPerformance, StartKit } from './types.ts';

// ---- Payloads -------------------------------------------------------------------------------

/** A change to one strength slot: the exercise at a 1-based position in the workout. */
export interface SlotChange {
	position: number;
	/** The planned exercise's lineage; null for an added exercise or an ad-hoc workout. */
	plannedLineage: string | null;
}

/** Where a set sits, and what is performed there: the planned exercise, a substitute or another. */
export interface SetPlace extends SlotChange {
	/** 1-based, in its slot. */
	setIndex: number;
	exerciseId: string;
}

export interface WorkoutStart {
	kind: SessionKind;
	title: string;
	sessionType: v.SessionType;
	discipline: Discipline;
	/** The kit's pinned planned session; all three null for an ad-hoc workout. */
	plannedSessionId: string | null;
	plannedLineage: string | null;
	programId: string | null;
}

export interface WorkoutFields {
	notes: string | null;
	sessionRpe: number | null;
	/** Time spent training, pauses left out. */
	durationSeconds: number | null;
}

export interface Substitution extends SlotChange {
	fromExerciseId: string;
	toExerciseId: string;
	reason: v.SubstitutionReason;
}

/** Closed: what the owner chose when something hurt. */
export const PAIN_ACTIONS = ['stopped', 'substituted', 'ended_workout'] as const;
export type PainAction = (typeof PAIN_ACTIONS)[number];

/**
 * Something hurt during a slot; area and severity may be left out. The report writes only itself:
 * stopping also sends exercise.skip, and a gentler option an exercise.substitute (reason pain),
 * whose id substitutionId names.
 */
export interface PainReport extends SlotChange {
	exerciseId: string;
	area: BodyArea | null;
	severity: Severity | null;
	action: PainAction;
	substitutionId: string | null;
	note: string | null;
}

/** A run's own values; each may wait until the run ends. */
export interface RunFields {
	distanceMetres: number | null;
	durationSeconds: number | null;
	avgHr: number | null;
	rpe: number | null;
	notes: string | null;
}

/** One segment as run. Every send carries all its values, so a later one replaces them. */
export interface RunSegmentFields {
	/** 1-based, in the run. */
	position: number;
	kind: v.RunSegmentKind;
	distanceMetres: number | null;
	durationSeconds: number | null;
	avgHr: number | null;
	rpe: number | null;
}

/** An other session's values, all of them on every send. */
export interface OtherFields {
	kind: v.OtherSessionKind;
	durationMinutes: number;
	rpe: number | null;
	metrics: CustomMetric[];
	notes: string | null;
}

type Empty = Record<string, never>;

/** Each type's payload. Edits are absolute: they carry values, never differences. */
export interface MutationPayloads {
	'workout.start': WorkoutStart;
	/** Sets the fields it carries. */
	'workout.update': Partial<WorkoutFields>;
	/** Finishes the workout at `at`, setting the summary's fields it carries. */
	'workout.finish': Partial<WorkoutFields>;
	'workout.abandon': Empty;
	'set.log': SetPlace & LoggedSet;
	/** A set not done: a skipped row in its place. */
	'set.skip': SetPlace & Pick<LoggedSet, 'unit'>;
	/** All the set's values after the edit. It never un-skips: delete the skip, log the set. */
	'set.edit': LoggedSet;
	/** Soft: the server keeps a tombstone. */
	'set.delete': Empty;
	/** The rest of a slot not done: a skipped row per set, under ids the device gives them. */
	'exercise.skip': SlotChange & {
		exerciseId: string;
		unit: WeightUnit;
		sets: { id: string; setIndex: number }[];
	};
	/** Today only: a substitution row, never a preference or a program version. */
	'exercise.substitute': Substitution;
	/** Confirmed: the preference, the program's swap from today, and today's substitution. */
	'exercise.dislike': Omit<Substitution, 'reason'> & { note: string | null };
	/** The owner's own exercise, under the device's id. */
	'exercise.create': CustomExercise;
	'pain.report': PainReport;
	/** Sets the run's fields it carries. */
	'run.log': Partial<RunFields>;
	'run.segment': RunSegmentFields;
	'other.log': OtherFields;
}

export type MutationType = keyof MutationPayloads;

// ---- Rules ----------------------------------------------------------------------------------

/**
 * The identity rule: how a type's id relates to the row it addresses. Rows are addressed by client
 * id, so an edit made offline before its create synced still works.
 * - create: id === entityId, the new row's client id
 * - edit: a fresh id; entityId is the row's client id, or the workout's for workout.*
 * - record: a fresh id; entityId is the workout's (the run and other-session records, a slot)
 * - segment: the send without an entityId creates (id === entityId); one with an entityId edits
 */
export type Identity = 'create' | 'edit' | 'record' | 'segment';

/** What an entity key names: a row by its client id, or a 1:1 record or a slot by its workout. */
export type EntityKind = 'workout' | 'set' | 'segment' | 'run' | 'other' | 'slot' | 'exercise';

/** `workout:<id>`, `set:<id>`, `segment:<id>`, `run:<workout>`, `other:<workout>`, `slot:<workout>:<position>`, `exercise:<id>`. */
export type EntityKey = `${EntityKind}:${string}`;

export interface MutationRule {
	kinds: readonly SessionKind[];
	identity: Identity;
	entity: EntityKind;
}

const ANY = ['strength', 'run', 'other'] as const;
const STRENGTH = ['strength'] as const;

/** Every type, in wire order, with the workout kinds it belongs to. */
export const MUTATION_RULES = {
	'workout.start': { kinds: ANY, identity: 'create', entity: 'workout' },
	'workout.update': { kinds: ANY, identity: 'edit', entity: 'workout' },
	'workout.finish': { kinds: ANY, identity: 'edit', entity: 'workout' },
	'workout.abandon': { kinds: ANY, identity: 'edit', entity: 'workout' },
	'set.log': { kinds: STRENGTH, identity: 'create', entity: 'set' },
	'set.skip': { kinds: STRENGTH, identity: 'create', entity: 'set' },
	'set.edit': { kinds: STRENGTH, identity: 'edit', entity: 'set' },
	'set.delete': { kinds: STRENGTH, identity: 'edit', entity: 'set' },
	'exercise.skip': { kinds: STRENGTH, identity: 'record', entity: 'slot' },
	'exercise.substitute': { kinds: STRENGTH, identity: 'create', entity: 'slot' },
	'exercise.dislike': { kinds: STRENGTH, identity: 'create', entity: 'slot' },
	'exercise.create': { kinds: STRENGTH, identity: 'create', entity: 'exercise' },
	'pain.report': { kinds: STRENGTH, identity: 'create', entity: 'slot' },
	'run.log': { kinds: ['run'], identity: 'record', entity: 'run' },
	'run.segment': { kinds: ['run'], identity: 'segment', entity: 'segment' },
	'other.log': { kinds: ['other'], identity: 'record', entity: 'other' }
} as const satisfies { readonly [T in MutationType]: MutationRule };

export const MUTATION_TYPES = Object.keys(MUTATION_RULES) as MutationType[];

/** The types a kind's reducer table handles. */
export type MutationTypeFor<K extends SessionKind> = {
	[T in MutationType]: K extends (typeof MUTATION_RULES)[T]['kinds'][number] ? T : never;
}[MutationType];

// ---- The envelope ---------------------------------------------------------------------------

export interface Envelope<T extends MutationType = MutationType> {
	v: 1;
	/** crypto.randomUUID: the ledger's key, so a replay is applied once. */
	id: string;
	type: T;
	workoutId: string;
	/** The client id of the row it creates or changes, or its workout's (MUTATION_RULES). */
	entityId: string;
	/** When it happened on the device: a set's performed_at, a workout's start or finish. */
	at: Instant;
	payload: MutationPayloads[T];
}

/** Any mutation, narrowed by its type. */
export type Mutation = { [T in MutationType]: Envelope<T> }[MutationType];

/** The mutations of some types: Envelope<T> for one, a Mutation for a union of them. */
export type MutationOf<T extends MutationType> = Extract<Mutation, { type: T }>;

export interface MutationInput<T extends MutationType> {
	workoutId: string;
	/** The row's client id: required to change a row, optional for a create (one is made). */
	entityId?: string;
	at: Instant;
	payload: MutationPayloads[T];
}

const randomId = () => crypto.randomUUID();

/**
 * A mutation under the identity rule. A segment's client id comes only from its first run.segment,
 * sent without an entityId: a run.segment given one always edits that segment.
 */
export function createMutation<T extends MutationType>(
	type: T,
	{ workoutId, entityId: target, at, payload }: MutationInput<T>,
	newId: () => string = randomId
): MutationOf<T> {
	const { identity, entity } = MUTATION_RULES[type] as MutationRule;
	const byWorkout = entity === 'workout' || identity === 'record';
	if (byWorkout && target !== undefined && target !== workoutId) {
		throw new RangeError(`${type} addresses its workout, not ${target}`);
	}
	if (identity === 'edit' && !byWorkout && target === undefined) {
		throw new RangeError(`${type} needs the client id of the row it changes`);
	}
	const entityId = byWorkout ? workoutId : (target ?? newId());
	const creates = identity === 'create' || (identity === 'segment' && target === undefined);
	const m: Envelope<T> = {
		v: 1,
		id: creates ? entityId : newId(),
		type,
		workoutId,
		entityId,
		at,
		payload
	};
	// Envelope<T> is MutationOf<T> for every T; TypeScript cannot see it for a generic one.
	return m as unknown as MutationOf<T>;
}

/** The row, record or slot a mutation addresses: no two of its mutations are ever reordered. */
export function entityKey(m: Mutation): EntityKey {
	const entity = MUTATION_RULES[m.type].entity;
	switch (entity) {
		case 'workout':
		case 'run':
		case 'other':
			return `${entity}:${m.workoutId}`;
		case 'slot':
			return `slot:${m.workoutId}:${(m.payload as SlotChange).position}`;
		default:
			return `${entity}:${m.entityId}`;
	}
}

/** A switch's default for a mutation type it does not handle: pnpm check fails until it does. */
export function unhandledMutation(m: never): never {
	throw new RangeError(`Unhandled mutation type '${(m as Mutation).type}'`);
}

// ---- Device actions -------------------------------------------------------------------------

/**
 * What changes only this device's state (DeviceState, or the kit it holds). Never sent, never in
 * the outbox. Times are epoch ms on this device's clock.
 */
export type LocalAction = { workoutId: string } & (
	| { type: 'goTo'; position: number }
	| { type: 'draft'; position: number; setIndex: number; draft: Partial<LoggedSet> | null }
	| { type: 'exercise.add'; exercise: AddedExercise }
	| { type: 'kit.attach'; kit: StartKit }
	| { type: 'kit.attach'; exerciseId: string; previous: PreviousPerformance | null }
	| { type: 'rest.start'; at: number; durationMs: number }
	| { type: 'rest.add'; at: number; ms: number }
	| { type: 'rest.pause' | 'rest.resume' | 'rest.reset' | 'rest.skip'; at: number }
	| {
			type: 'stopwatch.start' | 'stopwatch.pause' | 'stopwatch.resume' | 'stopwatch.reset';
			at: number;
	  }
);
