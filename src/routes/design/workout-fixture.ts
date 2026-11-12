/**
 * /design → Workout's fixtures: one state of each src/lib/ui/workout component per entry, in the
 * words the strength view would give them (set-words.ts, sync-words.ts, logger-words.ts), so each
 * can be audited and screenshotted on its own. Up next's views are real projections of a small
 * strength kit (a straight exercise, then a superset), replayed as the workout page does.
 */
import { BASELINE_INSTRUCTION } from '#lib/domain/training/describe.ts';
import type { LoadType, Measure } from '#lib/domain/training/vocabulary.ts';
import type {
	KitExercise,
	KitSet,
	LoggedSet,
	PreviousPerformance,
	StrengthKit,
	WorkoutView
} from '#lib/domain/workout/index.ts';
import { setFields, type SetFields } from '#lib/domain/workout/logging.ts';
import { createMutation, type Mutation } from '#lib/domain/workout/mutations.ts';
import { applyLocal, replay, viewOf } from '#lib/domain/workout/project.ts';
import { strengthTable } from '#lib/domain/workout/reducers/tables.ts';
import type { OutboxStatus } from '#lib/client/workout/outbox-rules.ts';
import { loadHint } from '#lib/ui/workout/logger-words.ts';
import type { ExerciseWords, SetRowWords } from '#lib/ui/workout/set-words.ts';

/** Every set row state, in the order a session meets them. */
export const SET_ROWS: readonly SetRowWords[] = [
	{ setIndex: 1, state: 'done', text: '100 kg × 5 reps · RPE 8', word: 'Done' },
	{ setIndex: 2, state: 'missed', text: '97.5 kg × 3 reps · RPE 10', word: '2 missed' },
	{ setIndex: 3, state: 'skipped', text: '5 reps · ≈ 97.5 kg', word: 'Skipped' },
	{ setIndex: 4, state: 'current', text: '5 reps · ≈ 97.5 kg', word: 'Now' },
	{ setIndex: 5, state: 'todo', text: '5 reps · ≈ 97.5 kg', word: 'To do' },
	{ setIndex: 6, state: 'extra', text: '80 kg × 8 reps', word: 'Extra set' },
	{ setIndex: 7, state: 'not-saved', text: '80 kg × 8 reps', word: 'Not saved on this device' }
];

/** Every sync pill state, its 'needs attention' included. */
export const SYNC_STATES: readonly OutboxStatus[] = [
	{ state: 'synced' },
	{ state: 'saving', pending: 2 },
	{ state: 'offline', pending: 3 },
	{ state: 'unreachable', waiting: 3 },
	{ state: 'retrying', seconds: 12, pending: 3 },
	{ state: 'attention', count: 2 },
	{ state: 'signed-out', waiting: 4 },
	{ state: 'passkey', waiting: 0 }
];

const set = (values: Partial<LoggedSet>): LoggedSet => ({
	reps: null,
	seconds: null,
	metres: null,
	weight: null,
	assistance: null,
	unit: 'kg',
	rpe: null,
	missedReps: 0,
	isWarmup: false,
	isExtra: false,
	...values
});

/** The session this device holds of the history sheet's exercise, shown offline. */
export const HISTORY_FALLBACK: PreviousPerformance = {
	date: '2026-10-30',
	sets: [set({ reps: 5, weight: 100, rpe: 8 }), set({ reps: 5, weight: 85, rpe: 7 })]
};

export interface LoggerFixture {
	label: string;
	heading: string;
	fields: SetFields;
	values: LoggedSet;
	increment: number;
	loadHint: string | null;
}

const logger = (
	label: string,
	heading: string,
	[measure, loadType]: [Measure, LoadType],
	values: Partial<LoggedSet>,
	fromLastTime = true
): LoggerFixture => {
	const fields = setFields(measure, loadType);
	const loadFrom = fromLastTime ? ('last_session' as const) : null;
	return {
		label,
		heading,
		fields,
		values: set(values),
		increment: 2.5,
		loadHint: loadHint({ loadFrom, instruction: null, fields })
	};
};

