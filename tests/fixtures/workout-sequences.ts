/**
 * Seeded random strength sequences for the convergence property (test-only, never imported by
 * app code; the offline workout sync ADR). workout-projection folds them in the domain, and
 * canonical-reads replays the same seeds against Postgres through the real endpoint.
 *
 * A sequence is what one device could send for one workout, in outbox order: its workout.start,
 * then sets logged, skipped, edited and deleted on the kit's exercises and on the owner's own
 * exercises created mid-workout, workout updates, and sometimes a finish or an abandon. Every
 * set carries what its exercise records: reps, seconds or metres; a weight, an added weight or an
 * assistance; missed reps, warm-ups and extra sets.
 *
 * - The same seed and kit always give the same mutations, ids and instants.
 * - Ids are UUID-shaped and carry the seed, so the sequences of one run never share an id.
 * - acrossRows reorders a sequence the way the outbox may deliver it: never one row's mutations
 *   among themselves, and never a mutation before one it depends on (dependsOn).
 */
import { seededRandom } from '../../src/lib/domain/programming/random';
import type { SeededRandom } from '../../src/lib/domain/programming/random';
import type { CustomExercise } from '../../src/lib/domain/training/types';
import type { LoadType, Measure } from '../../src/lib/domain/training/vocabulary';
import { createMutation, dependsOn } from '../../src/lib/domain/workout';
import type {
	LoggedSet,
	Mutation,
	MutationInput,
	MutationOf,
	MutationType,
	SetPlace,
	StrengthKit
} from '../../src/lib/domain/workout';

/** How many seeds the property runs: seeds 1 to SEQUENCE_COUNT. */
export const SEQUENCE_COUNT = 500;

/** The longest sequence after its workout.start. */
const MAX_STEPS = 30;

export interface StrengthSequence {
	seed: number;
	workoutId: string;
	mutations: Mutation[];
}

interface Slot {
	position: number;
	plannedLineage: string | null;
	exerciseId: string;
	measure: Measure;
	loadType: LoadType;
	plannedSets: number;
}

interface Made {
	id: string;
	slot: Slot;
	skipped: boolean;
	deleted: boolean;
}

const base = (fields: Partial<CustomExercise>): CustomExercise => ({
	name: '',
	aliases: [],
	pattern: 'carry',
	primaryMuscles: ['glutes'],
	secondaryMuscles: [],
	equipment: [],
	substitutionGroup: null,
	skillLevel: 'beginner',
	repMin: null,
	repMax: null,
	defaultSeconds: null,
	unilateral: false,
	measure: 'reps',
	loadType: 'external',
	tags: [],
	disciplines: [],
	...fields
});

/**
 * The owner's own exercises a sequence may create, in order, so the measures and loads the kit
 * lacks (metres, an assistance) come first. None is a catalogue name.
 */
const CUSTOM: CustomExercise[] = [
	base({ name: 'Keg carry', primaryMuscles: ['forearms'], measure: 'distance' }),
	base({
		name: 'Band-assisted muscle-up',
		pattern: 'vertical_pull',
		primaryMuscles: ['lats'],
		loadType: 'assisted'
	}),
	base({ name: 'Bulgarian bag spin', pattern: 'rotation', measure: 'time', defaultSeconds: 30 }),
	base({ name: 'Sandbag shouldering', repMin: 3, repMax: 8 })
];

const hex = (n: number, width: number) => n.toString(16).padStart(width, '0');

/** A whole number from `min` to `max`, or a multiple of `step` in that range. */
const between = (random: SeededRandom, min: number, max: number, step = 1) =>
	min + step * random.int(Math.floor((max - min) / step) + 1);

/** One set's values, as its exercise records them. */
function values(random: SeededRandom, slot: Slot, setIndex: number, unit: LoggedSet['unit']) {
	const reps = slot.measure === 'reps' ? between(random, 1, 12) : null;
	const loaded = slot.loadType === 'external' || random.next() < 0.5;
	return {
		reps,
		seconds: slot.measure === 'time' ? between(random, 15, 90) : null,
		metres: slot.measure === 'distance' ? between(random, 10, 60) : null,
		weight:
			slot.loadType === 'external'
				? between(random, 20, 150, 2.5)
				: slot.loadType === 'bodyweight' && loaded
					? between(random, 2.5, 20, 2.5)
					: null,
		assistance: slot.loadType === 'assisted' ? between(random, 5, 40, 2.5) : null,
		unit,
		rpe: random.next() < 0.3 ? null : between(random, 6, 10, 0.5),
		missedReps: reps !== null && random.next() < 0.2 ? between(random, 1, 3) : 0,
		isWarmup: setIndex === 1 && random.next() < 0.1,
		isExtra: setIndex > slot.plannedSets
	} satisfies LoggedSet;
}