/** The logger for each measure and each load type. */
export const LOGGERS = {
	weight: logger('Barbell', 'Set 2 of 4 · 5 reps · ≈ 97.5 kg', ['reps', 'external'], {
		reps: 5,
		weight: 97.5,
		rpe: 8
	}),
	added: logger('Bodyweight', 'Set 1 of 3 · 6–10 reps · RPE 8', ['reps', 'bodyweight'], {
		reps: 8
	}),
	assisted: logger('Assisted', 'Set 1 of 3 · 8 reps', ['reps', 'assisted'], {
		reps: 8,
		assistance: 20
	}),
	none: logger('Unloaded', 'Set 1 of 3 · 5 reps', ['reps', 'none'], { reps: 5 }, false),
	time: logger('Time', 'Set 1 of 3 · 0:45 · RPE 7', ['time', 'bodyweight'], { seconds: 45 }, false),
	distance: logger('Distance', 'Set 1 of 2 · 40 m', ['distance', 'external'], {
		metres: 40,
		weight: 32
	})
} satisfies Record<string, LoggerFixture>;

const words = (more: Partial<ExerciseWords>): ExerciseWords => ({
	name: 'Back squat',
	place: 'Exercise 1 of 4',
	lines: ['Work up to a set of 5 @ RPE 7', '3 × 5'],
	load: { kind: 'weight', text: '≈ 97.5 kg' },
	rest: 'Rest 3:00',
	loads: [
		{ kind: 'instruction', text: BASELINE_INSTRUCTION },
		{ kind: 'weight', text: '≈ 97.5 kg' }
	],
	rests: ['Rest 3:00'],
	previous: {
		heading: 'Last time · 7 days ago',
		sets: ['100 kg × 5 reps · RPE 8', '85 kg × 5 reps · RPE 7', '85 kg × 5 reps · RPE 7']
	},
	...more
});

export interface CardFixture {
	label: string;
	exercise: ExerciseWords;
	status: { text: string; instead: string | null } | null;
	noPrevious?: string;
	rows: SetRowWords[];
}

const SWAPPED = { text: 'Swapped for this session', instead: 'Back squat' };
const ahead = SET_ROWS.slice(3, 5);

/** The exercise card's states: what it says, its slot's state and the rows under it. */
export const CARDS = {
	baseline: {
		label: 'Baseline',
		exercise: words({
			lines: ['Work up to a set of 5 @ RPE 7'],
			load: { kind: 'instruction', text: BASELINE_INSTRUCTION },
			previous: null
		}),
		status: null,
		rows: [{ ...SET_ROWS[3]!, setIndex: 1, text: '5 reps · RPE 7' }]
	},
	superset: {
		label: 'A1 / A2',
		exercise: words({
			name: 'Pull-up',
			label: 'A1',
			place: 'Exercise 3 of 4',
			lines: ['3 × 6–10 @ RPE 8'],
			load: { kind: 'note', text: 'Bodyweight · add weight if you like' },
			loads: [],
			rest: 'No rest',
			rests: [],
			previous: { heading: 'Last time · 4 days ago', sets: ['9 reps', '8 reps', '7 reps · RPE 9'] }
		}),
		status: null,
		rows: [
			{ setIndex: 1, state: 'done', text: '9 reps · RPE 8', word: 'Done' },
			{ setIndex: 2, state: 'current', text: '6–10 reps · RPE 8', word: 'Now' }
		]
	},
	swapped: {
		label: 'Swapped',
		exercise: words({ name: 'Leg press', lines: ['3 × 10 @ RPE 7'], load: null, previous: null }),
		status: SWAPPED,
		noPrevious: 'No previous sets on this device',
		rows: ahead
	},
	stopped: {
		label: 'Stopped',
		exercise: words({}),
		status: { text: 'Stopped', instead: null },
		rows: [
			...SET_ROWS.slice(0, 2),
			...ahead.map((row) => ({ ...row, state: 'todo' as const, word: 'To do' }))
		]
	},
	checking: {
		label: 'Checking',
		exercise: words({ name: 'Hack squat', previous: null }),
		status: SWAPPED,
		noPrevious: 'Last time · checking',
		rows: ahead
	}
} satisfies Record<string, CardFixture>;

// ---- Up next: a real projection ------------------------------------------------------------

const WORKOUT = '00000000-0000-4000-8000-0000000d0001';
/** An ad-hoc session's: no plan behind it. */
const NO_PLAN = { plannedLineage: null, plannedSessionId: null, programId: null } as const;
const WORKING: Omit<KitSet, 'line'> = {
	role: 'working',
	repsMin: null,
	repsMax: null,
	seconds: null,
	metres: null,
	targetRpe: 7,
	prescribedWeight: null,
	restSeconds: 90,
	instruction: null
};

const PATTERN = {
	romanian_deadlift: 'hinge',
	pull_up: 'vertical_pull',
	plank: 'anti_extension'
} as const;

/** A kit exercise of two sets of one line, no load prescribed. */
const slot = (
	position: number,
	[key, name, measure, loadType]: [
		'romanian_deadlift' | 'pull_up' | 'plank',
		string,
		Measure,
		LoadType
	],
	set: Partial<KitSet> & Pick<KitSet, 'line'>,
	superset: number | null = null
): KitExercise => ({
	position,
	plannedLineage: null,
	superset,
	exercise: {
		id: key,
		key,
		name,
		measure,
		loadType,
		unilateral: false,
		pattern: PATTERN[key],
		tags: [],
		restClass: measure === 'time' ? 'timed' : 'compound',
		increment: 2.5
	},
	sets: [1, 2].map(() => ({ ...WORKING, ...set })),
	instructions: null,
	previous: null,
	bestE1rm: null,
	priorBests: [],
	mostReps: null
});

const SESSION = {
	title: 'Lower body & pull',
	sessionType: 'strength',
	discipline: 'strength',
	...NO_PLAN
} as const;

export const UP_NEXT_KIT: StrengthKit = {
	v: 1,
	kind: 'strength',
	...SESSION,
	date: '2026-11-06',
	versionNumber: null,
	units: { weight: 'kg', distance: 'km' },
	exercises: [
		slot(1, ['romanian_deadlift', 'Romanian deadlift', 'reps', 'external'], {
			repsMin: 8,
			repsMax: 8,
			line: '2 × 8 @ RPE 7'
		}),
		slot(
			2,
			['pull_up', 'Pull-up', 'reps', 'bodyweight'],
			{
				repsMin: 6,
				repsMax: 10,
				targetRpe: 8,
				restSeconds: 0,
				line: '2 × 6–10 @ RPE 8'
			},
			1
		),
		slot(3, ['plank', 'Plank', 'time', 'bodyweight'], { seconds: 45, line: '2 × 0:45 @ RPE 7' }, 1)
	]
};

/** Up next's moments: inside a superset round, between exercises, and once all is done. */
export const UP_NEXT = {
	partner: { label: 'Superset partner', logged: [] as number[], at: 2 },
	between: { label: 'Between exercises', logged: [1, 1], at: 1 },
	done: { label: 'All done', logged: [1, 1, 2, 3, 2, 3], at: 3 }
};

/** The kit's workout with one set logged at each position given, in order, then at `at`. */
export function upNextView({ logged, at }: { logged: readonly number[]; at: number }): WorkoutView {
	const now = '2026-11-06T18:00:00.000Z';
	const start = createMutation('workout.start', {
		workoutId: WORKOUT,
		entityId: WORKOUT,
		at: now,
		payload: { kind: 'strength', ...SESSION }
	});
	const counts = new Map<number, number>();
	const logs: Mutation[] = logged.map((position) => {
		const { exercise } = UP_NEXT_KIT.exercises[position - 1]!;
		const setIndex = (counts.get(position) ?? 0) + 1;
		counts.set(position, setIndex);
		const time = exercise.measure === 'time';
		const done = set({ reps: time ? null : 8, seconds: time ? 45 : null, rpe: 7 });
		return createMutation('set.log', {
			workoutId: WORKOUT,
			at: now,
			payload: { ...done, position, plannedLineage: null, setIndex, exerciseId: exercise.id }
		});
	});
	const state = replay(strengthTable, {
		workoutId: WORKOUT,
		kit: UP_NEXT_KIT,
		canonical: null,
		pending: [start, ...logs]
	});
	return viewOf(
		strengthTable,
		applyLocal(strengthTable, state, { type: 'goTo', workoutId: WORKOUT, position: at })
	)!;
}