/** The sequence for `seed` on `kit`, the kit's exercise ids as given. */
export function strengthSequence(
	seed: number,
	kit: StrengthKit,
	startAt = Date.UTC(2026, 10, 6, 17, 0, 0)
): StrengthSequence {
	const random = seededRandom(seed);
	let count = 0;
	const newId = () => `${hex(seed, 8)}-0000-4000-8000-${hex(++count, 12)}`;
	const workoutId = newId();
	const at = () => new Date(startAt + count * 7_000).toISOString();
	const make = <T extends MutationType>(
		type: T,
		input: Omit<MutationInput<T>, 'workoutId' | 'at'>
	) => createMutation(type, { workoutId, at: at(), ...input }, newId);

	const slots: Slot[] = kit.exercises.map((e) => ({
		position: e.position,
		plannedLineage: e.plannedLineage,
		exerciseId: e.exercise.id,
		measure: e.exercise.measure,
		loadType: e.exercise.loadType,
		plannedSets: e.sets.length
	}));
	const made: Made[] = [];
	const unit = kit.units.weight;
	const place = (slot: Slot): SetPlace => ({
		position: slot.position,
		plannedLineage: slot.plannedLineage,
		exerciseId: slot.exerciseId,
		setIndex: made.filter((m) => m.slot === slot).length + 1
	});
	const live = () => made.filter((m) => !m.deleted);

	const mutations: Mutation[] = [
		make('workout.start', {
			entityId: workoutId,
			payload: {
				kind: 'strength',
				title: kit.title,
				sessionType: kit.sessionType,
				discipline: kit.discipline,
				plannedSessionId: kit.plannedSessionId,
				plannedLineage: kit.plannedLineage,
				programId: kit.programId
			}
		})
	];
	const steps = 1 + random.int(MAX_STEPS);
	for (let step = 0; step < steps; step++) {
		const roll = random.next();
		const logged = live().filter((m) => !m.skipped);
		if (roll < 0.45) {
			const slot = random.pick(slots);
			const where = place(slot);
			const m = make('set.log', {
				payload: { ...where, ...values(random, slot, where.setIndex, unit) }
			});
			made.push({ id: m.entityId, slot, skipped: false, deleted: false });
			mutations.push(m);
		} else if (roll < 0.52) {
			const slot = random.pick(slots);
			const m = make('set.skip', { payload: { ...place(slot), unit } });
			made.push({ id: m.entityId, slot, skipped: true, deleted: false });
			mutations.push(m);
		} else if (roll < 0.7 && logged.length) {
			const set = random.pick(logged);
			const setIndex = made.filter((m) => m.slot === set.slot).indexOf(set) + 1;
			mutations.push(
				make('set.edit', { entityId: set.id, payload: values(random, set.slot, setIndex, unit) })
			);
		} else if (roll < 0.8 && live().length) {
			const set = random.pick(live());
			set.deleted = true;
			mutations.push(make('set.delete', { entityId: set.id, payload: {} }));
		} else if (roll < 0.9) {
			const fields: MutationOf<'workout.update'>['payload'] = {};
			if (random.next() < 0.6) fields.notes = random.pick([null, 'Felt quick', 'Grip went']);
			if (random.next() < 0.6) fields.sessionRpe = between(random, 5, 10, 0.5);
			if (random.next() < 0.3) fields.durationSeconds = between(random, 600, 5400, 60);
			mutations.push(make('workout.update', { payload: fields }));
		} else if (slots.length < kit.exercises.length + CUSTOM.length) {
			const exercise = CUSTOM[slots.length - kit.exercises.length]!;
			const m = make('exercise.create', { payload: exercise });
			slots.push({
				position: slots.length + 1,
				plannedLineage: null,
				exerciseId: m.entityId,
				measure: exercise.measure,
				loadType: exercise.loadType,
				plannedSets: 0
			});
			mutations.push(m);
		}
	}
	const end = random.next();
	if (end < 0.3) {
		mutations.push(
			make('workout.finish', { payload: { sessionRpe: between(random, 5, 10, 0.5) } })
		);
	} else if (end < 0.35) {
		mutations.push(make('workout.abandon', { payload: {} }));
	}
	return { seed, workoutId, mutations };
}

/**
 * The mutations in a random order the outbox could deliver them in: each one after every earlier
 * one it depends on, so one row's mutations keep their order.
 */
export function acrossRows(mutations: readonly Mutation[], random: SeededRandom): Mutation[] {
	const left = [...mutations];
	const out: Mutation[] = [];
	while (left.length) {
		const ready = left.filter((m, i) => !left.slice(0, i).some((earlier) => dependsOn(m, earlier)));
		const next = random.pick(ready);
		out.push(next);
		left.splice(left.indexOf(next), 1);
	}
	return out;
}

/**
 * Where the server stands for a seed: it has applied the first k + 1 mutations (k from −1, none
 * of them, to all of them), delivered in an order acrossRows allows. `random` makes the seed's
 * later choices, such as the order the server returns its rows in.
 */
export function serverSplit(seed: number, mutations: readonly Mutation[]) {
	const random = seededRandom(`overlap:${seed}`);
	const k = random.int(mutations.length + 1) - 1;
	return { k, applied: acrossRows(mutations.slice(0, k + 1), random), random };
}
